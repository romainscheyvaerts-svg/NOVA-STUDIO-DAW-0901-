#!/usr/bin/env python3
"""
Moteur VST natif du pont : NovaVSTHost.exe (native-host/, SDK VST3 de Steinberg sous
licence MIT, sans JUCE) à la place de pedalboard (GPLv3, embarque JUCE).

Choix du moteur : NOVA_VST_ENGINE=native|pedalboard (défaut : DEFAULT_ENGINE, avec repli
sur l'autre moteur s'il manque). vst_host.py garde son contrat (Slot, render_offline…) :
_open_plugin() rend ici un NativePlugin, qui offre la même surface que l'objet de
pedalboard (process, __call__ MIDI, parameters, _parameters, raw_state,
reported_latency_samples, show_editor…) avec les mêmes règles (latence retenue au début
du flux, textes des réglages relevés sur 1 001 pas, valeurs en float, apply_param…). Les
mêmes réglages donnent donc les mêmes valeurs, et le même son (prouvé plugin par plugin,
voir qa/vst_native_parite.py).

En plus de pedalboard :
  - un processus par plugin : un plugin qui plante (chargement, réglage, traitement)
    n'emporte que son processus ; le pont lève HostCrashed et continue ;
  - side-chain réel (bus auxiliaire du plugin) : process(..., key=(2, n)) ;
  - réglages à l'échantillon près : process(..., changes=[(clé ou index, décalage, valeur 0–1)])
    → IParameterChanges du SDK, sans découper le bloc ;
  - transport (tempo, position, lecture) transmis au plugin : set_transport() ;
  - gestes faits dans la fenêtre du plugin signalés aussitôt (on_edit), pas relevés.

Transport audio : une zone de mémoire partagée par plugin + deux événements Windows
(voir native-host/Source/SharedAudio.h), commandes en lignes JSON sur stdin / stdout.
"""

import base64
import ctypes
import itertools
import json
import logging
import mmap
import os
import platform
import re
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

logger = logging.getLogger("NovaBridge.Native")

IS_WINDOWS = platform.system() == "Windows"
EXE_NAME = "NovaVSTHost.exe"

# Moteur par défaut quand NOVA_VST_ENGINE n'est pas posé : « native » depuis la parité prouvée
# sur la liste de référence (Pro-Q 4, Pro-C 3, C6, L1, RVox, EchoBoy, LA-2A, Auto-Tune Pro, CL 1B,
# Vital ; modèle LENNON : voir D:\1 WORK\CONTENU\nova-hote-vst). pedalboard reste le repli
# (NOVA_VST_ENGINE=pedalboard, ou NovaVSTHost.exe absent).
DEFAULT_ENGINE = "native"

LOAD_TIMEOUT_S = 16 * 60.0      # un chargement peut attendre une fenêtre de licence (15 min côté pont)
CALL_TIMEOUT_S = 120.0
PROCESS_TIMEOUT_S = 30.0        # un bloc hors ligne ; le pont applique sa propre limite en temps réel
READY_TIMEOUT_S = 30.0

CREATE_NO_WINDOW = 0x08000000
PRIORITY = {"below_normal": 0x00004000, "normal": 0x00000020, "above_normal": 0x00008000, "high": 0x00000080}

K_CAN_AUTOMATE = 1 << 0
K_IS_BYPASS = 1 << 16
K_IS_READ_ONLY = 1 << 1
K_IS_PROGRAM_CHANGE = 1 << 15
DEFAULT_NUM_STEPS = 0x7FFFFFFF   # AudioProcessor::getDefaultNumParameterSteps de JUCE


class HostError(RuntimeError):
    """L'hôte a refusé une commande (le plugin reste utilisable)."""


class HostCrashed(RuntimeError):
    """Le plugin a planté (son processus est perdu) ; le pont, lui, continue."""


# ─────────────────────────────────────────────────────────────────────────────
# Moteur choisi
# ─────────────────────────────────────────────────────────────────────────────

def find_host_exe() -> Optional[str]:
    """NovaVSTHost.exe : NOVA_VST_HOST_EXE, à côté de l'exécutable figé, ou le build du dépôt."""
    env = os.environ.get("NOVA_VST_HOST_EXE")
    if env and os.path.isfile(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    cands = []
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
        cands += [os.path.join(base, EXE_NAME), os.path.join(os.path.dirname(sys.executable), EXE_NAME)]
    cands.append(os.path.join(here, "..", "native-host", "build", "NovaVSTHost_artefacts", "Release", EXE_NAME))
    for c in cands:
        if os.path.isfile(c):
            return os.path.abspath(c)
    return None


def select_engine(has_pedalboard: bool) -> str:
    """« native » ou « pedalboard » (ou « none ») : réglage NOVA_VST_ENGINE, sinon
    DEFAULT_ENGINE ; repli sur l'autre moteur quand celui demandé manque."""
    want = (os.environ.get("NOVA_VST_ENGINE") or DEFAULT_ENGINE).strip().lower()
    native_ok = IS_WINDOWS and find_host_exe() is not None
    if want == "native":
        if native_ok:
            return "native"
        if has_pedalboard:
            logger.warning("NovaVSTHost.exe introuvable : moteur pedalboard utilisé")
            return "pedalboard"
        return "none"
    if has_pedalboard:
        return "pedalboard"
    return "native" if native_ok else "none"


def host_priority() -> int:
    name = (os.environ.get("NOVA_VST_HOST_PRIORITY") or "normal").strip().lower()
    return PRIORITY.get(name, PRIORITY["normal"])


# ─────────────────────────────────────────────────────────────────────────────
# Noms des réglages (même règle que les clés de pedalboard : « Ratio » → ratio,
# « Gain » + unité « dB » → gain_db)
# ─────────────────────────────────────────────────────────────────────────────

IGNORED_PARAM_NAMES = (re.compile(r"MIDI CC "), re.compile(r"P\d\d\d"))


def python_key(name: str, label: str) -> str:
    """Clé d'un réglage : nom (+ unité sauf « :… »), minuscules, tout ce qui n'est pas une
    lettre ou un chiffre ASCII devient « _ » (une seule fois de suite), sans « _ » au bord ;
    « # » / « ♯ » → « _sharp », « ♭ » → « _flat »."""
    if not name and not label:
        return ""
    full = name if not label or label.startswith(":") else f"{name} {label}"
    full = full.lower().strip().replace("#", "_sharp").replace("♯", "_sharp").replace("♭", "_flat")
    out: List[str] = []
    for ch in full:
        keep = (ch.isalpha() or ch.isnumeric()) and ch.isprintable() and ord(ch) < 128
        c = ch if keep else "_"
        if c == "_" and out and out[-1] == "_":
            continue
        out.append(c)
    return "".join(out).strip("_")


# ─────────────────────────────────────────────────────────────────────────────
# Textes des réglages → nombres (mêmes conventions que pedalboard pour reconnaître
# un réglage numérique : « -16.00 dB », « 100.0 ms », « 1.5 kHz »…)
# ─────────────────────────────────────────────────────────────────────────────

UNIT_SUFFIXES = ("x", "%", "*", ",", ".", "hz", "ms", "db", "sec", "dbtp", "seconds")
TRUE_WORDS = {"on", "yes", "true", "enabled"}


def strip_units(s: Any, si: bool = True) -> Any:
    """« -16.00 dB » → « -16.00 » ; « 1.5 kHz » → « 1500.0 » (si) ; autre type : tel quel."""
    if not isinstance(s, str):
        return s
    s = s.strip()
    if si and len(s) >= 3 and s.lower().endswith("khz"):
        try:
            return str(float(s[:-3]) * 1000)
        except ValueError:
            return s
    while True:
        low = s.lower()
        for suf in UNIT_SUFFIXES:
            if low.endswith(suf):
                s = s[:len(s) - len(suf)].strip()
                break
        else:
            return s


def is_number_text(s: Any) -> bool:
    if isinstance(s, float):
        return True
    try:
        float(strip_units(s))
        return True
    except (TypeError, ValueError):
        return False


def juce_float_of(text: str) -> float:
    """Repli de JUCE quand le plugin ne lit pas un texte : chiffres, « - » et « . » gardés,
    puis le nombre en tête (0 sinon)."""
    kept = "".join(c for c in str(text) if c in "-0123456789.")
    m = re.match(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", kept)
    try:
        return float(m.group(0)) if m else 0.0
    except ValueError:
        return 0.0


def f32(x: float) -> float:
    return float(np.float32(x))


ROOT_UNIT = 0   # kRootUnitId


def juce_param_order(params: Sequence[dict], units: Sequence[dict]) -> List[int]:
    """Ordre des réglages vu par JUCE (donc par pedalboard) : chaque réglage rangé dans le
    groupe de son unité (IUnitInfo), groupes créés dans l'ordre de leur premier réglage,
    puis l'arbre lu en profondeur. Les unités inconnues (et l'unité d'indice 0) vont à la
    racine. Rend les indices du contrôleur dans cet ordre."""
    info = {int(u["id"]): u for u in units or [] if int(u.get("index", 0)) >= 1}
    children: Dict[int, List[Tuple[str, int]]] = {ROOT_UNIT: []}

    def group_of(uid: int) -> int:
        if uid in children:
            return uid
        if uid not in info:
            return ROOT_UNIT
        children[uid] = []
        parent = group_of(int(info[uid].get("parent", ROOT_UNIT)))
        children[parent].append(("g", uid))
        return uid

    for i, p in enumerate(params):
        children[group_of(int(p.get("unit", ROOT_UNIT)))].append(("p", i))
    out: List[int] = []

    def walk(g: int, depth: int = 0):
        for kind, v in children[g]:
            if kind == "p":
                out.append(v)
            elif depth < 64:
                walk(v, depth + 1)

    walk(ROOT_UNIT)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# État : enveloppe binaire de JUCE (identique à pedalboard, échangeable dans les deux sens)
#   « VC2! » + u32 taille + XML d'une ligne + octet nul ; IComponent / IEditController
#   en base64 « JUCE » (« taille.texte », 6 bits par caractère, bit de poids faible d'abord).
# ─────────────────────────────────────────────────────────────────────────────

_JUCE_B64 = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"
_JUCE_B64_ARR = np.frombuffer(_JUCE_B64.encode("ascii"), dtype=np.uint8)
_JUCE_B64_INV = np.full(256, 255, dtype=np.uint8)
_JUCE_B64_INV[_JUCE_B64_ARR] = np.arange(64, dtype=np.uint8)


def juce_b64_encode(data: bytes) -> str:
    n = len(data)
    if n == 0:
        return "0."
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8), bitorder="little")
    nchars = (n * 8 + 5) // 6
    bits = np.concatenate([bits, np.zeros(nchars * 6 - bits.size, np.uint8)])
    vals = bits.reshape(-1, 6).astype(np.uint8) @ (1 << np.arange(6, dtype=np.uint8))
    return f"{n}." + _JUCE_B64_ARR[vals.astype(np.uint8)].tobytes().decode("ascii")


def juce_b64_decode(s: str) -> bytes:
    size_str, _, enc = s.strip().partition(".")
    size = int(size_str)
    if size == 0:
        return b""
    vals = _JUCE_B64_INV[np.frombuffer(enc.encode("ascii"), dtype=np.uint8)]
    if (vals == 255).any():
        raise ValueError("base64 JUCE illisible")
    bits = ((vals[:, None] >> np.arange(6, dtype=np.uint8)) & 1).astype(np.uint8).reshape(-1)
    need = size * 8
    if bits.size < need:
        bits = np.concatenate([bits, np.zeros(need - bits.size, np.uint8)])
    return np.packbits(bits[:need], bitorder="little").tobytes()


def pack_state(component: Optional[bytes], controller: Optional[bytes]) -> bytes:
    xml = '<?xml version="1.0" encoding="UTF-8"?> <VST3PluginState>'
    if component is not None:
        xml += "<IComponent>" + juce_b64_encode(component) + "</IComponent>"
    if controller is not None:
        xml += "<IEditController>" + juce_b64_encode(controller) + "</IEditController>"
    xml += "</VST3PluginState>"
    b = xml.encode("utf-8") + b"\x00"
    return b"VC2!" + struct.pack("<I", len(b)) + b


def unpack_state(raw: bytes) -> Tuple[Optional[bytes], Optional[bytes]]:
    raw = bytes(raw)
    if raw[:4] != b"VC2!" or len(raw) < 8:
        raise ValueError("État VST3 non reconnu (enveloppe « VC2! » attendue)")
    n = struct.unpack("<I", raw[4:8])[0]
    xml = raw[8:8 + n].rstrip(b"\x00").decode("utf-8", "replace")
    comp = re.search(r"<IComponent>(.*?)</IComponent>", xml, re.S)
    ctrl = re.search(r"<IEditController>(.*?)</IEditController>", xml, re.S)
    return (juce_b64_decode(comp.group(1)) if comp else None,
            juce_b64_decode(ctrl.group(1)) if ctrl else None)


# ─────────────────────────────────────────────────────────────────────────────
# MIDI : (octets, instant en s) → échantillon, avec l'arrondi de pedalboard (float32, tronqué)
# ─────────────────────────────────────────────────────────────────────────────

def midi_to_samples(messages: Any, sample_rate: float) -> List[Tuple[int, bytes]]:
    out: List[Tuple[int, bytes]] = []
    sr = np.float32(sample_rate)
    for m in messages or []:
        if hasattr(m, "bytes") and hasattr(m, "time"):
            data, t = bytes(m.bytes()), m.time
        elif isinstance(m, (tuple, list)) and len(m) == 2:
            data, t = m
            data = bytes(data) if not isinstance(data, bytes) else data
        else:
            continue
        if not data:
            continue
        out.append((int(np.float32(t) * sr), data[:3]))
    out.sort(key=lambda e: e[0])
    return out


# ─────────────────────────────────────────────────────────────────────────────
# API Windows (événements, attente)
# ─────────────────────────────────────────────────────────────────────────────

if IS_WINDOWS:
    from ctypes import wintypes
    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.CreateEventW.restype = wintypes.HANDLE
    _k32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    _k32.SetEvent.argtypes = [wintypes.HANDLE]
    _k32.SetEvent.restype = wintypes.BOOL
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.WaitForMultipleObjects.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE), wintypes.BOOL, wintypes.DWORD]
    _k32.WaitForMultipleObjects.restype = wintypes.DWORD
    _u32 = ctypes.WinDLL("user32", use_last_error=True)
    _u32.AllowSetForegroundWindow.argtypes = [wintypes.DWORD]
else:  # pragma: no cover - hôte natif réservé à Windows
    _k32 = None
    _u32 = None

_seq = itertools.count(1)

# Tous les hôtes dans un « job » Windows fermé avec le pont : si le pont meurt (ou est
# arrêté net), aucun NovaVSTHost.exe ne reste orphelin.
_job = None
_job_lock = threading.Lock()


def _attach_to_job(proc_handle: int):
    global _job
    if not IS_WINDOWS:
        return
    try:
        with _job_lock:
            if _job is None:
                k = ctypes.windll.kernel32
                k.CreateJobObjectW.restype = wintypes.HANDLE
                job = k.CreateJobObjectW(None, None)

                class _Basic(ctypes.Structure):
                    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                                ("SchedulingClass", wintypes.DWORD)]

                class _Io(ctypes.Structure):
                    _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rt", "wt", "ot")]

                class _Ext(ctypes.Structure):
                    _fields_ = [("Basic", _Basic), ("Io", _Io), ("ProcessMemoryLimit", ctypes.c_size_t),
                                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                                ("PeakJobMemoryUsed", ctypes.c_size_t)]
                info = _Ext()
                info.Basic.LimitFlags = 0x2000          # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                k.SetInformationJobObject(wintypes.HANDLE(job), 9, ctypes.byref(info), ctypes.sizeof(info))
                _job = job
            ctypes.windll.kernel32.AssignProcessToJobObject(wintypes.HANDLE(_job), wintypes.HANDLE(proc_handle))
    except Exception as e:  # noqa: BLE001
        logger.debug(f"job Windows indisponible : {e}")


class _ParamChange(ctypes.Structure):
    _fields_ = [("id", ctypes.c_uint32), ("offset", ctypes.c_int32), ("value", ctypes.c_double)]


class _MidiEvent(ctypes.Structure):
    _fields_ = [("offset", ctypes.c_int32), ("data", ctypes.c_uint8 * 3), ("size", ctypes.c_uint8)]


def _header_type(layout: dict):
    class Header(ctypes.Structure):
        _fields_ = [
            ("magic", ctypes.c_uint32), ("version", ctypes.c_uint32), ("maxFrames", ctypes.c_uint32),
            ("maxChannels", ctypes.c_uint32), ("headerSize", ctypes.c_uint32), ("reserved0", ctypes.c_uint32),
            ("reqSeq", ctypes.c_uint32), ("nframes", ctypes.c_uint32), ("inChannels", ctypes.c_uint32),
            ("keyChannels", ctypes.c_uint32), ("outChannels", ctypes.c_uint32), ("flags", ctypes.c_uint32),
            ("blockSize", ctypes.c_uint32), ("nChanges", ctypes.c_uint32), ("nEvents", ctypes.c_uint32),
            ("sigNum", ctypes.c_int32), ("sigDen", ctypes.c_int32), ("reserved1", ctypes.c_uint32),
            ("projectTimeSamples", ctypes.c_int64), ("tempo", ctypes.c_double),
            ("respSeq", ctypes.c_uint32), ("status", ctypes.c_int32), ("nOutChanges", ctypes.c_uint32),
            ("latency", ctypes.c_int32), ("outFrames", ctypes.c_uint32), ("outChannelsWritten", ctypes.c_uint32),
            ("processUs", ctypes.c_double), ("error", ctypes.c_char * 256),
            ("changes", _ParamChange * int(layout["maxChanges"])),
            ("events", _MidiEvent * int(layout["maxEvents"])),
            ("outChanges", _ParamChange * int(layout["maxOutChanges"])),
        ]
    for f in ("reqSeq", "projectTimeSamples", "tempo", "respSeq", "processUs", "error", "changes", "events", "outChanges"):
        if getattr(Header, f).offset != int(layout[f]):
            raise HostError(f"Zone audio incompatible ({f} : {getattr(Header, f).offset} ≠ {layout[f]})")
    if ctypes.sizeof(Header) != int(layout["header"]):
        raise HostError("Zone audio incompatible (taille de l'en-tête)")
    return Header


# Réglages à l'échantillon près : bloc coupé aux changements (défaut), ou seulement le décalage
# IParameterChanges (NOVA_VST_SPLIT_AT_CHANGES=0 : moins d'appels, exact pour les plugins qui
# respectent le décalage, comme FabFilter).
SPLIT_AT_CHANGES = os.environ.get("NOVA_VST_SPLIT_AT_CHANGES", "1") != "0"

FLAG_TRANSPORT = 1
FLAG_PLAYING = 2
FLAG_RESET_FIRST = 4


# ─────────────────────────────────────────────────────────────────────────────
# Processus hôte
# ─────────────────────────────────────────────────────────────────────────────

class HostProcess:
    """NovaVSTHost.exe en mode serve : commandes JSON, événements, zone audio."""

    def __init__(self, exe: Optional[str] = None, priority: Optional[int] = None):
        exe = exe or find_host_exe()
        if not exe:
            raise HostError("NovaVSTHost.exe introuvable")
        flags = (CREATE_NO_WINDOW | (priority if priority is not None else host_priority())) if IS_WINDOWS else 0
        self.proc = subprocess.Popen([exe, "--serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, creationflags=flags)
        self.pid = self.proc.pid
        _attach_to_job(int(self.proc._handle))
        self._ids = itertools.count(1)
        self._pending: Dict[int, list] = {}
        self._lock = threading.Lock()
        self._wlock = threading.Lock()
        self.ready = threading.Event()
        self.info: dict = {}
        self.listeners: List[Callable[[str, dict], None]] = []
        self.dead = False
        self.crash_reason: Optional[str] = None
        self._reader = threading.Thread(target=self._read, name=f"vsthost-{self.pid}", daemon=True)
        self._reader.start()
        if not self.ready.wait(READY_TIMEOUT_S) or self.dead:
            self.kill()
            raise HostError("NovaVSTHost.exe ne démarre pas")
        # Zone audio
        self.layout = self.info["layout"]
        self.Header = _header_type(self.layout)
        n = next(_seq)
        base = f"Local\\NovaVST-{os.getpid()}-{self.pid}-{n}"
        self.shm_name, self.req_name, self.done_name = base, base + "-req", base + "-done"
        self.mm = mmap.mmap(-1, int(self.layout["total"]), tagname=self.shm_name)
        self.req_ev = _k32.CreateEventW(None, False, False, self.req_name)
        self.done_ev = _k32.CreateEventW(None, False, False, self.done_name)
        self.h = self.Header.from_buffer(self.mm)
        self.h.magic = int(self.layout["magic"])
        self.h.version = int(self.layout["version"])
        self.h.maxFrames = int(self.layout["maxFrames"])
        self.h.maxChannels = int(self.layout["maxChannels"])
        self.h.headerSize = int(self.layout["header"])
        mf = int(self.layout["maxFrames"])
        self.max_frames = mf
        self.a_in = np.frombuffer(self.mm, np.float32, int(self.layout["maxChannels"]) * mf, int(self.layout["in"])).reshape(-1, mf)
        self.a_key = np.frombuffer(self.mm, np.float32, int(self.layout["maxKeyChannels"]) * mf, int(self.layout["key"])).reshape(-1, mf)
        self.a_out = np.frombuffer(self.mm, np.float32, int(self.layout["maxChannels"]) * mf, int(self.layout["out"])).reshape(-1, mf)
        ch_dt = np.dtype([("id", "<u4"), ("offset", "<i4"), ("value", "<f8")])
        self.a_changes = np.frombuffer(self.mm, ch_dt, int(self.layout["maxChanges"]), int(self.layout["changes"]))
        self.a_outchanges = np.frombuffer(self.mm, ch_dt, int(self.layout["maxOutChanges"]), int(self.layout["outChanges"]))
        ev_dt = np.dtype([("offset", "<i4"), ("data", "u1", (3,)), ("size", "u1")])
        self.a_events = np.frombuffer(self.mm, ev_dt, int(self.layout["maxEvents"]), int(self.layout["events"]))
        self._handles = (wintypes.HANDLE * 2)(self.done_ev, int(self.proc._handle))
        self.audio_lock = threading.Lock()
        self.request("attach", shm=self.shm_name, req=self.req_name, done=self.done_name,
                     mmcss=os.environ.get("NOVA_VST_MMCSS") == "1")

    # --- lignes JSON ------------------------------------------------------------

    def _read(self):
        stream = self.proc.stdout
        try:
            for raw in iter(stream.readline, b""):
                try:
                    msg = json.loads(raw.decode("utf-8", "replace"))
                except Exception:
                    continue
                ev = msg.get("event")
                if ev is not None:
                    if ev == "ready":
                        self.info = msg
                        self.ready.set()
                    elif ev == "crashed":
                        self.crash_reason = str(msg.get("error") or "plantage")
                    for fn in list(self.listeners):
                        try:
                            fn(ev, msg)
                        except Exception as e:  # noqa: BLE001
                            logger.debug(f"écouteur {ev} : {e}")
                    continue
                rid = msg.get("id")
                with self._lock:
                    slot = self._pending.get(rid)
                if slot is not None:
                    slot[1] = msg
                    slot[0].set()
        finally:
            self.dead = True
            self.ready.set()
            with self._lock:
                for slot in self._pending.values():
                    slot[0].set()

    def alive(self) -> bool:
        return not self.dead and self.proc.poll() is None

    def request(self, cmd: str, timeout: Optional[float] = None, **kw) -> dict:
        timeout = CALL_TIMEOUT_S if timeout is None else timeout
        if not self.alive():
            raise HostCrashed(self.crash_reason or "le processus du plugin s'est arrêté")
        rid = next(self._ids)
        slot = [threading.Event(), None]
        with self._lock:
            self._pending[rid] = slot
        line = json.dumps({"id": rid, "cmd": cmd, **kw}, ensure_ascii=False) + "\n"
        try:
            with self._wlock:
                self.proc.stdin.write(line.encode("utf-8"))
                self.proc.stdin.flush()
        except (OSError, ValueError):
            with self._lock:
                self._pending.pop(rid, None)
            raise HostCrashed(self.crash_reason or "le processus du plugin s'est arrêté")
        try:
            t0 = time.monotonic()
            while not slot[0].wait(0.5):
                if not self.alive():
                    break
                if time.monotonic() - t0 > timeout:
                    raise TimeoutError(f"Le plugin ne répond pas ({cmd})")
        finally:
            with self._lock:
                self._pending.pop(rid, None)
        msg = slot[1]
        if msg is None:
            raise HostCrashed(self.crash_reason or "le processus du plugin s'est arrêté")
        if not msg.get("ok"):
            if msg.get("crashed"):
                self.crash_reason = str(msg.get("error") or "plantage")
                raise HostCrashed(self.crash_reason)
            raise HostError(str(msg.get("error") or f"échec de {cmd}"))
        return msg

    # --- audio ------------------------------------------------------------------

    def run(self, timeout: Optional[float] = None) -> None:
        timeout = PROCESS_TIMEOUT_S if timeout is None else timeout
        """Demande posée dans la zone : l'hôte traite, on attend la fin (ou la mort du processus)."""
        if not self.alive():
            raise HostCrashed(self.crash_reason or "le processus du plugin s'est arrêté")
        h = self.h
        h.reqSeq = (h.reqSeq + 1) & 0xFFFFFFFF
        _k32.SetEvent(self.req_ev)
        ms = int(max(1, timeout * 1000))
        r = _k32.WaitForMultipleObjects(2, self._handles, False, ms)
        if r == 0:
            if h.respSeq != h.reqSeq:
                raise HostError("réponse audio désynchronisée")
            if h.status != 0:
                err = h.error.decode("utf-8", "replace")
                if h.status in (-2, -3):
                    self.crash_reason = err
                    raise HostCrashed(err)
                raise HostError(err)
            return
        if r == 1:
            self.dead = True
            raise HostCrashed(self.crash_reason or "le plugin a planté (processus arrêté)")
        raise TimeoutError("le plugin ne répond plus (bloc audio)")

    def kill(self):
        try:
            if self.proc.poll() is None:
                self.proc.kill()
        except Exception:
            pass
        self.dead = True

    def close(self, timeout: float = 3.0):
        if self.proc.poll() is None:
            try:
                with self._wlock:
                    self.proc.stdin.write(b'{"id":0,"cmd":"quit"}\n')
                    self.proc.stdin.flush()
                self.proc.wait(timeout)
            except Exception:
                pass
        self.kill()
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                stream.close()
            except Exception:
                pass
        for hd in (getattr(self, "req_ev", None), getattr(self, "done_ev", None)):
            if hd:
                try:
                    _k32.CloseHandle(hd)
                except Exception:
                    pass
        self.req_ev = self.done_ev = None


# ─────────────────────────────────────────────────────────────────────────────
# Réglages : poignée « C++ » (comme _AudioProcessorParameter de pedalboard)
# ─────────────────────────────────────────────────────────────────────────────

class NativeCppParam:
    """Un réglage du plugin tel que JUCE l'expose : valeur brute 0–1 (float), textes
    du plugin, pas, unité. raw_value lu dans le cache de l'hôte (aucun aller-retour)."""

    __slots__ = ("_plugin", "index", "host_index", "param_id", "name", "label", "short_name", "flags", "step_count",
                 "default_raw_value", "num_steps", "is_discrete", "is_boolean", "is_automatable",
                 "is_meta_parameter", "is_orientation_inverted", "unit_id")

    def __init__(self, plugin: "NativePlugin", index: int, host_index: int, info: dict):
        self._plugin = plugin
        self.index = index               # place dans la liste de JUCE (pedalboard)
        self.host_index = host_index     # place dans le contrôleur (commandes de l'hôte)
        self.param_id = int(info["id"])
        self.name = str(info.get("title") or "")
        self.label = str(info.get("units") or "")
        self.short_name = str(info.get("short") or "")
        self.flags = int(info.get("flags") or 0)
        self.unit_id = int(info.get("unit") or 0)
        self.step_count = int(info.get("steps") or 0)
        self.default_raw_value = f32(float(info.get("default") or 0.0))
        self.num_steps = DEFAULT_NUM_STEPS if self.step_count == 0 else self.step_count + 1
        # pedalboard 0.9.25 répond « discret » pour presque tous les réglages VST3, continus compris
        # (Pro-C 3, Pro-Q 4, C6, Vital), mais pas toujours d'un chargement à l'autre (valeur non fiable
        # dans sa version de JUCE) : on garde sa réponse dominante.
        self.is_discrete = True
        self.is_boolean = False          # jamais « booléen » pour un VST3 (comme pedalboard)
        self.is_automatable = bool(self.flags & K_CAN_AUTOMATE)
        self.is_meta_parameter = False
        self.is_orientation_inverted = False

    @property
    def raw_value(self) -> float:
        return self._plugin._value(self.host_index)

    @raw_value.setter
    def raw_value(self, v: float):
        self._plugin._set_values([(self.host_index, float(v))])

    @property
    def string_value(self) -> str:
        return self.get_text_for_raw_value(self._plugin._value(self.host_index), 1024)

    def get_name(self, maximum_string_length: int) -> str:
        return self.name

    def get_text_for_raw_value(self, raw_value: float, maximum_string_length: int = 512) -> str:
        v = f32(raw_value)
        ok, text = self._plugin._texts([(self.host_index, v)])[0]
        if not ok:
            text = _fallback_text(v)
        return text[:maximum_string_length]

    def get_raw_value_for_text(self, string_value: str) -> float:
        res = self._plugin._host.request("from_text", index=self.host_index, text=str(string_value))
        if res.get("found"):
            return f32(float(res["value"]))
        return f32(juce_float_of(string_value))

    def __repr__(self):
        return f"<NativeCppParam name={self.name!r} label={self.label!r} raw_value={self.raw_value}>"


def _fallback_text(v: float) -> str:
    for prec in range(1, 10):
        t = f"{v:.{prec}g}"
        if f32(float(t)) == f32(v):
            return t
    return repr(v)


# ─────────────────────────────────────────────────────────────────────────────
# Réglages : enveloppe « Python » (type, plage, valeurs possibles, comme pedalboard)
# ─────────────────────────────────────────────────────────────────────────────

SEARCH_STEPS = 1000


class NativeParameter:
    """Réglage décrit par ses textes sur 1 001 pas (0, 0,001, … 1) : nombre (plage, pas),
    interrupteur (deux textes dont « On »…) ou liste de textes. Mêmes règles que pedalboard,
    donc même lecture des réglages et même valeur posée pour un texte donné."""

    def __init__(self, plugin: "NativePlugin", cpp: NativeCppParam, runs: Sequence[Sequence[Any]]):
        object.__setattr__(self, "_cpp", cpp)
        object.__setattr__(self, "_plugin", plugin)
        ranges = self._ranges_from_runs(runs)
        self.python_name = python_key(cpp.name, cpp.label)
        self._label = None
        self.min_value = None
        self.max_value = None
        self.step_size = None
        self.approximate_step_size = None
        self.type = str
        values = list(ranges.values())
        if values and all(is_number_text(v) for v in values):
            self.type = float
            nums = {k: float(strip_units(v)) for k, v in ranges.items()}
            self.min_value = min(nums.values())
            self.max_value = max(nums.values())
            if not cpp.label:
                self._guess_label(values)
            ordered = sorted(nums.values())
            gaps = {round(abs(b - a), 8) for a, b in zip(ordered, ordered[1:])}
            if len(gaps) == 1:
                self.step_size = next(iter(gaps))
            elif gaps:
                self.approximate_step_size = sum(gaps) / len(gaps)
            ranges = nums
        elif len(ranges) == 2 and TRUE_WORDS & {(v.lower() if isinstance(v, str) else v) for v in values}:
            self.type = bool
            ranges = {k: (v.lower() if isinstance(v, str) else v) in TRUE_WORDS for k, v in ranges.items()}
            self.min_value, self.max_value, self.step_size = False, True, 1
        self.ranges = ranges
        self.valid_values = list(ranges.values())
        self.range = (self.min_value, self.max_value, self.step_size)
        self._value_to_raw_value_ranges = {v: k for k, v in ranges.items()}

    @staticmethod
    def _ranges_from_runs(runs: Sequence[Sequence[Any]]) -> Dict[Tuple[float, float], Any]:
        out: Dict[Tuple[float, float], Any] = {}
        runs = list(runs)
        for i, (x, text) in enumerate(runs):
            start = 0 if i == 0 else int(x) / SEARCH_STEPS
            end = int(runs[i + 1][0]) / SEARCH_STEPS if i + 1 < len(runs) else 1
            out[(start, end)] = text
        return out

    @staticmethod
    def looks_wrong(runs: Sequence[Sequence[Any]]) -> bool:
        """Textes suspects (un seul, ou deux nombres) : relevé « lent » (valeur posée puis lue)."""
        done = len(runs) - 1        # plages fermées pendant le relevé (la dernière reste ouverte)
        if done <= 0:
            return True
        return done == 1 and is_number_text(runs[0][1])

    def _guess_label(self, values: List[str]):
        first = values[0]
        if not isinstance(first, str):
            return
        bare = strip_units(first, si=False)
        if not (bare != first and isinstance(bare, str) and bare in first):
            return
        labels = set()
        for v in values:
            if not isinstance(v, str):
                continue
            b = strip_units(v, si=False)
            if isinstance(b, str):
                labels.add(v.replace(b, "").strip())
        if len(labels) == 1:
            self._label = next(iter(labels))

    @property
    def label(self) -> Optional[str]:
        if self._label:
            return self._label
        return self._cpp.label or None

    @property
    def units(self) -> Optional[str]:
        return self.label

    def get_raw_value_for(self, new_value: Any) -> float:
        cpp = self._cpp
        if self.type is float:
            v = new_value
            if isinstance(new_value, str) and self.label and new_value.endswith(self.label):
                v = new_value[:-len(self.label)]
            try:
                num = float(v)
            except (TypeError, ValueError):
                raise ValueError(f"Value received for parameter '{self.python_name}' ({new_value!r}) must be a number"
                                 + (f" or a string (with the optional suffix '{self.label}')" if self.label else " or a string"))
            if (self.min_value is not None and num < self.min_value) or (self.max_value is not None and num > self.max_value):
                raise ValueError(f"Value received for parameter '{self.python_name}' ({num!r}) is out of range "
                                 f"[{self.min_value}{self.label}, {self.max_value}{self.label}]")
            reported = cpp.get_raw_value_for_text(str(num))
            best = None
            gap = None
            for value, rng in self._value_to_raw_value_ranges.items():
                if not isinstance(value, float):
                    continue
                d = num - value
                if gap is None or abs(d) < abs(gap):
                    best, gap = rng, d
            if best is not None and (reported < best[0] or reported > best[1]):
                return best[0]
            return reported
        if self.type is str:
            if not isinstance(new_value, (str, int, float, bool)):
                raise ValueError(f"Value received for parameter '{self.python_name}' ({new_value!r}) should be a string")
            text = str(new_value)
            if text not in self.valid_values:
                raise ValueError(f"Value received for parameter '{self.python_name}' ({text!r}) not in list of valid "
                                 f"values: {self.valid_values}")
            reported = cpp.get_raw_value_for_text(text)
            lo, hi = self._value_to_raw_value_ranges[text]
            return lo if (reported < lo or reported > hi) else reported
        if self.type is bool:
            if not isinstance(new_value, (bool, np.bool_)):
                raise ValueError(f"Value received for parameter '{self.python_name}' ({new_value!r}) should be a boolean")
            return 1.0 if new_value else 0.0
        raise ValueError(f"Type de réglage inconnu : {self.type}")

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(object.__getattribute__(self, "_cpp"), name)

    def __setattr__(self, name: str, value):
        cpp = self.__dict__.get("_cpp") or object.__getattribute__(self, "_cpp")
        if not name.startswith("_") and name in ("raw_value",):
            setattr(cpp, name, value)
            return
        object.__setattr__(self, name, value)

    def __repr__(self):
        return f"<NativeParameter {self.python_name} type={self.type.__name__} value={self.string_value!r}>"


# ─────────────────────────────────────────────────────────────────────────────
# Plugin (même surface que l'ExternalPlugin de pedalboard)
# ─────────────────────────────────────────────────────────────────────────────

class NativePlugin:
    """Une instance de plugin dans son propre processus NovaVSTHost."""

    _OWN = {"name", "manufacturer_name", "version", "category", "is_instrument", "identifier", "descriptive_name",
            "path", "plugin_name", "offline", "has_shared_container", "on_edit"}

    def __init__(self, path: str, plugin_name: Optional[str] = None, *, cid: Optional[str] = None,
                 host_exe: Optional[str] = None, offline: Optional[bool] = None, priority: Optional[int] = None):
        if not os.path.exists(path):
            raise FileNotFoundError(f"Plugin introuvable : {path}")
        _s = object.__setattr__
        _s(self, "_host", HostProcess(host_exe, priority))
        _s(self, "_lock", threading.RLock())
        try:
            t0 = time.monotonic()
            info = self._host.request("load", timeout=LOAD_TIMEOUT_S, path=path, **{"class": plugin_name or ""},
                                      cid=cid or "")
        except BaseException:
            self._host.close(0.5)
            raise
        _s(self, "load_seconds", time.monotonic() - t0)
        _s(self, "path", path)
        _s(self, "plugin_name", plugin_name)
        _s(self, "name", info.get("name") or os.path.basename(path)[:-5])
        _s(self, "manufacturer_name", info.get("vendor") or "")
        _s(self, "version", info.get("version") or "")
        _s(self, "category", info.get("sub_categories") or "")
        _s(self, "descriptive_name", info.get("name") or "")
        _s(self, "is_instrument", bool(info.get("instrument")))
        _s(self, "identifier", f"VST3-{info.get('name')}-{info.get('class_id')}")
        _s(self, "class_id", info.get("class_id") or "")
        _s(self, "has_shared_container", int(info.get("classes") or 1) > 1)
        _s(self, "buses", info.get("buses") or {})
        _s(self, "offline", (os.environ.get("NOVA_VST_REALTIME_MODE") != "1") if offline is None else bool(offline))
        _s(self, "on_edit", None)
        _s(self, "out_values", {})        # indice (hôte) → dernière valeur renvoyée par le processeur
        _s(self, "_latency", int(info.get("latency") or 0))
        _s(self, "_spec", None)           # (fréquence, bloc, canaux, side-chain) préparés
        _s(self, "_reload_persists", None)  # garde du son après arrêt / redémarrage ? (test fait une fois)
        _s(self, "_provided", 0)          # échantillons fournis depuis la dernière remise à zéro
        _s(self, "_transport", None)
        _s(self, "_editor_open", threading.Event())
        _s(self, "_values_dirty", False)
        _s(self, "_ranges_cache", {})
        _s(self, "_wrapped", None)
        _s(self, "_by_key", None)
        _s(self, "_closed", False)
        self._host.listeners.append(self._on_event)
        self._load_params()
        self._detect_reload_type()

    def _warm_up(self):
        """Instrument : mise en route comme pedalboard (une note jouée jusqu'au son, puis coupée)."""
        try:
            self._host.request("warm_up", timeout=60.0, seconds=10.0)
        except HostError as e:
            logger.debug(f"mise en route : {e}")

    def _detect_reload_type(self):
        """Comme pedalboard au chargement : un effet passe le test « garde-t-il du son après un
        arrêt / redémarrage ? » (44,1 kHz, avant toute préparation réelle) ; s'il en garde, il est
        recréé à neuf tout de suite, puis à chaque remise à zéro. Un instrument est toujours recréé."""
        if self.main_input_channels == 0:
            object.__setattr__(self, "_reload_persists", True)
            self._warm_up()
            return
        try:
            persists = bool(self._host.request("detect_reload").get("persists"))
        except HostError:
            persists = False
        object.__setattr__(self, "_reload_persists", persists)
        if persists:
            res = self._host.request("reinstantiate", timeout=LOAD_TIMEOUT_S)
            object.__setattr__(self, "buses", res.get("buses") or self.buses)
            self._host.request("release")
            self._refresh_values()

    # --- réglages ----------------------------------------------------------------

    def _load_params(self):
        res = self._host.request("params")
        infos = res.get("params") or []
        order = juce_param_order(infos, res.get("units") or [])
        cpp = [NativeCppParam(self, flat, hi, infos[hi]) for flat, hi in enumerate(order)]
        by_host = [None] * len(infos)
        for c in cpp:
            by_host[c.host_index] = c
        object.__setattr__(self, "_cpp", cpp)
        object.__setattr__(self, "_cpp_by_host", by_host)
        object.__setattr__(self, "_values", np.array([f32(p.get("value") or 0.0) for p in infos], dtype=np.float32))
        object.__setattr__(self, "_id_index", {int(p["id"]): i for i, p in enumerate(infos)})
        object.__setattr__(self, "_wrapped", None)
        object.__setattr__(self, "_by_key", None)
        object.__setattr__(self, "_ranges_cache", {})

    def _refresh_values(self):
        res = self._host.request("values")
        vals = res.get("values") or []
        if len(vals) == len(self._cpp):
            object.__setattr__(self, "_values", np.array(vals, dtype=np.float32))
        object.__setattr__(self, "_values_dirty", False)
        if res.get("latency") is not None:
            object.__setattr__(self, "_latency", int(res["latency"]))

    def _value(self, index: int) -> float:
        if self._values_dirty:
            self._refresh_values()
        return float(self._values[index])

    def _set_values(self, items: Sequence[Tuple[int, float]]):
        items = [(int(i), f32(v)) for i, v in items]
        if not items:
            return
        self._host.request("set", items=items)
        for i, v in items:
            self._values[i] = v

    def _texts(self, items: Sequence[Tuple[int, float]]) -> List[Tuple[bool, str]]:
        res = self._host.request("text", items=[[int(i), float(v)] for i, v in items])
        return [(bool(a), str(b)) for a, b in res.get("texts") or []]

    def _on_event(self, ev: str, msg: dict):
        if ev == "edit":
            idx = msg.get("index")
            if isinstance(idx, int) and 0 <= idx < len(self._values):
                self._values[idx] = f32(msg.get("value") or 0.0)
            cb = self.on_edit
            if cb is not None:
                try:
                    cb(msg)
                except Exception:
                    pass
        elif ev == "restart":
            object.__setattr__(self, "_values_dirty", True)
            if msg.get("latency") is not None:
                object.__setattr__(self, "_latency", int(msg["latency"]))
        elif ev == "editor_closed":
            self._editor_open.clear()

    @property
    def _parameters(self) -> List[NativeCppParam]:
        return list(self._cpp)

    def _get_parameter(self, name: str) -> Optional[NativeCppParam]:
        for c in self._cpp:
            if c.name == name:
                return c
        return None

    def ranges_for(self, indices: Sequence[int]) -> Dict[int, list]:
        """Textes relevés sur 1 001 pas (un seul aller-retour pour plusieurs réglages),
        relevé « lent » pour les réglages dont le relevé rapide paraît faux. Indices du contrôleur."""
        todo = [i for i in indices if i not in self._ranges_cache]
        if todo:
            res = self._host.request("ranges", timeout=max(CALL_TIMEOUT_S, 0.05 * len(todo)), indices=todo,
                                     steps=SEARCH_STEPS)
            fast = res.get("ranges") or []
            slow_idx = []
            for i, runs in zip(todo, fast):
                self._ranges_cache[i] = runs
                flags = self._cpp_by_host[i].flags if 0 <= i < len(self._cpp_by_host) else 0
                # Relevé « lent » (valeur posée puis lue) : jamais pour le réglage de programme
                # (il changerait tous les autres ; RUBY2 plante dessus).
                if NativeParameter.looks_wrong(runs) and not flags & K_IS_PROGRAM_CHANGE:
                    slow_idx.append(i)
            if slow_idx:
                res = self._host.request("ranges", timeout=max(CALL_TIMEOUT_S, 0.05 * len(slow_idx)),
                                         indices=slow_idx, steps=SEARCH_STEPS, slow=True)
                for i, runs in zip(slow_idx, res.get("ranges") or []):
                    self._ranges_cache[i] = runs
                object.__setattr__(self, "_values_dirty", True)
        return {i: self._ranges_cache[i] for i in indices}

    def _build_wrapped(self):
        """Réglages par clé, comme plugin.parameters de pedalboard : noms « MIDI CC … » et
        « Pnnn » écartés ; un même nom ne donne qu'un réglage (le premier) ; une clé
        reprise par un autre nom pointe vers le dernier."""
        first_by_title: Dict[str, NativeCppParam] = {}
        order: List[NativeCppParam] = []
        for c in self._cpp:
            if any(r.match(c.name) for r in IGNORED_PARAM_NAMES):
                continue
            order.append(c)
            first_by_title.setdefault(c.name, c)
        need = sorted({first_by_title[c.name].host_index for c in order})
        runs = self.ranges_for(need)
        wrappers: Dict[int, NativeParameter] = {}
        by_key: Dict[str, NativeParameter] = {}
        for c in order:
            owner = first_by_title[c.name]
            w = wrappers.get(owner.host_index)
            if w is None:
                w = wrappers[owner.host_index] = NativeParameter(self, owner, runs[owner.host_index])
            if w.python_name:
                by_key[w.python_name] = w
        object.__setattr__(self, "_wrapped", wrappers)
        object.__setattr__(self, "_by_key", by_key)

    @property
    def parameters(self) -> Dict[str, NativeParameter]:
        with self._lock:
            if self._by_key is None:
                self._build_wrapped()
            return dict(self._by_key)

    def parameter_by_key(self, key: str) -> Optional[NativeParameter]:
        with self._lock:
            if self._by_key is None:
                self._build_wrapped()
            return self._by_key.get(key)

    def key_index(self, key: str) -> int:
        """Indice du contrôleur (hôte) du réglage de clé `key`, -1 s'il n'existe pas."""
        p = self.parameter_by_key(key)
        return p._cpp.host_index if p is not None else -1

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)
        p = self.parameter_by_key(name)
        if p is None:
            raise AttributeError(f"'NativePlugin' n'a pas de réglage « {name} »")
        if p.type is float:
            return float(strip_units(p.string_value))
        if p.type is bool:
            return p.raw_value >= 0.5
        return str(p.string_value)

    def __setattr__(self, name: str, value):
        if not name.startswith("_") and name not in self._OWN:
            p = self.parameter_by_key(name)
            if p is not None:
                p.raw_value = p.get_raw_value_for(value)
                return
        object.__setattr__(self, name, value)

    # --- état ----------------------------------------------------------------------

    @property
    def raw_state(self) -> bytes:
        res = self._host.request("get_state")
        comp = base64.b64decode(res["component"]) if res.get("component") is not None else None
        ctrl = base64.b64decode(res["controller"]) if res.get("controller") is not None else None
        return pack_state(comp, ctrl)

    @raw_state.setter
    def raw_state(self, raw: bytes):
        comp, ctrl = unpack_state(raw)
        self._host.request("set_state",
                           component=base64.b64encode(comp).decode("ascii") if comp is not None else None,
                           controller=base64.b64encode(ctrl).decode("ascii") if ctrl is not None else None)
        self._refresh_values()

    # --- latence, préparation --------------------------------------------------------

    @property
    def reported_latency_samples(self) -> int:
        return int(self._latency)

    @property
    def latency_samples(self) -> int:
        return int(self._latency)

    @property
    def main_input_channels(self) -> int:
        ins = (self.buses or {}).get("in") or []
        return int(ins[0]["channels"]) if ins else 0

    @property
    def has_sidechain(self) -> bool:
        return len((self.buses or {}).get("in") or []) > 1

    @property
    def sidechain_channels(self) -> int:
        """(Contrat vst_sidechain) Canaux du 1er bus d'entrée auxiliaire, 0 s'il n'y en a pas."""
        ins = (self.buses or {}).get("in") or []
        if len(ins) < 2:
            return 0
        return int(ins[1].get("channels") or ins[1].get("default_channels") or 2)

    def set_transport(self, tempo: Optional[float] = None, position_samples: Optional[int] = None,
                      playing: bool = False, sig: Tuple[int, int] = (4, 4)):
        """Transport transmis au plugin à chaque bloc (None : aucun, comme pedalboard)."""
        if tempo is None:
            object.__setattr__(self, "_transport", None)
        else:
            object.__setattr__(self, "_transport", {"tempo": float(tempo), "pos": int(position_samples or 0),
                                                    "playing": bool(playing), "sig": (int(sig[0]), int(sig[1]))})

    def reset(self):
        """Comme pedalboard : le plugin repart à neuf (voix, queues de réverbe, latence relue) au
        traitement suivant. Un plugin qui garde du son après un arrêt / redémarrage (test de
        pedalboard, fait une fois) et tout instrument sont recréés (même classe, état et réglages
        restaurés) ; les autres sont simplement arrêtés."""
        with self._lock:
            if self._reload_persists:
                res = self._host.request("reinstantiate", timeout=LOAD_TIMEOUT_S)
                object.__setattr__(self, "buses", res.get("buses") or self.buses)
                if self.main_input_channels == 0:
                    self._warm_up()
                self._host.request("release")
                self._refresh_values()
                if self._spec is not None:
                    sr, _bs, ch, sc = self._spec
                    object.__setattr__(self, "_spec", (sr, 0, ch, sc))
            elif self._spec is not None:
                self._host.request("release")
                sr, _bs, ch, sc = self._spec
                object.__setattr__(self, "_spec", (sr, 0, ch, sc))
            object.__setattr__(self, "_provided", 0)

    def _prepare(self, sr: float, block: int, channels: int, sidechain: bool = False):
        spec = self._spec
        if (spec is not None and spec[0] == sr and spec[1] >= block and spec[2] == channels and spec[3] == sidechain):
            return
        if spec is not None and spec[2] != channels:
            self._host.request("release")
        res = self._host.request("prepare", sample_rate=float(sr), block=int(block), offline=bool(self.offline),
                                 channels=int(channels), sidechain=bool(sidechain))
        object.__setattr__(self, "buses", res.get("buses") or self.buses)
        # Un plugin peut « accepter » la disposition demandée et rester en mono (shells Waves « Mono ») :
        # on juge sur ce qu'il a retenu.
        if res.get("ok") and (int(res.get("main_in") or 0) not in (0, int(channels))
                              or int(res.get("main_out") or 0) != int(channels)):
            res["ok"] = False
            self._host.request("release")
        if not res.get("ok"):
            object.__setattr__(self, "_spec", None)
            raise ValueError(f"Plugin '{self.name}' does not support {channels}-channel output. (Main bus currently "
                             f"expects {res.get('main_in')} input channels and {res.get('main_out')} output channels.)")
        object.__setattr__(self, "_spec", (sr, int(block), int(channels), bool(sidechain)))
        object.__setattr__(self, "_latency", int(res.get("latency") or 0))

    # --- traitement --------------------------------------------------------------------

    def _map_changes(self, changes: Any) -> List[Tuple[int, int, float]]:
        """(clé pedalboard | index | NativeCppParam, décalage, valeur 0–1) → (ParamID, décalage, valeur)."""
        out = []
        for name, off, value in changes or []:
            if isinstance(name, NativeCppParam):
                hi = name.host_index
            elif isinstance(name, (int, np.integer)):
                hi = self._cpp[int(name)].host_index if 0 <= int(name) < len(self._cpp) else -1
            else:
                hi = self.key_index(str(name))
            if 0 <= hi < len(self._cpp_by_host):
                v = min(1.0, max(0.0, float(value)))
                out.append((self._cpp_by_host[hi].param_id, int(off), v))
                self._values[hi] = f32(v)
        out.sort(key=lambda c: c[1])
        return out

    def _run(self, x: Optional[np.ndarray], n: int, block: int, out_ch: int, key: Optional[np.ndarray] = None,
             changes: Sequence[Tuple[int, int, float]] = (), events: Sequence[Tuple[int, bytes]] = ()) -> np.ndarray:
        """Traite n échantillons (entrée x (nch, n) ou silence pour un instrument), en sous-blocs
        de `block` comptés depuis le début de l'appel (comme pedalboard)."""
        host = self._host
        cap = max(block, (host.max_frames // block) * block) if block <= host.max_frames else host.max_frames
        out = np.zeros((out_ch, n), np.float32)
        ci = ei = 0
        tr = self._transport
        with host.audio_lock:
            h = host.h
            pos = 0
            while pos < n:
                m = min(cap, n - pos)
                if SPLIT_AT_CHANGES:
                    # Le bloc est coupé à chaque réglage posé : le plugin le reçoit au début d'un
                    # appel (décalage 0). Exact même pour les plugins qui ignorent le décalage
                    # (Waves : appliqué au début de leur bloc, jusqu'à 256 échantillons trop tôt),
                    # et même découpe que le pont avec pedalboard (R9) : sorties identiques.
                    j = ci
                    while j < len(changes) and changes[j][1] <= pos:
                        j += 1
                    if j < len(changes) and changes[j][1] < pos + m:
                        m = changes[j][1] - pos
                nin = 0
                if x is not None:
                    nin = x.shape[0]
                    host.a_in[:nin, :m] = x[:, pos:pos + m]
                nkey = 0
                if key is not None:
                    nkey = min(key.shape[0], host.a_key.shape[0])
                    host.a_key[:nkey, :m] = key[:nkey, pos:pos + m]
                k = 0
                while ci < len(changes) and changes[ci][1] < pos + m:
                    if k >= len(host.a_changes):
                        break
                    pid, off, v = changes[ci]
                    host.a_changes[k] = (pid, max(0, off - pos), v)
                    k += 1
                    ci += 1
                e = 0
                while ei < len(events) and events[ei][0] < pos + m:
                    if e >= len(host.a_events):
                        break
                    off, data = events[ei]
                    d = (bytes(data) + b"\x00\x00\x00")[:3]
                    host.a_events[e] = (max(0, off - pos), tuple(d), min(3, len(data)))
                    e += 1
                    ei += 1
                h.nframes = m
                h.inChannels = nin
                h.keyChannels = nkey
                h.outChannels = out_ch
                h.blockSize = block
                h.nChanges = k
                h.nEvents = e
                flags = 0
                if tr is not None:
                    flags |= FLAG_TRANSPORT | (FLAG_PLAYING if tr["playing"] else 0)
                    h.projectTimeSamples = tr["pos"]
                    h.tempo = tr["tempo"]
                    h.sigNum, h.sigDen = tr["sig"]
                h.flags = flags
                host.run()
                wrote = min(int(h.outChannelsWritten), out_ch)
                out[:wrote, pos:pos + m] = host.a_out[:wrote, :m]
                if wrote == 1 and out_ch > 1 and x is None:
                    out[1:, pos:pos + m] = host.a_out[0, :m]
                if h.nOutChanges:
                    # Réglages renvoyés par le processeur (vu-mètres, réduction de gain…) : gardés à
                    # part (out_values) ; raw_value garde la valeur posée, comme pedalboard.
                    oc = host.a_outchanges[:int(h.nOutChanges)]
                    for pid, _off, v in oc:
                        idx = self._id_index.get(int(pid))
                        if idx is not None:
                            self.out_values[idx] = float(v)
                object.__setattr__(self, "_latency", int(h.latency))
                object.__setattr__(self, "last_process_us", float(h.processUs))
                if tr is not None:
                    tr["pos"] += m
                pos += m
        return out

    def process(self, input_array: np.ndarray, sample_rate: float, buffer_size: int = 8192, reset: bool = True,
                *, key: Optional[np.ndarray] = None, changes: Any = None) -> np.ndarray:
        """Comme pedalboard : (canaux, n) → (canaux, n - latence restant à retenir) ; le début du
        flux (la latence du plugin) est retenu après une remise à zéro. key : clé de side-chain
        (canaux, n) ; changes : réglages à l'échantillon près [(clé | index, décalage, valeur 0–1)]."""
        x = np.asarray(input_array, dtype=np.float32)
        if x.ndim == 1:
            x = x[None, :]
        nch, n = int(x.shape[0]), int(x.shape[1])
        with self._lock:
            if self.main_input_channels == 0 and nch > 0 and self.is_instrument:
                raise ValueError(f"Plugin '{self.name}' does not accept audio input. It may be an instrument plugin "
                                 "instead of an effect plugin.")
            if reset:
                self.reset()
            if n == 0:
                return np.zeros((nch, 0), np.float32)
            bs = int(min(int(buffer_size), n))
            sidechain = key is not None and self.has_sidechain
            if self._spec is not None and self._spec[3] and not sidechain:
                sidechain = True          # bus de side-chain gardé (clé muette) : pas de remise à zéro
            self._prepare(float(sample_rate), bs, nch, sidechain)
            k = None
            if key is not None and sidechain:
                k = np.asarray(key, dtype=np.float32)
                if k.ndim == 1:
                    k = k[None, :]
                if k.shape[1] < n:
                    k = np.concatenate([k, np.zeros((k.shape[0], n - k.shape[1]), np.float32)], axis=1)
            out = self._run(np.ascontiguousarray(x), n, bs, nch, key=k, changes=self._map_changes(changes))
            before = self._provided
            object.__setattr__(self, "_provided", before + n)
            drop = max(0, min(n, int(self._latency) - before))
            return out[:, drop:] if drop else out

    def process_keyed(self, main: np.ndarray, key: Optional[np.ndarray], changes: Any = None,
                      sample_rate: Optional[float] = None, buffer_size: int = 128) -> np.ndarray:
        """(Contrat vst_sidechain) main (2, n) + clé (2, n) sur le bus side-chain, réglages
        [(clé | index | poignée, décalage, valeur 0–1)] par IParameterChanges ; sortie de même
        longueur, latence du plugin NON retenue (le flux continue celui de process())."""
        x = np.asarray(main, dtype=np.float32)
        n = int(x.shape[1])
        with self._lock:
            sr = float(sample_rate or (self._spec[0] if self._spec else 48000.0))
            bs = int(min(int(buffer_size), max(1, n)))
            self._prepare(sr, bs, int(x.shape[0]), self.has_sidechain)
            k = None
            if key is not None and self.has_sidechain:
                k = np.asarray(key, dtype=np.float32)
                if k.ndim == 1:
                    k = k[None, :]
            out = self._run(np.ascontiguousarray(x), n, bs, int(x.shape[0]), key=k, changes=self._map_changes(changes))
            object.__setattr__(self, "_provided", self._provided + n)
            return out

    def render_midi(self, midi_messages: Any, duration: float, sample_rate: float, num_channels: int = 2,
                    buffer_size: int = 8192, reset: bool = True, *, changes: Any = None) -> np.ndarray:
        """Instrument : notes → audio (comme le rendu MIDI de pedalboard : durée × fréquence en
        float32 tronquée, sous-blocs de buffer_size depuis le début, sans retenue de latence)."""
        with self._lock:
            n = int(np.float32(duration) * np.float32(sample_rate))
            if reset:
                self.reset()
            self._prepare(float(sample_rate), int(buffer_size), int(num_channels), False)
            if not self.is_instrument:
                raise ValueError(f"Plugin '{self.name}' expects audio as input, but was provided MIDI messages.")
            outs = (self.buses or {}).get("out") or []
            main_out = int(outs[0]["channels"]) if outs else 0
            if main_out != int(num_channels):
                raise ValueError(f"Plugin '{self.name}' produces {main_out}-channel output, but {num_channels} "
                                 "channels of output were requested.")
            if n <= 0:
                return np.zeros((int(num_channels), 0), np.float32)
            events = midi_to_samples(midi_messages, sample_rate)
            return self._run(None, n, int(buffer_size), int(num_channels), events=events,
                             changes=self._map_changes(changes))

    def __call__(self, *args, **kwargs):
        first = args[0] if args else kwargs.get("input_array", kwargs.get("midi_messages"))
        if isinstance(first, np.ndarray) and first.dtype != object and "duration" not in kwargs:
            return self.process(*args, **kwargs)
        if "midi_messages" in kwargs:
            kwargs = dict(kwargs)
            msgs = kwargs.pop("midi_messages")
            return self.render_midi(msgs, *args, **kwargs)
        return self.render_midi(*args, **kwargs)

    # --- fenêtre ---------------------------------------------------------------------

    def show_editor(self, close_event: Optional[threading.Event] = None, offscreen: bool = False):
        """Fenêtre du plugin (au premier plan) ; rend la main à sa fermeture ou quand
        close_event est posé (comme pedalboard)."""
        if _u32 is not None and not offscreen:
            try:
                _u32.AllowSetForegroundWindow(self._host.pid)
            except Exception:
                pass
        self._editor_open.set()
        try:
            self._host.request("show_editor", timeout=LOAD_TIMEOUT_S, offscreen=bool(offscreen), title=self.name)
        except BaseException:
            self._editor_open.clear()
            raise
        try:
            while self._editor_open.is_set() and self._host.alive():
                if close_event is not None and close_event.is_set():
                    break
                time.sleep(0.05)
        finally:
            if self._editor_open.is_set() and self._host.alive():
                try:
                    self._host.request("hide_editor")
                except Exception:
                    pass
            self._editor_open.clear()
            object.__setattr__(self, "_values_dirty", True)

    def bring_editor_to_front(self):
        if _u32 is not None:
            try:
                _u32.AllowSetForegroundWindow(self._host.pid)
            except Exception:
                pass
        self._host.request("show_editor", offscreen=False, title=self.name)

    def has_editor(self) -> bool:
        return bool(self._host.request("has_editor").get("has_editor"))

    # --- fin de vie --------------------------------------------------------------------

    @property
    def host_pid(self) -> int:
        return self._host.pid

    def alive(self) -> bool:
        return self._host.alive()

    def close(self):
        if self._closed:
            return
        object.__setattr__(self, "_closed", True)
        try:
            self._host.close()
        except Exception:
            pass

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass

    def __repr__(self):
        return f"<NativePlugin {self.name!r} pid={self._host.pid}>"


def load_plugin(path: str, plugin_name: Optional[str] = None, **kw) -> NativePlugin:
    return NativePlugin(path, plugin_name, **kw)


def load_prepared(path: str, plugin_name: Optional[str], state_b64: Optional[str], sample_rate: int,
                  max_block: int, offline: bool) -> NativePlugin:
    """(Contrat vst_sidechain.load) Instance chargée, état restauré, préparée et remise à zéro."""
    p = NativePlugin(path, plugin_name, offline=offline)
    try:
        if state_b64:
            p.raw_state = base64.b64decode(state_b64)
        p._prepare(float(sample_rate), int(max_block), 2 if p.main_input_channels != 1 else 1, False)
        p.reset()
    except BaseException:
        p.close()
        raise
    return p


def scan_command() -> Optional[List[str]]:
    """Commande de lecture des fabriques (vst_probe) par l'hôte natif."""
    exe = find_host_exe()
    return [exe, "--scan"] if exe else None
