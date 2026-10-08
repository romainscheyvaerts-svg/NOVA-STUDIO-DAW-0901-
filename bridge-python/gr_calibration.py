"""
Calage « réduction cible » d'un compresseur VST3 réel (règle de mix de Romain) :
le pont rend la voix HORS LIGNE à travers le plugin (instance hors ligne, sans
fenêtre), mesure la réduction de gain telle que la montrerait un VU-mètre et
cherche par dichotomie la valeur du réglage (seuil, entrée, « Peak
Reduction »…) qui donne la réduction MAX visée (5 dB voix / FET de bus,
2 dB pour l'optique de bus).

Même méthode que utils/grCalibration.ts côté NOVA :
  - réduction estimée sans connaître le plugin : gain court terme sortie /
    entrée (fenêtres de 10 ms, passages audibles), référence = gain des
    passages les moins comprimés (98e centile) ;
  - balistique VU : 2e ordre critique, constante 45 ms (99 % en ~300 ms).
"""
from __future__ import annotations

import math
from typing import Callable, Dict, List, Optional

import numpy as np


def vu_max_gr(trace_db: np.ndarray, step_s: float) -> float:
    tau = 0.045
    sub = max(1, int(math.ceil(step_s / 0.001)))
    dt = step_s / sub
    v = d = mx = 0.0
    for g in np.maximum(np.asarray(trace_db, float), 0.0):
        for _ in range(sub):
            a = (g - v) / (tau * tau) - 2.0 * d / tau
            d += a * dt
            v += d * dt
            if v < 0:
                v = 0.0
                d = 0.0
        if v > mx:
            mx = v
    return float(mx)


def gr_trace_from_io(x: np.ndarray, y: np.ndarray, sr: int):
    """x, y : (n,) ou (2, n). Renvoie (trace dB >= 0 par fenêtre de 10 ms, pas en s)."""
    if x.ndim == 2:
        x = x.mean(axis=0)
    if y.ndim == 2:
        y = y.mean(axis=0)
    w = max(1, int(round(0.01 * sr)))
    n = (min(len(x), len(y)) // w) * w
    if n <= 0:
        return np.zeros(0), 0.01
    ex = np.mean(x[:n].reshape(-1, w).astype(np.float64) ** 2, axis=1)
    ey = np.mean(y[:n].reshape(-1, w).astype(np.float64) ** 2, axis=1)
    ok = ex >= 1e-6   # passages au-dessus de -60 dBFS
    if not ok.any():
        return np.zeros(len(ex)), w / sr
    g = 10.0 * np.log10(np.maximum(ey, 1e-20) / np.maximum(ex, 1e-20))
    ref = float(np.percentile(g[ok], 98))
    trace = np.where(ok, np.maximum(ref - g, 0.0), 0.0)
    return trace, w / sr


def bisect_for_target(measure: Callable[[float], float], lo: float, hi: float, sense: int, target: float,
                      iterations: int = 12, tol: float = 0.1) -> Dict:
    """`measure(v)` = réduction max au VU ; sense = +1 si augmenter v comprime plus."""
    steps: List[Dict] = []

    def meas(v):
        g = float(measure(v))
        steps.append({"value": v, "gr_db": g})
        return g
    little, much = (lo, hi) if sense > 0 else (hi, lo)
    g_much = meas(much)
    if g_much < target - tol:
        return {"value": much, "gr_db": g_much, "reached": False, "why": "son trop faible : même au maximum, la réduction reste sous la cible", "steps": steps}
    g_little = meas(little)
    if g_little > target + tol:
        return {"value": little, "gr_db": g_little, "reached": False, "why": "son trop fort : même au minimum, la réduction dépasse la cible", "steps": steps}
    best = (much, g_much) if abs(g_much - target) < abs(g_little - target) else (little, g_little)
    for _ in range(iterations):
        mid = 0.5 * (little + much)
        g = meas(mid)
        if abs(g - target) < abs(best[1] - target):
            best = (mid, g)
        if abs(g - target) <= tol:
            break
        if g > target:
            much = mid
        else:
            little = mid
    return {"value": best[0], "gr_db": best[1], "reached": abs(best[1] - target) <= 0.25, "steps": steps}


def calibrate_plugin(plugin, apply: Callable[[float], None], audio: np.ndarray, sr: int, lo: float, hi: float,
                     sense: int, target: float, block: int = 512, iterations: int = 12) -> Dict:
    """Instance pedalboard déjà chargée (hors ligne). `apply(v)` règle le paramètre."""
    src = np.ascontiguousarray(audio if audio.ndim == 2 else np.vstack([audio, audio]), dtype=np.float32)

    def measure(v):
        apply(v)
        out = np.asarray(plugin.process(src, float(sr), buffer_size=block, reset=True), np.float32)
        tr, step = gr_trace_from_io(src, out, sr)
        return vu_max_gr(tr, step)
    res = bisect_for_target(measure, lo, hi, sense, target, iterations=iterations)
    apply(res["value"])
    return res
