"""Panneau du pilote ASIO (asio_control_panel.py + OPEN_CONTROL_PANEL du pont), SANS pilote :
le processus du panneau est simulé, aucun pilote ASIO n'est chargé.

  <python du pont> -m unittest discover -s tests -p "test_asio_panel.py"

Vérifie :
  - le pont répond tout de suite (avant : 1 s fixe pendant laquelle il ne lisait plus rien de ce
    client, ni messages ni audio de lecture) et signale ensuite un panneau qui échoue ;
  - le processus du panneau vit tant que le panneau est ouvert (avant : 60 s fixes, panneau
    fermé en plein réglage, pilote gardé occupé jusqu'à une minute après sa fermeture).
"""
import asyncio
import json
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import fake_sounddevice as fsd  # noqa: E402
fsd.install()
import asio_bridge  # noqa: E402
import asio_control_panel as acp  # noqa: E402
import logging  # noqa: E402
asio_bridge.logger.setLevel(logging.WARNING)
acp.logger.setLevel(logging.WARNING)


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, dt):
        self.t += dt


class WaitPanelTests(unittest.TestCase):
    def run_case(self, windows_at, **kw):
        """windows_at(t) -> nombre de fenêtres visibles à l'instant t."""
        c = FakeClock()
        why = acp.wait_panel_closed(lambda: windows_at(c.t), pump=lambda: True, clock=c, sleep=c.sleep, **kw)
        return why, c.t

    def test_panneau_ouvert_cinq_minutes_reste_ouvert(self):
        why, t = self.run_case(lambda t: 1 if 0.5 <= t < 300 else 0)
        self.assertEqual(why, "ferme")
        self.assertGreaterEqual(t, 300)          # avant : coupé à 60 s
        self.assertLess(t, 300 + 1.0)            # pilote rendu < 1 s après la fermeture

    def test_panneau_ferme_vite_rend_le_pilote_tout_de_suite(self):
        why, t = self.run_case(lambda t: 1 if 0.2 <= t < 3 else 0)
        self.assertEqual(why, "ferme")
        self.assertLess(t, 4.0)                  # avant : 60 s

    def test_application_du_fabricant_aucune_fenetre(self):
        why, t = self.run_case(lambda t: 0)
        self.assertEqual(why, "aucune-fenetre")
        self.assertLess(t, 4.5)

    def test_panneau_modal_deja_ferme(self):
        why, t = self.run_case(lambda t: 0, appear_grace_s=0.3)
        self.assertEqual(why, "aucune-fenetre")
        self.assertLess(t, 0.5)

    def test_plafond(self):
        why, t = self.run_case(lambda t: 1, max_s=10)
        self.assertEqual(why, "delai")

    def test_wm_quit(self):
        c = FakeClock()
        self.assertEqual(acp.wait_panel_closed(lambda: 1, pump=lambda: False, clock=c, sleep=c.sleep), "quit")


class FakeProc:
    def __init__(self, code_after=None, code=0):
        self.pid = 4242
        self.t0 = time.time()
        self.code_after, self.code = code_after, code
        self.stdout = iter(())

    def poll(self):
        if self.code_after is not None and time.time() - self.t0 >= self.code_after:
            return self.code
        return None


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, m):
        self.sent.append((time.perf_counter(), m))


class BridgePanelTests(unittest.TestCase):
    def _run(self, proc, wait=0.0):
        srv = asio_bridge.ASIOBridgeServer(port=1)
        srv.config.device_name = "Pilote de test"
        ws = FakeWS()
        srv.clients["c"] = ws
        import subprocess
        real = subprocess.Popen
        subprocess.Popen = lambda *a, **kw: proc
        try:
            async def go():
                t0 = time.perf_counter()
                await srv._handle_open_control_panel("c", {})
                took = time.perf_counter() - t0
                if wait:
                    await asyncio.sleep(wait)
                return took
            took = asyncio.run(go())
        finally:
            subprocess.Popen = real
        msgs = [json.loads(m) for _, m in ws.sent if isinstance(m, str)]
        return took, [m for m in msgs if m.get("action") == "CONTROL_PANEL_RESULT"]

    def test_reponse_immediate(self):
        took, res = self._run(FakeProc())
        self.assertLess(took, 0.2, f"le pont a bloqué ce client {took:.2f} s")   # avant : 1,0 s
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["success"])

    def test_panneau_en_echec_signale_ensuite(self):
        took, res = self._run(FakeProc(code_after=0.1, code=1), wait=2.0)
        self.assertLess(took, 0.2)
        self.assertEqual([r["success"] for r in res], [True, False])
        self.assertIn("pilote", res[-1]["error"])
        self.assertNotIn("Process exited", res[-1]["error"])

    def test_sans_pilote(self):
        srv = asio_bridge.ASIOBridgeServer(port=1)
        srv.config.device_name = ""
        ws = FakeWS()
        srv.clients["c"] = ws
        asyncio.run(srv._handle_open_control_panel("c", {}))
        m = json.loads(ws.sent[0][1])
        self.assertFalse(m["success"])
        self.assertEqual(m["error"], "Aucun driver ASIO sélectionné")


if __name__ == "__main__":
    unittest.main()
