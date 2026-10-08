"""Mesures boîte noire d'un de-esser (mêmes stimuli pour le VST et pour NOVA).

- statique     : sinus à f0 par paliers -> réduction (dB) dans la bande ;
- selectivite  : sinus fort à différentes fréquences -> réduction par fréquence ;
- masquage     : sinus grave fort + sinus aigu faible (et l'inverse) -> chaque
                 composante séparément : la bande seule doit bouger ;
- transparence : sinus glissant à bas niveau (Farina) -> écart max en dB et
                 null avec l'entrée (le de-esser au repos doit être plat) ;
- temps        : saut de niveau d'un sinus à f0 -> t63 d'attaque / relâchement ;
- voix         : vraie voix -> trames « s » (énergie 5-12 kHz dominante) :
                 réduction des « s », écart hors « s ».
"""
from __future__ import annotations

import math
import os
import sys

import numpy as np
from scipy import signal as sps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa: E402

SR = 48000


def st(x):
    return np.vstack([x, x])


def amp_at(y, f, a=0.25, b=None):
    """Amplitude du sinus de fréquence f sur la fenêtre [a, b] s (moindres carrés)."""
    n0 = int(a * SR)
    n1 = len(y) if b is None else int(b * SR)
    seg = y[n0:n1]
    t = np.arange(n0, n1) / SR
    M = np.vstack([np.cos(2 * np.pi * f * t), np.sin(2 * np.pi * f * t)]).T
    k, *_ = np.linalg.lstsq(M, seg, rcond=None)
    return float(np.hypot(*k))


def static_curve(proc, f0, levels, dur=1.0):
    t = np.arange(int(dur * SR)) / SR
    out = []
    for L in levels:
        A = 10 ** (L / 20)
        y = proc.run(st(A * np.sin(2 * np.pi * f0 * t)))[0]
        out.append(round(20 * math.log10(max(amp_at(y, f0, 0.5), 1e-12) / A), 2))
    return {"f0": f0, "levels": list(levels), "gain_db": out}


def selectivity(proc, freqs, level, dur=1.0):
    t = np.arange(int(dur * SR)) / SR
    A = 10 ** (level / 20)
    g = []
    for f in freqs:
        y = proc.run(st(A * np.sin(2 * np.pi * f * t)))[0]
        g.append(round(20 * math.log10(max(amp_at(y, f, 0.5), 1e-12) / A), 2))
    return {"level": level, "freqs": list(freqs), "gain_db": g}


def masking(proc, f_lo=200.0, f_hi=8000.0, dur=1.0):
    """grave_fort : grave -6 dBFS + aigu faible -40 (l'aigu ne doit pas être réduit à cause du grave) ;
    aigu_fort : grave -20 + aigu -10 (le grave ne doit pas bouger : seule la bande est atténuée)."""
    t = np.arange(int(dur * SR)) / SR
    res = {}
    for name, (alo, ahi) in {"grave_fort": (-6, -40), "aigu_fort": (-20, -10)}.items():
        a, b = 10 ** (alo / 20), 10 ** (ahi / 20)
        y = proc.run(st(a * np.sin(2 * np.pi * f_lo * t) + b * np.sin(2 * np.pi * f_hi * t)))[0]
        res[name] = {"grave_db": round(20 * math.log10(amp_at(y, f_lo, 0.5) / a), 2),
                     "aigu_db": round(20 * math.log10(max(amp_at(y, f_hi, 0.5), 1e-12) / b), 2)}
    return res


def transparency(proc, level=-50.0):
    x, inv, _L = bench.ess(T=2.0)
    A = 10 ** (level / 20)
    xin = np.concatenate([x * A, np.zeros(int(0.3 * SR))])
    y = proc.run(st(xin))[0]
    ref = bench._deconv(xin, inv)
    ir = bench._deconv(y, inv)
    k0 = int(np.argmax(np.abs(ref)))
    pre, post = int(0.004 * SR), int(0.1 * SR)
    NF = 1 << 16
    R = np.fft.rfft(ref[k0 - pre:k0 + post], NF)
    H = np.fft.rfft(ir[k0 - pre:k0 + post], NF) / np.where(np.abs(R) > 1e-9, R, 1e-9)
    f = np.fft.rfftfreq(NF, 1 / SR)
    m = (f >= 30) & (f <= 16000)
    mag = 20 * np.log10(np.abs(H[m]) + 1e-12)
    d = xin[:len(y)] - y
    nul = 10 * np.log10(np.sum(d ** 2) / np.sum(xin[:len(y)] ** 2) + 1e-30)
    fl = np.geomspace(30, 16000, 60)
    return {"level": level, "max_ecart_db": round(float(np.max(np.abs(mag))), 3), "null_db": round(float(nul), 1),
            "freqs": fl.round(1).tolist(), "mag_db": np.interp(fl, f[m], mag).round(3).tolist()}


def times(proc, f0, base=-50.0, step=-10.0, hold=0.5, rel=0.6):
    n0, n1, n2 = int(0.4 * SR), int(hold * SR), int(rel * SR)
    n = n0 + n1 + n2
    t = np.arange(n) / SR
    amp = np.full(n, 10 ** (base / 20))
    amp[n0:n0 + n1] = 10 ** (step / 20)
    x = amp * np.sin(2 * np.pi * f0 * t)
    y = proc.run(st(x))[0]
    w = max(4, int(round(SR / f0)))
    g = 20 * np.log10(np.maximum(np.abs(bench._gain_ls(y, x, w)), 1e-9))
    gr = -g
    g_hold = float(np.median(gr[n0 + n1 - int(0.05 * SR):n0 + n1 - w]))
    g_pre = float(np.median(gr[n0 - int(0.1 * SR):n0 - w]))
    att = bench._times(np.arange(n1) / SR, gr[n0:n0 + n1], g_pre, g_hold)
    r = bench._times(np.arange(n2 - w) / SR, gr[n0 + n1 + w:], g_hold, g_pre)
    return {"gr_pre_db": round(g_pre, 2), "gr_hold_db": round(g_hold, 2), "attack_ms": att, "release_ms": r,
            "gr_curve_ms": gr[n0 - int(0.02 * SR)::48].round(2).tolist()}


# ── Vraie voix : trames « s » ───────────────────────────────────────────────
def band(x, lo, hi):
    sos = sps.butter(6, [lo, hi], btype="bandpass", fs=SR, output="sos")
    return sps.sosfiltfilt(sos, x)


def frames_rms(x, w=480):
    n = (len(x) // w) * w
    return np.sqrt(np.mean(x[:n].reshape(-1, w) ** 2, 1) + 1e-20)


def sibilant_mask(x, w=480):
    """Trames de 10 ms où l'énergie 5-12 kHz domine (« s », « ch ») et où le niveau est audible."""
    hf = frames_rms(band(x, 5000, 12000), w)
    tot = frames_rms(x, w)
    lvl = 20 * np.log10(tot)
    ratio = (hf / tot) ** 2
    s = (ratio > 0.35) & (lvl > np.max(lvl) - 45)
    s = np.convolve(s.astype(float), np.ones(3), "same") > 0  # marge d'une trame
    voiced = (lvl > np.max(lvl) - 45) & ~s
    return s, voiced


def voice_metrics(x, y, w=480):
    """x, y : mono, alignés. Réduction des « s » (bande 5-12 kHz, trames « s »),
    préservation hors « s » (trames voisées non sibilantes)."""
    n = min(len(x), len(y))
    x, y = x[:n], y[:n]
    s, v = sibilant_mask(x, w)
    hx, hy = frames_rms(band(x, 5000, 12000), w), frames_rms(band(y, 5000, 12000), w)
    lx, ly = frames_rms(band(x, 80, 3000), w), frames_rms(band(y, 80, 3000), w)
    d = frames_rms(x - y, w)
    tx = frames_rms(x, w)

    def eg(a, b, m):
        return float(10 * np.log10(np.sum(b[m] ** 2) / max(np.sum(a[m] ** 2), 1e-30))) if m.any() else 0.0
    red = 20 * np.log10(hx[s] / hy[s]) if s.any() else np.zeros(1)
    return {
        "trames_s": int(s.sum()), "trames_voix": int(v.sum()),
        "reduction_s_db": round(-eg(hx, hy, s), 2),
        "reduction_s_p90_db": round(float(np.percentile(red, 90)), 2),
        "aigus_hors_s_db": round(eg(hx, hy, v), 2),
        "grave_hors_s_db": round(eg(lx, ly, v), 2),
        "grave_sur_s_db": round(eg(lx, ly, s), 2),
        "null_hors_s_db": round(float(10 * np.log10(np.sum(d[v] ** 2) / max(np.sum(tx[v] ** 2), 1e-30))), 1),
    }


def at_rest(proc, level=-20.0, dur=2.0):
    """Le de-esser au repos (voix sans « s » : bruit rose passe-bas 3 kHz) :
    null avec l'entrée (dB) — doit être parfait (reconstruction à l'échantillon)."""
    n = int(dur * SR)
    x = bench.pink(n, 7)
    x = sps.sosfilt(sps.butter(6, 3000, fs=SR, output="sos"), x)
    x = x / np.sqrt(np.mean(x ** 2)) * 10 ** (level / 20)
    y = proc.run(st(x))[0]
    d = x - y
    return {"level": level, "null_db": round(float(10 * np.log10(np.sum(d ** 2) / np.sum(x ** 2) + 1e-30)), 1)}
