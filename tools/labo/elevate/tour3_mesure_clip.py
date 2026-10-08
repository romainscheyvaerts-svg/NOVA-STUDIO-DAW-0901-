"""Tour 3 : mesures boîte noire du clipper spectral de l'original (hors ligne, sans fenêtre).
Limiteur au repos (poussée 0 dB, plafond −0,1 dBTP), clipper : poussée 3 / 6 / 12 dB, forme 0 / 50 / 100 %, détail 0 / 100 %.
  - loi statique : sinus 100 Hz / 1 kHz / 5 kHz, −24 à 0 dBFS par 1 dB : niveau RMS, crête, harmoniques H2..H7 ;
  - bruit rose (crête −6 dBFS) ;
  - vraie batterie et vrai mix (−16 dBFS RMS) : rendus gardés pour les null tests.
Usage : python elevate/tour3_mesure_clip.py  -> <labo>/elevate/tour3/mesures_clip.json, audio_clip/*.npy"""
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
from tour3_mesure_lim import sine, pink, SR  # noqa: E402

T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"
AUD = r"D:\1 WORK\CONTENU\nova-labo\elevate\audio_vst"


def clip_settings(drive, shape, detail):
    s = dict(banc.NEUTRE)
    s.update({"ceiling_db": -0.1, "true_peak": True, "clipper_drive_active": True, "clipper_drive_db": drive,
              "clipper_shape_active": True, "clipper_shape": shape, "clipper_detail_active": True, "clipper_detail": detail})
    return s


def harm(y, f, nh=7):
    n = len(y)
    w = np.hanning(n)
    Y = np.abs(np.fft.rfft(y * w))
    fr = np.fft.rfftfreq(n, 1 / SR)
    a = []
    for h in range(1, nh + 1):
        k = int(round(h * f * n / SR))
        a.append(float(np.max(Y[max(k - 2, 0):k + 3])) if h * f < SR / 2 else 0.0)
    return [float(20 * np.log10(v / a[0] + 1e-12)) for v in a[1:]]


def main():
    k = ctypes.windll.kernel32
    k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    host.hide_console()
    os.makedirs(os.path.join(T3, "audio_clip"), exist_ok=True)
    E = Elevate()
    out = {}
    for drive, shape, detail in ((6.0, 0.0, 100.0), (6.0, 100.0, 100.0), (6.0, 50.0, 100.0), (12.0, 0.0, 100.0), (3.0, 0.0, 100.0),
                                 (6.0, 0.0, 0.0), (12.0, 100.0, 0.0)):
        key = f"d{int(drive)}_s{int(shape)}_det{int(detail)}"
        E.configure(clip_settings(drive, shape, detail))
        res = {}
        for f in (100, 1000, 5000):
            rows = []
            for L in range(-24, 1):
                x = sine(float(L), f, 0.6)
                y = E.run(np.vstack([x, x]))[0][-SR // 4:]
                xs = x[-SR // 4:]
                rows.append([L, float(20 * np.log10(np.std(y) / np.std(xs))), float(20 * np.log10(np.max(np.abs(y)))), harm(y, f)])
            res[f"sin{f}"] = rows
        pk = pink(int(1.5 * SR)) * 10 ** (-6 / 20)
        y = E.run(np.vstack([pk, pk]))[0][SR // 2:]
        res["rose_-6"] = [float(20 * np.log10(np.std(y) / np.std(pk[SR // 2:]))), float(20 * np.log10(np.max(np.abs(y))))]
        for nm in ("batterie", "mix"):
            x = np.load(os.path.join(AUD, f"in16_{nm}.npy")).astype(np.float64)
            y = E.run(x)
            np.save(os.path.join(T3, "audio_clip", f"{key}_{nm}.npy"), y.astype(np.float32))
            res[f"{nm}_rms"] = float(20 * np.log10(np.std(y)))
        out[key] = res
        print(key, "rose", res["rose_-6"], "1k@0", res["sin1000"][-1][:3], flush=True)
        json.dump(out, open(os.path.join(T3, "mesures_clip.json"), "w"), indent=0)


if __name__ == "__main__":
    main()
