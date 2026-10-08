"""Inventaire : une entrée par plugin d'un fichier « shell » (Waves), variantes mono / stéréo.

    venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_vst_probe.py"
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vst_probe  # noqa: E402


class ListeNovaTest(unittest.TestCase):
    def test_une_entree_par_plugin_du_shell(self):
        path = r"C:\VST3\WaveShell1-VST3 17.1_x64.vst3"
        plugins = [{"name": "WaveShell1-VST3 17.1_x64", "vendor": "", "uid": "", "category": "Effect",
                    "is_instrument": None, "sub_categories": [], "path": path, "plugin_name": None, "id": "x"}]
        res = {path: {"st": "ok", "c": [("C6 Stereo", "Fx|Dynamics", "Waves"), ("C6 Mono", "Fx|Dynamics", "Waves"),
                                        ("RVerb Mono/Stereo", "Fx|Reverb", "Waves"), ("Bass Fingers", "Instrument|Synth", "Waves"),
                                        ("C6 Stereo", "Fx|Dynamics", "Waves")]}}
        out = vst_probe.apply_classes(plugins, res)
        names = [p["name"] for p in out]
        self.assertNotIn("WaveShell1-VST3 17.1_x64", names)       # l'entrée du fichier disparaît
        self.assertEqual(names.count("C6 Stereo"), 1)             # doublon ignoré
        c6 = next(p for p in out if p["name"] == "C6 Mono")
        self.assertEqual((c6["plugin_name"], c6["family"], c6["channels"], c6["vendor"], c6["shell"]),
                         ("C6 Mono", "C6", "mono", "Waves", "WaveShell1-VST3 17.1_x64"))
        self.assertEqual(next(p for p in out if p["name"] == "RVerb Mono/Stereo")["channels"], "mono/stereo")
        self.assertTrue(next(p for p in out if p["name"] == "Bass Fingers")["is_instrument"])
        self.assertEqual(out[-1]["name"], "Bass Fingers")         # instruments après les effets

    def test_ancien_cache_coupe_a_512_relu(self):
        self.assertEqual(vst_probe.MAX_CLASSES, 4096)
        self.assertEqual(vst_probe.OLD_CLASS_CAP, 512)

    def test_variantes(self):
        self.assertEqual(vst_probe.channels_of("SSL EV2 Channel Stereo"), "stereo")
        self.assertEqual(vst_probe.channels_of("PS22 Spread Mono/Stereo"), "mono/stereo")
        self.assertIsNone(vst_probe.channels_of("Abbey Road Saturator"))
        self.assertEqual(vst_probe.family_of("L3 MultiMaximizer Stereo"), "L3 MultiMaximizer")


if __name__ == "__main__":
    unittest.main()
