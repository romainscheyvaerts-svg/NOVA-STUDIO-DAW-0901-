"""« Ce que j'entends = ce que j'exporte » côté pont VST (12/10/2026), sans plugin réel.

  - départ de lecture : la trame drapeau RESET (0x08) fait remettre le plugin à zéro dans l'hôte
    natif juste avant CE bloc (reset_first), une seule fois, dans l'ordre du flux ;
  - réglages posés à l'arrêt : remis au processeur (flush_params, sans audio) avant toute
    lecture d'état, même si un bloc vient de passer (avant : rien dans les 250 ms) ;
  - sondes du chargement (test de remise à zéro, mise en route) à la fréquence du projet.

    <python du pont> -m unittest discover -s tests -p "test_fidelite_vst.py"
"""
import asyncio
import struct
import sys
import time
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vst_host  # noqa: E402
import vst_native  # noqa: E402
import vst_automation  # noqa: E402
from vst_host import Slot  # noqa: E402

SR = 48000
N = vst_host.BLOCK


class FakeJuce:
    editor_slot = None

    def close_editor(self, slot):
        pass

    def release(self, obj):
        pass


class FakeNative(vst_native.NativePlugin):
    """Hôte natif simulé : relève reset_first à chaque appel et les remises au processeur."""

    def __init__(self):
        object.__setattr__(self, "_closed", True)
        object.__setattr__(self, "_calls", [])
        object.__setattr__(self, "_flushes", 0)
        object.__setattr__(self, "_by_key", {})

    def process(self, x, sample_rate, buffer_size=8192, reset=True, *, key=None, changes=None, reset_first=False):
        self._calls.append(bool(reset_first))
        return np.asarray(x, np.float32) * 0.5

    def flush_params(self):
        object.__setattr__(self, "_flushes", self._flushes + 1)
        return True


def make_slot(plugin, sid="s1"):
    s = Slot(sid, r"C:\fake\Plug.vst3", None, SR, FakeJuce())
    s.plugin = plugin
    s.loaded.set()
    return s


def block(i=0):
    b = (np.arange(N, dtype=np.float32) + i) / (10 * N)
    return np.vstack([b, b]).astype(np.float32)


class StreamResetTest(unittest.TestCase):
    def test_reset_stream_marque_le_bloc_suivant_seulement(self):
        p = FakeNative()
        s = make_slot(p)
        s.process_block(block(0))
        s.reset_stream()
        s.process_block(block(1))
        s.process_block(block(2))
        self.assertEqual(p._calls, [False, True, False])
        self.assertEqual(s.stream_resets, 1)

    def test_pedalboard_rien(self):
        class Gain:
            def process(self, x, sr, buffer_size=128, reset=False):
                return x * 0.5
        s = make_slot(Gain())
        s.reset_stream()          # sa remise à zéro décalerait le flux : ignorée
        self.assertFalse(s._reset_next)

    def test_trame_drapeau_reset_dans_l_ordre_du_flux(self):
        import nova_bridge_server as srv

        class WS:
            def __init__(self):
                self.sent = []

            async def send(self, d):
                self.sent.append(d)

        def frame(sid, seq, flags):
            buf = bytearray(srv.build_audio_frame(sid, seq, block(seq)))
            h = srv._align4(2 + len(sid.encode()))
            buf[h + 7] = flags
            return bytes(buf)

        async def scenario():
            server = srv.NovaBridgeServer.__new__(srv.NovaBridgeServer)
            server.slots, server.slot_queues, server.clients = {}, {}, set()
            server.loop = asyncio.get_running_loop()
            p = FakeNative()
            slot = make_slot(p, "v")
            ws = WS()
            slot.owner = ws
            server.slots["v"] = slot
            q = asyncio.Queue()
            server.slot_queues["v"] = q
            task = asyncio.create_task(server._slot_worker(slot, q))
            for seq, fl in [(0, 0), (1, 0), (2, vst_automation.FLAG_RESET), (3, 0)]:
                server._on_audio(ws, frame("v", seq, fl))
            for _ in range(100):
                await asyncio.sleep(0.01)
                if len(ws.sent) >= 4:
                    break
            server._drop_slot("v")
            await asyncio.sleep(0.02)
            task.cancel()
            return p, ws

        p, ws = asyncio.run(scenario())
        self.assertEqual(p._calls, [False, False, True, False])
        self.assertEqual(len(ws.sent), 4)

    def test_hello_annonce_stream_reset(self):
        self.assertEqual(vst_automation.FLAG_RESET, 0x08)


class FlushParamsTest(unittest.TestCase):
    def test_reglage_pose_juste_apres_un_bloc_remis_quand_meme(self):
        p = FakeNative()
        s = make_slot(p)
        s.process_block(block(0))
        s._params_dirty = True
        s._last_block_t = time.monotonic()      # un bloc vient de passer (avant : rien n'était fait)
        with s.lock:
            s._flush_params()
        self.assertEqual(p._flushes, 1)
        self.assertEqual(p._calls, [False])      # aucun son ajouté au flux

    def test_reglage_de_la_fenetre_aussi(self):
        p = FakeNative()
        s = make_slot(p)
        s._params_dirty = False                  # bougé dans la fenêtre du plugin : le pont ne le sait pas
        with s.lock:
            s._flush_params()
        self.assertEqual(p._flushes, 1)


class ProbeRateTest(unittest.TestCase):
    def _bare(self, hint, spec):
        p = object.__new__(vst_native.NativePlugin)
        object.__setattr__(p, "_closed", True)
        object.__setattr__(p, "_rate_hint", hint)
        object.__setattr__(p, "_spec", spec)
        return p

    def test_frequence_du_projet(self):
        self.assertEqual(self._bare(48000.0, None)._probe_rate(), 48000.0)
        self.assertEqual(self._bare(48000.0, (96000.0, 512, 2, False))._probe_rate(), 96000.0)
        self.assertEqual(self._bare(None, None)._probe_rate(), 44100.0)   # ancien appelant : comme avant

    def test_detect_reload_envoie_la_frequence(self):
        p = self._bare(48000.0, None)
        sent = []

        class Host:
            def request(self, cmd, timeout=None, **kw):
                sent.append((cmd, kw))
                return {"persists": False}

        object.__setattr__(p, "_host", Host())
        object.__setattr__(p, "buses", {"in": [{"channels": 2}], "out": [{"channels": 2}]})
        p._detect_reload_type()
        self.assertEqual(sent, [("detect_reload", {"sample_rate": 48000.0})])

    def test_mise_en_route_d_un_instrument(self):
        p = self._bare(48000.0, None)
        sent = []

        class Host:
            def request(self, cmd, timeout=None, **kw):
                sent.append((cmd, kw))
                return {}

        object.__setattr__(p, "_host", Host())
        object.__setattr__(p, "buses", {"in": [], "out": [{"channels": 2}]})
        p._detect_reload_type()
        self.assertEqual(sent[0][0], "warm_up")
        self.assertEqual(sent[0][1]["sample_rate"], 48000.0)


class ResetFlagTest(unittest.TestCase):
    def test_reset_first_pose_le_drapeau_sur_le_premier_sous_bloc(self):
        """_run : FLAG_RESET_FIRST sur la 1re demande à l'hôte seulement."""
        flags = []

        class H:
            pass

        class Host:
            max_frames = 256
            audio_lock = __import__("threading").Lock()

            def __init__(self):
                self.h = H()
                self.a_in = np.zeros((8, 256), np.float32)
                self.a_key = np.zeros((2, 256), np.float32)
                self.a_out = np.zeros((8, 256), np.float32)
                self.a_changes = [None] * 16
                self.a_events = [None] * 16

            def run(self):
                flags.append(self.h.flags)
                self.h.outChannelsWritten = 2
                self.h.nOutChanges = 0
                self.h.latency = 0
                self.h.processUs = 0.0

        p = object.__new__(vst_native.NativePlugin)
        object.__setattr__(p, "_closed", True)
        object.__setattr__(p, "_host", Host())
        object.__setattr__(p, "_transport", None)
        object.__setattr__(p, "out_values", {})
        p._run(np.zeros((2, 600), np.float32), 600, 128, 2, reset_first=True)
        self.assertEqual(flags[0], vst_native.FLAG_RESET_FIRST)
        self.assertTrue(all(f == 0 for f in flags[1:]))
        self.assertGreater(len(flags), 1)


if __name__ == "__main__":
    unittest.main()
