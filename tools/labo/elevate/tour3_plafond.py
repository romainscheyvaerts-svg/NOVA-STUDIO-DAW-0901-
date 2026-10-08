"""Tour 3 : plafond atteignable par un modèle « gains par bande » (oracle).
On mesure, trame par trame, le gain RÉEL de l'original dans chacune des 26 bandes
(même banc de filtres que NOVA), on l'applique à l'entrée, et on compare à l'original.
Si même l'oracle ne descend pas sous −30 dB, la structure (gains par bande lissés) est en cause.
Usage : python elevate/tour3_plafond.py"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import modele  # noqa: E402

AUD = r"D:\1 WORK\CONTENU\nova-labo\elevate\audio_vst"


def stft(x, N=512, H=128):
    win = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N))
    xx = np.concatenate([np.zeros(N), x, np.zeros(2 * N)])
    nfr = (len(xx) - N) // H + 1
    idx = np.arange(N)[None, :] + H * np.arange(nfr)[:, None]
    return np.fft.rfft(xx[idx] * win, axis=1), win, len(xx)


def istft(Z, win, nxx, n, N=512, H=128):
    yf = np.fft.irfft(Z, N, axis=1) * win
    out = np.zeros(nxx)
    for j in range(Z.shape[0]):
        out[j * H:j * H + N] += yf[j]
    return out[N:N + n] / ((N / H) / 2.0)


def null(a, b):
    return 10 * np.log10(np.sum((a - b) ** 2) / np.sum(a ** 2))


def main():
    W = modele.band_weights(512)
    for tag in ("lim_g8_noadapt", "lim_romain", "romain"):
        for nm in ("batterie", "mix"):
            x = np.load(os.path.join(AUD, f"in16_{nm}.npy")).astype(np.float64)
            yv = np.load(os.path.join(AUD, f"{tag}_{nm}.npy")).astype(np.float64)
            res = []
            for ch in range(1):
                X, win, nxx = stft(x[ch])
                Y, _, _ = stft(yv[ch])
                n = x.shape[1]
                # oracle par case (gain réel, phase de l'entrée)
                gk = np.abs(Y) / np.maximum(np.abs(X), 1e-12)
                y1 = istft(X * np.minimum(gk, 10), win, nxx, n)
                # oracle complexe par case (gain + phase) : borne « tout ce qu'un filtre variant par trame peut faire »
                y0 = istft(Y, win, nxx, n)
                # oracle par bande (26 bandes)
                Ex = (np.abs(X) ** 2) @ W.T
                Ey = (np.abs(Y) ** 2) @ W.T
                Gb = np.sqrt(Ey / np.maximum(Ex, 1e-20))
                y2 = istft(X * (Gb @ W), win, nxx, n)
                # oracle large bande (un seul gain par trame)
                gw = np.sqrt(np.sum(np.abs(Y) ** 2, 1) / np.maximum(np.sum(np.abs(X) ** 2, 1), 1e-20))
                y3 = istft(X * gw[:, None], win, nxx, n)
                a = yv[ch]
                res = [null(a, y0), null(a, y1), null(a, y2), null(a, y3)]
            print(f"{tag:15s} {nm:9s} reconstr {res[0]:6.1f} | oracle par case {res[1]:6.1f} | par bande {res[2]:6.1f} | large bande {res[3]:6.1f}", flush=True)


if __name__ == "__main__":
    main()
