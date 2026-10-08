"""Calage du limiteur multibande (cœur TypeScript via Node) sur les rendus du plugin d'origine.
Usage : python elevate/fit_limiter.py [maxfev]  -> elevate/limiter_fit.json"""
import json
import os
import sys

import numpy as np
from scipy.optimize import minimize

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nova  # noqa: E402

OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate"
AUD = os.path.join(OUT, "audio_vst")
FIT = os.path.join(HERE, "limiter_fit.json")

# (tag VST, réglages NOVA)
CASES = [
    ("lim_g8_noadapt", dict(limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=0.0, adaptiveSpeed=0.0)),
    ("lim_g8_s5", dict(limitGainDb=8.0, speedMs=5.0, adaptiveGainDb=0.0, adaptiveSpeed=0.0)),
    ("lim_g4_noadapt", dict(limitGainDb=4.0, speedMs=1.0, adaptiveGainDb=0.0, adaptiveSpeed=0.0)),
    ("lim_g8_a6_s0", dict(limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=6.0, adaptiveSpeed=0.0)),
    ("lim_g8_a0_s100", dict(limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=0.0, adaptiveSpeed=100.0)),
    ("lim_romain", dict(limitGainDb=8.0, speedMs=1.0, adaptiveGainDb=6.0, adaptiveSpeed=100.0)),
]
BASE = dict(emphasis=0.0, adaptive=0.0, transientOn=False, limiterOn=True, clipperOn=False, ceilingDb=-0.1, truePeak=True,
            bandTransient=[100.0] * 26, bandGainDb=[0.0] * 26)


def st_db(y, w=480):
    n = (y.shape[1] // w) * w
    return 10 * np.log10(np.mean(y[:, :n].reshape(2, -1, w) ** 2, axis=(0, 2)) + 1e-12)


def evaluate(m, prof, verbose=False):
    tot, rows = 0.0, []
    for name in ("batterie", "mix"):
        x = np.load(os.path.join(AUD, f"in16_{name}.npy")).astype(np.float64)
        for tag, s in CASES:
            yv = np.load(os.path.join(AUD, f"{tag}_{name}.npy")).astype(np.float64)
            yn = m.run(x, dict(BASE, **s), prof)
            a, b = st_db(yv), st_db(yn)
            sel = a > -50
            e = float(np.sqrt(np.mean((a[sel] - b[sel]) ** 2)))
            nd = float(10 * np.log10(np.sum((yv - yn) ** 2) / np.sum(yv ** 2)))
            rows.append((name, tag, round(e, 3), round(float(np.mean(b[sel] - a[sel])), 3), round(nd, 2)))
            tot += e ** 2
            if verbose is None:
                print(name, tag, round(e, 3), flush=True)
    # loi statique (sinus 1 kHz, +8 dB, sans adaptatif) : coude doux de l'original
    V = json.load(open(os.path.join(OUT, "mesures_limiteur.json"), encoding="utf-8"))["statique_g8"]
    t = np.arange(48000) / 48000
    for L, vo in V:
        xs = 10 ** (L / 20) * np.sin(2 * np.pi * 1000 * t)
        ys = m.run(np.vstack([xs, xs]), dict(BASE, **CASES[0][1]), prof)
        no = 20 * np.log10(np.max(np.abs(ys[0, 24000:])))
        rows.append(("statique", L, round(vo, 2), round(float(no), 2)))
        tot += 0.5 * (no - vo) ** 2
    if verbose:
        for r in rows:
            print(r)
    return tot, rows


if __name__ == "__main__":
    maxfev = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    m = nova.MasterTransient()
    prof = {"limThrDb": -3.0, "limRelK": 20.0, "limAdaptExp": 0.5, "limRelRefHz": 1000.0, "limFinRelMs": 30.0, "limKneeDb": 6.0}
    if os.path.exists(FIT):
        prof.update(json.load(open(FIT)))
    keys = ["limThrDb", "limRelK", "limAdaptExp", "limFinRelMs", "limKneeDb"]

    def put(v):
        p = dict(prof)
        p["limThrDb"] = float(v[0])
        p["limRelK"] = float(np.exp(v[1]))
        p["limAdaptExp"] = float(np.clip(v[2], 0, 2))
        p["limFinRelMs"] = float(np.exp(v[3]))
        p["limKneeDb"] = float(np.clip(v[4], 0, 24))
        return p
    prof.setdefault("limKneeDb", 6.0)
    if prof["limKneeDb"] < 1:
        prof["limKneeDb"] = 6.0
    v0 = [prof["limThrDb"], np.log(prof["limRelK"]), prof["limAdaptExp"], np.log(prof["limFinRelMs"]), prof["limKneeDb"]]
    r = minimize(lambda v: evaluate(m, put(v))[0], v0, method="Nelder-Mead",
                 options={"maxfev": maxfev, "initial_simplex": [v0, [v0[0] + 2, v0[1], v0[2], v0[3], v0[4]], [v0[0], v0[1] + 1, v0[2], v0[3], v0[4]], [v0[0], v0[1], v0[2] + 0.4, v0[3], v0[4]], [v0[0], v0[1], v0[2], v0[3] - 1.2, v0[4]], [v0[0] - 3, v0[1], v0[2], v0[3], v0[4] + 4]]})
    best = put(r.x)
    json.dump(best, open(FIT, "w"), indent=1)
    print("limiteur", {k: round(best[k], 4) for k in keys}, "coût", round(r.fun, 4))
    evaluate(m, best, verbose=True)
    m.close()
