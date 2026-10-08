"""Pannes injectées dans le pont VST (v10), sans plugin réel : faux plugins qui
lèvent une exception, sortent des NaN, se figent ; quarantaine au chargement.

    <python du pont> -m unittest discover -s tests -p "test_slot_faults.py"
"""
import asyncio
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vst_host  # noqa: E402
from vst_host import Slot, CrashGuard, PluginQuarantined  # noqa: E402

SR = 48000
N = vst_host.BLOCK


class FakeJuce:
    """Le slot n'utilise le thread JUCE que pour fermer la fenêtre et libérer l'instance."""
    editor_slot = None

    def __init__(self):
        self.released = []

    def close_editor(self, slot):
        pass

    def release(self, obj):
        self.released.append(obj)

    def call(self, fn, *args):  # ne doit jamais servir pour un plugin en quarantaine
        raise AssertionError("instanciation native interdite")


class Gain:
    """Plugin sain : gain 0,5, sans latence."""
    def process(self, x, sr, buffer_size=128, reset=False):
        return x * 0.5


class Raises:
    """Lève une exception à partir du bloc `at`."""
    def __init__(self, at=3):
        self.n, self.at = 0, at

    def process(self, x, sr, buffer_size=128, reset=False):
        self.n += 1
        if self.n >= self.at:
            raise RuntimeError("violation d'accès simulée")
        return x * 0.5


class NaNs:
    """Sort des NaN / infinis."""
    def process(self, x, sr, buffer_size=128, reset=False):
        y = x.copy()
        y[:, ::2] = np.nan
        y[:, 1] = np.inf
        return y


class Huge:
    def process(self, x, sr, buffer_size=128, reset=False):
        return x * 1e9


class Hangs:
    """Se fige `secs` secondes au bloc `at`."""
    def __init__(self, at=2, secs=3.0):
        self.n, self.at, self.secs = 0, at, secs
        self.release = threading.Event()

    def process(self, x, sr, buffer_size=128, reset=False):
        self.n += 1
        if self.n == self.at:
            self.release.wait(self.secs)
        return x * 0.5


def make_slot(plugin, latency=0, sid="s1"):
    s = Slot(sid, r"C:\fake\Plug.vst3", None, SR, FakeJuce())
    s.plugin = plugin
    s.reported_latency = latency
    s.loaded.set()
    return s


def ramp(i):
    """Bloc stéréo reconnaissable (valeurs distinctes d'un bloc à l'autre)."""
    base = (np.arange(N, dtype=np.float32) + i * N) / (50 * N)
    return np.vstack([base, -base]).astype(np.float32)


class SlotFaultTest(unittest.TestCase):
    def test_exception_passe_le_son_sec_aligne_sur_la_latence(self):
        lat = 64
        s = make_slot(Raises(at=3), latency=lat)
        outs = [s.process_block(ramp(i)) for i in range(8)]
        self.assertEqual(s.failed, "exception")
        self.assertIn("violation", s.fail_error)
        # Après la panne : signal sec retardé de `lat` échantillons (la piste reste alignée).
        dry_in = np.concatenate([ramp(i) for i in range(2, 8)], axis=1)
        dry_out = np.concatenate(outs[2:], axis=1)
        np.testing.assert_allclose(dry_out[:, lat:], dry_in[:, :-lat], atol=1e-7)
        self.assertTrue(np.all(dry_out[:, :lat] == 0))
        # Jamais du silence à vie (avant : zéros pour toujours).
        self.assertGreater(float(np.abs(outs[-1]).max()), 0.0)

    def test_nan_nettoyes_puis_panne_apres_nan_limit(self):
        s = make_slot(NaNs())
        for i in range(vst_host.NAN_LIMIT - 1):
            out = s.process_block(ramp(i))
            self.assertTrue(np.isfinite(out).all())
            self.assertIsNone(s.failed)
        out = s.process_block(ramp(99))
        self.assertEqual(s.failed, "nan")
        self.assertTrue(np.isfinite(out).all())
        np.testing.assert_allclose(out, ramp(99), atol=1e-7)  # latence 0 : sec tel quel

    def test_sortie_bornee(self):
        s = make_slot(Huge())
        out = s.process_block(ramp(5))
        self.assertLessEqual(float(np.abs(out).max()), vst_host.OUT_LIMIT)
        self.assertIsNone(s.failed)

    def test_dechargement_d_un_slot_fige_ne_bloque_pas(self):
        hang = Hangs(at=1, secs=5.0)
        s = make_slot(hang)
        t = threading.Thread(target=s.process_block, args=(ramp(0),), daemon=True)
        t.start()
        time.sleep(0.2)
        s.mark_failed("hang", "test")
        t0 = time.time()
        s.unload()
        self.assertLess(time.time() - t0, 0.3)
        hang.release.set()
        t.join(2)
        time.sleep(0.2)
        self.assertIsNone(s.plugin)  # libéré dès que le traitement a rendu la main


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, data):
        self.sent.append(data)

    def frames(self, sid):
        import nova_bridge_server as srv
        out = []
        for d in self.sent:
            if isinstance(d, (bytes, bytearray)):
                slot_id, seq, nframes, nch, flags, data = srv.parse_audio_frame(bytes(d))
                if slot_id == sid:
                    out.append((seq, data.reshape(nframes, nch).T))
        return out

    def events(self, action):
        return [json.loads(d) for d in self.sent if isinstance(d, str) and json.loads(d).get("action") == action]


class WorkerFaultTest(unittest.TestCase):
    """Boucle asyncio réelle du serveur (_slot_worker, _on_audio), faux websocket."""

    def setUp(self):
        import nova_bridge_server as srv
        self.srv = srv
        self.old_hang = vst_host.HANG_TIMEOUT_S
        vst_host.HANG_TIMEOUT_S = 0.4

    def tearDown(self):
        vst_host.HANG_TIMEOUT_S = self.old_hang

    def _server(self):
        server = self.srv.NovaBridgeServer.__new__(self.srv.NovaBridgeServer)
        server.slots, server.slot_queues, server.clients = {}, {}, set()
        server.loop = asyncio.get_running_loop()
        return server

    def _add(self, server, slot, ws):
        slot.owner = ws
        server.slots[slot.slot_id] = slot
        q = asyncio.Queue()
        server.slot_queues[slot.slot_id] = q
        return asyncio.create_task(server._slot_worker(slot, q))

    def test_plugin_fige_et_plugin_qui_plante_le_slot_sain_continue(self):
        async def scenario():
            server = self._server()
            ws = FakeWS()
            hang = Hangs(at=3, secs=3.0)
            tasks = [self._add(server, make_slot(Gain(), sid="sain"), ws),
                     self._add(server, make_slot(hang, sid="fige"), ws),
                     self._add(server, make_slot(Raises(at=2), sid="plante"), ws)]
            t0 = time.time()
            for i in range(40):
                for sid in ("sain", "fige", "plante"):
                    server._on_audio(ws, self.srv.build_audio_frame(sid, i, ramp(i)))
                await asyncio.sleep(0.003)
            # Laisse passer le chien de garde (0,4 s) et vider les files.
            for _ in range(200):
                await asyncio.sleep(0.02)
                if len(ws.frames("fige")) >= 40 and len(ws.frames("sain")) >= 40:
                    break
            elapsed = time.time() - t0
            hang.release.set()
            for sid in list(server.slots):
                server._drop_slot(sid)
            await asyncio.sleep(0.05)
            return server, ws, tasks, elapsed

        server, ws, tasks, elapsed = asyncio.run(scenario())
        sain, fige, plante = ws.frames("sain"), ws.frames("fige"), ws.frames("plante")
        self.assertEqual(len(sain), 40)
        self.assertEqual([q for q, _ in sain], list(range(40)))
        for seq, out in sain:
            np.testing.assert_allclose(out, ramp(seq) * 0.5, atol=1e-6)
        # Le slot figé ne retient pas 3 s : panne déclarée au bout du chien de garde.
        self.assertLess(elapsed, 2.5)
        self.assertGreaterEqual(len(fige), 39)  # le bloc figé lui-même repart sec
        np.testing.assert_allclose(fige[-1][1], ramp(fige[-1][0]), atol=1e-6)  # sec (latence 0)
        self.assertEqual(len(plante), 40)
        np.testing.assert_allclose(plante[-1][1], ramp(39), atol=1e-6)
        crashes = ws.events("PLUGIN_CRASHED")
        reasons = sorted((c["slot_id"], c["reason"]) for c in crashes)
        self.assertEqual(reasons, [("fige", "hang"), ("plante", "exception")])  # une fois chacun
        for t in tasks:
            self.assertTrue(t.done())  # arrêtés proprement par _drop_slot (None), pas morts en route
            self.assertIsNone(t.exception())

    def test_worker_survit_a_une_erreur_inattendue(self):
        async def scenario():
            server = self._server()
            ws = FakeWS()
            slot = make_slot(Gain(), sid="x")
            calls = {"n": 0}
            real = slot.process_block

            def flaky(block):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise MemoryError("bloc impossible")
                return real(block)
            slot.process_block = flaky
            task = self._add(server, slot, ws)
            for i in range(5):
                server._on_audio(ws, self.srv.build_audio_frame("x", i, ramp(i)))
            for _ in range(50):
                await asyncio.sleep(0.01)
                if len(ws.frames("x")) >= 4:
                    break
            alive = not task.done()
            server._drop_slot("x")
            await asyncio.sleep(0.02)
            return ws, alive

        ws, alive = asyncio.run(scenario())
        self.assertTrue(alive)
        self.assertEqual([q for q, _ in ws.frames("x")], [0, 2, 3, 4])


class QuarantineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = vst_host.CRASH_GUARD

    def tearDown(self):
        vst_host.CRASH_GUARD = self.old
        self.tmp.cleanup()

    def crash_once(self, path):
        g = CrashGuard(self.tmp.name)
        g.begin(path)          # le processus « meurt » ici : end() n'est jamais appelé
        return CrashGuard(self.tmp.name).recover()

    def test_deux_plantages_au_chargement_quarantaine_puis_rescan(self):
        path = r"C:\VST3\Plante.vst3"
        self.assertEqual(self.crash_once(path), [path])
        g = CrashGuard(self.tmp.name)
        self.assertEqual(g.count(path), 1)
        self.assertFalse(g.is_quarantined(path))
        self.crash_once(path)
        g = CrashGuard(self.tmp.name)
        self.assertTrue(g.is_quarantined(path))
        self.assertIn("a fait planter le pont 2 fois", g.message(path))
        self.assertIn("Plante", g.message(path))
        vst_host.CRASH_GUARD = g
        with self.assertRaises(PluginQuarantined):
            vst_host.instantiate(FakeJuce(), path, None, None, SR, 128)
        g.clear()
        self.assertFalse(CrashGuard(self.tmp.name).is_quarantined(path))

    def test_chargement_termine_efface_le_marqueur(self):
        g = CrashGuard(self.tmp.name)
        tok = g.begin(r"C:\VST3\Sain.vst3")
        self.assertTrue(os.path.exists(tok))
        g.end(tok)
        self.assertEqual(CrashGuard(self.tmp.name).recover(), [])

    def test_load_plugin_repond_quarantined(self):
        import nova_bridge_server as srv
        path = r"C:\VST3\Plante.vst3"
        self.crash_once(path)
        self.crash_once(path)
        vst_host.CRASH_GUARD = CrashGuard(self.tmp.name)

        async def scenario():
            server = srv.NovaBridgeServer.__new__(srv.NovaBridgeServer)
            server.slots, server.slot_queues = {}, {}
            server.loop = asyncio.get_running_loop()
            ws = FakeWS()
            await server._a_load_plugin(ws, {"action": "LOAD_PLUGIN", "req_id": 7, "slot_id": "a", "path": path, "sample_rate": SR})
            await asyncio.sleep(0.01)
            return server, ws

        server, ws = asyncio.run(scenario())
        rep = ws.events("LOAD_PLUGIN")
        self.assertEqual(len(rep), 1)
        self.assertFalse(rep[0]["success"])
        self.assertTrue(rep[0]["quarantined"])
        self.assertEqual(rep[0]["req_id"], 7)
        self.assertNotIn("a", server.slots)


if __name__ == "__main__":
    unittest.main()
