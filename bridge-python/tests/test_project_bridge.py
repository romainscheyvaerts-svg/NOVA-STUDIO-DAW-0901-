"""Actions PROJECT_* du pont (v13) : boucle asyncio réelle du serveur, faux websocket,
dossier de projets temporaire. Même chemin que Nova Studio : sons manquants →
trames PROJECT_AUDIO_PUT (planar) → PROJECT_SAVE_VERSION → PROJECT_LIST → PROJECT_LOAD.

    venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_project_bridge*.py"
"""
import asyncio
import json
import struct
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def frame(meta: dict, payload: np.ndarray) -> bytes:
    j = json.dumps(meta).encode("utf-8")
    off = (8 + len(j) + 3) & ~3
    head = bytearray(off)
    head[0] = 2
    struct.pack_into("<I", head, 4, len(j))
    head[8:8 + len(j)] = j
    return bytes(head) + np.ascontiguousarray(payload, dtype="<f4").tobytes()


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send(self, data):
        self.sent.append(data)

    def json(self, action):
        return [json.loads(d) for d in self.sent if isinstance(d, str) and json.loads(d).get("action") == action]


class ProjectBridgeTest(unittest.TestCase):
    def setUp(self):
        import nova_bridge_server as srv
        import project_store
        self.srv, self.ps = srv, project_store
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _server(self):
        server = self.srv.NovaBridgeServer.__new__(self.srv.NovaBridgeServer)
        server.loop = asyncio.get_running_loop()
        server.clients = set()
        server.projects = self.ps.ProjectStore(Path(self.tmp.name) / "Projets")
        server.project_pool = ThreadPoolExecutor(max_workers=1)
        return server

    def test_aller_retour_complet(self):
        async def scenario():
            server, ws = self._server(), FakeWS()
            hello = FakeWS()
            await server._a_hello(hello, {"action": "HELLO", "req_id": 1})
            await asyncio.sleep(0)
            self.assertTrue(json.loads(hello.sent[0])["projects"])
            self.assertGreaterEqual(json.loads(hello.sent[0])["version"], 13)

            await server._a_project_audio_missing(ws, {"action": "PROJECT_AUDIO_MISSING", "req_id": 2, "project_id": "p-1",
                                                       "name": "Séance LENNON", "audio_ids": ["voix", "beat"]})
            await asyncio.sleep(0)
            self.assertEqual(ws.json("PROJECT_AUDIO_MISSING")[-1]["missing"], ["voix", "beat"])
            voix = np.vstack([np.linspace(-1, 1, 4800), np.linspace(1, -1, 4800)]).astype(np.float32)
            beat = np.sin(np.arange(9600) / 10).astype(np.float32)[None, :]
            for i, (aid, a) in enumerate((("voix", voix), ("beat", beat))):
                meta = {"action": "PROJECT_AUDIO_PUT", "req_id": 10 + i, "project_id": "p-1", "name": "Séance LENNON",
                        "audio_id": aid, "sample_rate": 48000, "nch": a.shape[0], "nframes": a.shape[1], "planar": True}
                await server._on_render(ws, frame(meta, a.reshape(-1)))
            self.assertTrue(all(r["success"] for r in ws.json("PROJECT_AUDIO_PUT")))
            rec = {"id": 1760000000000, "savedAt": 1760000000000, "name": "Séance LENNON", "reason": "auto", "tracks": 2,
                   "takes": 1, "json": json.dumps({"tracks": [1, 2]}), "audioIds": ["voix", "beat"]}
            await server._a_project_save_version(ws, {"action": "PROJECT_SAVE_VERSION", "req_id": 20, "project_id": "p-1",
                                                      "name": "Séance LENNON", "version": rec})
            await asyncio.sleep(0)
            saved = ws.json("PROJECT_SAVE_VERSION")[-1]
            self.assertTrue(saved["success"])
            self.assertTrue(saved["folder"].endswith("Séance LENNON"))
            await server._a_project_list(ws, {"action": "PROJECT_LIST", "req_id": 21})
            await asyncio.sleep(0)
            lst = ws.json("PROJECT_LIST")[-1]
            self.assertEqual(lst["projects"][0]["latest"]["id"], 1760000000000)

            ws.sent.clear()
            await server._a_project_load(ws, {"action": "PROJECT_LOAD", "req_id": 30, "project_id": "p-1"})
            frames = [self.srv.parse_render_frame(d) for d in ws.sent if isinstance(d, (bytes, bytearray))]
            self.assertEqual([m["action"] for m, _ in frames], ["PROJECT_AUDIO", "PROJECT_AUDIO", "PROJECT_LOAD"])
            got = {m["audio_id"]: data.reshape(m["nch"], m["nframes"]) for m, data in frames[:2]}
            np.testing.assert_array_equal(got["voix"], voix)
            np.testing.assert_array_equal(got["beat"], beat)
            self.assertEqual(frames[2][0]["record"]["json"], rec["json"])
            self.assertEqual(frames[2][0]["missing"], [])

        asyncio.run(scenario())

    def test_version_sans_son_refusee_et_projet_inconnu(self):
        async def scenario():
            server, ws = self._server(), FakeWS()
            await server._safe(server._a_project_save_version, ws, {"action": "PROJECT_SAVE_VERSION", "req_id": 1, "project_id": "p",
                                                                    "name": "X", "version": {"id": 5, "json": "{}", "audioIds": ["absent"]}})
            await asyncio.sleep(0)
            r = ws.json("PROJECT_SAVE_VERSION")[-1]
            self.assertFalse(r["success"])
            self.assertIn("pas encore écrit", r["error"])
            await server._a_project_load(ws, {"action": "PROJECT_LOAD", "req_id": 2, "project_id": "inconnu"})
            m, _ = self.srv.parse_render_frame(ws.sent[-1])
            self.assertFalse(m["success"])

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
