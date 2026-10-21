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

    def test_shell_vide_masque(self):
        plugins = [{"name": "WaveShell1-VST3 14.12_x64", "vendor": "", "path": r"C:\VST3\WaveShell1-VST3 14.12_x64.vst3", "is_instrument": None, "category": "Effect"},
                   {"name": "WaveShell1-VST3 17.4_x64", "vendor": "", "path": SHELL, "is_instrument": None, "category": "Effect"},
                   {"name": "Bizarre", "vendor": "", "path": r"C:\VST3\Bizarre.vst3", "is_instrument": None, "category": "Effect"}]
        res = {plugins[0]["path"]: {"c": [], "st": "ok"},
               SHELL: {"c": [("C6 Stereo", "Fx|Dynamics", "Waves"), ("C6 Mono", "Fx|Dynamics", "Waves")], "st": "ok"},
               plugins[2]["path"]: {"c": None, "st": "hang"}}
        names = [p["name"] for p in vst_probe.apply_classes(plugins, res)]
        self.assertNotIn("WaveShell1-VST3 14.12_x64", names)   # vide : masqué
        self.assertIn("C6 Stereo", names)
        self.assertIn("Bizarre", names)                         # illisible (pas un shell) : gardé




class ShellsSequentiels(unittest.TestCase):
    """Deux WaveShell lus en même temps se bloquent l'un l'autre : tous dans un seul enfant,
    l'un après l'autre ; un shell resté muet est relu tout seul aussitôt."""

    def test_shells_dans_un_seul_enfant_et_relu_seul(self):
        vst_probe._shells_retried.clear()
        shells = [rf"C:\VST3\WaveShell1-VST3 {v}_x64.vst3" for v in ("14.21", "16.7", "17.1")]
        autres = [rf"C:\VST3\Plug{i}.vst3" for i in range(7)]
        lots = []
        appels = {"n": 0}

        def fake_child(_cmd, paths, results, on_done):
            lots.append(list(paths))
            for p in paths:
                if p.endswith("16.7_x64.vst3") and len(paths) > 1:
                    results[p] = {"c": None, "st": "hang"}   # bloqué à côté des autres shells
                else:
                    results[p] = {"c": [(os.path.basename(p), "Fx", "Waves")], "st": "ok"}
                on_done()

        saved = (vst_probe._load_cache, vst_probe._save_cache, vst_probe._fingerprint, vst_probe._run_child, vst_probe.platform.system)
        vst_probe._load_cache = lambda: {}
        vst_probe._save_cache = lambda d: None
        vst_probe._fingerprint = lambda b: (1.0, 10)
        vst_probe._run_child = fake_child
        vst_probe.platform.system = lambda: "Windows"
        try:
            res = vst_probe.probe_bundles(autres + shells, "x")
        finally:
            (vst_probe._load_cache, vst_probe._save_cache, vst_probe._fingerprint, vst_probe._run_child, vst_probe.platform.system) = saved
        avec_shell = [l for l in lots if any(vst_probe.is_shell(p) for p in l)]
        self.assertEqual(avec_shell[0], shells)                        # tous ensemble, dans l'ordre
        self.assertTrue(all(not vst_probe.is_shell(p) for l in lots if l is not avec_shell[0] and len(l) > 1 for p in l))
        self.assertEqual(avec_shell[-1], [shells[1]])                  # 16.7 relu tout seul
        self.assertEqual(res[shells[1]]["st"], "ok")
        self.assertTrue(all(res[p]["st"] == "ok" for p in autres))


if __name__ == "__main__":
    unittest.main(verbosity=2)
