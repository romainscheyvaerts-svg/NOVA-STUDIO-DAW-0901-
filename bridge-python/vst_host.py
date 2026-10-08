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
- Pannes (v10)  : un plugin qui lève une exception, sort des NaN en continu ou
                  se fige pendant le traitement passe en « panne » : son slot
                  laisse passer le signal SEC (retardé de sa latence, la piste
                  reste alignée) au lieu de rendre du silence à vie. La sortie
                  de chaque plugin est nettoyée (NaN / infini → 0, ±4 max).
                  CrashGuard : un marqueur disque est posé pendant chaque
                  chargement natif ; s'il reste au démarrage suivant, le pont
                  est mort en chargeant ce plugin. Deux fois : quarantaine.
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
    try:
        return load_plugin(path)
    except ImportError as e:
        # Certains plugins (Slate MetaTune, constaté le 04/10/2026) échouent au
        # tout premier « scan » de la session (vérification de licence trop
        # lente) puis se chargent normalement : un seul nouvel essai.
        if "scan" not in str(e).lower():
            raise
        logger.info(f"Nouvel essai de chargement : {os.path.basename(path)}")
        try:
            return load_plugin(path)
        except ImportError:
            inner = _bundle_binary(path)
            if not inner:
                raise
            # UADx (uaudio_*.vst3, constaté le 04/10/2026) : le dossier du plugin
            # n'est pas « scanné » par pedalboard, son fichier interne se charge.
            logger.info(f"Chargement par le fichier interne : {os.path.basename(path)}")
            return load_plugin(inner)


def _bundle_binary(path: str) -> Optional[str]:
    """Fichier binaire d'un dossier VST3 (Contents\\x86_64-win\\<nom>.vst3), s'il existe."""
    if not os.path.isdir(path):
        return None
    arch = os.path.join(path, "Contents", "x86_64-win")
    named = os.path.join(arch, os.path.basename(path))
    if os.path.isfile(named):
        return named
    try:
        found = [f for f in os.listdir(arch) if f.lower().endswith(".vst3")]
    except OSError:
        return None
    return os.path.join(arch, found[0]) if len(found) == 1 else None


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
    licence modale bloque le chargement : on attend alors jusqu'à 15 min.
    Plugin en quarantaine (il a fait planter le pont) : refusé (PluginQuarantined).
    Un marqueur disque couvre le chargement natif ; il n'est effacé qu'une fois
    le chargement fini (même après un délai dépassé)."""
    guard = CRASH_GUARD
    if guard is not None and guard.is_quarantined(path):
        raise PluginQuarantined(guard.message(path))
    token = guard.begin(path) if guard is not None else None
    w = WATCHER.begin(path, plugin_name, context) if WATCHER is not None else None
    fut = juce.call(prepare_plugin, path, plugin_name, state_b64, sample_rate, block)
    if token is not None:
        fut.add_done_callback(lambda _f: guard.end(token))
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


# ─────────────────────────────────────────────────────────────────────────────
# QUARANTAINE : plugins qui font planter le pont au chargement
# ─────────────────────────────────────────────────────────────────────────────

QUARANTINE_AFTER = 2


class PluginQuarantined(RuntimeError):
    """Plugin qui a fait planter le pont plusieurs fois au chargement."""


def _guard_dir() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "NovaStudio", "crash_guard")


class CrashGuard:
    """Marqueurs de chargement natif + compteur de plantages par plugin.

    begin(path) écrit loading/<id>.json AVANT l'instanciation native, end() l'efface
    après. Un marqueur encore là au démarrage (recover) = le processus est mort
    pendant ce chargement : un plantage de plus pour ce plugin. À partir de
    QUARANTINE_AFTER, le plugin n'est plus chargé (rescan = on réessaie)."""

    def __init__(self, directory: Optional[str] = None):
        self.dir = directory or _guard_dir()
        self.loading_dir = os.path.join(self.dir, "loading")
        self.counts_path = os.path.join(self.dir, "crashes.json")
        self.lock = threading.Lock()
        self.crashes: Dict[str, Dict[str, Any]] = {}
        self._seq = 0
        try:
            with open(self.counts_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self.crashes = {k: v for k, v in data.items() if isinstance(v, dict)}
        except Exception:
            self.crashes = {}

    def _save(self):
        try:
            os.makedirs(self.dir, exist_ok=True)
            tmp = self.counts_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.crashes, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.counts_path)
        except Exception as e:
            logger.debug(f"Compteur de plantages non écrit : {e}")

    def begin(self, path: str) -> Optional[str]:
        with self.lock:
            self._seq += 1
            token = os.path.join(self.loading_dir, f"{os.getpid()}-{self._seq}-{int(time.time() * 1000)}.json")
        try:
            os.makedirs(self.loading_dir, exist_ok=True)
            with open(token, "w", encoding="utf-8") as f:
                json.dump({"path": path, "t": time.time(), "pid": os.getpid()}, f)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            return token
        except Exception as e:
            logger.debug(f"Marqueur de chargement non écrit : {e}")
            return None

    def end(self, token: Optional[str]):
        if not token:
            return
        try:
            os.remove(token)
        except OSError:
            pass

    def recover(self) -> List[str]:
        """(Démarrage) Marqueurs restés = plantages pendant un chargement."""
        crashed: List[str] = []
        try:
            names = os.listdir(self.loading_dir)
        except OSError:
            return crashed
        for n in names:
            fp = os.path.join(self.loading_dir, n)
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    path = str(json.load(f).get("path") or "")
            except Exception:
                path = ""
            try:
                os.remove(fp)
            except OSError:
                pass
            if path:
                crashed.append(path)
        if crashed:
            with self.lock:
                for path in crashed:
                    e = self.crashes.setdefault(path, {"count": 0})
                    e["count"] = int(e.get("count", 0)) + 1
                    e["last"] = time.time()
                self._save()
        return crashed

    def count(self, path: str) -> int:
        return int((self.crashes.get(path) or {}).get("count", 0))

    def is_quarantined(self, path: str) -> bool:
        return self.count(path) >= QUARANTINE_AFTER

    def quarantined(self) -> List[str]:
        return [p for p in self.crashes if self.is_quarantined(p)]

    def message(self, path: str) -> str:
        name = os.path.basename(path.rstrip("\\/"))
        name = name[:-5] if name.lower().endswith(".vst3") else name
        return (f"{name} a fait planter le pont {self.count(path)} fois : désactivé. "
                f"Rescanner les plugins pour réessayer")

    def clear(self):
        with self.lock:
            self.crashes = {}
            self._save()


CRASH_GUARD: Optional[CrashGuard] = None


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



# ─────────────────────────────────────────────────────────────────────────────
# PARAMÈTRES (v7 : valeurs texte)
# ─────────────────────────────────────────────────────────────────────────────

MAX_LISTED_VALUES = 128


def _text_of(p) -> str:
    try:
        return str(p.string_value)
    except Exception:
        return ""


def param_info(key: str, p) -> Dict[str, Any]:
    """Description d'un paramètre pour le DAW (introspection, sans index codé en dur)."""
    raw = float(getattr(p, "raw_value", 0.0))
    info: Dict[str, Any] = {"name": key, "display_name": getattr(p, "name", key),
                            "value": raw if np.isfinite(raw) else 0.0, "text": _text_of(p)}
    for attr in ("label", "units"):
        try:
            v = getattr(p, attr)
            if v:
                info[attr] = str(v)
        except Exception:
            pass
    try:
        steps = int(getattr(p, "num_steps"))
    except Exception:
        steps = 0
    info["num_steps"] = steps
    info["is_boolean"] = _is_bool(p)
    try:
        info["is_discrete"] = bool(getattr(p, "is_discrete"))
    except Exception:
        pass
    try:
        lo, hi, step = p.range
        # JSON strict côté navigateur : pas de -Infinity (niveaux en dB « -inf »).
        fin = lambda x: None if x is None or not np.isfinite(float(x)) else float(x)
        info["range"] = [fin(lo), fin(hi), fin(step)]
    except Exception:
        pass
    if 0 < steps <= MAX_LISTED_VALUES:
        try:
            vv = p.valid_values
            if vv is not None:
                info["values"] = [str(v) for v in vv][:MAX_LISTED_VALUES]
        except Exception:
            pass
    return info


def _is_bool(p) -> bool:
    """Interrupteur : pedalboard n'expose pas toujours is_boolean (Auto-Tune Pro
    « latency_removal », notes de MetaTune) ; la plage (False, True) le trahit."""
    try:
        if bool(getattr(p, "is_boolean", False)) or getattr(p, "type", None) is bool:
            return True
    except Exception:
        pass
    try:
        lo, hi, _ = p.range
        if isinstance(lo, bool) or isinstance(hi, bool):
            return True
    except Exception:
        pass
    try:
        vv = p.valid_values
        return vv is not None and len(vv) == 2 and {str(v) for v in vv} == {"False", "True"}
    except Exception:
        return False


def _bool_from(v) -> Optional[bool]:
    if isinstance(v, bool):
        return v
    t = str(v).strip().lower()
    if t in ("on", "true", "1", "1.0", "yes", "oui", "enabled", "active"):
        return True
    if t in ("off", "false", "0", "0.0", "no", "non", "disabled"):
        return False
    return None


def _norm(x: str) -> str:
    return re.sub(r"[\s_\-]+", "", x.lower())


_NUM = re.compile(r"[-+]?\d+(?:[.,]\d+)?")
_OFF_WORDS = re.compile(r"\b(not|off|disabled|inactive|no)\b|^0$", re.I)


def _first_number(x) -> Optional[float]:
    m = _NUM.search(str(x))
    return float(m.group(0).replace(",", ".")) if m else None


def _valid_strings(p) -> List[str]:
    # num_steps n'est pas fiable : Pro-C 3 annonce 2 147 483 647 crans pour un
    # ratio qui n'accepte que 676 textes (« 2.00:1 »). On lit la liste elle-même.
    try:
        vv = p.valid_values
        return [str(v) for v in vv][:20000] if vv else []
    except Exception:
        return []


def _nearest_valid(vv: List[str], target: float) -> Optional[str]:
    """Liste de valeurs texte (Pro-C 3 : « 2.00:1 » mais pas « 2:1 ») : la valeur
    dont le nombre est le plus proche de la cible, si l'écart reste minime."""
    best, gap = None, None
    nums = [(v, _first_number(v)) for v in vv]
    nums = [(v, n) for v, n in nums if n is not None]
    if not nums:
        return None
    for v, n in nums:
        d = abs(n - target)
        if gap is None or d < gap:
            best, gap = v, d
    span = max(n for _, n in nums) - min(n for _, n in nums)
    return best if gap is not None and gap <= max(0.02 * abs(target), 0.01 * span, 1e-6) else None


def _two_state_choice(vv: List[str], on: bool) -> Optional[str]:
    """Interrupteur à deux libellés (« Not Bypassed » / « Bypassed », « Off » / « On »)."""
    if len(vv) != 2:
        return None
    off = [v for v in vv if _OFF_WORDS.search(v.strip())]
    if len(off) != 1:
        return None
    other = vv[1] if off[0] == vv[0] else vv[0]
    return other if on else off[0]


def _set_from_list(plugin, key: str, p, hit: str):
    try:
        setattr(plugin, key, hit)
    except Exception:
        p.raw_value = float(p.get_raw_value_for(hit))


def apply_param(plugin, key: str, p, it: Dict[str, Any]):
    """Un réglage : text (valeur affichée), real (unité du plugin) ou value (brute 0–1)."""
    if it.get("text") is not None:
        text = str(it["text"])
        if _is_bool(p):
            b = _bool_from(text)
            if b is not None:
                setattr(plugin, key, b)
                return
        try:
            try:
                setattr(plugin, key, float(text))   # « 20 » pour un paramètre numérique
            except ValueError:
                setattr(plugin, key, text)          # « F# », « Minor »
            return
        except Exception as first:
            # Refusé : on cherche dans la liste du plugin (casse, « Off » → « Not Bypassed »,
            # « 2:1 » → « 2.00:1 »).
            vv = _valid_strings(p)
            hit = next((v for v in vv if v == text), None) or next((v for v in vv if _norm(v) == _norm(text)), None)
            if hit is None:
                b = _bool_from(text)
                hit = _two_state_choice(vv, b) if b is not None else None
            if hit is None:
                n = _first_number(text)
                hit = _nearest_valid(vv, n) if n is not None else None
            if hit is None:
                raise first
            _set_from_list(plugin, key, p, hit)
        return
    if it.get("real") is not None:
        try:
            setattr(plugin, key, float(it["real"]))
        except (ValueError, TypeError):
            # Paramètre à liste de textes (« 2.00:1 ») : valeur la plus proche.
            hit = _nearest_valid(_valid_strings(p), float(it["real"]))
            if hit is None:
                raise
            _set_from_list(plugin, key, p, hit)
        return
    if it.get("value") is not None:
        p.raw_value = max(0.0, min(1.0, float(it["value"])))
        return
    raise ValueError("Valeur manquante (text, real ou value)")


def _reprepare(plugin, sample_rate: int, block: int) -> int:
    """(Thread JUCE) Nouvelle préparation (reset=True) : c'est là que le plugin
    publie sa nouvelle latence (mesuré sur Auto-Tune Pro ; un reset() seul la
    fait relire à l'ancienne valeur). Renvoie la latence annoncée."""
    plugin.process(np.zeros((2, block), np.float32), int(sample_rate), buffer_size=block, reset=True)
    return _latency_of(plugin)


OFFLINE = OfflinePool()


BLOCK = 128          # taille du bloc temps réel (quantum Web Audio)
RENDER_BLOCK = 512
OUT_LIMIT = 4.0      # sortie d'un plugin bornée (±12 dB) : un plugin qui s'emballe n'abîme pas le mix
NAN_LIMIT = 8        # blocs NaN / infinis d'affilée avant de déclarer le plugin en panne
HANG_TIMEOUT_S = 2.0 # un bloc qui prend plus que ça : plugin figé


def sanitize(out: np.ndarray) -> bool:
    """Nettoie EN PLACE (NaN / infini → 0, borné à ±OUT_LIMIT). Renvoie True si
    le bloc contenait des valeurs non finies."""
    bad = not bool(np.isfinite(out).all())
    if bad:
        np.nan_to_num(out, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    np.clip(out, -OUT_LIMIT, OUT_LIMIT, out=out)
    return bad


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
        # Panne (v10) : « exception », « nan » ou « hang ». Le slot passe alors
        # le signal sec, retardé de sa latence (ligne à retard _dry_hist).
        self.failed: Optional[str] = None
        self.fail_error: Optional[str] = None
        self.crash_reported = False
        self._nan_blocks = 0
        self._dry_lock = threading.Lock()
        self._dry_hist: Optional[np.ndarray] = None

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

    def mark_failed(self, reason: str, error: str):
        """Panne : à partir de maintenant, signal sec (une seule fois)."""
        if self.failed:
            return
        self.fail_error = str(error)[:300]
        self.failed = reason
        logger.error(f"[{self.name}] en panne ({reason}) : {self.fail_error} : le son passe sans l'effet")

    def dry_block(self, block: np.ndarray) -> np.ndarray:
        """Signal sec retardé de la latence du flux (la piste reste alignée).
        N'utilise PAS self.lock : un thread de traitement figé peut le garder."""
        x = _to_stereo(block)
        n = x.shape[1]
        with self._dry_lock:
            if self._dry_hist is None:
                self._dry_hist = np.zeros((2, self.latency_samples), np.float32)
            buf = np.concatenate([self._dry_hist, x], axis=1)
            self._dry_hist = buf[:, n:]
            out = np.array(buf[:, :n], dtype=np.float32, copy=True)
        np.clip(out, -OUT_LIMIT, OUT_LIMIT, out=out)
        return out

    def process_block(self, block: np.ndarray) -> np.ndarray:
        """block (nch, n) → sortie stéréo (2, n), latence constante.
        Plugin en panne (exception, NaN en continu, figé) : signal sec."""
        n = block.shape[1]
        if self.failed:
            return self.dry_block(block)
        with self.lock:
            plugin = self.plugin
            if plugin is None:
                return np.zeros((2, n), np.float32)
            try:
                out = plugin.process(_to_stereo(block), self.sample_rate, buffer_size=BLOCK, reset=False)
            except Exception as e:
                self.mark_failed("exception", f"{type(e).__name__}: {e}")
                return self.dry_block(block)
            out = np.array(_to_stereo(np.asarray(out, dtype=np.float32)), dtype=np.float32, copy=True)
            if sanitize(out):
                self._nan_blocks += 1
                if self._nan_blocks >= NAN_LIMIT:
                    self.mark_failed("nan", f"{self._nan_blocks} blocs NaN / infinis d'affilée")
                    return self.dry_block(block)
            else:
                self._nan_blocks = 0
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

    def _on_message_thread(self, fn, *args):
        """Lecture / réglage des paramètres sur le thread JUCE (thread « message »).

        Constaté le 04/10/2026 : lire les paramètres d'une instance d'Auto-Tune Pro
        (pedalboard → get_text_for_raw_value) depuis le thread d'un slot PENDANT
        qu'une autre instance se chargeait sur le thread JUCE bloquait tout le pont
        (verrou du plugin contre verrou de l'interpréteur). Tout passe donc par le
        thread JUCE, à la suite des chargements. Exception : une fenêtre de plugin
        ouverte occupe ce thread (et serait fermée) : on travaille alors sur place."""
        if self.juce.editor_slot is not None:
            return fn(*args)
        return self.juce.run_sync(fn, *args, timeout=LOAD_TIMEOUT_S)

    def parameters(self, names: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """Paramètres exposés : clé, nom affiché, valeur brute 0–1 et (v7) valeur
        texte telle que le plugin l'affiche (« F# », « Minor », « 20 »), plage,
        type et, pour les paramètres à choix (≤ 128 crans), la liste des valeurs."""
        return self._on_message_thread(self._parameters_now, names)

    def _parameters_now(self, names: Optional[List[str]]) -> List[Dict[str, Any]]:
        out = []
        with self.lock:
            params = getattr(self.plugin, "parameters", {}) or {}
            wanted = set(names) if names else None
            for key, p in list(params.items())[:256]:
                if wanted is not None and key not in wanted:
                    continue
                try:
                    out.append(param_info(key, p))
                except Exception:
                    pass
        return out

    def set_parameter(self, name: str, value: float):
        def now():
            with self.lock:
                p = (getattr(self.plugin, "parameters", {}) or {}).get(name)
                if p is not None:
                    p.raw_value = float(value)
        self._on_message_thread(now)

    def set_parameters(self, items: List[Dict[str, Any]], probe_latency: Optional[bool] = None) -> Dict[str, Any]:
        """(v7) Réglage groupé, par valeur texte (« F# »), réelle (20.0 ms) ou
        brute (0–1). Chaque réglage est relu : on renvoie la valeur texte
        effectivement prise par le plugin. Si la latence annoncée change (mode
        basse latence d'Auto-Tune…), le plugin est re-préparé et la latence du
        flux repart de zéro."""
        return self._on_message_thread(self._set_parameters_now, items, probe_latency)

    def _set_parameters_now(self, items: List[Dict[str, Any]], probe_latency: Optional[bool]) -> Dict[str, Any]:
        results = []
        with self.lock:
            plugin = self.plugin
            if plugin is None:
                raise RuntimeError("Plugin non chargé sur le pont")
            before = int(self.reported_latency)
            params = getattr(plugin, "parameters", {}) or {}
            for it in items or []:
                name = str(it.get("name") or "")
                p = params.get(name)
                if p is None:
                    results.append({"name": name, "ok": False, "error": "Paramètre inconnu"})
                    continue
                try:
                    apply_param(plugin, name, p, it)
                    results.append({"name": name, "ok": True, "text": _text_of(p), "value": float(p.raw_value)})
                except Exception as e:
                    results.append({"name": name, "ok": False, "error": str(e)[:200], "text": _text_of(p),
                                    "value": float(getattr(p, "raw_value", 0.0))})
            after = _latency_of(plugin)
            if probe_latency is None:
                probe_latency = any("latency" in str(it.get("name") or "").lower() for it in items or [])
            if probe_latency or after != before:
                # Le plugin n'annonce sa nouvelle latence qu'à la préparation suivante
                # (Auto-Tune Pro : 2 670 → 112 éch. en mode Low Latency) : nouvelle
                # préparation, relecture, flux remis à zéro.
                after = _reprepare(plugin, self.sample_rate, BLOCK)
                self.reported_latency = after
                self._fifo = np.zeros((2, 0), dtype=np.float32)
                self.padded_total = 0
        changed = after != before
        return {"results": results, "latency_samples": self.latency_samples, "latency_changed": changed,
                "plugin_latency_before": before, "plugin_latency_after": after}

    def unload(self):
        """Libère l'instance. Ne bloque jamais l'appelant (boucle asyncio) : si le
        verrou est tenu par un traitement figé, la libération part dans un thread
        à part et attend qu'il rende la main."""
        try:
            self.juce.close_editor(self)
        except Exception:
            pass
        if self.failed != "hang" and self.lock.acquire(timeout=0.5):
            try:
                plugin, self.plugin = self.plugin, None
            finally:
                self.lock.release()
            if plugin is not None:
                self.juce.release(plugin)
                plugin = None
            self.executor.shutdown(wait=False)
            return

        def later():
            with self.lock:
                plugin, self.plugin = self.plugin, None
            if plugin is not None:
                self.juce.release(plugin)

        threading.Thread(target=later, name=f"unload-{self.slot_id[:12]}", daemon=True).start()
        self.executor.shutdown(wait=False, cancel_futures=True)


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
