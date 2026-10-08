"""Tour 3 : formes des bandes de l'égaliseur de l'original -> table NOVA (dB par case de la STFT 512).
1. linéarité : la bande à −6 / +3 dB a-t-elle la même forme (en dB) que +6 dB ? combinaison en dB ?
2. NOVA applique un gain par case de la STFT (fenêtres racine de Hann 512, pas 128) : la réponse
   effective est lissée par la fenêtre. On cherche, pour chaque bande, les gains par case (dB) qui
   donnent la forme mesurée (pré-compensation itérative), puis on vérifie sur des combinaisons.
Sortie : elevate/eq_shapes.json  (26 x 257 : dB par case pour +1 dB de réglage)."""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
T3 = r"D:\1 WORK\CONTENU\nova-labo\elevate\tour3"
SR, N, H = 48000, 512, 128
NH = N // 2 + 1
FB = np.arange(NH) * SR / N


_X = {}


def eff_response(gbin_lin, nfft=8192):
    """Réponse effective mesurée : bruit blanc traité par la STFT (racine de Hann 512 / pas 128,
    gains réels par case, même normalisation que le cœur NOVA), estimation de Welch."""
    from scipy import signal as sps
    from tour3_plafond import stft, istft
    if "x" not in _X:
        _X["x"] = np.random.default_rng(3).standard_normal(4 * SR)
        _X["X"] = stft(_X["x"])
    x = _X["x"]
    X, win, nxx = _X["X"]
    y = istft(X * gbin_lin[None, :], win, nxx, len(x))
    f, pxx = sps.welch(x, SR, nperseg=nfft)
    _, pxy = sps.csd(x, y, SR, nperseg=nfft)
    return f, pxy / pxx


def main():
    d = json.load(open(os.path.join(T3, "eq_formes.json")))
    fq = np.array(d["freq"])
    # 1. linéarité
    for b in (1, 2, 3, 8, 20):
        p = np.array(d[f"b{b}_+6"]) / 6
        m = np.array(d[f"b{b}_-6"]) / -6
        t = np.array(d[f"b{b}_+3"]) / 3 if f"b{b}_+3" in d else p
        print(f"bande {b:2d} : forme +6 vs −6 écart max {np.max(np.abs(p - m)) * 6:5.2f} dB ; +6 vs +3 {np.max(np.abs(p - t)) * 6:5.2f} dB")
    # somme des formes (partition de l'unité en dB ?)
    S = np.array([np.array(d[f"b{b}_+6"]) / 6 for b in range(1, 27)])
    ssum = S.sum(0)
    print("somme des 26 formes (dB/dB) : min", round(float(ssum.min()), 3), "max", round(float(ssum.max()), 3))
    # 2. pré-compensation : cible par case = forme mesurée interpolée aux fréquences des cases (+6 dB)
    shapes = np.zeros((26, NH))
    f8k = None
    for b in range(26):
        tgt_db = np.interp(FB, fq, (S[b] * 6))
        g = 10 ** (tgt_db / 20)
        for _ in range(12):
            f, Hf = eff_response(g)
            act = np.interp(FB, f, 20 * np.log10(np.abs(Hf) + 1e-12))
            g = g * 10 ** ((tgt_db - act) / 20 * 0.8)
        shapes[b] = 20 * np.log10(g) / 6
        f, Hf = eff_response(g)
        err = np.interp(fq[fq < 20000], f, 20 * np.log10(np.abs(Hf) + 1e-12)) - S[b][fq < 20000] * 6
        print(f"bande {b + 1:2d} : écart après pré-compensation max {np.max(np.abs(err)):5.2f} dB")
    json.dump({"bins_hz": FB.round(3).tolist(), "shapes_db_per_db": shapes.round(5).tolist()},
              open(os.path.join(HERE, "eq_shapes.json"), "w"))


if __name__ == "__main__":
    main()
