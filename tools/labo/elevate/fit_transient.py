"""Calage du façonneur de transitoires (modele.py) sur les mesures du plugin d'origine.
Usage : python elevate/fit_transient.py [maxfev]   -> elevate/transient_fit.json"""
import json
import os
import sys

import numpy as np
from scipy.optimize import minimize

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import modele  # noqa: E402
from mesure import burst_signal, gain_curve, SR  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate"
FIT = os.path.join(HERE, "transient_fit.json")
C = json.load(open(os.path.join(OUT, "mesures_carto.json"), encoding="utf-8"))
D = json.load(open(os.path.join(OUT, "mesures_durees.json"), encoding="utf-8"))
AD = json.load(open(os.path.join(OUT, "mesures_adaptatif.json"), encoding="utf-8"))


def stim(kind, arg):
    """Reproduit le stimulus d'une mesure -> (x, starts, post_ms)."""
    if kind == "em":
        x, st = burst_signal(1000.0, -20, 300, 500)
        return x, st, 300 + 300
    if kind == "pas":
        x, st = burst_signal(1000.0, -20, 300, 500, base_db=-20 - arg)
        return x, st, 600
    if kind == "gap":
        x, st = burst_signal(1000.0, -20, 300, arg)
        return x, st, 300 + min(arg, 300)
    if kind == "rampe":
        x, st = burst_signal(1000.0, -20, 300, 500)
        for s0 in st:
            nr = int(arg / 1000 * SR)
            x[:, s0:s0 + nr] *= np.linspace(0, 1, nr)
        return x, st, 600
    if kind == "on":
        x, st = burst_signal(1000.0, -20, arg, max(400, arg))
        return x, st, arg + min(max(400, arg), 300)
    if kind == "fond":
        x, st = burst_signal(1000.0, -20, 300, 500, base_db=arg)
        return x, st, 600
    raise ValueError(kind)


CASES = [("em", 100, 100, C["em100"]["1000.0"], 1.0), ("em", 100, 50, C["em50"]["1000.0"], 1.0)]
CASES += [("pas", d, 100, C[f"pas100_{d}"]["1000.0"], 1.0) for d in (1, 2, 3, 6, 10)]
CASES += [("gap", g, 100, C[f"gap100_{g}"]["1000.0"], 0.5) for g in (20, 40, 80, 160, 320)]
CASES += [("rampe", r, 100, C[f"rampe100_{r}"]["1000.0"], 1.0) for r in (5, 20, 60)]
CASES += [("on", o, 100, D[f"on{o}"]["1000.0"], 0.5) for o in (5, 20, 60)]
_STIM = {}


def sim_curve(prm, kind, arg, em, adaptive=0.0):
    key = (kind, arg)
    if key not in _STIM:
        _STIM[key] = stim(kind, arg)
    x, st, post = _STIM[key]
    y = modele.process(x, prm, em=em, adaptive=adaptive)
    return np.array(gain_curve(x, y, 1000.0, st, post_ms=post))


def err(prm, cases=CASES, adaptive=0.0, verbose=False):
    tot = 0.0
    rows = []
    for kind, arg, em, meas, w in cases:
        m = np.array(meas)
        s = sim_curve(prm, kind, arg, em, adaptive)
        n = min(len(m), len(s))
        t = np.arange(n) * 0.5 - 20
        sel = (t > -15) & (t < 160) & (m[:n] > -100) & (s[:n] > -100)
        # écart dans le domaine du surplus linéaire normalisé (même poids pour toutes les emphases)
        A = modele.em_excess(em)
        e = (10 ** (s[:n][sel] / 20) - 10 ** (m[sel] / 20)) / A
        r = float(np.sqrt(np.mean(e ** 2)))
        rows.append((kind, arg, em, round(r, 4), round(float(np.max(np.abs(s[:n][sel] - m[sel]))), 2)))
        tot += w * r ** 2
    if verbose:
        for r in rows:
            print(r)
    return tot


KEYS = [("as_ms", "log", 1, 200), ("rs_ms", "log", 5, 2000), ("d0", "log", 0.05, 20), ("p", "log", 0.2, 4),
        ("q", "log", 0.2, 3), ("wneg", "lin", 0, 1), ("gs_ms", "log", 0.5, 200), ("rf_ms", "log", 0.5, 200)]


def pack(prm):
    return [np.log(prm[k]) if sc == "log" else prm[k] for k, sc, _, _ in KEYS]


def unpack(v, base):
    p = dict(base)
    for (k, sc, lo, hi), x in zip(KEYS, v):
        p[k] = float(np.clip(np.exp(x) if sc == "log" else x, lo, hi))
    return p


if __name__ == "__main__":
    maxfev = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    las = [int(v) for v in sys.argv[2].split(",")] if len(sys.argv) > 2 else [1, 2, 3, 4]
    if len(las) == 1:
        FIT = FIT.replace(".json", f"_la{las[0]}.json")
    base = dict(modele.DEFAULT)
    src = os.path.join(HERE, "transient_fit.json")
    if os.path.exists(src):
        base.update(json.load(open(src)))
    best = None
    for la in las:
        b = dict(base, la=la)
        b.setdefault("gs_ms", 1.0)
        if b["gs_ms"] <= 0:
            b["gs_ms"] = 1.0
        if b["rf_ms"] <= 0:
            b["rf_ms"] = 1.0
        v0 = pack(b)
        r = minimize(lambda v: err(unpack(v, b)), v0, method="Nelder-Mead",
                     options={"maxfev": maxfev, "xatol": 1e-3, "fatol": 1e-6})
        p = unpack(r.x, b)
        print("la", la, "coût", round(r.fun, 5), {k: round(p[k], 4) for k, *_ in KEYS}, flush=True)
        if best is None or r.fun < best[0]:
            best = (r.fun, p)
    json.dump(best[1], open(FIT, "w"), indent=1)
    err(best[1], verbose=True)
