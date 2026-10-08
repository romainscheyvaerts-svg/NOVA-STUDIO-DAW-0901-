"""Tests du calage « réduction cible » (sans plugin : compresseur simulé).

    venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_gr*.py"
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gr_calibration as gc  # noqa: E402

SR = 48000


class FakeComp:
    """Compresseur simple (seuil réglable, 3:1, montée 5 ms, retour 150 ms) + gain de sortie 6 dB."""

    def __init__(self):
        self.thr = -10.0

    def process(self, x, sr, buffer_size=512, reset=True):
        x = np.asarray(x, np.float64)
        m = np.abs(x).max(axis=0)
        env = 0.0
        a, r = 1 - np.exp(-1 / (0.005 * sr)), 1 - np.exp(-1 / (0.15 * sr))
        g = np.empty(x.shape[1])
        for i, v in enumerate(m):
            env += (v - env) * (a if v > env else r)
            lv = 20 * np.log10(max(env, 1e-9))
            gr = max(0.0, (lv - self.thr) * (1 - 1 / 3))
            g[i] = 10 ** (-gr / 20)
        return (x * g * 2.0).astype(np.float32)


def voice_like(seconds=4.0):
    rng = np.random.default_rng(3)
    t = np.arange(int(seconds * SR)) / SR
    env = 0.5 * (1 + np.sin(2 * np.pi * 1.3 * t)) ** 2 * (0.3 + 0.7 * (rng.random(len(t)) > 0.0))
    x = 0.25 * env * np.sin(2 * np.pi * 220 * t) * (1 + 0.3 * np.sin(2 * np.pi * 3 * t))
    return np.vstack([x, x]).astype(np.float32)


class GrCalibrationTests(unittest.TestCase):
    def test_vu_ballistics(self):
        # un palier de 10 dB tenu 1 s : le VU arrive à ~10 dB ; un pic de 10 ms reste bas
        step = 0.01
        long = np.r_[np.zeros(10), np.full(100, 10.0), np.zeros(50)]
        short = np.r_[np.zeros(10), np.full(1, 10.0), np.zeros(50)]
        self.assertAlmostEqual(gc.vu_max_gr(long, step), 10.0, delta=0.15)
        self.assertLess(gc.vu_max_gr(short, step), 2.0)

    def test_trace_reference_is_least_compressed(self):
        x = voice_like(2.0)
        y = x * 0.5  # gain constant : aucune réduction
        tr, _ = gc.gr_trace_from_io(x, y, SR)
        self.assertLess(tr.max(), 0.05)

    def test_bisection_reaches_target(self):
        comp = FakeComp()
        x = voice_like()

        def apply(v):
            comp.thr = v
        res = gc.calibrate_plugin(comp, apply, x, SR, lo=-40.0, hi=0.0, sense=-1, target=5.0)
        self.assertTrue(res["reached"], res)
        self.assertAlmostEqual(res["gr_db"], 5.0, delta=0.25)
        self.assertEqual(comp.thr, res["value"])

    def test_unreachable_says_why(self):
        comp = FakeComp()
        quiet = voice_like() * 1e-3
        res = gc.calibrate_plugin(comp, lambda v: setattr(comp, "thr", v), quiet, SR, lo=-40.0, hi=0.0, sense=-1, target=5.0)
        self.assertFalse(res["reached"])
        self.assertIn("faible", res["why"])


if __name__ == "__main__":
    unittest.main()
