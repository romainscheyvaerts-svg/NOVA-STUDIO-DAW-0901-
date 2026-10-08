"""Tour 3 : prototype de limiteur « dans le temps » (gain par échantillon) pour l'hypothèse :
la réduction commune de l'original suit l'enveloppe CRÊTE échantillon par échantillon
(loi statique à coude doux mesurée), avec anticipation et relâchement = vitesse.
Indices : à 100 Hz et vitesse 1 ms l'original module le gain DANS la période (RMS plus fort
à crête égale), plus à 5 ms ; en adaptatif 0 une sonde aiguë subit presque la réduction du grave.
Usage : python elevate/tour3_proto_td.py"""
import json
import math
import os
import sys

import numpy as np
from numba import njit

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tour3_mesure_lim import sine, pink, SR  # noqa: E402

T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"
AUD = r"D:\1 WORK\CONTENU\nova-labo\elevate\audio_vst"


def knee_table():
    A = json.load(open(os.path.join(T3, "mesures_lim_A.json")))["stat_1000_s1"]
    u = np.array([-40.0, -22.0] + [r[0] + 8 for r in A])
    gr = np.array([0.0, 0.1] + [8 - r[1] for r in A])
    return u, gr


@njit(cache=True)
def td_lim(x, gain_lin, ku, kgr, la, rel_c_arr, att_avg, rdb, hold, kgrdep=0.0):
    """x (2, n) -> y (2, n), gain (n). Anticipation la éch. ; gain cible = coude(crête) ;
    min glissant sur la+1, maintien `hold` éch., relâchement exponentiel, lissage moyen sur att_avg éch."""
    n = x.shape[1]
    y = np.zeros_like(x)
    g = np.ones(n)
    tgt = np.ones(n)
    for i in range(n):
        p = max(abs(x[0, i]), abs(x[1, i])) * gain_lin
        u = 20.0 * math.log10(p + 1e-12)
        if u <= ku[0]:
            gr = 0.0
        elif u >= ku[-1]:
            gr = kgr[-1] + (u - ku[-1])
        else:
            j = np.searchsorted(ku, u) - 1
            t = (u - ku[j]) / (ku[j + 1] - ku[j])
            gr = kgr[j] + (kgr[j + 1] - kgr[j]) * t
        tgt[i] = 10.0 ** (-gr / 20.0)
    # min glissant (fenêtre la+1, centrée sur l'anticipation)
    m = np.ones(n)
    for i in range(n):
        lo = i
        hi = min(n - 1, i + la)
        v = 1.0
        for k in range(lo, hi + 1):
            if tgt[k] < v:
                v = tgt[k]
        m[i] = v
    gs = 1.0
    age = 0
    for i in range(n):
        if m[i] <= gs:
            gs = m[i]
            age = 0
        else:
            age += 1
            if age > hold:
                rel_c = rel_c_arr[i]
                if kgrdep != 0.0:
                    rel_c = min(1.0, rel_c * max(0.05, 1.0 + kgrdep * (-20.0 * math.log10(gs))))
                if rdb > 0.5:
                    gs = math.exp(math.log(gs) + (math.log(m[i]) - math.log(gs)) * rel_c)
                else:
                    gs += (m[i] - gs) * rel_c
        g[i] = gs
    # lissage (moyenne glissante causale sur att_avg éch.) -> rampe d'attaque
    if att_avg > 1:
        c = np.cumsum(g)
        g2 = g.copy()
        for i in range(n):
            a = i - att_avg
            g2[i] = (c[i] - (c[a] if a >= 0 else 0.0) + (0.0 if a >= 0 else -a)) / att_avg
        g = g2
    for i in range(n):
        y[0, i] = x[0, i] * gain_lin * g[i]
        y[1, i] = x[1, i] * gain_lin * g[i]
    return y, g


def centroid_track(x, n):
    """Centroïde spectral (Hz) par trame STFT 512 / pas 128, ramené à chaque échantillon."""
    N, H = 512, 128
    win = np.hanning(N)
    m = 0.5 * (x[0] + x[1])
    xx = np.concatenate([np.zeros(N // 2), m, np.zeros(N)])
    nfr = (len(xx) - N) // H + 1
    idx = np.arange(N)[None, :] + H * np.arange(nfr)[:, None]
    P = np.abs(np.fft.rfft(xx[idx] * win, axis=1)) ** 2
    f = np.fft.rfftfreq(N, 1 / SR)
    c = (P @ f) / np.maximum(P.sum(1), 1e-20)
    return np.interp(np.arange(n), np.arange(nfr) * H, c)


_CT = {}


def run(x, prm, speed=1.0, gain_db=8.0, asp=0.0):
    """Anticipation D : m[i] = min(cible[i..i+D]) ; relâchement exponentiel ; gain = moyenne de [i-D..i]
    (rampe d'attaque qui atteint la cible pile sur la crête). asp : vitesse adaptative (0..1) :
    relâchement × (centroïde / réf)^(−k·asp)."""
    ku, kgr = knee_table()
    la_ms = prm["la_ms"] * speed ** prm.get("ela", 0.0)
    la = max(1, int(la_ms * SR / 1000))
    rel_ms = prm["rel_k"] * (prm["rel_a"] + speed)
    n = x.shape[1]
    if asp > 0:
        key = (x.__array_interface__["data"][0], n)
        if key not in _CT:
            _CT[key] = centroid_track(x, n)
        ct = _CT[key]
        rel_arr = rel_ms * prm.get("as_mul", 1.0) * (np.maximum(ct, 20.0) / prm.get("as_ref", 1000.0)) ** (-prm.get("as_k", 0.0) * asp)
    else:
        rel_arr = np.full(n, rel_ms)
    rel_c = 1 - np.exp(-1 / (rel_arr * 0.001 * SR))
    avg = max(1, min(la, int(prm.get("avg_ms", prm["la_ms"]) * speed ** prm.get("eavg", 0.0) * SR / 1000)))
    y, g = td_lim(np.ascontiguousarray(x), 10 ** (gain_db / 20), ku + prm.get("thr", 0.0), kgr, la, rel_c, avg,
                  float(prm.get("rdb", 0.0)), int(prm.get("hold_ms", 0.0) * SR / 1000), prm.get("as_gr", 0.0) * asp)
    return y


def null(a, b):
    return float(10 * np.log10(np.sum((a - b) ** 2) / np.sum(a ** 2)))


def evaluate(prm, verbose=False):
    A = json.load(open(os.path.join(T3, "mesures_lim_A.json")))
    res = {}
    e100 = []
    for key, f, sp in (("stat_100_s1", 100, 1.0), ("stat_100_s5", 100, 5.0)):
        e = []
        for L, gv, _ in A[key][::4]:
            x = sine(L, f, 0.5)
            y = run(np.vstack([x, x]), prm, sp)[0]
            e.append(20 * np.log10(np.std(y[-SR // 5:]) / np.std(x[-SR // 5:])) - gv)
        res[key] = np.round(e, 2).tolist()
        e100 += e
    tot = float(np.mean(np.square(e100)))
    for nm in ("batterie", "mix"):
        x = np.load(os.path.join(AUD, f"in16_{nm}.npy")).astype(np.float64)
        yv = np.load(os.path.join(AUD, f"lim_g8_noadapt_{nm}.npy")).astype(np.float64)
        yn = run(x, prm, 1.0)
        # meilleur alignement entier (−64..64)
        best = (0, null(yv, yn))
        res[nm] = round(best[1], 2)
        tot += 0.1 * best[1]
    if verbose:
        print(prm, res)
    return tot, res


if __name__ == "__main__":
    import ctypes
    k = ctypes.windll.kernel32
    k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    for la, rk, ra in ((1.5, 1.0, 0.0), (0.5, 1.0, 0.0), (1.5, 3.0, 0.0), (1.5, 0.5, 0.5), (3.0, 1.0, 0.0), (1.5, 5.0, 0.2)):
        evaluate({"la_ms": la, "rel_k": rk, "rel_a": ra}, verbose=True)
