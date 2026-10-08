"""« s » synthétiques : corps de voix (bruit rose passe-bas 3 kHz) + salves de bruit
dans les aigus (6-11 kHz, 120 ms) ; on suit la réduction de la bande aiguë dans le
temps (attaque / relâchement), en fonction du niveau de la salve (relatif au
corps) et du niveau global (détection absolue ou relative ?)."""
from __future__ import annotations

import os
import sys

import numpy as np
from scipy import signal as sps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa: E402

SR = 48000


def make(global_db=-20.0, s_rel_db=0.0, seed=3, dur=2.4, burst=(0.6, 0.72), burst2=(1.4, 1.46)):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    body = bench.pink(n, seed)
    body = sps.sosfilt(sps.butter(4, 3000, fs=SR, output="sos"), body)
    body /= np.sqrt(np.mean(body ** 2))
    hf = sps.sosfilt(sps.butter(4, [6000, 11000], btype="bandpass", fs=SR, output="sos"), rng.standard_normal(n))
    hf /= np.sqrt(np.mean(hf ** 2))
    env = np.zeros(n)
    for a, b in (burst, burst2):
        i0, i1 = int(a * SR), int(b * SR)
        r = int(0.004 * SR)
        e = np.ones(i1 - i0)
        e[:r] = np.linspace(0, 1, r)
        e[-r:] = np.linspace(1, 0, r)
        env[i0:i1] = e
    g = 10 ** (global_db / 20)
    x = g * (body + 10 ** (s_rel_db / 20) * hf * env)
    return x, g * body, g * 10 ** (s_rel_db / 20) * hf * env


def band_gain(x, y, w=96):
    """Gain de la bande 6-11 kHz (dB) par trames de 2 ms."""
    sos = sps.butter(6, [6000, 11000], btype="bandpass", fs=SR, output="sos")
    bx, by = sps.sosfiltfilt(sos, x), sps.sosfiltfilt(sos, y)
    n = (len(x) // w) * w
    ex = np.sqrt(np.mean(bx[:n].reshape(-1, w) ** 2, 1) + 1e-20)
    ey = np.sqrt(np.mean(by[:n].reshape(-1, w) ** 2, 1) + 1e-20)
    return 20 * np.log10(ey / ex)


def run(proc, levels=(-30.0, -20.0, -10.0), rels=(-12.0, -6.0, 0.0, 6.0)):
    out = {}
    for G in levels:
        for R in rels:
            x, _, _ = make(G, R)
            y = proc.run(np.vstack([x, x]))[0]
            g = band_gain(x, y)
            t = np.arange(len(g)) * 2.0  # ms
            m1 = (t >= 640) & (t <= 715)
            m0 = (t >= 300) & (t <= 550)
            red = -float(np.median(g[m1]))
            # attaque : premier instant où la réduction dépasse 63 % de la réduction tenue
            k = np.where((t >= 600) & (-g >= 0.63 * red))[0] if red > 0.5 else []
            att = float(t[k[0]] - 600) if len(k) else None
            k2 = np.where((t >= 720) & (-g <= 0.37 * red))[0] if red > 0.5 else []
            rel = float(t[k2[0]] - 720) if len(k2) else None
            out[f"G{int(G)}_S{int(R)}"] = {"reduction_salve_db": round(red, 2), "reduction_hors_salve_db": round(-float(np.median(g[m0])), 2),
                                            "attaque_t63_ms": att, "relachement_t63_ms": rel,
                                            "courbe_2ms": g[250:450].round(2).tolist()}
    return out
