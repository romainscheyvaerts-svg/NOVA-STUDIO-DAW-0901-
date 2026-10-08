"""Calage global du façonneur de transitoires (détecteur fin, modele.py) par évolution différentielle
parallèle : courbes synthétiques + vraie batterie + vrai mix. Puis l'adaptatif.
Usage : python elevate/fit3.py base|adapt [generations] [workers]   -> elevate/transient_fit.json"""
import json
import os
import sys

import numpy as np
from scipy.optimize import differential_evolution

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import modele  # noqa: E402
import fit_transient as ft  # noqa: E402
import fit_transient2 as f2  # noqa: E402

FIT = os.path.join(HERE, "transient_fit.json")

BASE = [("la_ms", -2, 12, "lin"), ("af_ms", 0.05, 5, "log"), ("rf_ms", 0.3, 60, "log"), ("as_ms", 0.3, 60, "log"),
        ("rs_ms", 10, 3000, "log"), ("d0", 0.1, 12, "log"), ("p", 0.3, 4, "log"), ("hold_ms", 0, 20, "lin"),
        ("gs_ms", 3, 80, "log"), ("q", 0.3, 2, "log"), ("wneg", 0, 1, "lin")]
ADAPT = [("ad_k", 0.01, 30, "log"), ("ad_p", 0.3, 6, "log"), ("ad_bg", 0, 1.5, "lin"), ("ad_lt_ms", 10, 5000, "log"),
         ("ad_sens", 0, 20, "lin")]
SYN = [c for c in ft.CASES if not (c[0] == "on" and c[1] == 5)]


def load_base():
    b = dict(modele.DEFAULT)
    if os.path.exists(FIT):
        try:
            b.update(json.load(open(FIT)))
        except Exception:
            pass
    return b


def to_prm(v, keys, base):
    p = dict(base)
    for (k, lo, hi, sc), x in zip(keys, v):
        p[k] = float(np.exp(x)) if sc == "log" else float(x)
    return p


def bounds(keys):
    return [(np.log(lo), np.log(hi)) if sc == "log" else (lo, hi) for _, lo, hi, sc in keys]


def cost_base(prm, verbose=False):
    c = ft.err(prm, cases=SYN, verbose=verbose)
    r1, d1 = f2.real_err(prm, "t100", "batterie", 100)
    r2, d2 = f2.real_err(prm, "t100", "mix", 100)
    r3, d3 = f2.real_err(prm, "t27", "batterie", 27)
    r4, d4 = f2.real_err(prm, "t27", "mix", 27)
    if verbose:
        print("synth", round(c, 4), "réel (normalisé / dB rms court terme) :", [(round(a, 4), round(b, 2)) for a, b in ((r1, d1), (r2, d2), (r3, d3), (r4, d4))], flush=True)
    return c + 4 * (r1 + r2) + (r3 + r4)


def cost_adapt(prm, verbose=False):
    return f2.cost_adapt(prm, verbose)


_BASE = None
_KEYS = None
_CF = None


def obj(v):
    try:
        return _CF(to_prm(v, _KEYS, _BASE))
    except Exception:
        return 1e9


def init(base, keys, step):
    global _BASE, _KEYS, _CF
    _BASE, _KEYS = base, keys
    _CF = cost_base if step == "base" else cost_adapt


if __name__ == "__main__":
    step = sys.argv[1]
    gens = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 16
    base = load_base()
    keys = BASE if step == "base" else ADAPT
    init(base, keys, step)
    from multiprocessing import Pool
    x0 = [np.log(min(max(base[k], lo), hi)) if sc == "log" else min(max(base[k], lo), hi) for k, lo, hi, sc in keys]
    with Pool(workers, initializer=init, initargs=(base, keys, step)) as pool:
        def cb(xk, convergence=None):
            # meilleur point de chaque génération, sauvegardé (le calage peut être arrêté à tout moment)
            json.dump(to_prm(xk, keys, base), open(FIT.replace(".json", f"_{step}_encours.json"), "w"), indent=1)
        r = differential_evolution(obj, bounds(keys), maxiter=gens, popsize=12, tol=1e-4, mutation=(0.5, 1.0),
                                   recombination=0.7, seed=3, x0=x0, workers=pool.map, updating="deferred", polish=False,
                                   disp=True, callback=cb)
    best = to_prm(r.x, keys, base)
    print("fin", round(r.fun, 5), {k: round(best[k], 4) for k, *_ in keys}, flush=True)
    (cost_base if step == "base" else cost_adapt)(best, True)
    json.dump(best, open(FIT, "w"), indent=1)
