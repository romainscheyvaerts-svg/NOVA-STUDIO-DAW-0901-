"""Tour 3 : évaluation du limiteur NOVA (cœur TS via Node) sur les mesures de l'original :
loi statique (sinus 1 kHz / 100 Hz), bruit rose (facteur de crête), couplage entre bandes,
et null tests batterie / mix. Usage : python elevate/tour3_eval_lim.py [profil.json]"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nova  # noqa: E402
from tour3_mesure_lim import sine, pink, SR  # noqa: E402

T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"
AUD = r"D:\1 WORK\CONTENU\nova-labo\elevate\audio_vst"
LIM = dict(nova.transient_params(0), limiterOn=True, ceilingDb=-0.1, truePeak=True, transientOn=False)


def lim(gain=8.0, speed=1.0, ad=0.0, asp=0.0):
    return dict(LIM, limitGainDb=gain, speedMs=speed, adaptiveGainDb=ad, adaptiveSpeed=asp)


def null(a, b):
    return float(10 * np.log10(np.sum((a - b) ** 2) / np.sum(a ** 2)))


def evaluate(m, prof=None, real=True, verbose=True, stat_step=2):
    A = json.load(open(os.path.join(T3, "mesures_lim_A.json")))
    C = json.load(open(os.path.join(T3, "mesures_lim_C.json")))["rose"]
    D = json.load(open(os.path.join(T3, "mesures_lim_D.json")))["couplage"]
    out = {}
    # A : statique
    for key, f in (("stat_1000_s1", 1000), ("stat_100_s1", 100)):
        rows = A[key][::stat_step]
        e = []
        for L, gv, _pk in rows:
            x = sine(L, f, 0.8)
            y = m.run(np.vstack([x, x]), lim(), prof)[0]
            gn = 20 * np.log10(np.std(y[-SR // 4:]) / np.std(x[-SR // 4:]))
            e.append(gn - gv)
        out[key] = e
    # C : bruit rose
    pk = pink(int(1.0 * SR))
    e = []
    for Lp, _rms, gv, _pkv in C[::stat_step]:
        x = pk * 10 ** (Lp / 20)
        y = m.run(np.vstack([x, x]), lim(), prof)[0]
        e.append(20 * np.log10(np.std(y[SR // 2:]) / np.std(x[SR // 2:])) - gv)
    out["rose"] = e
    # D : couplage
    for ad in (0.0, 6.0):
        e = []
        for Lb, gbv, gpv in D[f"ad{int(ad)}"][::2]:
            x = sine(Lb, 100, 0.8) + sine(-30.0, 5000, 0.8)
            y = m.run(np.vstack([x, x]), lim(ad=ad), prof)[0][-SR // 4:]
            xp = sine(-30.0, 5000, 0.8)[-SR // 4:]
            xb = sine(Lb, 100, 0.8)[-SR // 4:]
            M = np.vstack([xb, np.roll(xb, 120), xp, np.roll(xp, 3)]).T
            c, *_ = np.linalg.lstsq(M, y, rcond=None)
            gb = 20 * np.log10(np.sqrt(np.sum((M[:, :2] @ c[:2]) ** 2) / np.sum(xb ** 2)))
            gp = 20 * np.log10(np.sqrt(np.sum((M[:, 2:] @ c[2:]) ** 2) / np.sum(xp ** 2)))
            e.append((round(gb - gbv, 2), round(gp - gpv, 2)))
        out[f"coupl_ad{int(ad)}"] = e
    if real:
        for tag, prm in (("lim_g8_noadapt", lim()), ("lim_g8_s5", lim(speed=5.0)), ("lim_g8_a6_s0", lim(ad=6.0)),
                         ("lim_g8_a0_s100", lim(asp=100.0)), ("lim_romain", lim(ad=6.0, asp=100.0))):
            for nm in ("batterie", "mix"):
                x = np.load(os.path.join(AUD, f"in16_{nm}.npy")).astype(np.float64)
                yv = np.load(os.path.join(AUD, f"{tag}_{nm}.npy")).astype(np.float64)
                yn = m.run(x, prm, prof)
                g = float(np.sum(yv * yn) / np.sum(yn * yn))
                out[f"{tag}_{nm}"] = (round(null(yv, yn), 2), round(-20 * np.log10(g), 2))
    if verbose:
        for k, v in out.items():
            if isinstance(v, list) and v and not isinstance(v[0], tuple):
                print(f"{k:22s} max {np.max(np.abs(v)):5.2f}  " + " ".join(f"{u:+.2f}" for u in v))
            else:
                print(f"{k:22s} {v}")
    return out


if __name__ == "__main__":
    import ctypes
    k = ctypes.windll.kernel32
    k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    prof = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else None
    m = nova.MasterTransient()
    evaluate(m, prof)
    m.close()
