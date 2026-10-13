"""Tests du module « voix par l'IA locale » (R24) côté pont : service, déréverbération,
transcription, installation (sans Whisper ni DeepFilterNet : faux moteur).

    venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_voice*.py"
"""
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deverb_service  # noqa: E402
import transcribe_service  # noqa: E402
import voice_install  # noqa: E402
import voice_worker  # noqa: E402
from voice_service import VoiceCancelled, VoiceError, VoiceNotInstalled, VoiceService  # noqa: E402

# Faux voice_worker.py : même protocole JSON que le vrai ; mode choisi dans mode.txt.
FAKE_WORKER = r'''
import json, sys, time, argparse, struct
from pathlib import Path
ap = argparse.ArgumentParser()
ap.add_argument("command")
ap.add_argument("--input"); ap.add_argument("--output"); ap.add_argument("--language"); ap.add_argument("--model")
a = ap.parse_args()
mode = (Path(__file__).parent / "mode.txt").read_text().strip()
JOB = None
def emit(**kw):
    if JOB is not None:
        kw["job"] = JOB
    print(json.dumps(kw), flush=True)
def work(command, language, model, output=None, inp=None):
    emit(event="progress", pct=1, message="Lecture de la voix")
    if mode == "error":
        emit(event="error", message="RuntimeError: CUDA out of memory"); return False
    if mode == "crash":
        sys.stderr.write("Traceback: boom\n"); sys.exit(3)
    emit(event="device", device="cuda", name="RTX")
    steps = 300 if mode == "slow" else 3
    for i in range(steps):
        emit(event="progress", pct=5 + 90 * (i + 1) / steps, message="En cours")
        time.sleep(0.05 if mode == "slow" else 0)
    if command == "deverb":
        Path(output).write_bytes(Path(inp).read_bytes())  # « traitement » : copie
        emit(event="done", path=output, device="cpu", seconds=0.1, engine="deepfilternet3")
    else:
        emit(event="done", words=[{"w": "Silence", "s": 0.1, "e": 0.5, "p": 0.9, "b": True}, {"w": "blanc", "s": 0.6, "e": 0.9, "p": 0.8}, {"w": " ", "s": 1, "e": 1}],
             segments=[{"s": 0.1, "e": 0.9, "text": "Silence blanc"}], language=language if language != "mix" else "fr",
             model=model, device="cuda", seconds=0.2, duration=1.0)
    return True
if a.command == "serve":
    # Mode B7 : modèle « chargé » une fois (compté dans loads.txt), demandes à la suite.
    loads = Path(__file__).parent / "loads.txt"
    loads.write_text(str(int(loads.read_text() or 0) + 1) if loads.exists() else "1")
    emit(event="ready", pid=0)
    for line in sys.stdin:
        req = json.loads(line)
        if req.get("cmd") == "quit":
            break
        JOB = req["job"]
        mode = (Path(__file__).parent / "mode.txt").read_text().strip()
        lang = req.get("language") or "fr"
        work("transcribe", lang if lang in ("fr", "en", "mix", "auto") else "fr", req.get("model"))
        JOB = None
    sys.exit(0)
ok = work(a.command, a.language, a.model, a.output, a.input)
sys.exit(0 if ok else 1)
'''


class VoiceServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "voice"
        self.home.mkdir()
        self.svc = VoiceService(self.home, python_exe=Path(sys.executable))
        self.svc._refresh_worker = lambda: None  # garde le faux moteur
        self.audio = (0.1 * np.sin(2 * np.pi * 220 * np.arange(24000) / 24000)).astype(np.float32)[None]

    def tearDown(self):
        self.svc.stop_server()
        self.tmp.cleanup()

    def install_fake(self, mode="ok", features=("transcribe", "deverb")):
        (self.home / "voice_worker.py").write_text(FAKE_WORKER, encoding="utf-8")
        (self.home / "mode.txt").write_text(mode)
        info = {"env": {"python": "3.12", "packages": ["base", "whisper"]}, "features": {f: {"model": "large-v3-turbo", "device": "cuda"} for f in features}}
        (self.home / "installed.json").write_text(json.dumps(info))

    # --- état ----------------------------------------------------------------------

    def test_absent_then_feature_by_feature(self):
        st = self.svc.status()
        self.assertFalse(st["features"]["transcribe"]["installed"])
        self.assertFalse(st["features"]["deverb"]["installed"])
        self.assertGreater(st["features"]["deverb"]["download_bytes"], voice_install.DEEPFILTER_BYTES)
        self.install_fake(features=("deverb",))
        st = self.svc.status()
        self.assertTrue(st["features"]["deverb"]["installed"])
        self.assertFalse(st["features"]["transcribe"]["installed"])
        with self.assertRaises(VoiceNotInstalled):
            transcribe_service.transcribe(self.svc, "j1", self.audio, 24000)

    def test_download_estimate_reuses_env_and_stems_cublas(self):
        est_full = voice_install.download_estimate(self.home, "transcribe", "cuda")
        self.install_fake()
        py = voice_install.env_python(self.home)
        py.parent.mkdir(parents=True)
        py.write_bytes(b"")
        with mock.patch.object(voice_install, "stems_torch_lib", return_value=Path("x")):
            est = voice_install.download_estimate(self.home, "transcribe", "cuda")
        # Environnement déjà là et cuBLAS repris du module stems : seulement le modèle.
        self.assertEqual(est, voice_install.WHISPER_MODELS["large-v3-turbo"]["bytes"])
        base = voice_install.ENV_BYTES + voice_install.WHISPER_PKG_BYTES
        self.assertEqual(est_full - est, base + voice_install.CUBLAS_BYTES if voice_install.stems_torch_lib() is None else base)
        self.assertEqual(voice_install.download_estimate(self.home, "transcribe", "cpu"), voice_install.WHISPER_MODELS["large-v3-turbo"]["bytes"])
        # Déréverbération seule : le socle audio et DeepFilterNet, sans faster-whisper.
        (self.home / "installed.json").write_text(json.dumps({"env": {"packages": []}}))
        self.assertEqual(voice_install.download_estimate(self.home, "deverb"), voice_install.ENV_BYTES + voice_install.DEEPFILTER_BYTES)

    # --- calculs ---------------------------------------------------------------------

    def test_transcribe_words_and_progress(self):
        self.install_fake()
        events = []
        res = transcribe_service.transcribe(self.svc, "j1", np.stack([self.audio[0], self.audio[0]]), 24000, "mix", events.append)
        self.assertEqual([w["w"] for w in res["words"]], ["Silence", "blanc"])  # mot vide écarté
        self.assertTrue(res["words"][0]["b"])
        self.assertEqual(res["language"], "fr")
        self.assertEqual(res["model"], "large-v3-turbo")
        self.assertEqual(res["device"], "cuda")
        self.assertTrue(any(e.get("event") == "device" for e in events))
        self.assertGreaterEqual(sum(1 for e in events if e.get("event") == "progress"), 3)
        self.assertFalse((self.home / "work" / "j1").exists())  # fichiers de travail effacés

    def test_transcriptions_share_one_engine(self):
        """B7 : une piste de plusieurs prises ne recharge pas Whisper à chaque clip."""
        self.install_fake()
        for i in range(3):
            res = transcribe_service.transcribe(self.svc, f"p{i}", self.audio, 24000, "mix")
            self.assertEqual([w["w"] for w in res["words"]], ["Silence", "blanc"])
        self.assertEqual((self.home / "loads.txt").read_text(), "1")
        self.assertIsNotNone(self.svc.server)
        self.svc.stop_server()
        self.assertIsNone(self.svc.server)
        transcribe_service.transcribe(self.svc, "p3", self.audio, 24000)
        self.assertEqual((self.home / "loads.txt").read_text(), "2")  # relancé au besoin

    def test_idle_engine_is_released(self):
        self.install_fake()
        with mock.patch("voice_service.SERVER_IDLE_S", 0.3):
            transcribe_service.transcribe(self.svc, "i1", self.audio, 24000)
            proc = self.svc.server
            for _ in range(60):
                if self.svc.server is None and proc.poll() is not None:
                    break
                time.sleep(0.1)
        self.assertIsNone(self.svc.server)
        self.assertIsNotNone(proc.poll())  # mémoire de la carte rendue

    def test_engine_error_then_next_clip(self):
        self.install_fake("error")
        with self.assertRaises(VoiceError) as cm:
            transcribe_service.transcribe(self.svc, "e1", self.audio, 24000)
        self.assertIn("mémoire", str(cm.exception))
        (self.home / "mode.txt").write_text("ok")
        res = transcribe_service.transcribe(self.svc, "e2", self.audio, 24000)  # même moteur, toujours vivant
        self.assertEqual(len(res["words"]), 2)

    def test_deverb_roundtrip_same_shape(self):
        self.install_fake()
        stereo = np.stack([self.audio[0], 0.5 * self.audio[0]])
        res = deverb_service.deverb(self.svc, "d1", stereo, 24000)
        self.assertEqual(res["audio"].shape, stereo.shape)
        self.assertEqual(res["sample_rate"], 24000)
        np.testing.assert_allclose(res["audio"], stereo, atol=1e-6)
        self.assertEqual(res["engine"], "deepfilternet3")

    def test_too_short_and_bad_language(self):
        self.install_fake()
        with self.assertRaises(VoiceError):
            deverb_service.deverb(self.svc, "d", self.audio[:, :100], 24000)
        with self.assertRaises(VoiceError):
            transcribe_service.transcribe(self.svc, "t", self.audio[:, :100], 24000)
        res = transcribe_service.transcribe(self.svc, "t2", self.audio, 24000, "klingon")
        self.assertEqual(res["language"], "fr")

    def test_worker_error_is_clear(self):
        self.install_fake("error")
        with self.assertRaises(VoiceError) as cm:
            deverb_service.deverb(self.svc, "e", self.audio, 24000)
        self.assertIn("mémoire", str(cm.exception))

    def test_worker_crash_reports_stderr(self):
        self.install_fake("crash")
        with self.assertRaises(VoiceError) as cm:
            transcribe_service.transcribe(self.svc, "c", self.audio, 24000)
        self.assertIn("boom", str(cm.exception))

    def test_cancel(self):
        self.install_fake("slow")
        out = {}

        def run():
            try:
                transcribe_service.transcribe(self.svc, "slow", self.audio, 24000)
            except Exception as e:
                out["e"] = e

        th = threading.Thread(target=run)
        th.start()
        for _ in range(100):
            if "slow" in self.svc.jobs:
                break
            time.sleep(0.05)
        time.sleep(0.3)
        self.assertTrue(self.svc.cancel("slow"))
        th.join(20)
        self.assertIsInstance(out.get("e"), VoiceCancelled)
        self.assertFalse(self.svc.cancel("inconnu"))

    def test_status_while_installing_and_cancel(self):
        started = threading.Event()

        class SlowInstaller:
            def __init__(self, *a, **k):
                self.stop = threading.Event()

            def install(self):
                started.set()
                self.stop.wait(10)
                raise voice_install.InstallCancelled("annulée")

            def cancel(self):
                self.stop.set()

            def close(self):
                pass

        events = []
        with mock.patch.object(voice_install, "Installer", SlowInstaller):
            self.assertTrue(self.svc.start_install("deverb", events.append))
            started.wait(5)
            st = self.svc.status()
            self.assertTrue(st["installing"])
            self.assertEqual(st["install_feature"], "deverb")
            self.assertFalse(self.svc.start_install("transcribe", events.append))  # une à la fois
            self.assertTrue(self.svc.cancel_install())
            self.svc.install_thread.join(5)
        self.assertEqual(events[-1]["event"], "cancelled")
        self.assertEqual(events[-1]["feature"], "deverb")
        with self.assertRaises(VoiceError):
            self.svc.start_install("inconnu", events.append)


class WorkerChunkingTest(unittest.TestCase):
    """Découpe en morceaux parallèles de la déréverbération : un filtre « neutre » doit rendre
    exactement le signal (pas de clic ni de décalage aux jonctions)."""

    def test_identity_filter_gives_input_back(self):
        sr = 48000
        rng = np.random.default_rng(1)
        x = (0.1 * rng.standard_normal((2, sr * 7 + 1234))).astype(np.float32)
        progress = []
        with mock.patch.object(voice_worker, "_df_chunk", lambda exe, chunk, work, i: chunk.copy()), \
                mock.patch.object(voice_worker, "deep_filter_exe", return_value=Path(sys.executable)):
            y = voice_worker.deverb(x, sr, jobs=3, on_progress=progress.append, chunk_s=2.0, preroll_s=0.5, xfade_s=0.05, late=False)
        self.assertEqual(y.shape, x.shape)
        np.testing.assert_allclose(y, x, atol=1e-6)
        self.assertEqual(progress[-1], 1.0)
        self.assertEqual(len(progress), 4)  # 7,03 s en morceaux de 2 s : 2 + 2 + 2 + 1,03

    def test_short_last_chunk_is_merged(self):
        sr = 48000
        x = np.ones((1, int(sr * 4.5)), np.float32)
        progress = []
        with mock.patch.object(voice_worker, "_df_chunk", lambda exe, chunk, work, i: chunk.copy()),                 mock.patch.object(voice_worker, "deep_filter_exe", return_value=Path(sys.executable)):
            y = voice_worker.deverb(x, sr, jobs=2, on_progress=progress.append, chunk_s=2.0, preroll_s=0.5, late=False)
        np.testing.assert_allclose(y, x, atol=1e-6)
        self.assertEqual(len(progress), 2)  # le dernier morceau (0,5 s) rejoint le précédent

    def test_missing_exe(self):
        with mock.patch.object(voice_worker, "deep_filter_exe", return_value=Path("introuvable.exe")):
            with self.assertRaises(FileNotFoundError):
                voice_worker.deverb(np.zeros((1, 48000), np.float32), 48000)

    def test_hallucinations_filtered(self):
        self.assertTrue(voice_worker.HALLUCINATIONS.search("Sous-titrage ST' 501"))
        self.assertTrue(voice_worker.HALLUCINATIONS.search("Merci d'avoir regardé cette vidéo"))
        self.assertFalse(voice_worker.HALLUCINATIONS.search("Silence blanc, tu prends toute la place"))

    def test_phrase_language_threshold(self):
        """B7 : du rap français mâché (anglais à 0,51-0,61) reste en français ; une vraie phrase anglaise (0,99) passe."""
        class M:
            def __init__(self, probs):
                self.probs = probs

            def detect_language(self, chunk):
                return "en", 0.0, list(self.probs.items())

        self.assertEqual(voice_worker.phrase_language(M({"en": 0.99, "fr": 0.001}), None), "en")
        self.assertEqual(voice_worker.phrase_language(M({"en": 0.57, "fr": 0.03}), None), "fr")
        self.assertEqual(voice_worker.phrase_language(M({"en": 0.85, "fr": 0.4}), None), "fr")

    def test_languages(self):
        self.assertEqual(voice_worker.LANGUAGES["fr"], "fr")
        self.assertIsNone(voice_worker.LANGUAGES["auto"])


class LateReverbTest(unittest.TestCase):
    """B7 : retrait de la réverbe tardive après DeepFilterNet (estimateur de Lebart / Habets).
    Voix simulée : rafales de bruit coupées net, passées dans une « pièce » (bruit à décroissance
    exponentielle, RT60 0,6 s)."""

    SR = 48000

    def room(self, rt60=0.6, seed=0):
        sr = self.SR
        rng = np.random.default_rng(seed)
        n = int(sr * 6)
        dry = np.zeros(n, np.float32)
        for k in range(5):  # 5 « phrases » de 0,5 s, séparées de 0,7 s de silence
            a = int(sr * (0.3 + 1.2 * k))
            dry[a: a + sr // 2] = 0.3 * rng.standard_normal(sr // 2)
        t = np.arange(int(sr * rt60 * 1.5)) / sr
        ir = rng.standard_normal(len(t)) * np.exp(-3 * np.log(10) * t / rt60)
        ir[0] = 6.0  # son direct
        ir /= np.abs(ir).max()
        nf = 1 << int(np.ceil(np.log2(n + len(ir))))
        wet = np.fft.irfft(np.fft.rfft(dry, nf) * np.fft.rfft(ir, nf), nf)[:n].astype(np.float32)
        return dry, wet / np.abs(wet).max() * 0.5

    def tail_db(self, x, dry):
        sr = self.SR
        vals = []
        for k in range(5):
            end = int(sr * (0.3 + 1.2 * k)) + sr // 2
            pre = np.mean(x[end - sr // 4: end] ** 2)
            post = np.mean(x[end + sr // 50: end + sr // 4] ** 2)
            vals.append(10 * np.log10(post / pre + 1e-14))
        return float(np.mean(vals))

    def test_rt60_read_on_the_take(self):
        _, wet = self.room(0.6)
        rt, n = voice_worker.rt60_estimate(wet, self.SR)
        self.assertGreater(n, 0)
        self.assertGreater(rt, 0.3)
        self.assertLess(rt, 1.2)
        self.assertEqual(voice_worker.rt60_estimate(np.zeros(100, np.float32), self.SR), (0.5, 0))

    def test_tail_is_reduced_voice_is_kept(self):
        dry, wet = self.room(0.6)
        rt, _ = voice_worker.rt60_estimate(wet, self.SR)
        y = voice_worker.suppress_late_reverb(wet[None], self.SR, rt)[0]
        self.assertEqual(y.shape, wet.shape)
        self.assertTrue(np.isfinite(y).all())
        # Sur ce bruit très réverbéré, l'étape seule retire ~5 dB de queue (sur de vraies voix
        # après DeepFilterNet : 4 à 11 dB de plus, mesures dans CONTENU\nova-r24\deverb).
        drop = self.tail_db(y, dry) - self.tail_db(wet, dry)
        self.assertLess(drop, -1.5)
        sr = self.SR
        post = lambda x: np.mean([np.mean(x[int(sr * (0.8 + 1.2 * k)) + sr // 50: int(sr * (0.8 + 1.2 * k)) + sr // 4] ** 2) for k in range(5)])
        self.assertLess(10 * np.log10(post(y) / post(wet)), -3.0)
        # La voix elle-même (pendant les phrases) garde son niveau à 3 dB près.
        act = np.abs(dry) > 0
        lvl = 10 * np.log10(np.mean(y[act] ** 2) / np.mean(wet[act] ** 2))
        self.assertGreater(lvl, -3.0)
        # Mesure sans voix sèche (renvoyée au pont) : de la réverbe en moins, sur les 5 fins.
        est, n = voice_worker.tail_reduction_db(wet, y, self.SR)
        self.assertEqual(n, 5)
        self.assertLess(est, 0.0)

    def test_stereo_image_and_short_clip(self):
        _, wet = self.room(0.5, seed=2)
        st = np.stack([wet, 0.5 * wet])
        y = voice_worker.suppress_late_reverb(st, self.SR, 0.5)
        self.assertEqual(y.shape, st.shape)
        np.testing.assert_allclose(y[1], 0.5 * y[0], atol=1e-5)  # même gain sur les deux canaux
        short = np.ones((1, 1000), np.float32)
        np.testing.assert_array_equal(voice_worker.suppress_late_reverb(short, self.SR, 0.5), short)

    def test_chunked_deverb_applies_late_stage(self):
        _, wet = self.room(0.6, seed=3)
        with mock.patch.object(voice_worker, "_df_chunk", lambda exe, chunk, work, i: chunk.copy()),                 mock.patch.object(voice_worker, "deep_filter_exe", return_value=Path(sys.executable)):
            info = {}
            y = voice_worker.deverb(wet[None], self.SR, jobs=2, chunk_s=2.0, preroll_s=0.5, info=info)
        self.assertEqual(y.shape, (1, len(wet)))
        self.assertIsNotNone(info["rt60"])
        self.assertLess(voice_worker.tail_reduction_db(wet, y[0], self.SR)[0], 0.0)


if __name__ == "__main__":
    unittest.main()
