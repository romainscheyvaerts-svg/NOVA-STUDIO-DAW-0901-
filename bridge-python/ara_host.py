#!/usr/bin/env python3
"""
Pont NOVA ↔ hôte ARA2 natif (NovaARAHost.exe, sources dans nova-ara-host/).

pedalboard ne sait pas faire d'ARA : Melodyne y passe le son sans rien faire et
VocAlign rend du silence (il attend une capture et un guide). L'hôte natif
(JUCE + ARA SDK) donne au plugin le clip entier, comme Pro Tools ou Studio One :
analyse immédiate (notes visibles sans lecture), fenêtre du plugin, rendu hors
temps réel, et sauvegarde des retouches (archive ARA) pour rouvrir plus tard.

Un AraHostProcess = un processus NovaARAHost.exe = un plugin + un document ARA
(une session « Ouvrir dans Melodyne » ou « Aligner avec VocAlign »). Lancé caché
(CREATE_NO_WINDOW) ; seule la fenêtre du plugin apparaît, quand on la demande.
"""

import base64
import json
import logging
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import Future
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("NovaBridge.ARA")

EXE_NAME = "NovaARAHost.exe"

# Plugins ARA connus : clé NOVA → (motif du chemin, nom affiché, rôle)
KNOWN = {
    "melodyne": {"match": ("melodyne",), "label": "Melodyne", "kind": "edit"},
    "vocalign": {"match": ("vocalign",), "label": "VocAlign", "kind": "align"},
}


def _candidates() -> List[str]:
    here = os.path.dirname(os.path.abspath(__file__))
    base = getattr(sys, "_MEIPASS", None)
    out = []
    env = os.environ.get("NOVA_ARA_HOST")
    if env:
        out.append(env)
    if base:
        out.append(os.path.join(base, EXE_NAME))
    exe_dir = os.path.dirname(sys.executable)
    out += [
        os.path.join(exe_dir, EXE_NAME),
        os.path.join(exe_dir, "ara", EXE_NAME),
        os.path.join(here, EXE_NAME),
        os.path.join(here, "..", "nova-ara-host", "build", "NovaARAHost_artefacts", "Release", EXE_NAME),
    ]
    return [os.path.normpath(p) for p in out]


def find_host_exe() -> Optional[str]:
    for p in _candidates():
        if os.path.isfile(p):
            return p
    return None


def plugin_kind(path_or_name: str) -> Optional[str]:
    low = (path_or_name or "").lower()
    for key, info in KNOWN.items():
        if any(m in low for m in info["match"]):
            return key
    return None


def find_ara_plugins(plugins: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Melodyne / VocAlign parmi les plugins scannés (le premier trouvé pour chaque)."""
    found: Dict[str, Dict[str, Any]] = {}
    for p in plugins:
        k = plugin_kind((p.get("path") or "") + " " + (p.get("name") or ""))
        if k and k not in found:
            found[k] = {"path": p.get("path"), "name": p.get("name"), "kind": KNOWN[k]["kind"], "label": KNOWN[k]["label"]}
    return found


class AraHostError(RuntimeError):
    pass


class AraHostProcess:
    """Un NovaARAHost.exe piloté en lignes JSON (stdin / stdout)."""

    def __init__(self, exe: Optional[str] = None, on_event: Optional[Callable[[dict], None]] = None):
        self.exe = exe or find_host_exe()
        if not self.exe:
            raise AraHostError("L'hôte ARA (NovaARAHost.exe) n'est pas installé avec Nova Studio")
        self.on_event = on_event
        self._next = 0
        self._pending: Dict[int, Future] = {}
        self._lock = threading.Lock()
        flags = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW
        self.proc = subprocess.Popen([self.exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, creationflags=flags, bufsize=0)
        self.ready = threading.Event()
        self.info: Dict[str, Any] = {}
        self._reader = threading.Thread(target=self._read, name="ara-host", daemon=True)
        self._reader.start()
        if not self.ready.wait(20):
            self.close()
            raise AraHostError("L'hôte ARA ne démarre pas")

    def _read(self):
        f = self.proc.stdout
        for raw in iter(f.readline, b""):
            try:
                msg = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            if "event" in msg:
                if msg["event"] == "ready":
                    self.info = msg
                    self.ready.set()
                elif msg["event"] == "log":
                    logger.info(f"[hôte ARA] {msg.get('message')}")
                if self.on_event:
                    try:
                        self.on_event(msg)
                    except Exception as e:  # pragma: no cover
                        logger.error(f"Évènement ARA : {e}")
                continue
            fut = self._pending.pop(msg.get("id"), None)
            if fut is not None:
                if msg.get("ok"):
                    fut.set_result(msg)
                else:
                    fut.set_exception(AraHostError(msg.get("error") or "Erreur de l'hôte ARA"))
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(AraHostError("L'hôte ARA s'est arrêté"))
        self._pending.clear()

    def alive(self) -> bool:
        return self.proc.poll() is None

    def call(self, cmd: str, timeout: float = 120.0, **kw) -> Dict[str, Any]:
        if not self.alive():
            raise AraHostError("L'hôte ARA s'est arrêté")
        with self._lock:
            self._next += 1
            rid = self._next
            fut: Future = Future()
            self._pending[rid] = fut
            line = json.dumps({"id": rid, "cmd": cmd, **kw}, ensure_ascii=False) + "\n"
            self.proc.stdin.write(line.encode("utf-8"))
            self.proc.stdin.flush()
        return fut.result(timeout=timeout)

    def close(self):
        try:
            if self.alive():
                try:
                    self.call("quit", timeout=5)
                except Exception:
                    pass
                try:
                    self.proc.wait(5)
                except Exception:
                    self.proc.kill()
        finally:
            try:
                self.proc.stdin.close()
            except Exception:
                pass


def notes_summary(notes: List[List[float]]) -> Dict[str, Any]:
    """Notes ARA [fréquence, n° MIDI, volume, début, durée] → résumé (cents d'écart à la note juste)."""
    import math
    devs = []
    for f, _p, _v, _s, d in notes:
        if f and f > 0 and d > 0.05:
            m = 69 + 12 * math.log2(f / 440.0)
            devs.append((m - round(m)) * 100)
    if not devs:
        return {"count": len(notes), "voiced": 0}
    return {"count": len(notes), "voiced": len(devs),
            "mean_abs_cents": sum(abs(x) for x in devs) / len(devs),
            "max_abs_cents": max(abs(x) for x in devs)}


def b64_or_none(s: Optional[str]) -> Optional[bytes]:
    if not s:
        return None
    try:
        return base64.b64decode(s)
    except Exception:
        return None
