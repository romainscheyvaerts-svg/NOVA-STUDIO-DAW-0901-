"""Tour 3 : plafonds complémentaires (résolution temporelle) : oracle par case à trames courtes,
gain large bande dans le temps (lissé), et cascade « bandes (512) puis gain large bande rapide »."""
import os, sys
import numpy as np
from scipy.ndimage import uniform_filter1d
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import modele
from tour3_plafond import null
AUD = r"D:\1 WORK\CONTENU\nova-labo\elevate\audio_vst"


def stft(x, N, H):
    win = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N))
    xx = np.concatenate([np.zeros(N), x, np.zeros(2 * N)])
    nfr = (len(xx) - N) // H + 1
    idx = np.arange(N)[None, :] + H * np.arange(nfr)[:, None]
    return np.fft.rfft(xx[idx] * win, axis=1), win, len(xx)


def istft(Z, win, nxx, n, N, H):
    yf = np.fft.irfft(Z, N, axis=1) * win
    out = np.zeros(nxx)
    for j in range(Z.shape[0]):
        out[j * H:j * H + N] += yf[j]
    return out[N:N + n] / ((N / H) / 2.0)


def tgain(a, b, w):
    return uniform_filter1d(a * b, w) / np.maximum(uniform_filter1d(b * b, w), 1e-14)


for tag in ("lim_romain",):
    for nm in ("batterie", "mix"):
        x = np.load(os.path.join(AUD, f"in16_{nm}.npy")).astype(np.float64)[0]
        a = np.load(os.path.join(AUD, f"{tag}_{nm}.npy")).astype(np.float64)[0]
        n = len(x); r = []
        for N, H in ((256, 64), (128, 32)):
            X, win, nxx = stft(x, N, H); Y, _, _ = stft(a, N, H)
            r.append(null(a, istft(X * np.minimum(np.abs(Y) / np.maximum(np.abs(X), 1e-12), 10), win, nxx, n, N, H)))
        for w in (48, 12, 3):
            r.append(null(a, x * tgain(a, x, w)))
        # cascade : bandes 512 (oracle) puis gain large bande rapide (oracle, 0,25 ms)
        W = modele.band_weights(512)
        X, win, nxx = stft(x, 512, 128); Y, _, _ = stft(a, 512, 128)
        Gb = np.sqrt(((np.abs(Y) ** 2) @ W.T) / np.maximum((np.abs(X) ** 2) @ W.T, 1e-20))
        yb = istft(X * (Gb @ W), win, nxx, n, 512, 128)
        for w in (48, 12):
            r.append(null(a, yb * tgain(a, yb, w)))
        print(nm, "par case 256:", round(r[0], 1), "128:", round(r[1], 1), "| large bande temps 1ms/0.25ms/0.06ms:", [round(v, 1) for v in r[2:5]],
              "| bandes+rapide 1ms/0.25ms:", [round(v, 1) for v in r[5:]], flush=True)
