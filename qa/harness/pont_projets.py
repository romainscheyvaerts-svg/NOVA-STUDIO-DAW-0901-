"""Pont de test pour qa/sauvegarde_persistante.py : le VRAI code du pont (nova_bridge_server,
actions PROJECT_* et HELLO, project_store) derrière un WebSocket local, sans plugins.

    venv\\Scripts\\python.exe qa/harness/pont_projets.py --port 8795 --root <dossier Projets>
        [--lent <fichier>]   tant que <fichier> existe, chaque écriture de VERSION s'arrête au
                             milieu (fichier temporaire à moitié écrit) : le scénario tue alors
                             le processus pour simuler un plantage pendant l'écriture.

Aucune fenêtre, n'écoute que sur 127.0.0.1.
"""
import argparse
import asyncio
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bridge-python"))

import websockets  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

import nova_bridge_server as srv  # noqa: E402
import project_store  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--lent", default="")
    a = ap.parse_args()

    if a.lent:
        flag = Path(a.lent)

        def hook(path, written):
            if flag.exists() and path.parent.name == "versions":
                (flag.parent / "ecriture_commencee.txt").write_text(f"{path.name} {written}", encoding="utf-8")
                time.sleep(120)  # le scénario tue le processus pendant cette pause

        project_store._WRITE_HOOK = hook

    async def run():
        server = srv.NovaBridgeServer.__new__(srv.NovaBridgeServer)
        server.loop = asyncio.get_running_loop()
        server.clients = set()
        server.slots = {}
        server.projects = project_store.ProjectStore(Path(a.root))
        server.project_pool = ThreadPoolExecutor(max_workers=1)

        async def handle(ws):
            server.clients.add(ws)
            try:
                async for message in ws:
                    if isinstance(message, (bytes, bytearray)):
                        if message and message[0] == 2:
                            asyncio.create_task(server._on_render(ws, bytes(message)))
                        continue
                    try:
                        data = json.loads(message)
                    except ValueError:
                        continue
                    if isinstance(data, dict):
                        server._dispatch(ws, data)
            except websockets.ConnectionClosed:
                pass
            finally:
                server.clients.discard(ws)

        async with serve(handle, "127.0.0.1", a.port, max_size=1024 * 1024 * 1024, compression=None):
            print(f"pont de test prêt sur {a.port}", flush=True)
            await asyncio.Future()

    asyncio.run(run())


if __name__ == "__main__":
    main()
