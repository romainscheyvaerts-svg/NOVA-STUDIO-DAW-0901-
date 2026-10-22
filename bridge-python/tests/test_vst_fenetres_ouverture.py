"""Fenêtres de plugins « comme dans un DAW » (owner = fenêtre de Nova Studio) et ouverture plus
rapide (hôtes de réserve, chargements en parallèle, une recréation de moins), sans plugin réel."""

import asyncio
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vst_native as vn  # noqa: E402
import vst_host  # noqa: E402


class FakeHost:
    """HostProcess factice : enregistre les commandes."""
    made = []

    def __init__(self, *a, **k):
        self.cmds = []
        self.dead = False
        self.pid = 4242
        self.preloaded_path = None
        self.crash_reason = None
        self.listeners = []
        FakeHost.made.append(self)

    def alive(self):
        return not self.dead

    preload_s = 0.0

    def request(self, cmd, timeout=None, **kw):
        self.cmds.append((cmd, kw))
        if cmd == "preload":
            time.sleep(FakeHost.preload_s)
        if cmd == "detect_reload":
            return {"persists": True}
        if cmd == "reinstantiate":
            return {"buses": {}}
        if cmd == "values":
            return {"values": []}
        if cmd == "show_editor":
            return {"hwnd": 777, "owner": kw.get("owner") or 0}
        return {}

    def close(self, timeout=0.5):
        self.dead = True

    def set_priority(self, priority):
        self.priority = priority

    def kill(self):
        self.dead = True


def bare_plugin(**fields):
    p = vn.NativePlugin.__new__(vn.NativePlugin)
    base = {"_host": FakeHost(), "_lock": threading.RLock(), "_defer_fresh": False, "buses": {"in": [{"channels": 2}]},
            "_rate_hint": 48000.0, "_spec": None, "_cpp": [], "_values": [], "_values_dirty": False, "_latency": 0,
            "_editor_open": threading.Event(), "_editor_hwnd": 0, "_editor_owner": 0, "name": "Test", "_closed": False}
    base.update(fields)
    for k, v in base.items():
        object.__setattr__(p, k, v)
    return p


class TestHostPool(unittest.TestCase):
    def setUp(self):
        FakeHost.made.clear()
        self.patch = mock.patch.object(vn, "HostProcess", FakeHost)
        self.patch.start()
        self.pool = vn.HostPool(modules=2)
        self.pool.enabled = lambda: True

    def tearDown(self):
        self.patch.stop()

    def wait(self):
        for _ in range(100):
            t = self.pool.thread
            if t is None or not t.is_alive():
                return
            t.join(0.05)

    def test_heavy_module_is_preloaded_and_reused(self):
        self.pool.note(r"C:\VST3\Shell.vst3", 1200.0)
        self.wait()
        preloads = [kw["path"] for h in FakeHost.made for c, kw in h.cmds if c == "preload"]
        self.assertEqual(preloads, [r"C:\VST3\Shell.vst3"])
        h = self.pool.take(r"c:\vst3\shell.vst3")          # même plugin, autre casse
        self.assertIsNotNone(h)
        self.assertEqual(h.preloaded_path, r"C:\VST3\Shell.vst3")
        self.wait()
        # Remplacé aussitôt (prochain plugin du même shell rapide aussi)
        self.assertEqual(sum(1 for k, _ in self.pool.spares if k), 1)

    def test_waits_for_spare_being_preloaded(self):
        FakeHost.preload_s = 0.3
        try:
            self.pool.note(r"C:\VST3\Shell.vst3", 1200.0)
            time.sleep(0.05)                       # préparation en cours
            h = self.pool.take(r"C:\VST3\Shell.vst3")
            self.assertIsNotNone(h)
            self.assertEqual(h.preloaded_path, r"C:\VST3\Shell.vst3")
        finally:
            FakeHost.preload_s = 0.0
            self.wait()

    def test_only_one_load_waits_for_the_spare(self):
        FakeHost.preload_s = 0.4
        try:
            self.pool.note(r"C:\VST3\Shell.vst3", 1200.0)
            time.sleep(0.05)
            got = {}

            def take(i):
                t0 = time.time()
                got[i] = (self.pool.take(r"C:\VST3\Shell.vst3"), time.time() - t0)
            th = [threading.Thread(target=take, args=(i,)) for i in range(3)]
            for t in th:
                t.start()
            for t in th:
                t.join(5)
            waited = [d for _h, d in got.values() if d > 0.2]
            self.assertEqual(len(waited), 1)          # les autres partent aussitôt
            self.assertEqual(sum(1 for h, _d in got.values() if h is not None and h.preloaded_path), 1)
        finally:
            FakeHost.preload_s = 0.0
            self.wait()

    def test_fast_module_gets_blank_host_only(self):
        self.pool.note(r"C:\VST3\Fast.vst3", 20.0)
        self.wait()
        self.assertEqual([k for k, _ in self.pool.spares], [""])
        self.assertFalse(any(c == "preload" for h in FakeHost.made for c, _ in h.cmds))
        h = self.pool.take(r"C:\VST3\Other.vst3")
        self.assertIsNotNone(h)
        self.assertIsNone(h.preloaded_path)

    def test_forget_and_memory_guard(self):
        self.pool.note(r"C:\VST3\Shell.vst3", 1200.0)
        self.wait()
        self.pool.forget(r"C:\VST3\Shell.vst3")
        self.wait()
        self.assertEqual([k for k, _ in self.pool.spares], [""])
        self.pool.note(r"C:\VST3\Shell.vst3", 1200.0)        # oublié pour de bon
        self.wait()
        self.assertEqual([k for k, _ in self.pool.spares], [""])
        with mock.patch.object(vn, "_free_memory_mb", return_value=500.0):
            self.pool.note(r"C:\VST3\Big.vst3", 900.0)
            self.wait()
        self.assertEqual([k for k, _ in self.pool.spares], [""])

    def test_restore_from_previous_session(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "vst_reserve.json")
            a, b = os.path.join(d, "A.vst3"), os.path.join(d, "B.vst3")
            for p in (a, b):
                open(p, "w").close()
            with open(f, "w", encoding="utf-8") as fh:
                json.dump({"modules": [a, b, os.path.join(d, "absent.vst3")]}, fh)
            self.pool.restore(f, skip=lambda p: p == b)
            self.wait()
            self.assertEqual(sorted(k for k, _ in self.pool.spares if k), [vn.HostPool.key(a)])
            self.pool.note(b, 800.0)                         # enregistré pour la prochaine séance
            with open(f, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["modules"], [a, b])

    def test_disabled_pool_returns_nothing(self):
        pool = vn.HostPool(modules=0)
        self.assertIsNone(pool.take(r"C:\VST3\Shell.vst3"))


class TestDeferFresh(unittest.TestCase):
    def test_no_extra_recreation_when_caller_resets(self):
        p = bare_plugin(_defer_fresh=True)
        p._detect_reload_type()
        self.assertTrue(p._reload_persists)
        self.assertNotIn("reinstantiate", [c for c, _ in p._host.cmds])

    def test_recreated_when_not_deferred(self):
        p = bare_plugin(_defer_fresh=False)
        p._detect_reload_type()
        self.assertIn("reinstantiate", [c for c, _ in p._host.cmds])


class FakeU32:
    def __init__(self, hung_nova, plugin_answers):
        self.hung_nova, self.plugin_answers = hung_nova, plugin_answers

    def GetAncestor(self, h, flag):
        return 100

    def IsWindow(self, h):
        return True

    def IsHungAppWindow(self, h):
        return self.hung_nova

    def SendMessageTimeoutW(self, *a):
        return 1 if self.plugin_answers else 0

    def AllowSetForegroundWindow(self, pid):
        return True


class TestEditorOwner(unittest.TestCase):
    def test_owner_sent_to_host(self):
        p = bare_plugin()
        with mock.patch.object(vn, "_u32", FakeU32(False, True)):
            p._editor_request(False, 0x1234)
        cmd, kw = p._host.cmds[-1]
        self.assertEqual(cmd, "show_editor")
        self.assertEqual(kw["owner"], 0x1234)
        self.assertEqual(p._editor_hwnd, 777)
        self.assertEqual(p._editor_owner, 0x1234)

    def test_no_owner_in_browser(self):
        p = bare_plugin()
        with mock.patch.object(vn, "_u32", FakeU32(False, True)):
            p._editor_request(False, None)
        self.assertNotIn("owner", p._host.cmds[-1][1])

    def test_offscreen_forced_for_tests(self):
        p = bare_plugin()
        with mock.patch.dict(os.environ, {"NOVA_VST_EDITOR_OFFSCREEN": "1"}), \
                mock.patch.object(vn, "_u32", FakeU32(False, True)):
            p._editor_request(False, None)
        self.assertTrue(p._host.cmds[-1][1]["offscreen"])

    def test_frozen_guard(self):
        p = bare_plugin(_editor_hwnd=777, _editor_owner=55)
        for hung, answers, want in ((True, False, True), (True, True, False), (False, False, False)):
            with mock.patch.object(vn, "_u32", FakeU32(hung, answers)):
                self.assertEqual(p.nova_frozen_by_editor(), want, (hung, answers))
        p2 = bare_plugin(_editor_hwnd=777, _editor_owner=0)          # sans propriétaire : jamais
        with mock.patch.object(vn, "_u32", FakeU32(True, False)):
            self.assertFalse(p2.nova_frozen_by_editor())

    def test_show_editor_kills_host_that_freezes_nova(self):
        p = bare_plugin()
        with mock.patch.object(vn, "_u32", FakeU32(True, False)), mock.patch.object(vn, "EDITOR_GUARD_S", 0.0):
            t = threading.Thread(target=p.show_editor, kwargs={"owner": 55})
            t.start()
            t.join(5)
        self.assertFalse(t.is_alive())
        self.assertTrue(p._host.dead)
        self.assertIn("figée", p._host.crash_reason)


class TestParallelLoads(unittest.TestCase):
    def test_native_loads_run_in_parallel(self):
        state = {"now": 0, "max": 0}
        lock = threading.Lock()

        def slow_prepare(*a):
            with lock:
                state["now"] += 1
                state["max"] = max(state["max"], state["now"])
            time.sleep(0.3)
            with lock:
                state["now"] -= 1
            return ("plugin", True)

        with mock.patch.object(vst_host, "prepare_plugin", slow_prepare), \
                mock.patch.object(vst_host, "WATCHER", None), mock.patch.object(vst_host, "CRASH_GUARD", None):
            t0 = time.time()
            threads = [threading.Thread(target=vst_host._instantiate_native, args=(None, f"p{i}", None, None, 48000, 128))
                       for i in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(10)
            took = time.time() - t0
        self.assertGreaterEqual(state["max"], 2)
        self.assertLess(took, 1.0)       # 4 × 0,3 s à la suite = 1,2 s

    def test_param_reads_skip_the_juce_queue(self):
        slot = vst_host.Slot.__new__(vst_host.Slot)
        slot.plugin = bare_plugin()

        class Juce:
            editor_slot = None

            def run_sync(self, *a, **k):
                raise AssertionError("file JUCE utilisée")
        slot.juce = Juce()
        with mock.patch.object(vst_host, "NATIVE", True):
            self.assertEqual(slot._on_message_thread(lambda x: x + 1, 1), 2)


class TestBridgeShowEditor(unittest.TestCase):
    def test_owner_forwarded(self):
        import nova_bridge_server as nbs
        srv = nbs.NovaBridgeServer.__new__(nbs.NovaBridgeServer)
        got = {}

        class Juce:
            def open_editor(self, slot, on_closed, owner=None):
                got["owner"] = owner
        slot = object()
        srv.slots = {}            # aucun insert ARA (ara_insert enveloppe _a_show_editor)
        srv.juce = Juce()
        srv._slot = lambda req: slot
        srv._reply = lambda ws, req, payload: got.setdefault("reply", payload)

        async def run(req):
            srv.loop = asyncio.get_running_loop()
            await nbs.NovaBridgeServer._a_show_editor(srv, None, req)
        with mock.patch.object(vst_host, "HAS_VST", True):
            asyncio.run(run({"slot_id": "a", "owner": 4660}))
            self.assertEqual(got["owner"], 4660)
            asyncio.run(run({"slot_id": "a"}))
            self.assertIsNone(got["owner"])
            asyncio.run(run({"slot_id": "a", "owner": "pas un nombre"}))
            self.assertIsNone(got["owner"])
        self.assertTrue(got["reply"]["success"])


if __name__ == "__main__":
    unittest.main()
