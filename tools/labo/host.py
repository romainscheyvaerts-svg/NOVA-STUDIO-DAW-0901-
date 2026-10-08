"""
Labo de mesure NOVA : hôte VST3 hors ligne, SANS fenêtre.

- charge un plugin VST3 avec pedalboard, sans jamais ouvrir son éditeur ;
- surveille les fenêtres visibles créées par NOTRE processus (licence, iLok) :
  si un plugin en ouvre une, on le décharge et on le signale ;
- applique des réglages en texte (valeurs affichées du plugin), comme le pont
  (bridge-python/vst_host.apply_param) ;
- traite un signal (2, n) hors ligne.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import re
import time
from typing import Any, Dict, List, Optional

import numpy as np
from pedalboard import load_plugin

VST3_DIR = r"C:\Program Files\Common Files\VST3"

# ── Fenêtres visibles du processus ─────────────────────────────────────────
_user32 = ctypes.windll.user32
_EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def visible_windows() -> List[str]:
    """Titres des fenêtres visibles de premier niveau appartenant à ce processus."""
    pid = os.getpid()
    out: List[str] = []

    def cb(hwnd, _lp):
        p = wt.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and _user32.IsWindowVisible(hwnd):
            n = _user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            _user32.GetWindowTextW(hwnd, buf, n + 1)
            out.append(buf.value or "(sans titre)")
        return True

    _user32.EnumWindows(_EnumProc(cb), 0)
    return out


def hide_console():
    """Le labo ne doit jamais afficher de console (règle écran)."""
    try:
        h = ctypes.windll.kernel32.GetConsoleWindow()
        if h:
            _user32.ShowWindow(h, 0)
    except Exception:
        pass


class WindowOpened(RuntimeError):
    pass


def _bundle_binary(path: str) -> Optional[str]:
    arch = os.path.join(path, "Contents", "x86_64-win")
    named = os.path.join(arch, os.path.basename(path))
    if os.path.isfile(named):
        return named
    try:
        found = [f for f in os.listdir(arch) if f.lower().endswith(".vst3")]
    except OSError:
        return None
    return os.path.join(arch, found[0]) if len(found) == 1 else None


def open_plugin(name_or_path: str, plugin_name: Optional[str] = None):
    """Charge un VST3 (nom de dossier ou chemin). Lève WindowOpened si une
    fenêtre visible apparaît pendant le chargement."""
    path = name_or_path if os.path.isabs(name_or_path) else os.path.join(VST3_DIR, name_or_path)
    before = set(visible_windows())
    last = None
    plugin = None
    attempts = []
    if plugin_name:
        attempts.append(lambda: load_plugin(path, plugin_name=plugin_name))
    attempts.append(lambda: load_plugin(path))
    attempts.append(lambda: load_plugin(path))  # 2e essai (licence lente au 1er scan)
    attempts.append(lambda: load_plugin(_bundle_binary(path)))
    for attempt in attempts:
        try:
            plugin = attempt()
            break
        except Exception as e:  # noqa: BLE001
            last = e
    if plugin is None:
        raise RuntimeError(f"Chargement impossible : {last}")
    time.sleep(0.3)
    new = [w for w in visible_windows() if w not in before]
    if new:
        del plugin
        raise WindowOpened(f"fenêtre ouverte par le plugin : {new}")
    return plugin


# ── Paramètres ──────────────────────────────────────────────────────────────
_NUM = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def _first_number(x) -> Optional[float]:
    m = _NUM.search(str(x))
    return float(m.group(0).replace(",", ".")) if m else None


def valid_strings(p) -> List[str]:
    try:
        vv = p.valid_values
        return [str(v) for v in vv][:20000] if vv else []
    except Exception:
        return []


def describe_params(plugin) -> Dict[str, Any]:
    out = {}
    for k, p in plugin.parameters.items():
        d: Dict[str, Any] = {"text": None, "raw": None}
        try:
            d["raw"] = float(p.raw_value)
        except Exception:
            pass
        try:
            d["text"] = str(getattr(plugin, k))
        except Exception:
            pass
        try:
            d["range"] = [p.min_value, p.max_value]
        except Exception:
            d["range"] = None
        try:
            d["label"] = p.label
        except Exception:
            pass
        vv = valid_strings(p)
        d["n_valid"] = len(vv)
        if vv:
            d["valid_sample"] = vv[:6] + (["…"] + vv[-6:] if len(vv) > 12 else vv[6:12])
        out[k] = d
    return out


def set_param(plugin, key: str, value):
    """Réglage par valeur affichée (nombre ou texte) ; à défaut, valeur la plus
    proche dans la liste du plugin ; {'raw': x} règle la valeur brute 0–1."""
    p = plugin.parameters[key]
    if isinstance(value, dict) and "raw" in value:
        p.raw_value = float(value["raw"])
        return str(getattr(plugin, key))
    try:
        setattr(plugin, key, value)
        return str(getattr(plugin, key))
    except Exception as first:
        vv = valid_strings(p)
        hit = next((v for v in vv if v == str(value)), None)
        if hit is None:
            t = float(value) if isinstance(value, (int, float)) else _first_number(value)
            if t is not None:
                nums = [(v, _first_number(v)) for v in vv]
                nums = [(v, n) for v, n in nums if n is not None]
                if nums:
                    hit = min(nums, key=lambda vn: abs(vn[1] - t))[0]
        if hit is None:
            raise first
        try:
            setattr(plugin, key, hit)
        except Exception:
            p.raw_value = float(p.get_raw_value_for(hit))
        return str(getattr(plugin, key))


def set_params(plugin, params: Dict[str, Any]) -> Dict[str, str]:
    return {k: set_param(plugin, k, v) for k, v in params.items()}


def latency_of(plugin) -> int:
    try:
        return int(plugin.reported_latency_samples)  # type: ignore[attr-defined]
    except Exception:
        return 0


def process(plugin, x: np.ndarray, sr: int, block: int = 512, reset: bool = True) -> np.ndarray:
    """x : (n,) ou (2, n) -> (2, n) float64. pedalboard compense déjà la latence
    annoncée par le plugin (sortie alignée sur l'entrée)."""
    if x.ndim == 1:
        x = np.vstack([x, x])
    x = np.ascontiguousarray(x, dtype=np.float32)
    y = plugin.process(x, float(sr), buffer_size=block, reset=reset)
    y = np.asarray(y, dtype=np.float64)
    if y.shape[0] == 1:
        y = np.vstack([y[0], y[0]])
    return y
