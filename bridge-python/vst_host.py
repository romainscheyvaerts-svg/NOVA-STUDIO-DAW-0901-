#!/usr/bin/env python3
"""
Hôte VST3 du pont Nova (pedalboard de Spotify).

- scan_vst3()   : inventaire rapide des plugins installés, SANS les charger
                  (624 plugins sur une machine de studio : les charger tous au
                  démarrage prenait des minutes et pouvait planter le pont).
- Slot          : une instance persistante de plugin, identifiée par l'id du
                  plugin côté DAW. Le traitement temps réel d'un slot passe par
                  un unique thread : les blocs sont traités strictement dans
                  l'ordre d'arrivée, avec reset=False (l'état du plugin –
                  compresseur, réverbe… – continue d'un bloc à l'autre).
- render_offline() : rendu d'un buffer complet (gel / export) sur une instance
                  hors ligne (OfflinePool : gardée et réutilisée, un plugin à
                  fenêtre de licence ne la rouvre pas à chaque rendu), avec une
                  queue de silence pour les réverbes.
- instantiate() : toute création d'instance passe par là, surveillée par
                  license_watch (fenêtre d'activation ramenée au premier plan).
- Instruments   : Slot.render_midi() / render_instrument_offline() rendent des
                  notes (MIDI) en audio, hors temps réel.
- JuceThread    : le seul thread autorisé à préparer / détruire un plugin et à
                  afficher sa fenêtre (contrainte de JUCE).
"""

import base64
import json
import logging
import os
import platform
import queue
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Callable, Dict, List, Optional

import numpy as np

import license_watch

try:
    import pedalboard
    from pedalboard import load_plugin
    HAS_PEDALBOARD = True
except ImportError:  # pragma: no cover - le pont reste joignable, sans VST
    pedalboard = None
    load_plugin = None
    HAS_PEDALBOARD = False

logger = logging.getLogger('NovaBridge.VST')

VST3_PATHS = {
    "Windows": [
        r"C:\Program Files\Common Files\VST3",
        r"C:\Program Files (x86)\Common Files\VST3",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Common\VST3"),
    ],
    "Darwin": [
        "/Library/Audio/Plug-Ins/VST3",
        os.path.expanduser("~/Library/Audio/Plug-Ins/VST3"),
    ],
    "Linux": [
        "/usr/lib/vst3",
        "/usr/local/lib/vst3",
        os.path.expanduser("~/.vst3"),
    ],
}


# ─────────────────────────────────────────────────────────────────────────────
# INVENTAIRE
# ─────────────────────────────────────────────────────────────────────────────

def _read_moduleinfo(bundle: str) -> Optional[dict]:
    """moduleinfo.json (SDK VST 3.7+) : nom, éditeur, CID sans charger le binaire.
    Le fichier contient des virgules finales (JSON5) : on les retire avant parse."""
    path = os.path.join(bundle, "Contents", "Resources", "moduleinfo.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        text = re.sub(r",(\s*[}\]])", r"\1", text)
        return json.loads(text)
    except Exception as e:  # fichier exotique : on retombe sur le nom du dossier
        logger.debug(f"moduleinfo illisible ({bundle}): {e}")
        return None


def _entry_from_bundle(bundle: str, base: str) -> List[Dict[str, Any]]:
    name = os.path.basename(bundle)[:-5]  # sans « .vst3 »
    parent = os.path.dirname(bundle)
    vendor = "" if os.path.normcase(parent) == os.path.normcase(base) else os.path.basename(parent)
    info = _read_moduleinfo(bundle) if os.path.isdir(bundle) else None
    entries: List[Dict[str, Any]] = []
    if info:
        fvendor = (info.get("Factory Info") or {}).get("Vendor") or vendor
        audio_classes = [c for c in (info.get("Classes") or []) if c.get("Category") == "Audio Module Class"]
        for cls in audio_classes:
            subs = [str(s) for s in (cls.get("Sub Categories") or [])]
            is_instr = any(s.lower().startswith("instrument") for s in subs)
            entries.append({
                "name": cls.get("Name") or name,
                "vendor": cls.get("Vendor") or fvendor or "",
                "uid": cls.get("CID") or "",
                "category": "Instrument" if is_instr else "Effect",
                "is_instrument": is_instr,
                "sub_categories": subs,
                "path": bundle,
                # Bundles « shell » (plusieurs plugins) : load_plugin(plugin_name=...)
                "plugin_name": cls.get("Name") if len(audio_classes) > 1 else None,
            })
    if not entries:
        entries.append({
            "name": name, "vendor": vendor, "uid": "", "category": "Effect",
            # Inconnu tant que vst_probe n'a pas lu le plugin (pas de moduleinfo.json)
            "is_instrument": None,
            "sub_categories": [], "path": bundle, "plugin_name": None,
        })
    return entries


def scan_vst3(extra_paths: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Liste les plugins VST3 installés (bundles .vst3), sans les instancier."""
    bases = list(VST3_PATHS.get(platform.system(), []))
    env = os.environ.get("NOVA_VST3_PATHS")
    if env:
        bases += [p for p in env.split(os.pathsep) if p]
    if extra_paths:
        bases += extra_paths
    found: List[Dict[str, Any]] = []
    seen = set()
    for base in bases:
        if not os.path.isdir(base):
            continue
        for root, dirs, files in os.walk(base):
            keep = []
            for d in dirs:
                if d.lower().endswith(".vst3"):
                    for e in _entry_from_bundle(os.path.join(root, d), base):
                        key = (e["name"].lower(), e["vendor"].lower())
                        if key in seen:
                            continue  # même plugin installé à deux endroits
                        seen.add(key)
                        found.append(e)
                else:
                    keep.append(d)
            dirs[:] = keep  # on ne descend jamais dans un bundle
            for f in files:
                if f.lower().endswith(".vst3"):  # ancien format : fichier unique
                    for e in _entry_from_bundle(os.path.join(root, f), base):
                        key = (e["name"].lower(), e["vendor"].lower())
                        if key not in seen:
                            seen.add(key)
                            found.append(e)
    found.sort(key=lambda e: (e["category"] != "Effect", e["name"].lower()))
    for i, e in enumerate(found):
        e["id"] = e["uid"] or f"path:{e['path']}#{e['name']}"
    return found


# ─────────────────────────────────────────────────────────────────────────────
# INSTANCES
# ─────────────────────────────────────────────────────────────────────────────

def _open_plugin(path: str, plugin_name: Optional[str] = None):
    if not HAS_PEDALBOARD:
        raise RuntimeError("pedalboard n'est pas installé")
    if not os.path.exists(path):
        raise FileNotFoundError(f"Plugin introuvable : {path}")
    if plugin_name:
        try:
            return load_plugin(path, plugin_name=plugin_name)
        except Exception:
            pass  # le nom de classe ne correspond pas toujours : on tente sans
    return load_plugin(path)


def _to_stereo(block: np.ndarray) -> np.ndarray:
    """(nch, n) → (2, n) float32 contigu."""
    if block.shape[0] == 1:
        block = np.vstack([block[0], block[0]])
    elif block.shape[0] > 2:
        block = block[:2]
    return np.ascontiguousarray(block, dtype=np.float32)


def _get_state(plugin) -> Optional[str]:
    try:
        raw = plugin.raw_state
        return base64.b64encode(bytes(raw)).decode("ascii") if raw is not None else None
    except Exception as e:
        logger.debug(f"raw_state indisponible : {e}")
        return None


def _set_state(plugin, state_b64: Optional[str]) -> bool:
    if not state_b64:
        return False
    try:
        plugin.raw_state = base64.b64decode(state_b64)
        return True
    except Exception as e:
        logger.warning(f"Restauration d'état refusée par le plugin : {e}")
        return False


def _latency_of(plugin) -> int:
    for attr in ("reported_latency_samples", "latency_samples"):
        try:
            v = getattr(plugin, attr)
            if v is not None:
                return max(0, int(v))
        except Exception:
            pass
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# THREAD JUCE
# ─────────────────────────────────────────────────────────────────────────────
# pedalboard (JUCE) n'autorise qu'UN thread « message » : celui qui a chargé le
# premier plugin. Préparer un plugin (fréquence, taille de bloc), le remettre à
# zéro, le détruire ou afficher sa fenêtre ailleurs lève « must be reloaded on
# the main thread ». Tout ça passe donc par ce thread (le thread principal du
# pont). Le traitement audio lui-même (reset=False, réglages inchangés) tourne
# sans problème dans les threads des slots.

class JuceThread:
    def __init__(self):
        self.jobs: "queue.Queue" = queue.Queue()
        self._editor_close: Optional[threading.Event] = None
        self.editor_slot: Optional["Slot"] = None

    def call(self, fn, *args) -> Future:
        fut: Future = Future()
        self.jobs.put(("job", fn, args, fut))
        # Une fenêtre de plugin ouverte bloque ce thread : on la ferme pour
        # traiter la demande (chargement d'un plugin, rendu au moment d'une sauvegarde…).
        if self._editor_close is not None:
            self._editor_close.set()
        return fut

    def run_sync(self, fn, *args, timeout: float = 120.0):
        return self.call(fn, *args).result(timeout=timeout)

    def open_editor(self, slot: "Slot", on_closed: Callable[[], None]):
        if self._editor_close is not None:
            self._editor_close.set()  # un seul éditeur à la fois
        self.jobs.put(("editor", slot, on_closed, None))

    def close_editor(self, slot: "Slot"):
        if self.editor_slot is slot and self._editor_close is not None:
            self._editor_close.set()

    def release(self, obj):
        """Détruit un plugin sur ce thread (destructeur JUCE)."""
        holder = [obj]
        self.jobs.put(("job", holder.clear, (), None))

    def run_forever(self):
        while True:
            try:
                kind, a, b, fut = self.jobs.get(timeout=0.25)
            except queue.Empty:
                continue
            if kind == "job":
                try:
                    res = a(*b)
                    if fut is not None:
                        fut.set_result(res)
                except BaseException as e:  # noqa: BLE001 - renvoyé à l'appelant
                    if fut is not None:
                        fut.set_exception(e)
                    else:
                        logger.error(f"Tâche JUCE : {e}")
                    if isinstance(e, KeyboardInterrupt):
                        raise
                continue
            slot, on_closed = a, b
            plugin = slot.plugin
            if plugin is None:
                continue
            ev = threading.Event()
            self._editor_close = ev
            self.editor_slot = slot
            threading.Thread(target=bring_to_front, args=(slot.name,), daemon=True).start()
            try:
                logger.info(f"🪟 Fenêtre ouverte : {slot.name}")
                plugin.show_editor(ev)
            except Exception as e:
                logger.error(f"Fenêtre de {slot.name} : {e}")
            finally:
                self._editor_close = None
                self.editor_slot = None
                logger.info(f"🪟 Fenêtre fermée : {slot.name}")
                try:
                    on_closed()
                except Exception as e:
                    logger.error(f"Fermeture de fenêtre : {e}")


def bring_to_front(title_part: str):
    """Best effort (Windows) : la fenêtre du plugin s'ouvrait derrière le navigateur."""
    if platform.system() != "Windows":
        return
    try:
        import ctypes
        import time
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        pid = os.getpid()
        proto = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        for _ in range(30):
            time.sleep(0.1)
            found = []

            def enum_cb(hwnd, _lp):
                owner = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                if owner.value == pid and user32.IsWindowVisible(hwnd):
                    n = user32.GetWindowTextLengthW(hwnd)
                    buf = ctypes.create_unicode_buffer(n + 1)
                    user32.GetWindowTextW(hwnd, buf, n + 1)
                    if buf.value and title_part.lower() in buf.value.lower():
                        found.append(hwnd)
                return True

            user32.EnumWindows(proto(enum_cb), 0)
            if found:
                hwnd = found[-1]
                user32.keybd_event(0x12, 0, 0, 0)       # Alt : autorise SetForegroundWindow
                user32.ShowWindow(hwnd, 9)              # SW_RESTORE
                user32.SetForegroundWindow(hwnd)
                user32.keybd_event(0x12, 0, 2, 0)
                return
    except Exception as e:
        logger.debug(f"Mise au premier plan impossible : {e}")


def prepare_plugin(path: str, plugin_name: Optional[str], state_b64: Optional[str],
                   sample_rate: int, block: int):
    """(Thread JUCE) Charge, restaure l'état, prépare à (fréquence, bloc) puis
    remet à zéro. Après ce reset, pedalboard rend un flux ALIGNÉ sur l'entrée
    en retenant au début l'équivalent de la latence du plugin."""
    plugin = _open_plugin(path, plugin_name)
    restored = _set_state(plugin, state_b64)
    if _is_instrument(plugin):
        # Un instrument refuse l'audio en entrée : on le prépare avec du MIDI vide.
        plugin([], duration=block / float(sample_rate), sample_rate=int(sample_rate), num_channels=2,
               buffer_size=block, reset=False)
    else:
        plugin.process(np.zeros((2, block), np.float32), int(sample_rate), buffer_size=block, reset=False)
    plugin.reset()
    return plugin, restored


def _is_instrument(plugin) -> bool:
    try:
        return bool(getattr(plugin, "is_instrument", False))
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# INSTRUMENTS : notes → audio
# ─────────────────────────────────────────────────────────────────────────────

MAX_RENDER_SECONDS = 20 * 60


def midi_events(notes: List[Dict[str, Any]], duration: float) -> List[tuple]:
    """Notes du DAW → messages MIDI (octets, instant en s) triés pour pedalboard.

    Note : {pitch 0–127, start s, duration s, velocity, channel? 0–15}.
    velocity : 0–1 (flottant, 1 = fort) ; une valeur > 1 est lue en 0–127.
    À instant égal, les fins de note passent avant les débuts (note répétée)."""
    evs = []
    for n in notes or []:
        try:
            pitch = int(n.get("pitch"))
            start = float(n.get("start"))
            length = float(n.get("duration"))
            v = float(n.get("velocity", 0.8))
            ch = int(n.get("channel") or 0) & 0x0F
        except (TypeError, ValueError):
            continue
        if not (0 <= pitch <= 127) or not np.isfinite(start) or not np.isfinite(length) or start >= duration:
            continue
        start = max(0.0, start)
        end = min(duration, start + max(0.005, length))
        vel = int(round(v * 127)) if v <= 1.0 else int(round(v))
        vel = max(1, min(127, vel))
        evs.append((end, 0, bytes([0x80 | ch, pitch, 0])))
        evs.append((start, 1, bytes([0x90 | ch, pitch, vel])))
    evs.sort(key=lambda e: (e[0], e[1]))
    return [(b, t) for t, _, b in evs]


def _panic() -> List[tuple]:
    """All Sound Off + All Notes Off sur les 16 canaux (rendu précédent coupé)."""
    out = []
    for ch in range(16):
        out.append((bytes([0xB0 | ch, 120, 0]), 0.0))
        out.append((bytes([0xB0 | ch, 123, 0]), 0.0))
    return out


def _render_midi_on(plugin, events: List[tuple], duration: float, sr: int, block: int) -> np.ndarray:
    """Rend `duration` s de MIDI sur une instance déjà préparée (reset=False :
    pas de préparation, donc possible hors du thread JUCE, fenêtre ouverte)."""
    lat = _latency_of(plugin)
    n = int(round(duration * sr))
    # Rendu précédent coupé, puis un court silence pour vider les voix.
    plugin(_panic(), duration=0.25, sample_rate=sr, num_channels=2, buffer_size=block, reset=False)
    out = np.asarray(plugin(events, duration=(n + lat) / float(sr), sample_rate=sr, num_channels=2,
                            buffer_size=block, reset=False), np.float32)
    out = _to_stereo(out)[:, lat:lat + n]
    if out.shape[1] < n:
        out = np.concatenate([out, np.zeros((2, n - out.shape[1]), np.float32)], axis=1)
    return np.ascontiguousarray(out)


def render_instrument_offline(juce: "JuceThread", path: str, plugin_name: Optional[str], state_b64: Optional[str],
                              events: List[tuple], duration: float, sample_rate: int,
                              context: Optional[dict] = None) -> np.ndarray:
    """Rendu d'un instrument hors slot (instance hors ligne réutilisée, voir OfflinePool)."""
    sr = int(sample_rate)
    entry = OFFLINE.acquire(juce, path, plugin_name, state_b64, sr, RENDER_BLOCK, context)
    try:
        if not _is_instrument(entry.plugin):
            raise ValueError(f"{getattr(entry.plugin, 'name', 'Ce plugin')} n'est pas un instrument")
        return _render_midi_on(entry.plugin, events, duration, sr, RENDER_BLOCK)
    finally:
        OFFLINE.release(entry)


# ─────────────────────────────────────────────────────────────────────────────
# CRÉATION D'INSTANCE (surveillance des fenêtres de licence)
# ─────────────────────────────────────────────────────────────────────────────

# license_watch.LicenseWatcher posé par le serveur : chaque création d'instance
# est surveillée (fenêtre d'activation ramenée devant le navigateur et signalée).
WATCHER = None
LOAD_TIMEOUT_S = 120.0
LICENSE_WAIT_S = 15 * 60.0   # le temps de saisir un numéro de série, de se connecter…


def instantiate(juce: "JuceThread", path: str, plugin_name: Optional[str], state_b64: Optional[str],
                sample_rate: int, block: int, context: Optional[dict] = None):
    """prepare_plugin sur le thread JUCE, sous surveillance. Une fenêtre de
    licence modale bloque le chargement : on attend alors jusqu'à 15 min."""
    w = WATCHER.begin(path, plugin_name, context) if WATCHER is not None else None
    fut = juce.call(prepare_plugin, path, plugin_name, state_b64, sample_rate, block)
    t0 = time.time()
    try:
        while True:
            try:
                return fut.result(timeout=1.0)
            except FutureTimeout:
                limit = LICENSE_WAIT_S if (w is not None and w.seen) else LOAD_TIMEOUT_S
                if time.time() - t0 > limit:
                    # Fini plus tard (fenêtre fermée) : l'instance orpheline est libérée.
                    fut.add_done_callback(lambda f: juce.release(f.result()[0]) if not f.exception() else None)
                    raise TimeoutError("Le plugin ne répond pas (fenêtre de licence restée ouverte ?)")
    finally:
        if w is not None:
            w.end()


def _restore_and_reset(plugin, state_b64: Optional[str]):
    """(Thread JUCE) État du rendu appliqué, puis remise à zéro (voix, queues)."""
    if state_b64:
        _set_state(plugin, state_b64)
    plugin.reset()


class _OfflineEntry:
    def __init__(self, key):
        self.key = key
        self.plugin = None
        self.default_state: Optional[str] = None
        self.lock = threading.Lock()
        self.last_used = time.time()


class OfflinePool:
    """Instances hors ligne (gel, export, instrument sans slot) gardées et
    réutilisées par (plugin, fréquence) : un plugin à fenêtre de licence ou de
    rappel (« nag ») ne la rouvre plus à chaque rendu. Avant chaque rendu :
    état appliqué puis remise à zéro, sur le thread JUCE. Libérées après 3 min
    sans rendu, au-delà de MAX instances, à la décharge du plugin et quand la
    mémoire du PC est presque pleine."""

    MAX = 4
    IDLE_S = 180.0
    MEMORY_HIGH = 88   # % de mémoire physique utilisée

    def __init__(self):
        self.entries: "OrderedDict[tuple, _OfflineEntry]" = OrderedDict()
        self.lock = threading.Lock()
        self.juce: Optional["JuceThread"] = None

    def acquire(self, juce: "JuceThread", path: str, plugin_name: Optional[str], state_b64: Optional[str],
                sr: int, block: int, context: Optional[dict] = None) -> _OfflineEntry:
        self.juce = juce
        key = (path, plugin_name or "", int(sr), int(block))
        self.reap()
        with self.lock:
            e = self.entries.get(key)
            if e is None:
                e = self.entries[key] = _OfflineEntry(key)
            self.entries.move_to_end(key)
        e.lock.acquire()  # un rendu à la fois par instance
        try:
            if e.plugin is None:
                e.plugin, _ = instantiate(juce, path, plugin_name, None, sr, block, context)
                e.default_state = _get_state(e.plugin)
            # Pas d'état fourni : réglages d'origine (pas ceux du rendu précédent).
            juce.run_sync(_restore_and_reset, e.plugin, state_b64 or e.default_state)
        except BaseException:
            e.lock.release()
            with self.lock:
                if e.plugin is None and self.entries.get(key) is e:
                    del self.entries[key]
            raise
        self._evict_extra()
        return e

    def release(self, e: _OfflineEntry):
        e.last_used = time.time()
        e.lock.release()

    def _drop(self, e: _OfflineEntry):
        plugin, e.plugin = e.plugin, None
        if plugin is not None and self.juce is not None:
            self.juce.release(plugin)

    def _evict_extra(self):
        with self.lock:
            idle = [e for e in self.entries.values() if not e.lock.locked()]
            extra = len(self.entries) - self.MAX
            for e in idle[:max(0, extra)]:
                del self.entries[e.key]
                self._drop(e)

    def reap(self, path: Optional[str] = None):
        """Libère les instances inutilisées (délai, mémoire pleine, plugin déchargé)."""
        now = time.time()
        pressure = license_watch.memory_load() >= self.MEMORY_HIGH
        with self.lock:
            for key, e in list(self.entries.items()):
                if e.lock.locked():
                    continue
                if pressure or (path is not None and key[0] == path) or now - e.last_used > self.IDLE_S:
                    del self.entries[key]
                    self._drop(e)
                    logger.info(f"♻️ Instance hors ligne libérée : {os.path.basename(key[0])}")


OFFLINE = OfflinePool()


BLOCK = 128          # taille du bloc temps réel (quantum Web Audio)
RENDER_BLOCK = 512


class Slot:
    """Une instance de plugin persistante (un effet d'une piste du DAW)."""

    def __init__(self, slot_id: str, path: str, plugin_name: Optional[str], sample_rate: int, juce: JuceThread):
        self.slot_id = slot_id
        self.path = path
        self.plugin_name = plugin_name
        self.sample_rate = int(sample_rate or 48000)
        self.juce = juce
        self.plugin = None
        self.name = os.path.basename(path)[:-5] if path.lower().endswith(".vst3") else path
        self.vendor = ""
        # Un seul thread par slot : ordre strict des blocs et des commandes.
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"slot-{slot_id[:12]}")
        self.lock = threading.Lock()
        self.reported_latency = 0
        # pedalboard retient les premiers échantillons (latence du plugin) : on
        # comble par des zéros en tête pour garder un flux de taille constante.
        # Le total ajouté est la latence réelle du flux.
        self._fifo = np.zeros((2, 0), dtype=np.float32)
        self.padded_total = 0
        self.blocks = 0
        self.owner = None           # connexion de contrôle propriétaire
        self.orphan_since: Optional[float] = None
        self.loaded = threading.Event()
        self.error: Optional[str] = None
        self.is_instrument = False

    @property
    def latency_samples(self) -> int:
        """Retard entre l'entrée et la sortie du flux, en échantillons."""
        return int(max(self.reported_latency, self.padded_total))

    # Les méthodes ci-dessous tournent dans self.executor.

    def load(self, state_b64: Optional[str], context: Optional[dict] = None) -> bool:
        plugin, restored = instantiate(self.juce, self.path, self.plugin_name, state_b64,
                                       self.sample_rate, BLOCK, context)
        self.name = getattr(plugin, "name", None) or self.name
        self.vendor = getattr(plugin, "manufacturer_name", "") or ""
        self.is_instrument = _is_instrument(plugin)
        with self.lock:
            self.plugin = plugin
            self.reported_latency = _latency_of(plugin)
            self._fifo = np.zeros((2, 0), dtype=np.float32)
            self.padded_total = 0
        self.loaded.set()
        return restored

    def process_block(self, block: np.ndarray) -> np.ndarray:
        """block (nch, n) → sortie stéréo (2, n), latence constante."""
        n = block.shape[1]
        with self.lock:
            plugin = self.plugin
            if plugin is None:
                return np.zeros((2, n), np.float32)
            try:
                out = plugin.process(_to_stereo(block), self.sample_rate, buffer_size=BLOCK, reset=False)
            except Exception as e:
                logger.error(f"[{self.name}] erreur de traitement : {e}")
                return np.zeros((2, n), np.float32)
            out = _to_stereo(np.asarray(out, dtype=np.float32))
            fifo = np.concatenate([self._fifo, out], axis=1) if self._fifo.shape[1] else out
            if fifo.shape[1] < n:
                pad = n - fifo.shape[1]
                fifo = np.concatenate([np.zeros((2, pad), np.float32), fifo], axis=1)
                self.padded_total += pad
            self._fifo = fifo[:, n:]
            self.blocks += 1
            return fifo[:, :n]

    def render_midi(self, events: List[tuple], duration: float) -> np.ndarray:
        """Instrument : rendu des notes avec le son réglé dans cette instance
        (fenêtre du plugin ouverte ou non)."""
        with self.lock:
            if self.plugin is None:
                raise RuntimeError("Plugin non chargé sur le pont")
            if not self.is_instrument:
                raise ValueError(f"{self.name} n'est pas un instrument")
            return _render_midi_on(self.plugin, events, duration, self.sample_rate, BLOCK)

    def get_state(self) -> Optional[str]:
        with self.lock:
            return _get_state(self.plugin) if self.plugin is not None else None

    def set_state(self, state_b64: str) -> bool:
        with self.lock:
            return _set_state(self.plugin, state_b64) if self.plugin is not None else False

    def parameters(self) -> List[Dict[str, Any]]:
        out = []
        with self.lock:
            params = getattr(self.plugin, "parameters", {}) or {}
            for key, p in list(params.items())[:256]:
                try:
                    out.append({"name": key, "display_name": getattr(p, "name", key),
                                "value": float(getattr(p, "raw_value", 0.0))})
                except Exception:
                    pass
        return out

    def set_parameter(self, name: str, value: float):
        with self.lock:
            p = (getattr(self.plugin, "parameters", {}) or {}).get(name)
            if p is not None:
                p.raw_value = float(value)

    def unload(self):
        self.juce.close_editor(self)
        with self.lock:
            plugin, self.plugin = self.plugin, None
        if plugin is not None:
            self.juce.release(plugin)
            plugin = None
        self.executor.shutdown(wait=False)


def render_offline(juce: JuceThread, path: str, plugin_name: Optional[str], state_b64: Optional[str],
                   audio: np.ndarray, sample_rate: int, tail_seconds: float,
                   context: Optional[dict] = None) -> np.ndarray:
    """Rendu hors temps réel sur une instance hors ligne réutilisée (l'instance
    temps réel n'est pas perturbée) : buffer complet + queue de silence pour les réverbes.
    La sortie de pedalboard est alignée mais retient au début l'équivalent de
    la latence du plugin : on pousse du silence jusqu'à tout récupérer."""
    sr = int(sample_rate)
    entry = OFFLINE.acquire(juce, path, plugin_name, state_b64, sr, RENDER_BLOCK, context)
    plugin = entry.plugin
    parts = []
    try:
        tail = max(0, int(round(float(tail_seconds or 0) * sr)))
        src = _to_stereo(audio)
        if tail:
            src = np.concatenate([src, np.zeros((2, tail), np.float32)], axis=1)
        total = src.shape[1]
        chunk = 8192
        got = 0
        for start in range(0, total, chunk):
            out = np.asarray(plugin.process(src[:, start:start + chunk], sr, buffer_size=RENDER_BLOCK, reset=False), np.float32)
            if out.shape[-1]:
                parts.append(_to_stereo(out))
                got += out.shape[-1]
        flush = 0
        while got < total and flush < 64:  # au plus ~11 s de latence à vider
            out = np.asarray(plugin.process(np.zeros((2, chunk), np.float32), sr, buffer_size=RENDER_BLOCK, reset=False), np.float32)
            flush += 1
            if out.shape[-1]:
                parts.append(_to_stereo(out))
                got += out.shape[-1]
    finally:
        plugin = None
        OFFLINE.release(entry)
    res = np.concatenate(parts, axis=1) if parts else np.zeros((2, 0), np.float32)
    if res.shape[1] < total:
        res = np.concatenate([res, np.zeros((2, total - res.shape[1]), np.float32)], axis=1)
    return np.ascontiguousarray(res[:, :total])
