"""Moteur VST natif (vst_native) : règles reproduites de pedalboard, sans plugin réel.
Un dernier test charge un vrai plugin si NovaVSTHost.exe et FabFilter Pro-C 3 sont là."""

import os
import struct
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vst_native as vn  # noqa: E402
import juce_state  # noqa: E402


class Cpp:
    def __init__(self, name, label=""):
        self.name, self.label = name, label


class TestKeys(unittest.TestCase):
    CASES = [("Ratio", "", "ratio"), ("Gain", "dB", "gain_db"), ("Band 1 Frequency", "", "band_1_frequency"),
             ("Key", ":2", "key"), ("F#", "", "f_sharp"), ("  Mix (Wet) ", "%", "mix_wet"),
             ("Côté", "", "c_t"), ("Out--Level", "", "out_level"), ("", "", "")]

    def test_python_key(self):
        for name, label, want in self.CASES:
            self.assertEqual(vn.python_key(name, label), want, (name, label))

    def test_same_as_pedalboard(self):
        try:
            from pedalboard._pedalboard import to_python_parameter_name
        except Exception:
            self.skipTest("pedalboard absent")
        for name, label, _ in self.CASES[:-1]:
            self.assertEqual(vn.python_key(name, label), to_python_parameter_name(Cpp(name, label)) or "")


class TestTexts(unittest.TestCase):
    def test_strip_units(self):
        self.assertEqual(vn.strip_units("-16.00 dB"), "-16.00")
        self.assertEqual(vn.strip_units("1.5 kHz"), "1500.0")
        self.assertEqual(vn.strip_units("100.0 ms"), "100.0")
        self.assertEqual(vn.strip_units("50 %"), "50")
        self.assertEqual(vn.strip_units("2.00:1"), "2.00:1")
        self.assertTrue(vn.is_number_text("-inf dB"))
        self.assertFalse(vn.is_number_text("2.00:1"))

    def test_juce_float_fallback(self):
        self.assertEqual(vn.juce_float_of("-6.5 dB"), -6.5)
        self.assertEqual(vn.juce_float_of("abc"), 0.0)

    def test_parameter_types(self):
        class P:
            def __init__(self, label=""):
                self.name, self.label = "X", label
        f = vn.NativeParameter.__new__(vn.NativeParameter)
        object.__setattr__(f, "_cpp", P())
        runs_float = [[0, "-60.0 dB"], [500, "-30.0 dB"], [1000, "0.0 dB"]]
        vn.NativeParameter.__init__(f, None, P(), runs_float)
        self.assertIs(f.type, float)
        self.assertEqual(f.range, (-60.0, 0.0, 30.0))
        self.assertEqual(f.label, "dB")
        b = vn.NativeParameter.__new__(vn.NativeParameter)
        vn.NativeParameter.__init__(b, None, P(), [[0, "Off"], [500, "On"]])
        self.assertIs(b.type, bool)
        self.assertEqual(b.valid_values, [False, True])
        s = vn.NativeParameter.__new__(vn.NativeParameter)
        vn.NativeParameter.__init__(s, None, P(), [[0, "1.00:1"], [10, "1.01:1"], [20, "2.00:1"]])
        self.assertIs(s.type, str)
        self.assertEqual(s._value_to_raw_value_ranges["1.01:1"], (0.01, 0.02))

    def test_looks_wrong(self):
        self.assertTrue(vn.NativeParameter.looks_wrong([[0, "1.0"]]))
        self.assertTrue(vn.NativeParameter.looks_wrong([[0, "1.0"], [500, "2.0"]]))
        self.assertFalse(vn.NativeParameter.looks_wrong([[0, "Off"], [500, "On"]]))
        self.assertFalse(vn.NativeParameter.looks_wrong([[0, "1"], [5, "2"], [9, "3"]]))


class TestState(unittest.TestCase):
    def test_juce_base64_same_as_reference(self):
        rs = np.random.RandomState(3)
        for n in (0, 1, 2, 3, 5, 64, 1001):
            data = bytes(rs.randint(0, 256, n, dtype=np.uint8))
            enc = vn.juce_b64_encode(data)
            if n:
                self.assertEqual(enc, juce_state.juce_b64_encode(data))
            self.assertEqual(vn.juce_b64_decode(enc), data)

    def test_envelope(self):
        raw = vn.pack_state(b"\x01\x02comp", b"ctrl")
        self.assertEqual(raw[:4], b"VC2!")
        n = struct.unpack("<I", raw[4:8])[0]
        self.assertEqual(len(raw), 8 + n)
        self.assertTrue(raw.endswith(b"</VST3PluginState>\x00"))
        self.assertEqual(vn.unpack_state(raw), (b"\x01\x02comp", b"ctrl"))
        xml, comp, ctrl = juce_state.unpack(raw)
        self.assertEqual((comp, ctrl), (b"\x01\x02comp", b"ctrl"))
        self.assertEqual(vn.unpack_state(vn.pack_state(b"x", None)), (b"x", None))


class TestOrderAndMidi(unittest.TestCase):
    def test_juce_param_order(self):
        params = [{"unit": 0}, {"unit": 2}, {"unit": 1}, {"unit": 2}, {"unit": 0}, {"unit": 9}]
        units = [{"index": 0, "id": 0, "parent": -1}, {"index": 1, "id": 1, "parent": 0},
                 {"index": 2, "id": 2, "parent": 1}]
        # 0 (racine), groupe 1 créé par le réglage 1 (unité 2, enfant de 1) : [1 → [2 → [1, 3]], 2]
        self.assertEqual(vn.juce_param_order(params, units), [0, 1, 3, 2, 4, 5])

    def test_midi_samples(self):
        ev = vn.midi_to_samples([(bytes([0x90, 60, 100]), 0.1), (bytes([0x80, 60, 0]), 0.5)], 48000)
        self.assertEqual([e[0] for e in ev], [int(np.float32(0.1) * np.float32(48000)), 24000])


class TestEngine(unittest.TestCase):
    def test_select(self):
        old = os.environ.get("NOVA_VST_ENGINE")
        try:
            want = "native" if vn.find_host_exe() else "none"
            os.environ["NOVA_VST_ENGINE"] = "pedalboard"
            self.assertEqual(vn.select_engine(True), "pedalboard")      # demandé et installé à part
            self.assertEqual(vn.select_engine(False), want)             # demandé mais absent : natif
            os.environ["NOVA_VST_ENGINE"] = "native"
            self.assertEqual(vn.select_engine(True), want)
            os.environ.pop("NOVA_VST_ENGINE")
            self.assertEqual(vn.select_engine(True), want)              # défaut : natif, même si pedalboard est là
            self.assertIsNone(vn.load_pedalboard())                     # jamais importé sans demande
        finally:
            if old is None:
                os.environ.pop("NOVA_VST_ENGINE", None)
            else:
                os.environ["NOVA_VST_ENGINE"] = old


PROC3 = r"C:\Program Files\Common Files\VST3\FabFilter\FabFilter Pro-C 3.vst3"


@unittest.skipUnless(vn.find_host_exe() and os.path.exists(PROC3), "NovaVSTHost ou Pro-C 3 absent")
class TestRealPlugin(unittest.TestCase):
    def test_proc3(self):
        os.environ.setdefault("NOVA_VST_HOST_PRIORITY", "below_normal")
        p = vn.load_plugin(PROC3)
        try:
            self.assertEqual(p.name, "Pro-C 3")
            self.assertEqual(p.sidechain_channels, 2)
            p.ratio = "2.00:1"
            self.assertEqual(p.parameters["ratio"].string_value, "2.00:1")
            x = (np.random.RandomState(0).randn(2, 4800) * 0.2).astype(np.float32)
            y = p.process(x, 48000, buffer_size=512, reset=True)
            self.assertEqual(y.shape, (2, 4800))
            st = p.raw_state
            p.raw_state = st
            self.assertEqual(p.parameters["ratio"].string_value, "2.00:1")
            # Réglage à l'échantillon près : identique jusqu'à l'échantillon 1000, différent ensuite
            ref = p.process(x, 48000, buffer_size=128, reset=True)
            y2 = p.process(x, 48000, buffer_size=128, reset=True, changes=[("output_level", 1000, 0.0)])
            d = np.nonzero(np.abs(y2 - ref).max(axis=0) > 0)[0]
            self.assertTrue(1000 <= int(d[0]) <= 1001, int(d[0]))
            # Clé de side-chain : bus auxiliaire alimenté
            y3 = p.process(x, 48000, buffer_size=128, reset=False, key=x)
            self.assertEqual(y3.shape, (2, 4800))
        finally:
            p.close()


if __name__ == "__main__":
    unittest.main()
