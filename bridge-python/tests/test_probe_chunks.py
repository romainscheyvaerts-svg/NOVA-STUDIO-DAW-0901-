# -*- coding: utf-8 -*-
r"""
1re lecture des plugins sur un PC (rien en cache) : shells d'abord (Waves), puis par paquets ;
la liste du pont se complète au fur et à mesure (pas seulement à la fin de tout le lot).

    ..\desktop\venv\Scripts\python.exe -m unittest discover -s tests -p "test_probe_chunks.py"
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import nova_bridge_server as srv  # noqa: E402


class ProbeChunks(unittest.TestCase):
    def test_ordre_shells_dabord(self):
        paths = [r"C:\VST3\Auto-Tune Pro.vst3", r"C:\VST3\WaveShell1-VST3 17.4_x64.vst3", r"C:\VST3\A.vst3"]
        self.assertEqual(sorted(paths, key=srv.probe_order)[0], r"C:\VST3\WaveShell1-VST3 17.4_x64.vst3")

    def test_liste_completee_par_paquets(self):
        n = srv.PROBE_CHUNK * 2 + 3
        plugins = [{"name": f"P{i}", "vendor": "", "path": f"C:/VST3/P{i:03d}.vst3", "is_instrument": None, "category": "Effect"}
                   for i in range(n)]
        plugins.append({"name": "WaveShell1-VST3 17.4_x64", "vendor": "", "path": "C:/VST3/WaveShell1-VST3 17.4_x64.vst3",
                        "is_instrument": None, "category": "Effect"})
        calls, seen_lists = [], []

        def fake_probe(bundles, _main, progress):
            calls.append(list(bundles))
            for i, _ in enumerate(bundles):
                progress(i + 1, len(bundles))
            out = {}
            for b in bundles:
                if "WaveShell" in b:
                    out[b] = {"c": [("C6 Stereo", "Fx|Dynamics", "Waves"), ("C6 Mono", "Fx|Dynamics", "Waves")], "st": "ok"}
                else:
                    out[b] = {"c": [(os.path.basename(b)[:-5], "Fx")], "st": "ok"}
            return out

        class FakeServer:
            _probe = srv.NovaBridgeServer._probe

        s = FakeServer()
        s.plugins, s._probed, s.probe_progress = plugins, set(), None
        orig = srv.vst_probe.probe_bundles
        srv.vst_probe.probe_bundles = fake_probe
        orig_apply = srv.vst_probe.apply_classes

        def spy_apply(pl, res):
            out = orig_apply(pl, res)
            seen_lists.append([p["name"] for p in out])
            return out
        srv.vst_probe.apply_classes = spy_apply
        try:
            async def run():
                s.loop = asyncio.get_running_loop()
                s.misc_pool = None
                await s._probe()
            asyncio.run(run())
        finally:
            srv.vst_probe.probe_bundles = orig
            srv.vst_probe.apply_classes = orig_apply

        self.assertEqual(len(calls), 3)                              # par paquets
        self.assertIn("WaveShell1-VST3 17.4_x64.vst3", os.path.basename(calls[0][0]))  # shell d'abord
        self.assertIn("C6 Stereo", seen_lists[0])                    # Waves visible dès le 1er paquet
        self.assertIn("C6 Mono", [p["name"] for p in s.plugins])
        self.assertNotIn("WaveShell1-VST3 17.4_x64", [p["name"] for p in s.plugins])
        self.assertIsNone(s.probe_progress)


if __name__ == "__main__":
    unittest.main(verbosity=2)
