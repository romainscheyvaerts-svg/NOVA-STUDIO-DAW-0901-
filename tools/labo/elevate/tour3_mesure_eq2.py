"""Tour 3 : forme de chaque bande de l'égaliseur de l'original (+6 dB et −6 dB, une bande à la fois),
résolution 1,5 Hz (Welch 32768), pour reproduire les formes dans NOVA. -> tour3/eq_formes.json"""
import ctypes, json, os, sys
import numpy as np
from scipy import signal as sps
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import host
from bancs import elevate as banc
from vst import Elevate
SR = 48000
T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"
k = ctypes.windll.kernel32; k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
host.hide_console()
E = Elevate()
rng = np.random.default_rng(9)
x = rng.standard_normal((2, 12 * SR)) * 10 ** (-30 / 20)
fq = np.concatenate([np.arange(0, 2000, 5.0), np.geomspace(2000, 23900, 300)])
out = {"freq": fq.tolist()}
for g in (6.0, -6.0, 3.0):
    for b in range(1, 27):
        if g == 3.0 and b not in (1, 2, 3, 8, 20):
            continue
        s = dict(banc.NEUTRE); s[f"band_gain_{b}_db"] = g
        E.configure(s)
        y = E.run(x)
        f, pxx = sps.welch(x[0], SR, nperseg=32768)
        _, pxy = sps.csd(x[0], y[0], SR, nperseg=32768)
        h = 20 * np.log10(np.abs(pxy / pxx) + 1e-12)
        out[f"b{b}_{g:+.0f}"] = np.interp(fq, f, h).round(4).tolist()
        print(b, g, flush=True)
json.dump(out, open(os.path.join(T3, "eq_formes.json"), "w"))
