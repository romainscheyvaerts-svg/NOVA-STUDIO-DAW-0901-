#!/usr/bin/env python3
"""
Banc « ouverture d'un VST » de bout en bout, à travers le PONT (WebSocket), comme le fait la page :
LOAD_PLUGIN, puis (comme VSTPluginNode / VSTPluginWindow) AUTOMATABLE et SHOW_EDITOR aussitôt
le plugin actif ; on attend la fenêtre du plugin affichée (classe NovaPluginEditor, HORS ÉCRAN :
NOVA_VST_EDITOR_OFFSCREEN=1, rien ne s'affiche sur l'écran).

  insertion : un plugin à la fois (clic « ajouter l'effet » → fenêtre), médiane de --runs
  séance    : ouverture d'un projet (N plugins chargés d'un coup), puis le musicien ouvre le
              DERNIER plugin de la liste : temps jusqu'à sa fenêtre, temps jusqu'à tout chargé

Pont de test lancé à part : port 8791, données dans un dossier à part (copie du cache des plugins),
jamais 8765/8766 ni la carte son.

Usage (venv du bureau) : python qa/vst_ouverture_pont.py [--runs 3] [--json f] [--skip-session] [--skip-insert]
"""

import argparse
import asyncio
import ctypes
import itertools
import json
import os
import shutil
import socket
import statistics
import subprocess
import sys
import time
from ctypes import wintypes

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
PORT = int(os.environ.get("NOVA_BANC_PORT", "8791"))
SCRATCH = os.environ.get("NOVA_BANC_DIR") or os.path.join(os.path.dirname(ROOT), "_scratch_vstfen", "pont")
V = r"C:\Program Files\Common Files\VST3"
WS17 = rf"{V}\WaveShell1-VST3 17.1_x64.vst3"
INSERT = [
    ("Pro-Q 4", rf"{V}\FabFilter\FabFilter Pro-Q 4.vst3", None),
    ("Auto-Tune Pro", rf"{V}\Auto-Tune Pro.vst3", None),
    ("Waves C6", WS17, "C6 Stereo"),
    ("Waves CLA-2A", WS17, "CLA-2A Stereo"),
    ("AIR Delay Pro", rf"{V}\AIR Music Technology\AIR Delay Pro.vst3", None),
    ("ValhallaRoom", rf"{V}\ValhallaDSP\ValhallaRoom.vst3", None),
]
SESSION = [
    ("Pro-Q 4", rf"{V}\FabFilter\FabFilter Pro-Q 4.vst3", None),
    ("Pro-C 3", rf"{V}\FabFilter\FabFilter Pro-C 3.vst3", None),
    ("Waves C6", WS17, "C6 Stereo"),
    ("Waves CLA-2A", WS17, "CLA-2A Stereo"),
    ("Waves H-Reverb", WS17, "H-Reverb Stereo"),
    ("Waves RVox", WS17, "RVox Stereo"),
    ("Waves L1", WS17, "L1 limiter Stereo"),
    ("Auto-Tune Pro", rf"{V}\Auto-Tune Pro.vst3", None),
    ("A.O.M. Invisible Limiter G3", rf"{V}\A.O.M\Invisible_Limiter_G3.vst3", None),
    ("AIR Delay Pro", rf"{V}\AIR Music Technology\AIR Delay Pro.vst3", None),
    ("ValhallaRoom", rf"{V}\ValhallaDSP\ValhallaRoom.vst3", None),
    ("Pro-Q 4 (2)", rf"{V}\FabFilter\FabFilter Pro-Q 4.vst3", None),
]

u32 = ctypes.WinDLL("user32")
_Enum = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def editor_windows() -> set:
    found = set()

    def cb(h, _l):
        buf = ctypes.create_unicode_buffer(64)
        u32.GetClassNameW(h, buf, 64)
        if buf.value == "NovaPluginEditor" and u32.IsWindowVisible(h):
            found.add(int(h))
        return True
    u32.EnumWindows(_Enum(cb), 0)
    return found


def start_bridge(log_name: str) -> subprocess.Popen:
    data = os.path.join(SCRATCH, "appdata")
    os.makedirs(os.path.join(data, "NovaStudio"), exist_ok=True)
    real = os.path.join(os.environ["LOCALAPPDATA"], "NovaStudio")
    for f in ("vst3_classes.json", "license_windows.json"):
        src = os.path.join(real, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(data, "NovaStudio", f))
    env = dict(os.environ, NOVA_BRIDGE_PORT=str(PORT), LOCALAPPDATA=data, NOVA_VST_EDITOR_OFFSCREEN="1",
               NOVA_PROJECTS_DIR=os.path.join(SCRATCH, "projets"), PYTHONIOENCODING="utf-8")
    log = open(os.path.join(SCRATCH, log_name), "w", encoding="utf-8")
    p = subprocess.Popen([sys.executable, "-u", os.path.join(ROOT, "bridge-python", "nova_bridge_server.py")],
                         cwd=os.path.join(ROOT, "bridge-python"), env=env, stdout=log, stderr=subprocess.STDOUT,
                         creationflags=0x08000000)
    t0 = time.time()
    while time.time() - t0 < 60:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.3):
                return p
        except OSError:
            time.sleep(0.2)
    p.kill()
    raise RuntimeError("pont de test non démarré")


class Client:
    def __init__(self, ws):
        self.ws, self.ids, self.waiting = ws, itertools.count(1), {}
        self.reader = asyncio.ensure_future(self._read())

    async def _read(self):
        async for msg in self.ws:
            if isinstance(msg, (bytes, bytearray)):
                continue
            d = json.loads(msg)
            fut = self.waiting.pop(d.get("req_id"), None)
            if fut is not None and not fut.done():
                fut.set_result(d)

    async def req(self, action: str, timeout=900, **kw) -> dict:
        rid = f"r{next(self.ids)}"
        fut = asyncio.get_running_loop().create_future()
        self.waiting[rid] = fut
        await self.ws.send(json.dumps({"action": action, "req_id": rid, **kw}))
        return await asyncio.wait_for(fut, timeout)


async def wait_window(before: set, timeout=60.0) -> float:
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout:
        if editor_windows() - before:
            return time.perf_counter()
        await asyncio.sleep(0.005)
    raise TimeoutError("fenêtre du plugin jamais affichée")


async def open_like_page(c: Client, slot: str, path: str, cls, t0: float) -> dict:
    """LOAD_PLUGIN puis, comme la page une fois l'effet actif : AUTOMATABLE et SHOW_EDITOR."""
    r = await c.req("LOAD_PLUGIN", slot_id=slot, path=path, plugin_name=cls, sample_rate=48000)
    if not r.get("success"):
        raise RuntimeError(r.get("error"))
    t_load = time.perf_counter()
    before = editor_windows()
    auto = asyncio.ensure_future(c.req("AUTOMATABLE", slot_id=slot))
    await c.req("SHOW_EDITOR", slot_id=slot)
    t_win = await wait_window(before)
    await auto
    t_auto = time.perf_counter()
    return {"chargé (son prêt)": (t_load - t0) * 1000, "fenêtre affichée": (t_win - t0) * 1000,
            "réglages listés": (t_auto - t0) * 1000}


async def insertion(c: Client, runs: int) -> dict:
    out = {}
    for name, path, cls in INSERT:
        res = []
        for i in range(runs):
            slot = f"ins-{name}-{i}"
            t0 = time.perf_counter()
            res.append(await open_like_page(c, slot, path, cls, t0))
            await c.req("CLOSE_EDITOR", slot_id=slot)
            await c.req("UNLOAD_PLUGIN", slot_id=slot)
            await asyncio.sleep(0.6)
        med = {k: round(statistics.median(r[k] for r in res)) for k in res[0]}
        out[name] = med
        print(f"  {name:28s} " + " · ".join(f"{k} {v} ms" for k, v in med.items()), flush=True)
    return out


async def session(c: Client) -> dict:
    t0 = time.perf_counter()
    done = {}
    loaded = [asyncio.Event() for _ in SESSION]

    async def one(i, name, path, cls):
        slot = f"ses-{i}"
        r = await c.req("LOAD_PLUGIN", slot_id=slot, path=path, plugin_name=cls, sample_rate=48000)
        done[name] = (time.perf_counter() - t0) * 1000
        loaded[i].set()
        if r.get("success"):
            await c.req("AUTOMATABLE", slot_id=slot)     # comme la page, une fois l'effet actif
        return r

    tasks = [asyncio.ensure_future(one(i, *p)) for i, p in enumerate(SESSION)]
    # Le musicien ouvre le dernier plugin de la séance dès qu'il est actif.
    last = len(SESSION) - 1
    await loaded[last].wait()
    before = editor_windows()
    await c.req("SHOW_EDITOR", slot_id=f"ses-{last}")
    t_win = (await wait_window(before) - t0) * 1000
    results = await asyncio.gather(*tasks)
    t_all = (time.perf_counter() - t0) * 1000
    fails = [SESSION[i][0] for i, r in enumerate(results) if not r.get("success")]
    for i in range(len(SESSION)):
        await c.req("UNLOAD_PLUGIN", slot_id=f"ses-{i}")
    out = {"plugins": len(SESSION), "tout chargé (ms)": round(t_all),
           f"fenêtre du dernier ({SESSION[last][0]}) (ms)": round(t_win), "échecs": fails,
           "chargés à (ms)": {k: round(v) for k, v in done.items()}}
    print(f"  séance : {json.dumps(out, ensure_ascii=False)}", flush=True)
    return out


async def amain(a):
    os.makedirs(SCRATCH, exist_ok=True)
    report = {}
    if not a.skip_insert:
        bridge = start_bridge("pont_insertion.log")
        try:
            async with websockets.connect(f"ws://127.0.0.1:{PORT}", max_size=None) as ws:
                c = Client(ws)
                print("insertion :", flush=True)
                report["insertion"] = await insertion(c, a.runs)
        finally:
            bridge.kill()
            bridge.wait(10)
    if not a.skip_session:
        await asyncio.sleep(2)
        bridge = start_bridge("pont_seance.log")   # pont neuf : rien de préchauffé par l'insertion
        try:
            async with websockets.connect(f"ws://127.0.0.1:{PORT}", max_size=None) as ws:
                c = Client(ws)
                report["séance"] = await session(c)
        finally:
            bridge.kill()
            bridge.wait(10)
    if a.first:
        # Premier plugin ouvert après le démarrage de Nova (la séance précédente utilisait Waves et
        # Auto-Tune : vst_reserve.json, rempli par les scénarios ci-dessus).
        bridge = start_bridge("pont_premier.log")
        try:
            await asyncio.sleep(a.first)
            async with websockets.connect(f"ws://127.0.0.1:{PORT}", max_size=None) as ws:
                c = Client(ws)
                out = {}
                for name, path, cls in (INSERT[2], INSERT[1]):
                    t0 = time.perf_counter()
                    out[name] = {k: round(v) for k, v in (await open_like_page(c, f"first-{name}", path, cls, t0)).items()}
                    await c.req("CLOSE_EDITOR", slot_id=f"first-{name}")
                print(f"  premier plugin après {a.first:.0f} s : {json.dumps(out, ensure_ascii=False)}", flush=True)
                report["premier plugin après démarrage"] = out
        finally:
            bridge.kill()
            bridge.wait(10)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--json")
    ap.add_argument("--skip-session", action="store_true")
    ap.add_argument("--skip-insert", action="store_true")
    ap.add_argument("--first", type=float, default=0.0,
                    help="pont neuf, attendre N s puis ouvrir Waves C6 et Auto-Tune (1re ouverture)")
    a = ap.parse_args()
    asyncio.run(amain(a))
    return 0


if __name__ == "__main__":
    sys.exit(main())
