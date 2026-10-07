"""Tests du service de séparation de stems (sans PyTorch : faux moteur).

    venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_stems*.py"
"""
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import stems_service  # noqa: E402
from stems_service import StemsService, StemsNotInstalled, StemsCancelled, StemsError  # noqa: E402

# Faux stems_worker.py : même protocole JSON que le vrai, comportement choisi
# par la variable FAKE_MODE écrite dans un fichier à côté (ok / slow / error).
FAKE_WORKER = r'''
import json, sys, time, os, struct, argparse
from pathlib import Path
ap = argparse.ArgumentParser()
for a in ("--input", "--outdir", "--model", "--device"):
    ap.add_argument(a)
ap.add_argument("--stems", type=int)
a = ap.parse_args()
mode = (Path(__file__).parent / "mode.txt").read_text().strip()
def emit(**kw):
    print(json.dumps(kw), flush=True)
emit(event="progress", pct=1, message="Lecture du morceau")
if mode == "error":
    emit(event="error", message="RuntimeError: CUDA out of memory")
    sys.exit(1)
if mode == "crash":
    sys.stderr.write("Traceback: boom\n")
    sys.exit(3)
steps = 200 if mode == "slow" else 3
for i in range(steps):
    emit(event="progress", pct=5 + 90 * (i + 1) / steps, message="Séparation en cours")
    time.sleep(0.05 if mode == "slow" else 0)
out = Path(a.outdir)
keys = ["vocals", "instrumental"] if a.stems == 2 else ["vocals", "drums", "bass", "other"]
res = []
for k in keys:
    p = out / (k + ".wav")
    p.write_bytes((Path(a.input)).read_bytes())
    res.append({"key": k, "path": str(p), "rms": 0.1})
emit(event="done", stems=res, seconds=0.1, device="cpu")
'''


class StemsServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "stems"
        self.out = root / "out"
        self.home.mkdir()
        self.svc = StemsService(self.home, self.out, python_exe=Path(sys.executable))
        self.svc._refresh_worker = lambda: None  # garde le faux moteur
        self.wav = root / "in.wav"
        sr = 8000
        t = np.arange(sr) / sr
        stems_service.write_wav_float(self.wav, np.stack([np.sin(2 * np.pi * 440 * t)] * 2).astype("float32"), sr)

    def tearDown(self):
        self.tmp.cleanup()

    def install_fake(self, mode="ok"):
        (self.home / "stems_worker.py").write_text(FAKE_WORKER, encoding="utf-8")
        (self.home / "mode.txt").write_text(mode)
        (self.home / "installed.json").write_text(json.dumps({"variant": "cpu", "model": "htdemucs"}))

    # --- module absent ------------------------------------------------------------

    def test_module_absent(self):
        st = self.svc.status()
        self.assertFalse(st["installed"])
        self.assertFalse(st["installing"])
        with self.assertRaises(StemsNotInstalled) as cm:
            self.svc.separate("j1", self.wav, self.out / "a", 4)
        self.assertIn("pas encore installée", str(cm.exception))

    def test_installation_incomplete_is_not_installed(self):
        # installed.json absent = installation coupée en route
        (self.home / "stems_worker.py").write_text(FAKE_WORKER, encoding="utf-8")
        self.assertFalse(self.svc.status()["installed"])

    # --- séparation -----------------------------------------------------------------

    def test_separation_4_stems_progress_and_french_names(self):
        self.install_fake("ok")
        events = []
        res = self.svc.separate("j1", self.wav, self.out / "a", 4, events.append)
        self.assertEqual([s["label"] for s in res["stems"]], ["Voix", "Batterie", "Basse", "Autres"])
        for s in res["stems"]:
            self.assertTrue(Path(s["path"]).is_file())
            self.assertTrue(s["path"].endswith(f"{s['label']}.wav"))
        self.assertTrue(any(e.get("event") == "progress" for e in events))
        self.assertEqual(self.svc.status()["busy"], 0)

    def test_separation_2_stems(self):
        self.install_fake("ok")
        res = self.svc.separate("j2", self.wav, self.out / "b", 2)
        self.assertEqual([s["key"] for s in res["stems"]], ["vocals", "instrumental"])
        self.assertEqual([s["label"] for s in res["stems"]], ["Voix", "Instru"])

    def test_bad_stem_count(self):
        self.install_fake("ok")
        with self.assertRaises(StemsError):
            self.svc.separate("j3", self.wav, self.out / "c", 3)

    # --- erreurs ---------------------------------------------------------------------

    def test_worker_error_is_clear(self):
        self.install_fake("error")
        with self.assertRaises(StemsError) as cm:
            self.svc.separate("j4", self.wav, self.out / "d", 4)
        self.assertNotIsInstance(cm.exception, StemsCancelled)
        self.assertIn("mémoire", str(cm.exception))

    def test_worker_crash_reports_stderr(self):
        self.install_fake("crash")
        with self.assertRaises(StemsError) as cm:
            self.svc.separate("j5", self.wav, self.out / "e", 2)
        self.assertIn("boom", str(cm.exception))

    # --- annulation ------------------------------------------------------------------

    def test_cancel(self):
        self.install_fake("slow")
        got = {}
        started = threading.Event()

        def run():
            try:
                self.svc.separate("j6", self.wav, self.out / "f", 4, lambda e: started.set())
            except Exception as e:  # noqa: BLE001
                got["e"] = e

        th = threading.Thread(target=run)
        th.start()
        self.assertTrue(started.wait(15))
        self.assertTrue(self.svc.cancel("j6"))
        th.join(20)
        self.assertFalse(th.is_alive())
        self.assertIsInstance(got.get("e"), StemsCancelled)
        self.assertFalse((self.out / "f" / ".partiel").exists())
        self.assertEqual(self.svc.status()["busy"], 0)
        self.assertFalse(self.svc.cancel("j6"))  # plus rien à annuler

    def test_cancel_unknown_job(self):
        self.assertFalse(self.svc.cancel("rien"))

    # --- WAV ---------------------------------------------------------------------------

    def test_wav_roundtrip(self):
        a = (np.random.default_rng(1).standard_normal((2, 1000)) * 0.1).astype("float32")
        p = Path(self.tmp.name) / "rt.wav"
        stems_service.write_wav_float(p, a, 44100)
        b, sr = stems_service.read_wav(p)
        self.assertEqual(sr, 44100)
        np.testing.assert_array_equal(a, b)

    def test_wav_pcm24(self):
        import struct
        p = Path(self.tmp.name) / "p24.wav"
        vals = [0, 1 << 22, -(1 << 22)]
        data = b"".join(struct.pack("<i", v)[:3] for v in vals)
        fmt = struct.pack("<HHIIHH", 1, 1, 48000, 48000 * 3, 3, 24)
        p.write_bytes(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<I", 16) + fmt
                      + b"data" + struct.pack("<I", len(data)) + data)
        a, sr = stems_service.read_wav(p)
        np.testing.assert_allclose(a[0], [0, 0.5, -0.5])

    def test_safe_name(self):
        self.assertEqual(stems_service.safe_name('Beat: "test"/v2?'), "Beat test v2")
        self.assertEqual(stems_service.safe_name("   "), "clip")


class InstallerCancelTest(unittest.TestCase):
    def test_install_cancel_before_start(self):
        import stems_install
        with tempfile.TemporaryDirectory() as d:
            inst = stems_install.Installer(Path(d), "cpu", "htdemucs", on_event=lambda e: None)
            inst.cancel()
            with self.assertRaises(stems_install.InstallCancelled):
                inst.run([sys.executable, "-c", "print(1)"], "test", 0, 10, "test")
            inst.close()

    def test_install_cancel_kills_running_step(self):
        import stems_install
        with tempfile.TemporaryDirectory() as d:
            inst = stems_install.Installer(Path(d), "cpu", "htdemucs", on_event=lambda e: None)
            err = {}

            def run():
                try:
                    inst.run([sys.executable, "-c", "import time; time.sleep(60)"], "test", 0, 10, "test")
                except Exception as e:  # noqa: BLE001
                    err["e"] = e

            th = threading.Thread(target=run)
            th.start()
            for _ in range(100):
                if inst.proc is not None:
                    break
                time.sleep(0.05)
            inst.cancel()
            th.join(20)
            self.assertIsInstance(err.get("e"), stems_install.InstallCancelled)
            inst.close()


if __name__ == "__main__":
    unittest.main()
