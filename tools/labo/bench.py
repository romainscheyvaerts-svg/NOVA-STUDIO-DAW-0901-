"""
Banc de mesure du labo NOVA (boîte noire) : mêmes stimuli pour un VST réel et
pour l'effet NOVA, mêmes analyses.

Un « processeur » expose :
    configure(settings: dict) -> dict      (réglages appliqués, en texte)
    run(x: np.ndarray (2, n)) -> np.ndarray (2, n)   (état remis à zéro, latence retirée)
    latency -> int (échantillons annoncés)

Mesures :
  - freq_response : sinus glissant exponentiel (Farina), déconvolution, réponse
    en fréquence et retard mesuré (pic de la réponse impulsionnelle) ;
  - noise_response : bruit rose, densité spectrale sortie / entrée (Welch) ;
  - tone_levels   : sinus stables par paliers -> courbe statique (sortie en
    fonction de l'entrée), réduction de gain, harmoniques H2..H7, THD ;
  - step_response : saut de niveau d'un sinus -> courbe de réduction de gain
    dans le temps, temps d'attaque / relâchement (t50, t63, t90) ;
  - bursts        : salves courtes (transitoires) -> dépassement, gain moyen ;
  - stereo        : couplage L/R (un canal fort, l'autre faible) ;
  - real_signal   : vrai signal (voix, batterie) -> sortie gardée pour le null test.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
from scipy import signal as sps

SR = 48000


def db(x, floor=1e-12):
    return 20.0 * np.log10(np.maximum(np.abs(x), floor))


def dbfs_amp(level_db: float) -> float:
    """Amplitude crête d'un sinus de niveau `level_db` dBFS (crête)."""
    return 10.0 ** (level_db / 20.0)


def stereo(x: np.ndarray) -> np.ndarray:
    return np.vstack([x, x]) if x.ndim == 1 else x


# ── Réponse en fréquence (Farina) ──────────────────────────────────────────
def ess(f1=10.0, f2=22000.0, T=3.0, sr=SR):
    n = int(T * sr)
    t = np.arange(n) / sr
    L = T / math.log(f2 / f1)
    x = np.sin(2 * math.pi * f1 * L * (np.exp(t / L) - 1.0))
    # fondus d'entrée / sortie (5 ms / 20 ms) contre les clics
    fi, fo = int(0.005 * sr), int(0.02 * sr)
    x[:fi] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(fi) / fi)
    x[-fo:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(fo) / fo)
    inv = x[::-1] * np.exp(-t / L)  # filtre inverse (pente -6 dB/oct)
    return x, inv, L


def _deconv(y, inv):
    n = len(y) + len(inv) - 1
    N = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(y, N) * np.fft.rfft(inv, N), N)[:n]


def freq_response(proc, level_db: float, T: float = 3.0, fmin=20.0, fmax=20000.0, pts=200):
    x, inv, L = ess(T=T)
    A = dbfs_amp(level_db)
    pad = np.zeros(int(0.5 * SR))
    xin = np.concatenate([x * A, pad])
    y = proc.run(stereo(xin))
    ref = _deconv(xin, inv)
    k0 = int(np.argmax(np.abs(ref)))
    res = {"level_db": level_db, "channels": []}
    f = np.geomspace(fmin, fmax, pts)
    pre, post = int(0.004 * SR), int(0.15 * SR)
    win = np.ones(pre + post)
    win[:pre] = 0.5 - 0.5 * np.cos(np.pi * np.arange(pre) / pre)
    tail = int(0.03 * SR)
    win[-tail:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(tail) / tail)
    rseg = ref[k0 - pre:k0 + post] * win
    NF = 1 << 17
    R = np.fft.rfft(rseg, NF)
    freqs = np.fft.rfftfreq(NF, 1 / SR)
    for ch in range(y.shape[0]):
        ir = _deconv(y[ch], inv)
        kp = int(np.argmax(np.abs(ir[k0 - pre:k0 + post]))) + k0 - pre
        delay = kp - k0
        seg = ir[k0 - pre:k0 + post] * win
        H = np.fft.rfft(seg, NF) / np.where(np.abs(R) > 1e-9, R, 1e-9)
        mag = np.interp(f, freqs, db(H))
        # phase sans le retard mesuré (retard de groupe déjà compté à part)
        res["channels"].append({"delay_samples": int(delay), "mag_db": mag.round(4).tolist()})
    res["freqs"] = f.round(3).tolist()
    return res


# ── Bruit rose ─────────────────────────────────────────────────────────────
def pink(n, seed=1):
    rng = np.random.default_rng(seed)
    w = rng.standard_normal(n)
    W = np.fft.rfft(w)
    fr = np.fft.rfftfreq(n, 1 / SR)
    fr[0] = fr[1]
    p = np.fft.irfft(W / np.sqrt(fr), n)
    return p / np.sqrt(np.mean(p ** 2))


def noise_response(proc, rms_db: float, dur=6.0, kind="pink", pts=120):
    n = int(dur * SR)
    x = pink(n) if kind == "pink" else np.random.default_rng(2).standard_normal(n)
    x = x / np.sqrt(np.mean(x ** 2)) * 10 ** (rms_db / 20)
    y = proc.run(stereo(x))
    s = int(2.0 * SR)  # on laisse le compresseur se poser
    f, pxx = sps.welch(x[s:], SR, nperseg=8192)
    out = {"rms_db": rms_db, "kind": kind}
    fl = np.geomspace(20, 20000, pts)
    chans = []
    for ch in range(y.shape[0]):
        _, pyy = sps.welch(y[ch, s:], SR, nperseg=8192)
        _, pxy = sps.csd(x[s:], y[ch, s:], SR, nperseg=8192)
        h = 10 * np.log10(np.maximum(pyy, 1e-30) / np.maximum(pxx, 1e-30))
        coh = np.abs(pxy) ** 2 / np.maximum(pxx * pyy, 1e-30)
        chans.append({"psd_ratio_db": np.interp(fl, f, h).round(3).tolist(),
                      "coherence": np.interp(fl, f, coh).round(4).tolist(),
                      "out_rms_db": float(20 * np.log10(np.sqrt(np.mean(y[ch, s:] ** 2)) + 1e-12))})
    out["freqs"] = fl.round(2).tolist()
    out["channels"] = chans
    return out


# ── Sinus stables : courbe statique + harmoniques ───────────────────────────
def _harmonics(y, f0, nh=7):
    """Amplitudes crête de H1..Hnh (fenêtre Blackman-Harris, interpolation au pic)."""
    n = len(y)
    w = sps.windows.blackmanharris(n)
    Y = np.fft.rfft(y * w)
    cg = np.sum(w) / 2.0
    out = []
    for k in range(1, nh + 1):
        fk = k * f0
        if fk >= SR / 2 - 100:
            out.append(0.0)
            continue
        b = fk * n / SR
        lo, hi = int(b) - 3, int(b) + 4
        out.append(float(np.sqrt(np.sum(np.abs(Y[lo:hi]) ** 2) / np.sum(w ** 2) * 2 / n)) * 1.0)
    # normalisation : sinus d'amplitude A -> A
    return out


def _harm_cal():
    t = np.arange(int(0.4 * SR)) / SR
    return _harmonics(np.sin(2 * np.pi * 1000 * t), 1000, 1)[0]


_CAL = None


def tone_levels(proc, freq: float, levels: Sequence[float], dur=2.5, analyze=0.4, nh=7):
    global _CAL
    if _CAL is None:
        _CAL = _harm_cal()
    n = int(dur * SR)
    t = np.arange(n) / SR
    na = int(analyze * SR)
    rows = []
    for L in levels:
        x = dbfs_amp(L) * np.sin(2 * np.pi * freq * t)
        fi = int(0.002 * SR)
        x[:fi] *= np.arange(fi) / fi
        y = proc.run(stereo(x))
        row = {"in_db": float(L)}
        for ch in range(y.shape[0]):
            h = np.array(_harmonics(y[ch, -na:], freq, nh)) / _CAL
            h1 = max(h[0], 1e-12)
            rel = [float(20 * np.log10(max(v, 1e-12) / h1)) for v in h[1:]]
            thd = float(np.sqrt(np.sum(h[1:] ** 2)) / h1 * 100)
            row[f"ch{ch}"] = {"out_db": float(20 * np.log10(h1)), "harm_rel_db": rel, "thd_pct": thd}
        rows.append(row)
    return {"freq": freq, "rows": rows}


def static_summary(tl: Dict[str, Any]):
    """Gain et réduction de gain par palier (canal gauche)."""
    rows = tl["rows"]
    g = [r["ch0"]["out_db"] - r["in_db"] for r in rows]
    g0 = g[0]
    return {"in_db": [r["in_db"] for r in rows], "out_db": [r["ch0"]["out_db"] for r in rows],
            "gain_db": g, "gr_db": [g0 - v for v in g]}


# ── Saut de niveau : constantes de temps ───────────────────────────────────
def _gain_ls(y, x, win):
    """Gain instantané par moindres carrés sur une fenêtre glissante centrée :
    g = somme(y.x) / somme(x.x). Le stimulus x est connu exactement (saut
    compris), donc l'estimation reste juste de part et d'autre d'un saut."""
    k = np.ones(int(win))
    num = np.convolve(y * x, k, mode="same")
    den = np.convolve(x * x, k, mode="same")
    return num / np.maximum(den, 1e-30)


def _times(t, g, g_start, g_end, marks=(0.5, 0.632, 0.9)):
    """Instants où g passe de g_start vers g_end aux fractions `marks`."""
    out = {}
    span = g_end - g_start
    for m in marks:
        if abs(span) < 0.05:
            out[f"t{int(round(m * 100))}"] = None
            continue
        target = g_start + m * span
        idx = np.where((g - target) * np.sign(span) >= 0)[0]
        out[f"t{int(round(m * 100))}"] = float(t[idx[0]] * 1000) if len(idx) else None
    return out


def step_response(proc, freq: float, base_db: float, step_db: float, hold: float, rel_obs: float,
                  pre: float = 1.0):
    n0, n1, n2 = int(pre * SR), int(hold * SR), int(rel_obs * SR)
    n = n0 + n1 + n2
    t = np.arange(n) / SR
    amp = np.full(n, dbfs_amp(base_db))
    amp[n0:n0 + n1] = dbfs_amp(base_db + step_db)
    x = amp * np.sin(2 * np.pi * freq * t)
    y = proc.run(stereo(x))[0]
    w = max(4, int(round(SR / freq / 4)))  # quart de période
    gdb = 20 * np.log10(np.maximum(np.abs(_gain_ls(y, x, w)), 1e-9))
    # gain de référence : fin de la partie basse avant le saut
    g_base = float(np.median(gdb[n0 - int(0.2 * SR):n0 - int(0.02 * SR)]))
    gr = g_base - gdb  # réduction de gain (dB, positive)
    gr_pre = float(np.median(gr[n0 - int(0.2 * SR):n0 - int(0.02 * SR)]))
    g_hold_end = float(np.median(gr[n0 + n1 - max(int(0.1 * hold * SR), 48):n0 + n1 - 24]))
    ta = (np.arange(n1) / SR)
    att = _times(ta, gr[n0:n0 + n1], gr_pre, g_hold_end)
    tr = np.arange(n2) / SR
    g_rel_end = float(np.median(gr[-int(0.05 * SR):]))
    sk = w  # la fenêtre ne doit plus contenir d'échantillons forts
    rel = _times(tr[sk:], gr[n0 + n1 + sk:], g_hold_end, gr_pre)
    # courbe décimée pour superposition (1 point / ms)
    dec = int(SR / 1000)
    return {"freq": freq, "base_db": base_db, "step_db": step_db, "hold": hold, "rel_obs": rel_obs,
            "gr_hold_end_db": g_hold_end, "gr_rel_end_db": g_rel_end, "attack_ms": att, "release_ms": rel,
            "gr_curve_ms": gr[n0 - int(0.05 * SR)::dec].round(3).tolist()}


# ── Salves (transitoires) ───────────────────────────────────────────────────
def bursts(proc, freq: float, base_db: float, burst_db: float, burst_ms: float, period_ms: float, count=8):
    n = int((count * period_ms / 1000 + 0.5) * SR)
    t = np.arange(n) / SR
    amp = np.full(n, dbfs_amp(base_db))
    starts = []
    for k in range(count):
        s = int((0.25 + k * period_ms / 1000) * SR)
        amp[s:s + int(burst_ms / 1000 * SR)] = dbfs_amp(burst_db)
        starts.append(s)
    x = amp * np.sin(2 * np.pi * freq * t)
    y = proc.run(stereo(x))[0]
    w = max(4, int(round(SR / freq / 4)))
    gdb = 20 * np.log10(np.maximum(np.abs(_gain_ls(y, x, w)), 1e-9))
    bl = int(burst_ms / 1000 * SR)
    over, mean_g = [], []
    for s in starts:
        seg = gdb[s + 24:s + bl - 24]
        if len(seg) > 4:
            over.append(float(np.max(seg) - np.median(seg[-max(len(seg) // 4, 2):])))
            mean_g.append(float(np.mean(seg)))
    dec = int(SR / 1000)
    return {"freq": freq, "base_db": base_db, "burst_db": burst_db, "burst_ms": burst_ms, "period_ms": period_ms,
            "overshoot_db": over, "burst_gain_db": mean_g, "gain_curve_ms": gdb[::dec].round(3).tolist()}


# ── Stéréo ─────────────────────────────────────────────────────────────────
def stereo_link(proc, loud_db: float, quiet_db: float, dur=2.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    xl = dbfs_amp(loud_db) * np.sin(2 * np.pi * 1000 * t)
    xr = dbfs_amp(quiet_db) * np.sin(2 * np.pi * 1500 * t)
    y = proc.run(np.vstack([xl, xr]))
    na = int(0.4 * SR)
    yq = proc.run(np.vstack([xr, xr]))
    gr_r = 20 * np.log10(np.sqrt(np.mean(y[1, -na:] ** 2)) / np.sqrt(np.mean(yq[1, -na:] ** 2)))
    cross = 20 * np.log10(np.sqrt(np.mean(proc.run(np.vstack([xl, 0 * xl]))[1, -na:] ** 2)) + 1e-12) - loud_db
    return {"loud_db": loud_db, "quiet_db": quiet_db, "r_gain_change_db": float(gr_r),
            "linked": bool(gr_r < -0.5), "crosstalk_db": float(cross)}


# ── Signaux réels ──────────────────────────────────────────────────────────
def load_audio(path: str, seconds: Optional[float] = None, offset: float = 0.0, target_rms_db: Optional[float] = None):
    import soundfile as sf
    x, sr = sf.read(path, always_2d=True, dtype="float64")
    x = x.T
    if sr != SR:
        from math import gcd
        g = gcd(sr, SR)
        x = sps.resample_poly(x, SR // g, sr // g, axis=1)
    if x.shape[0] == 1:
        x = np.vstack([x[0], x[0]])
    s = int(offset * SR)
    x = x[:, s:]
    if seconds:
        x = x[:, :int(seconds * SR)]
    if target_rms_db is not None:
        x = x / np.sqrt(np.mean(x ** 2)) * 10 ** (target_rms_db / 20)
    return x


def null_db(a: np.ndarray, b: np.ndarray) -> float:
    """Différence a-b en dB RMS relatif à a (plus bas = plus proche)."""
    n = min(a.shape[-1], b.shape[-1])
    d = a[..., :n] - b[..., :n]
    return float(10 * np.log10(np.sum(d ** 2) / max(np.sum(a[..., :n] ** 2), 1e-30)))
