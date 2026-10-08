"""Décomposition des null tests (tour 2) : quelle part de l'écart vient
- du linéaire (filtre fixe : mieux corrigé par un FIR LTI des moindres carrés),
- de la dynamique (trajectoire de gain),
- du reste (non linéaire).
Usage : python -m tour2.diag_decomp <banc> <cas> <test> [mode=py]"""
import importlib, json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bench  # noqa
LABO = r"D:\1 WORK\CONTENU\nova-labo"


def lti_fit(a, b, taps=257):
    """Meilleur FIR (centré) h tel que h*b ≈ a, moindres carrés (domaine fréquentiel, Welch)."""
    from scipy import signal as sps
    f, pbb = sps.welch(b, 48000, nperseg=4096)
    _, pab = sps.csd(b, a, 48000, nperseg=4096)
    H = pab / np.maximum(pbb, 1e-30)
    h = np.fft.irfft(H)
    h = np.roll(h, taps // 2)[:taps] * np.hanning(taps)
    return np.convolve(b, h, mode="full")[taps // 2: taps // 2 + len(b)]


def st_gain(x, y, w=480):
    n = (min(len(x), len(y)) // w) * w
    ex = np.sqrt(np.mean(x[:n].reshape(-1, w) ** 2, 1)); ey = np.sqrt(np.mean(y[:n].reshape(-1, w) ** 2, 1))
    return 20 * np.log10(np.maximum(ey, 1e-9) / np.maximum(ex, 1e-9)), 20 * np.log10(np.maximum(ex, 1e-9))


def decomp(x, ya, yb):
    n = min(ya.shape[1], yb.shape[1], x.shape[1])
    a, b, xx = ya[0, :n], yb[0, :n], x[0, :n]
    raw = 10 * np.log10(np.sum((a - b) ** 2) / np.sum(a ** 2))
    bl = lti_fit(a, b)
    lti = 10 * np.log10(np.sum((a - bl) ** 2) / np.sum(a ** 2))
    ga, lx = st_gain(xx, a); gb, _ = st_gain(xx, b)
    m = lx > -50
    d = (gb - ga)[m]
    return {"null": round(raw, 2), "null_apres_LTI": round(lti, 2), "gain_err_moy": round(float(np.mean(d)), 2),
            "gain_err_rms": round(float(np.sqrt(np.mean(d ** 2))), 2), "gain_err_p95": round(float(np.percentile(np.abs(d), 95)), 2)}


if __name__ == "__main__":
    bn, case, test = sys.argv[1:4]
    mode = sys.argv[4] if len(sys.argv) > 4 else "py"
    banc = importlib.import_module(f"bancs.{bn}")
    c = next(c for c in banc.CASES if c["name"] == case)
    t = next(t for t in c["tests"] if t.get("name") == test)
    x = bench.load_audio(t["path"], t.get("seconds"), t.get("offset", 0.0), t.get("rms_db"))
    ya = np.load(os.path.join(LABO, banc.ID, "audio_vst", f"{case}__{test}.npy")).astype(float)
    yb = np.load(os.path.join(LABO, banc.ID, f"audio_nova_{mode}", f"{case}__{test}.npy")).astype(float)
    print(bn, case, test, mode, decomp(x, ya, yb))
    # plafond « gain pur » : la sortie VST expliquée par x * gain lissé (5 ms)
    a = ya[0, :x.shape[1]]; xx = x[0, :len(a)]
    w = 240
    from scipy.ndimage import uniform_filter1d
    g = uniform_filter1d(a * xx, w) / np.maximum(uniform_filter1d(xx * xx, w), 1e-12)
    yl = lti_fit(a, xx * g)
    print("  plafond gain-pur+LTI :", round(10 * np.log10(np.sum((a - yl) ** 2) / np.sum(a ** 2)), 2))
