"""Plugins d'un fichier « shell » (Waves) : relais de la factory, liste envoyée
à NOVA, chargement par nom, variantes mono / stéréo.

    venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_vst_shell.py"

Les tests « réels » (WaveShell installé + pedalboard) sont sautés ailleurs.
"""
import ctypes
import os
import platform
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vst_probe  # noqa: E402
import vst_shell  # noqa: E402

IS_WIN = platform.system() == "Windows"
WAVESHELL = r"C:\Program Files\Common Files\VST3\WaveShell1-VST3 17.1_x64.vst3"


class _PClassInfo(ctypes.Structure):
    _fields_ = [("cid", ctypes.c_ubyte * 16), ("cardinality", ctypes.c_int32),
                ("category", ctypes.c_char * 32), ("name", ctypes.c_char * 64)]


class FakeFactory:
    """Objet COM minimal (IPluginFactory3) en ctypes : 3 effets + 1 contrôleur."""

    CLASSES = [("Audio Module Class", b"A Mono"), ("Component Controller Class", b"A Ctl"),
               ("Audio Module Class", b"B Stereo"), ("Audio Module Class", b"B Mono")]

    def __init__(self):
        P = ctypes.c_void_p
        QI = ctypes.WINFUNCTYPE(ctypes.c_int32, P, P, ctypes.POINTER(P))
        REF = ctypes.WINFUNCTYPE(ctypes.c_uint32, P)
        INFO = ctypes.WINFUNCTYPE(ctypes.c_int32, P, P)
        COUNT = ctypes.WINFUNCTYPE(ctypes.c_int32, P)
        GET = ctypes.WINFUNCTYPE(ctypes.c_int32, P, ctypes.c_int32, P)
        CREATE = ctypes.WINFUNCTYPE(ctypes.c_int32, P, P, P, P)
        self.calls = []

        def qi(this, iid, out):
            out[0] = this
            return 0

        def get(this, i, info):
            self.calls.append(i)
            if not 0 <= i < len(self.CLASSES):
                return 2
            ci = ctypes.cast(info, ctypes.POINTER(_PClassInfo)).contents
            ci.category = self.CLASSES[i][0].encode()
            ci.name = self.CLASSES[i][1]
            return 0

        self._fns = [QI(qi), REF(lambda t: 1), REF(lambda t: 1), INFO(lambda t, i: 0),
                     COUNT(lambda t: len(self.CLASSES)), GET(get), CREATE(lambda *a: 1),
                     GET(get), GET(get), INFO(lambda t, i: 0)]
        self.vtable = (ctypes.c_void_p * 10)(*[ctypes.cast(f, ctypes.c_void_p).value for f in self._fns])
        self.obj = (ctypes.c_void_p * 1)(ctypes.addressof(self.vtable))
        self.ptr = ctypes.addressof(self.obj)

    def call_count(self) -> int:
        fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)(self.vtable[4])
        return fn(self.ptr)

    def call_get(self, idx: int, slot: int = 5):
        fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_void_p)(self.vtable[slot])
        ci = _PClassInfo()
        r = fn(self.ptr, idx, ctypes.byref(ci))
        return r, ci.name.decode()


@unittest.skipUnless(IS_WIN, "table virtuelle COM : Windows")
class ShellFactoryTest(unittest.TestCase):
    def test_inventaire_restreint_le_temps_du_chargement(self):
        f = FakeFactory()
        sh = vst_shell.ShellFactory(f.ptr)
        self.assertEqual([n for _, n in sh.classes], ["A Mono", "B Stereo", "B Mono"])
        self.assertEqual(f.call_count(), 4)                       # hors chargement : tout passe
        with sh.only("B Stereo") as idx:
            self.assertEqual(idx, 2)
            self.assertEqual(f.call_count(), 1)                   # JUCE ne voit qu'un plugin
            self.assertEqual(f.call_get(0), (0, "B Stereo"))
            self.assertEqual(f.call_get(0, slot=7), (0, "B Stereo"))   # getClassInfo2
            self.assertEqual(f.call_get(0, slot=8), (0, "B Stereo"))   # getClassInfoUnicode
            self.assertEqual(f.call_get(1)[0], 2)                 # au-delà : kInvalidArgument
        self.assertEqual(f.call_count(), 4)
        self.assertEqual(f.call_get(3), (0, "B Mono"))

    def test_nom_tolerant_et_nom_absent(self):
        sh = vst_shell.ShellFactory(FakeFactory().ptr)
        self.assertEqual(sh.index_of("b-stereo"), 2)
        with self.assertRaises(KeyError):
            with sh.only("C6 Stereo"):
                pass
        self.assertIsNone(sh.selected)


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
        self.assertEqual(vst_shell.channels_of("SSL EV2 Channel Stereo"), "stereo")
        self.assertEqual(vst_shell.channels_of("PS22 Spread Mono/Stereo"), "mono/stereo")
        self.assertIsNone(vst_shell.channels_of("Abbey Road Saturator"))
        self.assertEqual(vst_shell.family_of("L3 MultiMaximizer Stereo"), "L3 MultiMaximizer")


def _has_pedalboard() -> bool:
    try:
        import pedalboard  # noqa: F401
        return True
    except ImportError:
        return False


@unittest.skipUnless(IS_WIN and os.path.isfile(WAVESHELL) and _has_pedalboard(), "WaveShell 17.1 + pedalboard requis")
class WavesReelTest(unittest.TestCase):
    """Sur le PC du studio : C6 chargé par son nom en quelques secondes."""

    def test_c6_stereo_et_mono(self):
        import numpy as np
        import vst_host
        t = time.time()
        plugin, _ = vst_host.prepare_plugin(WAVESHELL, "C6 Stereo", None, 48000, 128)
        self.assertLess(time.time() - t, 60)                      # 10 min sans le relais
        self.assertEqual(plugin.name, "C6 Stereo")
        keys = [k for k, p in plugin.parameters.items() if not vst_host.is_midi_cc_param(k, p)]
        self.assertIn("band_1_threshold", keys)
        self.assertNotIn("control_3", keys)
        mono, _ = vst_host.prepare_plugin(WAVESHELL, "C6 Mono", None, 48000, 128)
        self.assertIn(id(mono), vst_host._MONO)
        out = vst_host.process(mono, np.zeros((2, 128), np.float32), 48000, 128)
        self.assertEqual(vst_host._to_stereo(np.asarray(out)).shape[0], 2)   # mono → doublé en stéréo


if __name__ == "__main__":
    unittest.main()
