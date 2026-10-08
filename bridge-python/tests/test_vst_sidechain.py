"""Side-chain des VST (R10) côté pont, sans plugin réel : trames à 4 canaux,
clé passée à un hôte qui sait l'alimenter (effet à clé de référence
« nova:debug-ducker »), ignorée sinon (pedalboard), rendu hors ligne avec clé.

    <python du pont> -m unittest discover -s tests -p "test_vst_sidechain.py"
"""
import os
import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["NOVA_BRIDGE_DEBUG"] = "1"
import vst_automation as va  # noqa: E402
import vst_host  # noqa: E402
import vst_sidechain as vs  # noqa: E402
from vst_host import Slot  # noqa: E402

SR = 48000
N = vst_host.BLOCK


class FakeJuce:
    editor_slot = None

    def close_editor(self, slot):
        pass

    def release(self, obj):
        pass

    def run_sync(self, fn, *args, timeout=0):
        return fn(*args)


def slot_with(plugin):
    s = Slot("k", vs.DEBUG_DUCKER, None, SR, FakeJuce())
    plugin.process(np.zeros((2, N), np.float32), SR)
    s.plugin = plugin
    s.sidechain_inputs = vs.sidechain_inputs(plugin)
    s.loaded.set()
    return s


def key_block(level):
    return np.full((2, N), level, np.float32)


class DuckerContract(unittest.TestCase):
    def test_reference_effect_follows_the_contract(self):
        d = vs.DebugDucker()
        self.assertEqual(vs.sidechain_inputs(d), 2)
        self.assertTrue(vs.keyed(d))
        st = d.raw_state
        d.threshold.raw_value = 0.1
        d.raw_state = st
        self.assertAlmostEqual(d.threshold.raw_value, 0.5)
        self.assertTrue(vs.is_debug_plugin(vs.DEBUG_DUCKER))
        self.assertIsInstance(vst_host._open_plugin(vs.DEBUG_DUCKER, None), vs.DebugDucker)

    def test_pedalboard_like_plugin_is_not_keyed(self):
        class Plain:
            def process(self, x, sr, buffer_size=128, reset=False):
                return x
        self.assertIsNone(vs.sidechain_inputs(Plain()))
        self.assertFalse(vs.keyed(Plain()))


class SlotKey(unittest.TestCase):
    def test_key_drives_the_reduction(self):
        s = slot_with(vs.DebugDucker())
        main = np.full((2, N), 0.1, np.float32)          # le son traité ; seule la clé décide de la réduction
        quiet = s.process_block(main, None, key_block(0.0))
        self.assertTrue(np.allclose(quiet, main, atol=1e-6))  # clé muette : aucune réduction
        loud = None
        for _ in range(8):
            loud = s.process_block(main, None, key_block(0.9))
        self.assertLess(float(np.max(np.abs(loud[:, -1]))), 0.1 * 10 ** (-20 / 20))  # > 20 dB de réduction
        self.assertEqual(s.key_blocks, 9)

    def test_key_and_automation_together(self):
        s = slot_with(vs.DebugDucker())
        s.set_automation_map([k for k in s.handles() if k.startswith("threshold")])
        main = np.full((2, N), 0.1, np.float32)
        out = s.process_block(main, [(0, 64, 1.0)], key_block(0.05))   # seuil 0 dB à l'échantillon 64
        self.assertLess(float(out[0, 60]), 0.1)                       # clé à −26 dB > −30 dB : réduit
        self.assertAlmostEqual(float(out[0, 127]), 0.1, places=3)     # seuil 0 dB : plus rien

    def test_key_ignored_without_host_support(self):
        class Plain:
            def process(self, x, sr, buffer_size=128, reset=False):
                return x * 0.5
        s = Slot("p", "C:/x.vst3", None, SR, FakeJuce())
        s.plugin = Plain()
        s.loaded.set()
        out = s.process_block(np.ones((2, N), np.float32), None, key_block(1.0))
        self.assertTrue(np.allclose(out, 0.5))
        self.assertEqual(s.key_blocks, 0)


class OfflineKey(unittest.TestCase):
    def test_render_with_key(self):
        d = vs.DebugDucker()

        class Entry:
            pass
        e = Entry()
        e.plugin = d
        acq, rel = vst_host.OFFLINE.acquire, vst_host.OFFLINE.release
        vst_host.OFFLINE.acquire = lambda *a, **k: (d.process(np.zeros((2, 8), np.float32), SR), e)[1]
        vst_host.OFFLINE.release = lambda _e: None
        try:
            main = np.full((2, SR), 0.1, np.float32)
            key = np.zeros((2, SR), np.float32)
            key[:, SR // 2:SR // 2 + 2400] = 0.9                       # un « kick » à 0,5 s
            out = vst_host.render_offline(FakeJuce(), vs.DEBUG_DUCKER, None, None, main, SR, 0, key=key)
        finally:
            vst_host.OFFLINE.acquire, vst_host.OFFLINE.release = acq, rel
        self.assertAlmostEqual(float(out[0, SR // 2 - 10]), 0.1, places=4)
        self.assertLess(float(out[0, SR // 2 + 100]), 0.02)


class FrameParsing(unittest.TestCase):
    def test_four_channel_frame_splits_main_and_key(self):
        import nova_bridge_server as srv
        sid = b"s"
        h = srv._align4(2 + len(sid))
        head = bytearray(h + 8)
        head[0], head[1] = 1, len(sid)
        head[2:2 + len(sid)] = sid
        struct.pack_into("<IHBB", head, h, 3, N, 4, va.FLAG_SIDECHAIN | va.FLAG_PARAMS)
        inter = np.zeros((N, 4), "<f4")
        inter[:, 0:2] = 0.25
        inter[:, 2:4] = 0.75
        buf = bytes(head) + inter.tobytes() + va.build_param_section([(0, 5, 0.5)])
        slot_id, seq, n, nch, flags, data = srv.parse_audio_frame(buf)
        self.assertEqual((nch, flags & va.FLAG_SIDECHAIN), (4, va.FLAG_SIDECHAIN))
        block = data.reshape(n, nch).T
        self.assertTrue(np.allclose(block[:2], 0.25) and np.allclose(block[2:4], 0.75))
        self.assertEqual(srv.parse_audio_extras(buf, n, nch, flags), [(0, 5, 0.5)])


if __name__ == "__main__":
    unittest.main()
