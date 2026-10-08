"""2e passe du calage du façonneur de transitoires : mesures synthétiques + VRAIE batterie et VRAI mix
(emphase court terme de l'original, fenêtres de 2 ms), puis l'adaptatif.
Usage : python elevate/fit_transient2.py <etape> [maxfev] [la]
  etape = base   : forme de l'emphase (sans adaptatif)
  etape = adapt  : paramètres de l'adaptatif
Lit/écrit elevate/transient_fit.json"""
import json
import os
import sys

import numpy as np
from scipy.optimize import minimize

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import modele  # noqa: E402
import fit_transient as ft  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate"
AUD = os.path.join(OUT, "audio_vst")
FIT = os.path.join(HERE, "transient_fit.json")
C = ft.C
AD = ft.AD

REAL = {}
for name in ("batterie", "mix"):
    x = np.load(os.path.join(AUD, f"in_{name}.npy")).astype(np.float64)
    REAL[name] = {"x": x}
    for tag in ("t100", "t27", "t100a50", "t50a100", "t27a50r"):
        fn = os.path.join(AUD, f"{tag}_{name}.npy")
        if os.path.exists(fn):
            REAL[name][tag] = np.load(fn).astype(np.float64)


def st(y, w=96):
    n = (y.shape[1] // w) * w
    return 10 * np.log10(np.mean(y[:, :n].reshape(2, -1, w) ** 2, axis=(0, 2)) + 1e-12)


def real_err(prm, tag, name, em, adaptive=0.0, bands=None):
    R = REAL[name]
    x, yv = R["x"], R[tag]
    yn = modele.process(x, prm, em=em, bands=bands, adaptive=adaptive)
    gx, gv, gn = st(x), st(yv), st(yn)
    sel = gx > -55
    d = (gn - gv)[sel]
    A = modele.em_excess(em)
    # écart normalisé par l'emphase max (comme les courbes synthétiques), + écart de niveau global
    lin = (10 ** ((gn - gx)[sel] / 20) - 10 ** ((gv - gx)[sel] / 20)) / A
    lev = (np.std(yn) / np.std(yv) - 1) / A
    return float(np.mean(lin ** 2) + 4 * lev ** 2), float(np.sqrt(np.mean(d ** 2)))


AD_CASES = [("em", 100, 100, C[f"ad100_{a}"]["1000.0"], 1.0, a) for a in (25, 50, 75, 100)]
AD_FOND = [("fond", -30, 50, AD[f"ad{a}_fond"]["1000.0"], 1.0, a) for a in (0, 50, 100)]


def cost_base(prm, verbose=False):
    c = ft.err(prm)
    r1, d1 = real_err(prm, "t100", "batterie", 100)
    r2, d2 = real_err(prm, "t100", "mix", 100)
    r3, d3 = real_err(prm, "t27", "batterie", 27)
    tot = c + 3 * (r1 + r2) + r3
    if verbose:
        print("synth", round(c, 4), "batterie", round(r1, 4), round(d1, 2), "dB", "mix", round(r2, 4), round(d2, 2), "dB", "b27", round(r3, 4), round(d3, 2))
    return tot


def cost_adapt(prm, verbose=False):
    tot = 0.0
    for kind, arg, em, meas, w, a in AD_CASES + AD_FOND:
        tot += w * ft.err(prm, cases=[(kind, arg, em, meas, 1.0)], adaptive=a)
    r1, d1 = real_err(prm, "t100a50", "batterie", 100, 50)
    r2, d2 = real_err(prm, "t100a50", "mix", 100, 50)
    r3, d3 = real_err(prm, "t50a100", "batterie", 50, 100)
    r4, d4 = real_err(prm, "t50a100", "mix", 50, 100)
    from bancs import elevate as banc
    rb = banc.romain_band_transient()
    r5, d5 = real_err(prm, "t27a50r", "batterie", 27, 50, rb)
    r6, d6 = real_err(prm, "t27a50r", "mix", 27, 50, rb)
    tot += 2 * (r1 + r2 + r3 + r4) + 2 * (r5 + r6)
    if verbose:
        print("adapt", round(tot, 4), "dB rms :", round(d1, 2), round(d2, 2), round(d3, 2), round(d4, 2), "Romain :", round(d5, 2), round(d6, 2))
    return tot


BASE_KEYS = [("as_ms", "log", 1, 300), ("rs_ms", "log", 5, 3000), ("d0", "log", 0.05, 30), ("p", "log", 0.2, 4),
             ("q", "log", 0.1, 3), ("wneg", "lin", 0, 1), ("gs_ms", "log", 0.5, 300), ("rf_ms", "log", 0.5, 300),
             ("af_ms", "log", 0.3, 100)]
AD_KEYS = [("ad_k", "log", 0.01, 50), ("ad_p", "log", 0.2, 8), ("ad_bg", "lin", 0, 1.5), ("ad_lt_ms", "log", 10, 5000)]


def pack(prm, keys):
    return [np.log(prm[k]) if sc == "log" else prm[k] for k, sc, _, _ in keys]


def unpack(v, base, keys):
    p = dict(base)
    for (k, sc, lo, hi), x in zip(keys, v):
        p[k] = float(np.clip(np.exp(x) if sc == "log" else x, lo, hi))
    return p


if __name__ == "__main__":
    step = sys.argv[1]
    maxfev = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    base = dict(modele.DEFAULT)
    if os.path.exists(FIT):
        base.update(json.load(open(FIT)))
    out = FIT
    if len(sys.argv) > 3:
        base["la"] = int(sys.argv[3])
        out = FIT.replace(".json", f"_{step}_la{sys.argv[3]}.json")
    for k, sc, lo, hi in BASE_KEYS + AD_KEYS:
        if sc == "log" and base.get(k, 0) <= 0:
            base[k] = max(lo * 2, 1.0)
    keys, cf = (BASE_KEYS, cost_base) if step == "base" else (AD_KEYS, cost_adapt)
    print("départ", round(cf(base, True), 5), flush=True)
    r = minimize(lambda v: cf(unpack(v, base, keys)), pack(base, keys), method="Nelder-Mead",
                 options={"maxfev": maxfev, "xatol": 1e-3, "fatol": 1e-6})
    best = unpack(r.x, base, keys)
    print("fin", round(r.fun, 5), {k: round(best[k], 4) for k, *_ in keys}, flush=True)
    cf(best, True)
    json.dump(best, open(out, "w"), indent=1)
