"""Tour 3 : mesures boîte noire du limiteur de l'original (hors ligne, sans fenêtre).
  A. loi statique fine : sinus 1 kHz et 100 Hz, −20 à 0 dBFS par 0,5 dB, vitesse 1 et 5 ms (+8 dB, sans adaptatif) ;
  B. dépendance à la DURÉE : salves de sinus 1 kHz (5 ms … 1 s) dans le coude, trajectoire du gain ;
  C. dépendance au FACTEUR DE CRÊTE : bruit rose et sinus de même valeur crête ;
  D. couplage entre bandes : grave fort (100 Hz) + sonde aiguë faible (5 kHz), adaptatif 0 et 6 dB.
Usage : python elevate/tour3_mesure_lim.py [A|B|C|D ...]  -> <labo>/elevate/tour3/mesures_lim_*.json"""
import ctypes
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import host  # noqa: E402
from bancs import elevate as banc  # noqa: E402
from vst import Elevate  # noqa: E402

SR = 48000
T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"


def lowprio():
    k = ctypes.windll.kernel32
    k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)


def sine(L, f, dur):
    t = np.arange(int(dur * SR)) / SR
    return 10 ** (L / 20) * np.sin(2 * np.pi * f * t)


def pink(n, seed=1):
    rng = np.random.default_rng(seed)
    W = np.fft.rfft(rng.standard_normal(n))
    fr = np.fft.rfftfreq(n, 1 / SR)
    W[1:] /= np.sqrt(fr[1:])
    W[fr < 20] = 0
    y = np.fft.irfft(W, n)
    return y / np.max(np.abs(y))


def gain_ls(y, x, w):
    k = np.ones(w)
    return np.convolve(y * x, k, "same") / np.maximum(np.convolve(x * x, k, "same"), 1e-30)


def static(E, f, speed, levels, gain=8.0, adapt=0.0):
    E.configure(banc.limiter_only(gain, speed, -0.1, True, adapt, 0.0))
    rows = []
    for L in levels:
        x = sine(L, f, 1.5)
        y = E.run(np.vstack([x, x]))[0]
        a, b = y[-SR // 2:], x[-SR // 2:]
        rows.append([float(L), float(20 * np.log10(np.std(a) / np.std(b))), float(20 * np.log10(np.max(np.abs(a))))])
    return rows


def main(parts):
    lowprio()
    host.hide_console()
    os.makedirs(T3, exist_ok=True)
    E = Elevate()
    out = {}
    lv = [float(v) for v in np.arange(-20.0, 0.01, 0.5)]
    if "A" in parts:
        for f in (1000, 100):
            for sp in (1.0, 5.0):
                out[f"stat_{f}_s{int(sp)}"] = static(E, f, sp, lv)
                print("A", f, sp, flush=True)
        json.dump(out, open(os.path.join(T3, "mesures_lim_A.json"), "w"), indent=0)
    if "B" in parts:
        res = {}
        E.configure(banc.limiter_only(8.0, 1.0, -0.1, True, 0.0, 0.0))
        for L in (-12.0, -8.0, -4.0):
            for d in (0.005, 0.02, 0.05, 0.1, 0.3, 1.0):
                n0 = int(0.3 * SR)
                x = np.zeros(n0 + int(d * SR) + int(0.4 * SR))
                s = sine(L, 1000, d)
                x[n0:n0 + len(s)] = s
                y = E.run(np.vstack([x, x]))[0]
                g = gain_ls(y, x, 12)
                seg = 20 * np.log10(np.maximum(np.abs(g[n0:n0 + len(s)]), 1e-6))
                res[f"L{L}_d{int(d * 1000)}"] = seg[::24].round(3).tolist()   # 0,5 ms
                print("B", L, d, round(float(seg[-24]), 2), flush=True)
        out = {"bursts": res}
        json.dump(out, open(os.path.join(T3, "mesures_lim_B.json"), "w"))
    if "C" in parts:
        res = []
        E.configure(banc.limiter_only(8.0, 1.0, -0.1, True, 0.0, 0.0))
        pk = pink(int(2.0 * SR))
        for Lp in np.arange(-20.0, 0.01, 1.0):   # valeur crête du bruit (dBFS)
            x = pk * 10 ** (Lp / 20)
            y = E.run(np.vstack([x, x]))[0]
            a, b = y[SR // 2:], x[SR // 2:]
            res.append([float(Lp), float(20 * np.log10(np.std(b))), float(20 * np.log10(np.std(a) / np.std(b))),
                        float(20 * np.log10(np.max(np.abs(a))))])
            print("C", Lp, round(res[-1][2], 2), flush=True)
        json.dump({"rose": res}, open(os.path.join(T3, "mesures_lim_C.json"), "w"))
    if "D" in parts:
        res = {}
        for ad in (0.0, 6.0):
            E.configure(banc.limiter_only(8.0, 1.0, -0.1, True, ad, 0.0))
            rows = []
            for Lb in np.arange(-24.0, 0.01, 2.0):
                x = sine(Lb, 100, 1.5) + sine(-30.0, 5000, 1.5)
                y = E.run(np.vstack([x, x]))[0][-SR // 2:]
                xp = sine(-30.0, 5000, 1.5)[-SR // 2:]
                xb = sine(Lb, 100, 1.5)[-SR // 2:]
                # gains de chaque composante par projection (sinus orthogonaux sur 0,5 s)
                M = np.vstack([xb, np.roll(xb, 120), xp, np.roll(xp, 3)]).T
                c, *_ = np.linalg.lstsq(M, y, rcond=None)
                gb = np.sqrt(np.sum((M[:, :2] @ c[:2]) ** 2) / np.sum(xb ** 2))
                gp = np.sqrt(np.sum((M[:, 2:] @ c[2:]) ** 2) / np.sum(xp ** 2))
                rows.append([float(Lb), float(20 * np.log10(gb)), float(20 * np.log10(gp))])
            res[f"ad{int(ad)}"] = rows
            print("D", ad, rows[-1], flush=True)
        json.dump({"couplage": res}, open(os.path.join(T3, "mesures_lim_D.json"), "w"))


if __name__ == "__main__":
    main(sys.argv[1:] or ["A", "B", "C", "D"])
