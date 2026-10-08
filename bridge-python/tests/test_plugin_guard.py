"""Garde du pont : un plugin qui plante est isolé (processus jetable), noté
« instable sur le pont », refusé ; le pont continue.

    venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_plugin_guard.py"
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import plugin_guard  # noqa: E402

PY = sys.executable


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["NOVA_GUARD_FILE"] = os.path.join(self.tmp.name, "guard.json")
        os.environ.pop("NOVA_BRIDGE_TRIAL", None)
        self.plugin = os.path.join(self.tmp.name, "RUBY2.vst3")
        Path(self.plugin).write_bytes(b"x")
        self.other = os.path.join(self.tmp.name, "Pro-Q 4.vst3")
        Path(self.other).write_bytes(b"y")

    def tearDown(self):
        os.environ.pop("NOVA_GUARD_FILE", None)
        self.tmp.cleanup()

    def _child(self, code: str):
        return [PY, "-c", code]

    def test_essai_plante_bloque_reussit(self):
        crash = self._child("import os; os.abort()")
        self.assertEqual(plugin_guard.run_trial(self.plugin, None, 20, crash)[0], "crash")
        hang = self._child("import time; time.sleep(30)")
        self.assertEqual(plugin_guard.run_trial(self.plugin, None, 1.5, hang)[0], "hang")
        ok = self._child(f"print('{plugin_guard.MARK}' + '{{\"ok\": true, \"params\": 3}}')")
        self.assertEqual(plugin_guard.run_trial(self.plugin, None, 20, ok), ("ok", "3 réglages"))
        err = self._child(f"print('{plugin_guard.MARK}' + '{{\"error\": \"scan failure\"}}')")
        self.assertEqual(plugin_guard.run_trial(self.plugin, None, 20, err)[0], "error")

    def test_plugin_qui_plante_est_isole_et_refuse(self):
        self.assertTrue(plugin_guard.is_risky(self.plugin, None))       # liste de départ (RUBY2)
        self.assertFalse(plugin_guard.is_risky(self.other, None))
        orig = plugin_guard._child_command
        plugin_guard._child_command = lambda: self._child("import os; os.abort()")
        try:
            with self.assertRaises(plugin_guard.PluginUnstable) as e:
                plugin_guard.check(self.plugin, None, timeout=20)
            self.assertIn("instable sur le pont", str(e.exception))
            # Ensuite : refusé tout de suite, sans nouvel essai.
            plugin_guard._child_command = lambda: (_ for _ in ()).throw(AssertionError("pas de nouvel essai"))
            with self.assertRaises(plugin_guard.PluginUnstable):
                plugin_guard.check(self.plugin, None)
            self.assertIsNotNone(plugin_guard.status(self.plugin, None))
            # Plugin mis à jour : nouvelle chance.
            Path(self.plugin).write_bytes(b"version 2")
            os.utime(self.plugin, (1, 1))
            self.assertIsNone(plugin_guard.status(self.plugin, None))
        finally:
            plugin_guard._child_command = orig

    def test_essai_reussi_puis_confiance(self):
        orig = plugin_guard._child_command
        plugin_guard._child_command = lambda: self._child(f"print('{plugin_guard.MARK}' + '{{\"ok\": true, \"params\": 1}}')")
        try:
            plugin_guard.check(self.plugin, None, timeout=20)
            self.assertFalse(plugin_guard.is_risky(self.plugin, None))
        finally:
            plugin_guard._child_command = orig

    def test_temoin_reste_apres_un_arret_du_pont(self):
        with plugin_guard.loading(self.other, "C6 Stereo"):
            d = json.loads(Path(os.environ["NOVA_GUARD_FILE"]).read_text(encoding="utf-8"))
            self.assertEqual(len(d["pending"]), 1)
            pending = dict(d["pending"])
        # Simule un pont mort pendant le chargement : le témoin est resté.
        d["pending"] = pending
        Path(os.environ["NOVA_GUARD_FILE"]).write_text(json.dumps(d), encoding="utf-8")
        self.assertEqual(plugin_guard.startup(), ["C6 Stereo"])
        self.assertTrue(plugin_guard.is_risky(self.other, "C6 Stereo"))
        self.assertFalse(plugin_guard.is_risky(self.other, "C6 Mono"))

    def test_mode_off_et_rescan(self):
        os.environ["NOVA_BRIDGE_TRIAL"] = "off"
        try:
            self.assertFalse(plugin_guard.is_risky(self.plugin, None))
        finally:
            os.environ.pop("NOVA_BRIDGE_TRIAL", None)
        d = plugin_guard._load()
        d["unstable"][plugin_guard.key_of(self.plugin, None)] = {"name": "RUBY2", "reason": "plantage", "fp": None}
        plugin_guard._save(d)
        plugin_guard.retry_unstable()
        self.assertIsNone(plugin_guard.status(self.plugin, None))
        self.assertTrue(plugin_guard.is_risky(self.plugin, None))


if __name__ == "__main__":
    unittest.main()
