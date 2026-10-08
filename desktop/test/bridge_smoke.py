# -*- coding: utf-8 -*-
"""
Test rapide des ponts embarqués : lance l'appli (page hors ligne, peu importe),
interroge le pont ASIO (GET_DEVICES) et le pont VST (HELLO, liste, chargement du
premier effet VST3 trouvé), puis ferme l'appli.

  venv\\Scripts\\python.exe test\\bridge_smoke.py dist\\NovaStudio\\NovaStudio.exe
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt  # noqa: E402
import websockets  # noqa: E402

ORIGIN = "https://nova-studio-daw-0901-9kzo.vercel.app"


async def ask(ws, msg, want=None, timeout=60):
    await ws.send(json.dumps(msg))
    end = time.time() + timeout
    while time.time() < end:
        raw = await asyncio.wait_for(ws.recv(), timeout)
        if isinstance(raw, bytes):
            continue
        data = json.loads(raw)
        if want is None or data.get("action") == want or data.get("req_id") == msg.get("req_id"):
            return data
    raise TimeoutError(msg)


async def smoke():
    async with websockets.connect("ws://127.0.0.1:8766", origin=ORIGIN, max_size=None) as ws:
        d = await ask(ws, {"action": "GET_DEVICES"}, "DEVICES")
        names = [x.get("name") for x in d.get("devices", d.get("asio_devices", []))] if isinstance(d, dict) else []
        rt.check("pont ASIO : GET_DEVICES répond", d.get("action") == "DEVICES", f"{len(names)} périphérique(s)")
    async with websockets.connect("ws://127.0.0.1:8765", origin=ORIGIN, max_size=None) as ws:
        h = await ask(ws, {"action": "HELLO", "req_id": "h"})
        rt.check("pont VST : HELLO (moteur natif)", h.get("success") and h.get("engine") == "native", str(h.get("version")))
        lst = await ask(ws, {"action": "GET_PLUGIN_LIST", "req_id": "l", "effects_only": True})
        plugins = lst.get("plugins") or []
        rt.check("pont VST : liste des plugins", len(plugins) > 0, f"{len(plugins)} effets")
        for p in plugins[:5]:
            r = await ask(ws, {"action": "LOAD_PLUGIN", "req_id": "x", "slot_id": "smoke", "path": p["path"],
                               "plugin_name": p.get("name"), "sample_rate": 48000}, timeout=60)
            if r.get("success"):
                rt.check("pont VST : chargement d'un VST3", True, r.get("name"))
                await ask(ws, {"action": "UNLOAD_PLUGIN", "req_id": "u", "slot_id": "smoke"})
                break
            print("   (échec sur", p.get("name"), ":", r.get("error"), ")")
        else:
            rt.check("pont VST : chargement d'un VST3", False)


def main():
    cmd = [os.path.abspath(sys.argv[1])] if len(sys.argv) > 1 else [sys.executable, os.path.join(rt.DESKTOP, "nova_desktop.py")]
    data_dir = tempfile.mkdtemp(prefix="nova-desktop-smoke-")
    p = rt.launch(cmd, "http://127.0.0.1:5198/", data_dir, bridges=True)
    try:
        ok = rt.wait_for(lambda: rt.listening(8766) and rt.listening(8765), 40)
        rt.check("ponts à l'écoute", ok)
        if ok:
            asyncio.run(smoke())
    finally:
        rt.wait_for(lambda: rt.find_window(p.pid), 10)
        rt.close_window(p.pid)
        try:
            p.wait(15)
        except subprocess.TimeoutExpired:
            p.kill()
        rt.check("ponts arrêtés", rt.wait_for(lambda: not rt.listening(8766) and not rt.listening(8765), 10))
        print("journaux :", os.path.join(data_dir, "logs"))
    sys.exit(0 if all(ok for _, ok in rt.results) else 1)


if __name__ == "__main__":
    main()
