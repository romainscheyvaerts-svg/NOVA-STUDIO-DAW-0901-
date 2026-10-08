"""Tour 3 : égaliseur par bande (±6 dB) — original contre NOVA.
Bruit blanc −30 dBFS RMS (limiteur, clipper et transitoires au repos), réponse H = Pxy/Pxx (Welch),
écart en dB de 30 Hz à 16 kHz (1/12 d'octave).
Usage : python elevate/tour3_mesure_eq.py  -> <labo>/elevate/tour3/eq.json"""
import ctypes
import json
import os
import sys

import numpy as np
from scipy import signal as sps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import host  # noqa: E402
import nova  # noqa: E402
from bancs import elevate as banc  # noqa: E402
from vst import Elevate  # noqa: E402

SR = 48000
T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"

CASES = {
    "b8_+6": {8: 6.0}, "b8_-6": {8: -6.0}, "b2_+6": {2: 6.0}, "b1_+6": {1: 6.0}, "b20_+6": {20: 6.0}, "b26_+6": {26: 6.0},
    "b10-14_+3": {k: 3.0 for k in range(10, 15)},
    "alterne_+-6": {k: (6.0 if k % 2 else -6.0) for k in range(1, 27)},
    "tous_+6": {k: 6.0 for k in range(1, 27)},
    "romain_like": {1: 2.0, 2: 2.0, 3: 1.0, 9: -1.0, 10: -1.0, 22: 3.0, 23: 3.0},
}


def resp(x, y):
    f, pxx = sps.welch(x, SR, nperseg=8192)
    _, pxy = sps.csd(x, y, SR, nperseg=8192)
    return f, 20 * np.log10(np.abs(pxy / pxx) + 1e-12)


def main():
    k = ctypes.windll.kernel32
    k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    host.hide_console()
    E = Elevate()
    m = nova.MasterTransient()
    rng = np.random.default_rng(5)
    x = rng.standard_normal((2, 6 * SR)) * 10 ** (-30 / 20)
    fq = np.geomspace(30, 16000, 110)
    out = {"freq": fq.tolist()}
    for name, bands in CASES.items():
        s = dict(banc.NEUTRE)
        for b, g in bands.items():
            s[f"band_gain_{b}_db"] = g
        E.configure(s)
        yv = E.run(x)
        g26 = [bands.get(b, 0.0) for b in range(1, 27)]
        prm = dict(nova.transient_params(0), bandGainDb=g26, transientOn=False, limiterOn=False, clipperOn=False, protect=False)
        yn = m.run(x, prm)
        f, hv = resp(x[0], yv[0])
        _, hn = resp(x[0], yn[0])
        a = np.interp(fq, f, hv)
        b = np.interp(fq, f, hn)
        out[name] = {"orig": a.round(3).tolist(), "nova": b.round(3).tolist(), "ecart_max": float(np.max(np.abs(a - b))),
                     "ecart_rms": float(np.sqrt(np.mean((a - b) ** 2)))}
        print(f"{name:14s} écart max {out[name]['ecart_max']:5.2f} dB rms {out[name]['ecart_rms']:5.2f}", flush=True)
        json.dump(out, open(os.path.join(T3, "eq.json"), "w"), indent=0)
    m.close()


if __name__ == "__main__":
    main()
