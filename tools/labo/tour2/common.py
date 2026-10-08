"""Outils communs du tour 2 du labo : signaux réels, null tests, LTI, coûts."""
import importlib, json, os, sys
import numpy as np
from scipy import signal as sps

HERE = os.path.dirname(os.path.abspath(__file__))
LABO_DIR = os.path.dirname(HERE)
sys.path.insert(0, LABO_DIR)
import bench  # noqa: E402
from modeles import analog_comp as ac  # noqa: E402

LABO = r"D:\1 WORK\CONTENU\nova-labo"
SR = 48000


def banc_mod(bn):
    return importlib.import_module(f"bancs.{bn}")


def real_cases(banc, extra=()):
    """[(case_name, test_name, settings, x, y_vst)] pour les signaux réels mesurés."""
    out = []
    for c in list(banc.CASES) + list(extra):
        for t in c["tests"]:
            if t["type"] != "real_signal":
                continue
            fn = os.path.join(LABO, banc.ID, "audio_vst", f"{c['name']}__{t['name']}.npy")
            if not os.path.exists(fn):
                continue
            x = bench.load_audio(t["path"], t.get("seconds"), t.get("offset", 0.0), t.get("rms_db"))
            y = np.load(fn).astype(np.float64)
            n = min(x.shape[1], y.shape[1])
            out.append((c["name"], t["name"], c["settings"], np.ascontiguousarray(x[:, :n]), y[:, :n]))
    return out


def null_db(a, b):
    d = a - b
    return float(10 * np.log10(np.sum(d ** 2) / max(np.sum(a ** 2), 1e-30)))


def lti_correct(a, b, taps=513, nper=8192):
    """Meilleur FIR h (centré) tel que h*b ≈ a (estimation de Welch)."""
    _, pbb = sps.welch(b, SR, nperseg=nper)
    _, pab = sps.csd(b, a, SR, nperseg=nper)
    H = pab / np.maximum(pbb, 1e-30)
    h = np.fft.irfft(H)
    h = np.roll(h, taps // 2)[:taps] * np.hanning(taps)
    return np.convolve(b, h, mode="full")[taps // 2: taps // 2 + len(b)], H


def model_run(build, settings, x):
    P, l0, dl, tab = build(settings)
    y, A = ac.process(np.ascontiguousarray(x, dtype=np.float64), P, float(l0), float(dl), np.ascontiguousarray(tab, dtype=np.float64))
    return y, A
