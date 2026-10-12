"""C6 — option de test « pont ralenti » (12/10/2026), sans plugin réel.

  - jamais active par défaut (aucune variable d'environnement) ;
  - active : chaque bloc traité repart `ms` (+ gigue) plus tard, SANS réduire le débit
    (les blocs sont traités au fil de l'eau, seul le retour est différé) ;
  - action DEBUG_SLOW refusée hors NOVA_BRIDGE_DEBUG=1.

    <python du pont> -m unittest discover -s tests -p "test_silence_pont.py"
"""
import asyncio
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import nova_bridge_server as srv  # noqa: E402
import vst_host  # noqa: E402
import vst_native  # noqa: E402
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
    def __init__(self):
        object.__setattr__(self, "_closed", True)
        object.__setattr__(self, "_by_key", {})

    def process(self, x, sample_rate, buffer_size=8192, reset=True, *, key=None, changes=None, reset_first=False):
        return np.asarray(x, np.float32) * 0.5

    def flush_params(self):
        return True


class WS:
    def __init__(self):
        self.sent = []

    async def send(self, d):
        self.sent.append((time.perf_counter(), d))


def make_server():
    server = srv.NovaBridgeServer.__new__(srv.NovaBridgeServer)
    server.slots, server.slot_queues, server.clients = {}, {}, set()
    return server


def block(i=0):
    b = (np.arange(N, dtype=np.float32) + i) / (10 * N)
    return np.vstack([b, b]).astype(np.float32)


def stream(server, nblocks, interval_s=0.0):
    """Envoie nblocks trames au pont (un slot « v ») ; renvoie (instants d'envoi, retours reçus)."""
    async def scenario():
        server.loop = asyncio.get_running_loop()
        s = Slot("v", r"C:\fake\Plug.vst3", None, SR, FakeJuce())
        s.plugin = FakeNative()
        s.loaded.set()
        ws = WS()
        s.owner = ws
        server.slots["v"] = s
        q = asyncio.Queue()
        server.slot_queues["v"] = q
        task = asyncio.create_task(server._slot_worker(s, q))
        t_send = []
        for seq in range(nblocks):
            t_send.append(time.perf_counter())
            server._on_audio(ws, srv.build_audio_frame("v", seq, block(seq)))
            await asyncio.sleep(interval_s)
        for _ in range(400):
            await asyncio.sleep(0.01)
            if len(ws.sent) >= nblocks:
                break
        server._drop_slot("v")
        await asyncio.sleep(0.02)
        task.cancel()
        return t_send, ws.sent

    return asyncio.run(scenario())


class TestSlowdownOption(unittest.TestCase):
    def test_jamais_active_par_defaut(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NOVA_TEST_SLOW_MS", None)
            os.environ.pop("NOVA_TEST_SLOW_JITTER_MS", None)
            sl = srv.TestSlowdown.from_env()
        self.assertFalse(sl.active)
        self.assertEqual(sl.delay_s(), 0.0)

    def test_variables_d_environnement(self):
        with mock.patch.dict(os.environ, {"NOVA_TEST_SLOW_MS": "70", "NOVA_TEST_SLOW_JITTER_MS": "30"}):
            sl = srv.TestSlowdown.from_env()
        self.assertTrue(sl.active)
        ds = [sl.delay_s() for _ in range(500)]
        self.assertGreaterEqual(min(ds), 0.070)
        self.assertLessEqual(max(ds), 0.100)
        self.assertGreater(max(ds) - min(ds), 0.02)   # gigue réelle

    def test_valeur_invalide_ignoree(self):
        with mock.patch.dict(os.environ, {"NOVA_TEST_SLOW_MS": "beaucoup"}):
            self.assertFalse(srv.TestSlowdown.from_env().active)


class SlowBridgeStreamTest(unittest.TestCase):
    def test_sans_option_retour_immediat_dans_l_ordre(self):
        server = make_server()
        t_send, sent = stream(server, 20)
        self.assertEqual(len(sent), 20)
        seqs = [srv.parse_audio_frame(d)[1] for _, d in sent]
        self.assertEqual(seqs, list(range(20)))
        self.assertLess(sent[-1][0] - t_send[-1], 0.05)

    def test_pont_ralenti_retour_differe_sans_perte_de_debit(self):
        server = make_server()
        server.slow = srv.TestSlowdown(100, 0)
        # 40 blocs envoyés à la suite : avec un retard « bloquant », il faudrait 4 s.
        t_send, sent = stream(server, 40, interval_s=0.0025)
        self.assertEqual(len(sent), 40)
        seqs = [srv.parse_audio_frame(d)[1] for _, d in sent]
        self.assertEqual(seqs, list(range(40)))   # retard constant : ordre gardé
        lags = [sent[i][0] - t_send[i] for i in range(40)]
        self.assertGreaterEqual(min(lags), 0.095)
        self.assertLess(max(lags), 0.35)
        # Débit intact : les retours s'étalent comme les envois (un retard « bloquant » : ≥ 4 s).
        self.assertLess((sent[-1][0] - sent[0][0]) - (t_send[-1] - t_send[0]), 0.2)
        self.assertLess(sent[-1][0] - sent[0][0], 2.0)

    def test_gigue_tous_les_blocs_arrivent(self):
        server = make_server()
        server.slow = srv.TestSlowdown(20, 40, seed=1)
        t_send, sent = stream(server, 30, interval_s=0.002)
        self.assertEqual(sorted(srv.parse_audio_frame(d)[1] for _, d in sent), list(range(30)))

    def test_debug_slow_refuse_hors_mode_debug(self):
        server = make_server()

        async def go():
            server.loop = asyncio.get_running_loop()
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("NOVA_BRIDGE_DEBUG", None)
                with self.assertRaises(RuntimeError):
                    await server._a_debug_slow(WS(), {"action": "DEBUG_SLOW", "ms": 50})
            with mock.patch.dict(os.environ, {"NOVA_BRIDGE_DEBUG": "1"}):
                ws = WS()
                await server._a_debug_slow(ws, {"action": "DEBUG_SLOW", "ms": 50, "jitter_ms": 10})
                await asyncio.sleep(0.01)
                return ws

        ws = asyncio.run(go())
        self.assertTrue(server.slow.active)
        self.assertEqual(server.slow.ms, 50)
        self.assertEqual(len(ws.sent), 1)


if __name__ == "__main__":
    unittest.main()
