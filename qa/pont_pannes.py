"""Pannes injectées dans le VRAI serveur du pont VST (v10), sans plugin réel.

Un NovaBridgeServer tourne en local sur un port libre ; seuls les plugins sont
simulés (vst_host.instantiate remplacé) : le protocole, les files par slot, le
chien de garde et les événements sont ceux du pont livré.

Trois effets jouent en même temps, en temps réel (blocs de 128 à 48 kHz) :
  sain   : gain 0,5 du début à la fin ;
  plante : gain 0,5 puis exception à partir du bloc 400 (≈ 1,07 s) ;
  fige   : gain 0,5 puis se fige 5 s au bloc 400.
Mesures par fenêtre de 0,25 s : RMS rendu par slot, blocs rendus / envoyés,
plus long silence du flux SAIN (retour du pont), événements PLUGIN_CRASHED.

Usage (Python du pont : numpy + websockets) :
  "<venv du pont>\\Scripts\\python.exe" qa/pont_pannes.py
Sortie : D:\\1 WORK\\CONTENU\\nova-stabilite\\pannes_pont.json
"""
import asyncio
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
# QA_BRIDGE_DIR : autre version du pont (ex. celle d'avant, pour comparer).
sys.path.insert(0, os.environ.get("QA_BRIDGE_DIR") or str(ROOT / "bridge-python"))
import vst_host  # noqa: E402
import nova_bridge_server as srv  # noqa: E402
import websockets  # noqa: E402

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-stabilite"))
SR = 48000
N = 128
SECONDS = 6.0
FAULT_BLOCK = 400
WIN = 0.25


class FakePlugin:
    is_instrument = False
    manufacturer_name = "QA"
    reported_latency_samples = 0
    raw_state = b""

    def __init__(self, name, mode):
        self.name, self.mode, self.n = name, mode, 0

    def process(self, x, sr, buffer_size=128, reset=False):
        self.n += 1
        if self.n >= FAULT_BLOCK:
            if self.mode == "plante":
                raise RuntimeError("violation d'accès simulée dans le plugin")
            if self.mode == "fige" and self.n == FAULT_BLOCK:
                time.sleep(5.0)
        return x * 0.5

    def reset(self):
        pass


def fake_instantiate(juce, path, plugin_name, state_b64, sample_rate, block, context=None):
    mode = path.split("://", 1)[1]
    return FakePlugin(f"Faux {mode}", mode), False


class QAServer(srv.NovaBridgeServer):
    """Serveur réel, sans lecture des plugins installés ni surveillance des fenêtres."""

    async def run_on(self, port, ready: asyncio.Event):
        self.loop = asyncio.get_running_loop()
        self.scan_done = asyncio.Event()
        self.scan_done.set()
        self.origins = srv.allowed_origins()
        async with srv.serve(self._handle, "127.0.0.1", port, process_request=self._check_origin,
                             max_size=64 * 1024 * 1024, compression=None):
            ready.set()
            await asyncio.Future()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


async def main():
    vst_host.instantiate = fake_instantiate
    vst_host.CRASH_GUARD = None
    port = free_port()
    server = QAServer(vst_host.JuceThread())
    ready = asyncio.Event()
    stask = asyncio.create_task(server.run_on(port, ready))
    await ready.wait()

    slots = ["sain", "plante", "fige"]
    recv = {s: [] for s in slots}        # (t_reception, seq, rms)
    events = []
    t0 = None

    async with websockets.connect(f"ws://127.0.0.1:{port}", max_size=None, compression=None) as ws:
        pending = {}

        async def reader():
            async for m in ws:
                now = time.perf_counter()
                if isinstance(m, (bytes, bytearray)):
                    sid, seq, nframes, nch, flags, data = srv.parse_audio_frame(bytes(m))
                    blk = data.reshape(nframes, nch).T
                    recv[sid].append((now - t0, seq, float(np.sqrt(np.mean(blk[0] ** 2)))))
                else:
                    d = json.loads(m)
                    if d.get("req_id") in pending:
                        pending.pop(d["req_id"]).set_result(d)
                    elif d.get("action") == "PLUGIN_CRASHED":
                        events.append({**d, "t": round(now - t0, 3)})

        rtask = asyncio.create_task(reader())
        rid = 0

        async def req(msg):
            nonlocal rid
            rid += 1
            fut = asyncio.get_running_loop().create_future()
            pending[rid] = fut
            await ws.send(json.dumps({**msg, "req_id": rid}))
            return await asyncio.wait_for(fut, 10)

        hello = await req({"action": "HELLO"})
        loads = {s: await req({"action": "LOAD_PLUGIN", "slot_id": s, "path": f"fake://{s}", "sample_rate": SR}) for s in slots}

        total = int(SECONDS * SR / N)
        t0 = time.perf_counter()
        phase = 0.0
        sent = 0
        for i in range(total):
            tt = (np.arange(N) + i * N) / SR
            x = (0.5 * np.sin(2 * np.pi * 440 * tt)).astype(np.float32)
            block = np.vstack([x, x])
            for s in slots:
                await ws.send(srv.build_audio_frame(s, i, block))
            sent += 1
            # cadence temps réel
            target = t0 + (i + 1) * N / SR
            delay = target - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
        await asyncio.sleep(2.5)  # derniers retours (et fin du blocage simulé)
        reload = await req({"action": "LOAD_PLUGIN", "slot_id": "plante", "path": "fake://plante", "sample_rate": SR})
        rtask.cancel()

    stask.cancel()
    in_rms = float(np.sqrt(np.mean((0.5 * np.sin(2 * np.pi * 440 * np.arange(SR) / SR)) ** 2)))
    fault_t = FAULT_BLOCK * N / SR

    def windows(sid):
        out = []
        k = int(np.ceil((SECONDS + 1.5) / WIN))
        for w in range(k):
            a, b = w * WIN, (w + 1) * WIN
            # par instant d'ENVOI du bloc (seq), pas de réception
            vals = [r for (_, q, r) in recv[sid] if a <= q * N / SR < b]
            expected = int(round(min(b, SECONDS) * SR / N)) - int(round(min(a, SECONDS) * SR / N))
            if expected <= 0:
                continue
            out.append({"de_s": round(a, 2), "a_s": round(b, 2), "blocs_rendus": len(vals), "blocs_envoyes": expected,
                        "rms": round(float(np.mean(vals)), 4) if vals else 0.0})
        return out

    def longest_gap(sid):
        ts = sorted(t for (t, _, _) in recv[sid])
        return round(max(b - a for a, b in zip(ts, ts[1:])) * 1000, 1) if len(ts) > 1 else None

    res = {
        "date": time.strftime("%Y-%m-%d %H:%M:%S"),
        "pont_version": hello.get("version"), "crash_events": hello.get("crash_events"),
        "chargements": {s: bool(loads[s].get("success")) for s in slots},
        "secondes_jouees": SECONDS, "panne_injectee_a_s": round(fault_t, 3),
        "rms_entree": round(in_rms, 4), "rms_attendu_avec_effet": round(in_rms * 0.5, 4),
        "evenements_PLUGIN_CRASHED": events,
        "rechargement_apres_panne": {"success": reload.get("success"), "reused": reload.get("reused")},
        "slots": {},
    }
    total = int(SECONDS * SR / N)
    for s in slots:
        seqs = {q for (_, q, _) in recv[s]}
        after = [r for (_, q, r) in recv[s] if q * N / SR > fault_t + 2.2]
        res["slots"][s] = {
            "blocs_envoyes": total, "blocs_rendus": len(seqs), "blocs_perdus": total - len(seqs),
            "silences_rendus": sum(1 for (_, _, r) in recv[s] if r < 1e-4),
            "rms_apres_panne": round(float(np.mean(after)), 4) if after else None,
            "plus_long_trou_de_retour_ms": longest_gap(s),
            "fenetres": windows(s),
        }
    sain = res["slots"]["sain"]
    res["verdict"] = {
        "sain_sans_perte": sain["blocs_perdus"] == 0 and sain["silences_rendus"] == 0,
        "sain_rms_constant": all(abs(w["rms"] - in_rms * 0.5) < 0.01 for w in sain["fenetres"] if w["blocs_rendus"]),
        "plante_passe_le_son_sec": abs((res["slots"]["plante"]["rms_apres_panne"] or 0) - in_rms) < 0.01,
        "fige_passe_le_son_sec": abs((res["slots"]["fige"]["rms_apres_panne"] or 0) - in_rms) < 0.01,
        "un_evenement_par_panne": sorted((e["slot_id"], e["reason"]) for e in events) == [("fige", "hang"), ("plante", "exception")],
        "slot_en_panne_recharge_a_neuf": bool(reload.get("success")) and not reload.get("reused"),
    }
    res["ok"] = all(res["verdict"].values())
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / os.environ.get("QA_OUT_NAME", "pannes_pont.json")).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    short = {k: v for k, v in res.items() if k != "slots"}
    short["slots"] = {s: {k: v for k, v in d.items() if k != "fenetres"} for s, d in res["slots"].items()}
    print(json.dumps(short, ensure_ascii=False, indent=1))
    sys.stdout.flush()
    os._exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    for st in (sys.stdout, sys.stderr):
        try:
            st.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    asyncio.run(main())
