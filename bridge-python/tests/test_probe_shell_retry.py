# -*- coding: utf-8 -*-
r"""
Shells Waves (WaveShell) : délai de lecture long (1re fois sur un PC) et nouvel essai à chaque
démarrage du pont quand la lecture a échoué ou rendu une liste vide (au lieu d'un « groupe » à vie).

    ..\desktop\venv\Scripts\python.exe -m unittest discover -s tests -p "test_probe_shell_retry.py"
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vst_probe  # noqa: E402

SHELL = r"C:\VST3\WaveShell1-VST3 17.4_x64.vst3"
AT = r"C:\VST3\Auto-Tune Pro.vst3"


class ShellRetry(unittest.TestCase):
    def setUp(self):
        vst_probe._shells_retried.clear()

    def test_reconnait_les_shells(self):
        self.assertTrue(vst_probe.is_shell(SHELL))
        self.assertFalse(vst_probe.is_shell(AT))
        self.assertGreaterEqual(vst_probe.SHELL_TIMEOUT_S, 120)

    def test_relu_une_fois_si_echec_ou_vide(self):
        for hit in ({"st": "hang", "c": None}, {"st": "ok", "c": []}, {"st": "crash", "c": None}):
            vst_probe._shells_retried.clear()
            self.assertTrue(vst_probe._shell_needs_retry(SHELL, hit), hit)
        vst_probe._shells_retried.add(SHELL)
        self.assertFalse(vst_probe._shell_needs_retry(SHELL, {"st": "hang", "c": None}))  # une fois par démarrage

    def test_pas_relu_si_lu_ou_pas_un_shell(self):
        self.assertFalse(vst_probe._shell_needs_retry(SHELL, {"st": "ok", "c": [["C6 Stereo", "Fx"]]}))
        self.assertFalse(vst_probe._shell_needs_retry(AT, {"st": "hang", "c": None}))

    def test_probe_bundles_relit_le_shell_echoue(self):
        fp = (1.0, 10)
        cache = {SHELL: {"m": fp[0], "s": fp[1], "st": "hang", "c": None},
                 AT: {"m": fp[0], "s": fp[1], "st": "ok", "c": [["Auto-Tune Pro", "Fx|Pitch Shift"]]}}
        lus = []

        def fake_child(_cmd, paths, results, on_done):
            for p in paths:
                lus.append(p)
                results[p] = {"c": [("C6 Stereo", "Fx|Dynamics", "Waves")], "st": "ok"}
                on_done()

        saved = (vst_probe._load_cache, vst_probe._save_cache, vst_probe._fingerprint, vst_probe._run_child, vst_probe.platform.system)
        vst_probe._load_cache = lambda: dict(cache)
        vst_probe._save_cache = lambda d: None
        vst_probe._fingerprint = lambda b: fp
        vst_probe._run_child = fake_child
        vst_probe.platform.system = lambda: "Windows"
        try:
            res = vst_probe.probe_bundles([SHELL, AT], "x")
            self.assertEqual(lus, [SHELL])                       # seul le shell échoué est relu
            self.assertEqual(res[SHELL]["c"][0][0], "C6 Stereo")
            self.assertEqual(res[AT]["st"], "ok")
            lus.clear()
            cache[SHELL] = {"m": fp[0], "s": fp[1], "st": "hang", "c": None}
            vst_probe.probe_bundles([SHELL], "x")
            self.assertEqual(lus, [])                            # pas deux fois dans le même démarrage
        finally:
            (vst_probe._load_cache, vst_probe._save_cache, vst_probe._fingerprint, vst_probe._run_child, vst_probe.platform.system) = saved


if __name__ == "__main__":
    unittest.main(verbosity=2)
