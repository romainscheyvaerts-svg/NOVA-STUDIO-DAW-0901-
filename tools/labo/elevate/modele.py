"""
Modèle de référence (Python/numpy) de l'effet NOVA « Mastering Transient » —
même algorithme que engine/masterTransientCore.ts (module Transient), sert au
calage sur les mesures boîte noire du limiteur de mastering d'origine.

Chaîne :
  - SYNTHÈSE : STFT (fenêtre racine de Hann, N = 512 à 48 kHz, pas H = N/4),
    26 bandes auditives (centres MEL, poids triangulaires qui somment à 1 :
    reconstruction parfaitement plate quand tous les gains sont égaux) ;
  - DÉTECTION des attaques, plus fine dans le temps : petite STFT (Nd = N/4,
    pas Hd = Nd/4 ≈ 0,7 ms), énergie par bande (mêmes poids triangulaires) ;
      Pf = enveloppe rapide (montée af, descente rf),
      Ps = enveloppe lente (montée as, descente rs ; domaine puissance^q),
      d  = 10·log10(Pf/Ps) (dB),  s = 1 − exp(−(d/d0)^p)  (0..1),
      S  = maintien (hold) puis relâchement exponentiel (gs) de s ;
    l'original réagit à la VITESSE de montée : une attaque franche de 1 dB
    accentue plus qu'une montée de 20 dB étalée sur 5 ms ;
  - gain linéaire de la bande = 1 + A(emphase) · dosage · S, lu avec une
    anticipation `la_ms` (le gain monte un peu avant l'attaque, comme l'original).
"""
import math

import numpy as np
from numba import njit

SR = 48000
CENTERS = [0.0, 101.55, 217.84, 351.0, 503.48, 678.07, 878.0, 1106.93, 1369.08, 1669.26, 2012.98, 2406.58,
           2857.27, 3373.35, 3964.3, 4640.99, 5415.84, 6303.12, 7319.11, 8482.5, 9814.68, 11340.12, 13086.87,
           15087.04, 17377.38, 20000.0]
# Emphase (%) -> gain max (dB) mesuré sur une attaque depuis le silence
EM_KNOB = [0, 5, 10, 20, 27, 35, 40, 50, 60, 70, 80, 90, 100]
EM_PEAK_DB = [0.0, 0.41, 0.52, 0.80, 1.09, 1.53, 1.89, 2.83, 4.14, 5.88, 8.07, 10.71, 13.72]

DEFAULT = {
    "N": 512,
    "la_ms": 4.0,          # anticipation du gain (ms)
    "af_ms": 0.0, "rf_ms": 3.0,      # enveloppe rapide : montée / descente
    "q": 1.0,                         # domaine de l'enveloppe lente : puissance^q
    "as_ms": 3.0, "rs_ms": 200.0,    # enveloppe lente : montée / descente
    "d0": 1.0, "p": 1.0,              # courbe de détection
    "wneg": 0.0,                      # part de l'emphase sur les descentes
    "hold_ms": 8.0, "gs_ms": 18.0,    # forme de l'emphase : maintien puis relâchement
    "ad_k": 2.0, "ad_p": 2.0,        # adaptatif : allonge le relâchement
    "ad_bg": 0.8,                     # adaptatif : réduit l'emphase sur fond déjà fort
    "ad_lt_ms": 300.0,                # adaptatif : enveloppe de long terme
    "ad_sens": 0.0,                   # adaptatif : détection plus sensible (attaques faibles plus accentuées)
}


def em_excess(em):
    return 10 ** (np.interp(em, EM_KNOB, EM_PEAK_DB) / 20) - 1.0


def band_weights(N, sr=SR):
    """Matrice (26, N/2+1) des poids triangulaires (partition de l'unité)."""
    f = np.arange(N // 2 + 1) * sr / N
    c = np.array(CENTERS)
    W = np.zeros((26, len(f)))
    for k, fk in enumerate(f):
        if fk >= c[-1]:
            W[-1, k] = 1.0
            continue
        j = np.searchsorted(c, fk, side="right") - 1
        t = (fk - c[j]) / (c[j + 1] - c[j])
        W[j, k] = 1 - t
        W[j + 1, k] = t
    return W


def coef(ms, hop):
    return 1.0 if ms <= 0 else 1.0 - math.exp(-hop / (ms * 0.001 * SR))


def stft_power(x2, N, H, win):
    """x2 (2, n) -> énergie (|L|²+|R|²)/2 par case (trames, N/2+1), trame j = échantillons [jH, jH+N)."""
    nfr = (x2.shape[1] - N) // H + 1
    idx = np.arange(N)[None, :] + H * np.arange(nfr)[:, None]
    z = x2[0] + 1j * x2[1]
    Z = np.fft.fft(z[idx] * win[None, :], axis=1)
    Zr = np.roll(Z[:, ::-1], 1, axis=1)
    return 0.5 * (np.abs(Z) ** 2 + np.abs(Zr) ** 2)[:, :N // 2 + 1], Z


def detect(Ed, prm, Hd, adaptive=0.0):
    """Ed (trames de détection, 26) -> S (trames, 26)."""
    nf = Ed.shape[0]
    q = prm["q"]
    a = adaptive / 100.0
    stretch = 1.0 + prm["ad_k"] * a ** prm["ad_p"]
    caf = coef(prm["af_ms"], Hd)
    crf = coef(prm["rf_ms"], Hd)
    cas = coef(prm["as_ms"], Hd)
    crs = coef(prm["rs_ms"], Hd)
    cgs = coef(prm["gs_ms"] * stretch, Hd)
    clt = coef(prm["ad_lt_ms"], Hd)
    hold = prm["hold_ms"] * 0.001 * SR / Hd
    d0 = prm["d0"] / (1.0 + prm.get("ad_sens", 0.0) * a)
    eps = 1e-9   # plancher d'énergie (≈ −120 dBFS) : le silence ne déclenche rien
    return _detect_nb(np.ascontiguousarray(Ed, dtype=np.float64), caf, crf, cas, crs, cgs, clt, hold, d0,
                      float(prm["p"]), float(q), float(prm["wneg"]), float(a), float(prm["ad_bg"]), eps)


@njit(cache=True)
def _detect_nb(Ed, caf, crf, cas, crs, cgs, clt, hold, d0, p, q, wneg, a, adbg, eps):
    nf, nb = Ed.shape
    Pf = np.full(nb, eps)
    Ps = np.full(nb, eps ** q)
    Lt = np.full(nb, eps)
    Sv = np.zeros(nb)
    age = np.zeros(nb)
    S = np.zeros((nf, nb))
    for j in range(nf):
        for b in range(nb):
            e = Ed[j, b] + eps
            pf = Pf[b]
            pf = pf + (e - pf) * caf if e > pf else pf + (e - pf) * crf
            Pf[b] = pf
            eq = pf if q == 1.0 else pf ** q
            ps = Ps[b]
            ps = ps + (eq - ps) * cas if eq > ps else ps + (eq - ps) * crs
            Ps[b] = ps
            d = 10.0 / q * math.log10((eq + eps) / (ps + eps))
            s = 1.0 - math.exp(-((d / d0) ** p)) if d > 0 else 0.0
            if wneg > 0 and d < 0:
                s += wneg * (1.0 - math.exp(-((-d / d0) ** p)))
            if a > 0:
                lt = Lt[b] + (pf - Lt[b]) * clt
                Lt[b] = lt
                r = lt / (pf + eps)
                if r > 1.0:
                    r = 1.0
                s = s * (1.0 - adbg * a * math.sqrt(r))
            sv = Sv[b]
            if s >= sv:
                sv = s
                age[b] = 0.0
            else:
                age[b] += 1.0
                if age[b] > hold:
                    sv += (s - sv) * cgs
            Sv[b] = sv
            S[j, b] = sv
    return S


def process(x, prm=None, em=27.0, bands=None, adaptive=0.0):
    """x (2, n) -> y (2, n) aligné (latence retirée). Module Transient seul."""
    prm = dict(DEFAULT, **(prm or {}))
    N = int(prm["N"])
    H = N // 4
    Nd = N // 4
    Hd = Nd // 4
    bands = bands if bands is not None else [100.0] * 26
    n = x.shape[1]
    key = (x.__array_interface__["data"][0], x.shape, float(np.sum(x[:, ::997])), N)
    if key not in _CACHE:  # les analyses ne dépendent que du signal : gardées pour le calage
        if len(_CACHE) > 64:
            _CACHE.clear()
        xx = np.concatenate([np.zeros((2, N)), x, np.zeros((2, 4 * N + int(0.013 * SR)))], axis=1)
        win = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N))
        P, Z = stft_power(xx, N, H, win)
        W = band_weights(N)
        wd = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(Nd) / Nd)
        Pd, _ = stft_power(xx, Nd, Hd, wd)
        Ed = Pd @ band_weights(Nd).T
        # bandes graves (centre < 1 kHz) : la petite trame est trop grossière en fréquence (cases de 375 Hz) ;
        # on y prend l'énergie de la dernière grande trame disponible (cases de 94 Hz), comme le cœur temps réel
        Em = P @ W.T
        cnt = np.arange(Ed.shape[0]) * Hd + Nd - N
        mav = np.floor((cnt - 1) / H).astype(int)
        ok = mav >= 0
        Ed[:, :LOW_BANDS] = 0.0
        Ed[ok, :LOW_BANDS] = Em[np.minimum(mav[ok], Em.shape[0] - 1), :LOW_BANDS]
        _CACHE[key] = (xx.shape[1], win, Z, W, Ed)
    nxx, win, Z, W, Ed = _CACHE[key]
    nfr = Z.shape[0]
    # détection
    S = detect(Ed, prm, Hd, adaptive)
    # trame de synthèse m (centre mH + N/2) <- détection centrée en mH + N/2 + la (max sur ±H/2)
    la = prm["la_ms"] * 0.001 * SR
    jc = (np.arange(nfr) * H + N / 2 + la - Nd / 2) / Hd
    j0 = np.clip(np.ceil(jc - (H / 2) / Hd).astype(int), 0, S.shape[0] - 1)
    j1 = np.clip(np.floor(jc + (H / 2) / Hd).astype(int), 0, S.shape[0] - 1)
    Sm = np.zeros((nfr, 26))
    for k in range(int(np.max(j1 - j0)) + 1):
        jj = np.minimum(j0 + k, j1)
        Sm = np.maximum(Sm, S[jj])
    A = em_excess(em) * np.asarray(bands, float) / 100.0
    G = 1.0 + Sm * A[None, :]
    gb = G @ W
    gfull = np.concatenate([gb, gb[:, -2:0:-1]], axis=1)
    yf = np.fft.ifft(Z * gfull, axis=1) * win[None, :]
    # addition-recouvrement vectorisée (pas H = N/4 : 4 quarts de trame)
    q = N // H
    out2 = np.zeros((nfr + q, H), complex)
    for b in range(q):
        out2[b:b + nfr] += yf[:, b * H:(b + 1) * H]
    out = out2.reshape(-1)[:nxx] / ((N / H) / 2.0)
    return np.vstack([out.real, out.imag])[:, N:N + n]


_CACHE = {}
LOW_BANDS = 7   # bandes 1 à 7 (0 à 878 Hz) : énergie de la grande trame pour la détection
