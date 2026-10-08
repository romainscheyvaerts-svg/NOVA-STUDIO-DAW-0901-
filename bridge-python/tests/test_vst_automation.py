"""Automation des VST par le pont (R9), sans plugin réel : faux plugin dont le
gain suit un réglage brut ; trames temps réel avec réglages horodatés,
découpage à l'échantillon près, rendu hors ligne, relevé des gestes faits dans
la fenêtre du plugin.

    <python du pont> -m unittest discover -s tests -p "test_vst_automation.py"
"""
import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vst_automation as va  # noqa: E402
import vst_host  # noqa: E402
from vst_host import Slot  # noqa: E402

SR = 48000
N = vst_host.BLOCK


class Param:
    """Poignée C++ simulée : raw_value lu / écrit directement."""
    def __init__(self, name, value=1.0, label=""):
        self.name = name
        self.raw_value = value
        self.label = label
        self.num_steps = 0
        self.is_boolean = False
        self.is_automatable = True

    @property
    def string_value(self):
        return f"{self.raw_value * 100:.0f} %"

    def get_text_for_raw_value(self, v):
        return f"{v * 100:.0f} %"


class GainPlugin:
    """Gain = réglage « Level » (lu au début de chaque process, comme JUCE passe
    les changements au plugin au début du bloc)."""
    def __init__(self):
        self.level = Param("Level", 1.0)
        self.other = Param("Mix", 0.5)
        self._parameters = [self.level, self.other]
        self.calls = []

    def process(self, x, sr, buffer_size=128, reset=False):
        self.calls.append(x.shape[1])
        return x * self.level.raw_value


class FakeJuce:
    editor_slot = None

    def close_editor(self, slot):
        pass

    def release(self, obj):
        pass

    def run_sync(self, fn, *args, timeout=0):
        return fn(*args)


def make_slot(plugin=None):
    s = Slot("s1", "C:/x/Fake.vst3", None, SR, FakeJuce())
    s.plugin = plugin or GainPlugin()
    s.loaded.set()
    return s


class ParamSection(unittest.TestCase):
    def test_round_trip(self):
        sec = va.build_param_section([(2, 64, 0.25), (0, 0, 0.75), (1, 5, 1.5)])
        got = va.parse_param_section(b"\0" * 8 + sec, 8)
        self.assertEqual([c[:2] for c in got], [(0, 0), (1, 5), (2, 64)])   # triés par décalage
        self.assertAlmostEqual(got[2][2], 0.25)
        self.assertEqual(got[1][2], 1.0)                                     # borné à 0–1

    def test_truncated_section_is_safe(self):
        sec = va.build_param_section([(0, 1, 0.5), (1, 2, 0.5)])
        self.assertEqual(len(va.parse_param_section(sec[:-3], 0)), 1)
        self.assertEqual(va.parse_param_section(b"", 0), [])

    def test_segments(self):
        self.assertEqual(va.segments(128, []), [(0, 128, [])])
        segs = va.segments(128, [(0, 40, 0.1), (1, 40, 0.2), (0, 0, 0.3)])
        self.assertEqual([(a, b) for a, b, _ in segs], [(0, 40), (40, 128)])
        self.assertEqual(len(segs[1][2]), 2)
        self.assertEqual([(a, b) for a, b, _ in va.segments(128, [(0, 500, 1.0)])], [(0, 127), (127, 128)])


class SlotAutomation(unittest.TestCase):
    def test_change_lands_on_the_exact_sample(self):
        s = make_slot()
        s.set_automation_map(["level"])
        x = np.ones((2, N), np.float32)
        out = s.process_block(x, [(0, 37, 0.25)])
        self.assertTrue(np.allclose(out[:, :37], 1.0))
        self.assertTrue(np.allclose(out[:, 37:], 0.25))
        self.assertEqual(s.plugin.calls, [37, N - 37])
        # Bloc suivant : la valeur tient, un seul appel.
        out = s.process_block(x)
        self.assertTrue(np.allclose(out, 0.25))
        self.assertEqual(s.auto_applied, 1)

    def test_offset_zero_does_not_split(self):
        s = make_slot()
        s.set_automation_map(["mix", "level"])
        s.process_block(np.ones((2, N), np.float32), [(1, 0, 0.5)])
        self.assertEqual(s.plugin.calls, [N])
        self.assertAlmostEqual(s.plugin.level.raw_value, 0.5)

    def test_unknown_index_and_name_are_ignored(self):
        s = make_slot()
        res = s.set_automation_map(["level", "nope"])
        self.assertEqual(res["missing"], ["nope"])
        out = s.process_block(np.ones((2, N), np.float32), [(1, 10, 0.1), (7, 20, 0.1)])
        self.assertTrue(np.allclose(out, 1.0))

    def test_dropped_block_changes_are_carried(self):
        s = make_slot()
        s.set_automation_map(["level"])
        s.carry_changes([(0, 90, 0.5)])
        out = s.process_block(np.ones((2, N), np.float32))
        self.assertTrue(np.allclose(out, 0.5))

    def test_editor_gesture_keeps_the_hand(self):
        clock = [100.0]
        s = make_slot()
        s.watch = va.ParamWatch(clock=lambda: clock[0])
        s.set_automation_map(["level"])
        s.set_watching(True)
        # Geste dans la fenêtre du plugin : relevé, puis l'automation ne l'écrase pas tout de suite.
        s.plugin.level.raw_value = 0.8
        moved = s.poll_changes()
        self.assertEqual(moved, [{"name": "level", "value": 0.8, "from": 1.0}])
        out = s.process_block(np.ones((2, N), np.float32), [(0, 0, 0.1)])
        self.assertTrue(np.allclose(out, 0.8))
        self.assertEqual(s.auto_skipped, 1)
        clock[0] += 1.0
        out = s.process_block(np.ones((2, N), np.float32), [(0, 0, 0.1)])
        self.assertTrue(np.allclose(out, 0.1))
        # L'automation elle-même n'est pas prise pour un geste.
        self.assertEqual(s.poll_changes(), [])

    def test_poll_ignores_first_reading(self):
        s = make_slot()
        s.handles()
        self.assertEqual(s.poll_changes(), [])
        s.plugin.other.raw_value = 0.9
        self.assertEqual([m["name"] for m in s.poll_changes()], ["mix"])

    def test_automatable_and_texts(self):
        s = make_slot()
        names = [p["name"] for p in s.automatable()]
        self.assertEqual(names, ["level", "mix"])
        t = s.param_texts(["level"], steps=4)
        self.assertEqual(t["level"], ["0 %", "25 %", "50 %", "75 %", "100 %"])


class OfflineEvents(unittest.TestCase):
    def test_events_parse_and_bound(self):
        ev = va.offline_events([{"name": "level", "frames": [0, 96000, 10 ** 9], "values": [1, 0.5, 0]},
                                {"name": "", "frames": [1], "values": [1]}, "junk"], 100000)
        self.assertEqual(ev, [(0, "level", 1.0), (96000, "level", 0.5)])

    def test_chunks_cut_at_events(self):
        ch = list(va.render_chunks(20000, [(0, "a", 1.0), (9000, "a", 0.5), (9000, "b", 0.1)], 8192))
        self.assertEqual([(a, b) for a, b, _ in ch], [(0, 8192), (8192, 9000), (9000, 17192), (17192, 20000)])
        self.assertEqual(len(ch[2][2]), 2)

    def test_render_offline_step_is_sample_exact(self):
        plugin = GainPlugin()

        class Entry:
            pass
        e = Entry()
        e.plugin = plugin
        orig_acq, orig_rel = vst_host.OFFLINE.acquire, vst_host.OFFLINE.release
        vst_host.OFFLINE.acquire = lambda *a, **k: e
        vst_host.OFFLINE.release = lambda _e: None
        orig_key = vst_host._python_key
        vst_host._python_key = lambda cp: cp.name.lower()
        try:
            audio = np.ones((2, 30000), np.float32)
            out = vst_host.render_offline(FakeJuce(), "C:/x/Fake.vst3", None, None, audio, SR, 0,
                                          automation=[{"name": "level", "frames": [0, 12345], "values": [1.0, 0.25]}])
        finally:
            vst_host.OFFLINE.acquire, vst_host.OFFLINE.release = orig_acq, orig_rel
            vst_host._python_key = orig_key
        self.assertTrue(np.allclose(out[:, :12345], 1.0))
        self.assertTrue(np.allclose(out[:, 12345:], 0.25))


class FrameParsing(unittest.TestCase):
    def test_server_parses_params_after_audio(self):
        import nova_bridge_server as srv
        sid = b"slot-1"
        h = srv._align4(2 + len(sid))
        head = bytearray(h + 8)
        head[0], head[1] = 1, len(sid)
        head[2:2 + len(sid)] = sid
        struct.pack_into("<IHBB", head, h, 7, N, 2, va.FLAG_PARAMS)
        audio = np.zeros(N * 2, "<f4").tobytes()
        buf = bytes(head) + audio + va.build_param_section([(3, 100, 0.5)])
        slot_id, seq, nframes, nch, flags, data = srv.parse_audio_frame(buf)
        self.assertEqual((slot_id, seq, nframes, nch), ("slot-1", 7, N, 2))
        self.assertEqual(srv.parse_audio_extras(buf, nframes, nch, flags), [(3, 100, 0.5)])
        self.assertIsNone(srv.parse_audio_extras(buf, nframes, nch, 0))


if __name__ == "__main__":
    unittest.main()
