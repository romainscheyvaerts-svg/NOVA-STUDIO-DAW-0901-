"""Outils communs des preuves R9 / R10 (automation et side-chain des VST par le pont).

- start_bridge(port) : lance le pont DE CE DÉPÔT (bridge-python), caché, avec
  NOVA_BRIDGE_DEBUG=1 (geste simulé dans la fenêtre d'un plugin, sans fenêtre).
- Client : connexion WebSocket synchrone, requêtes JSON, trames audio type 1
  (avec réglages horodatés / clé de side-chain) et rendus type 2.

À lancer avec le Python du pont (websockets + numpy).
"""
import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT / "bridge-python"
sys.path.insert(0, str(BRIDGE_DIR))
BRIDGE_PY = Path(os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-r9-r10"))
OUT.mkdir(parents=True, exist_ok=True)
SR = 48000
ORIGIN = "http://127.0.0.1:3460"


def port_free(port):
    try:
        socket.create_connection(("127.0.0.1", port), 0.3).close()
        return False
    except OSError:
        return True


def pick_port():
    for p in (int(os.environ.get("NOVA_BRIDGE_PORT", "8776")), 8777):
        if port_free(p):
            return p
    raise RuntimeError("ports 8776 et 8777 occupés")


def start_bridge(port, extra_env=None):
    env = dict(os.environ, NOVA_BRIDGE_PORT=str(port), NOVA_BRIDGE_DEBUG="1", PYTHONIOENCODING="utf-8",
               NOVA_BRIDGE_ALLOWED_ORIGINS="http://127.0.0.1:3460,http://127.0.0.1:3470", **(extra_env or {}))
    log = open(OUT / f"pont-{port}.log", "w", encoding="utf-8")
    p = subprocess.Popen([str(BRIDGE_PY), "nova_bridge_server.py"], cwd=str(BRIDGE_DIR), env=env,
                         stdout=log, stderr=subprocess.STDOUT, creationflags=0x08000000)
    for _ in range(240):
        if not port_free(port):
            return p
        if p.poll() is not None:
            break
        time.sleep(0.5)
    stop_bridge(p)
    raise RuntimeError(f"pont {port} injoignable (voir {OUT / f'pont-{port}.log'})")


def stop_bridge(p):
    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)


def _align4(n):
    return (n + 3) & ~3


def audio_frame(slot_id, seq, block, changes=None, key=None):
    """block (2, n) ; changes [(index, décalage, valeur)] ; key (2, n) ou None."""
    sid = slot_id.encode("utf-8")
    h = _align4(2 + len(sid))
    head = bytearray(h + 8)
    head[0], head[1] = 1, len(sid)
    head[2:2 + len(sid)] = sid
    data = block if key is None else np.vstack([block, key])
    nch, n = data.shape
    flags = (1 if changes else 0) | (2 if key is not None else 0)
    struct.pack_into("<IHBB", head, h, seq & 0xFFFFFFFF, n, nch, flags)
    body = np.ascontiguousarray(data.T, dtype="<f4").tobytes()
    extra = b""
    if changes:
        extra = struct.pack("<HH", len(changes), 0) + b"".join(struct.pack("<HHf", i, o, v) for i, o, v in changes)
    return bytes(head) + body + extra


def parse_audio_reply(buf):
    L = buf[1]
    h = _align4(2 + L)
    seq, n, nch, _flags = struct.unpack_from("<IHBB", buf, h)
    data = np.frombuffer(buf, dtype="<f4", count=n * nch, offset=h + 8).reshape(n, nch).T
    return seq, data


def render_frame(meta, channels):
    j = json.dumps(meta).encode("utf-8")
    off = _align4(8 + len(j))
    head = bytearray(off)
    head[0] = 2
    struct.pack_into("<I", head, 4, len(j))
    head[8:8 + len(j)] = j
    inter = np.ascontiguousarray(np.vstack(channels).T, dtype="<f4").tobytes()
    return bytes(head) + inter


def parse_render(buf):
    (jlen,) = struct.unpack_from("<I", buf, 4)
    meta = json.loads(buf[8:8 + jlen].decode("utf-8"))
    off = _align4(8 + jlen)
    nch = int(meta.get("nch") or 2)
    data = np.frombuffer(buf, dtype="<f4", offset=off)
    n = data.size // nch if nch else 0
    return meta, data[:n * nch].reshape(n, nch).T if n else None


class Bridge:
    def __init__(self, port):
        from websockets.sync.client import connect
        self.ws = connect(f"ws://127.0.0.1:{port}", origin=ORIGIN, max_size=None, open_timeout=30)
        self.req = 0
        self.events = []

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass

    def _recv(self, timeout):
        return self.ws.recv(timeout=timeout)

    def request(self, msg, timeout=180):
        self.req += 1
        rid = self.req
        self.ws.send(json.dumps({**msg, "req_id": rid}))
        t0 = time.time()
        while time.time() - t0 < timeout:
            m = self._recv(timeout)
            if isinstance(m, (bytes, bytearray)):
                continue
            d = json.loads(m)
            if d.get("req_id") == rid:
                if d.get("success") is False:
                    raise RuntimeError(f"{msg.get('action')} : {d.get('error')}")
                return d
            self.events.append((time.time(), d))
        raise TimeoutError(msg.get("action"))

    def wait_event(self, action, timeout=5.0):
        t0 = time.time()
        for i, (t, e) in enumerate(self.events):
            if e.get("action") == action:
                return self.events.pop(i)
        while time.time() - t0 < timeout:
            try:
                m = self._recv(max(0.05, timeout - (time.time() - t0)))
            except TimeoutError:
                break
            if isinstance(m, (bytes, bytearray)):
                continue
            d = json.loads(m)
            if d.get("action") == action:
                return time.time(), d
            self.events.append((time.time(), d))
        return None

    def render(self, meta, channels, timeout=600):
        self.req += 1
        rid = self.req
        nch = len(channels)
        n = channels[0].shape[-1]
        self.ws.send(render_frame({**meta, "action": "RENDER", "req_id": rid, "nch": nch, "nframes": n}, channels))
        t0 = time.time()
        while time.time() - t0 < timeout:
            m = self._recv(timeout)
            if isinstance(m, (bytes, bytearray)) and m[0] == 2:
                meta2, data = parse_render(m)
                if meta2.get("req_id") == rid:
                    if not meta2.get("success"):
                        raise RuntimeError(meta2.get("error"))
                    return data
            elif not isinstance(m, (bytes, bytearray)):
                self.events.append((time.time(), json.loads(m)))
        raise TimeoutError("RENDER")

    def stream(self, slot_id, audio, changes_at=None, key=None, pace=0.0):
        """Envoie `audio` (2, N) en blocs de 128 (réglages par bloc : changes_at[b] = [(i, off, v)]),
        récupère la sortie, dans l'ordre. Renvoie (sortie (2, N'), secondes)."""
        n = audio.shape[1] // 128
        outs = {}
        t0 = time.time()
        inflight = 0
        sent = 0
        while len(outs) < n:
            while sent < n and inflight < 48:
                b = sent
                blk = audio[:, b * 128:(b + 1) * 128]
                kb = key[:, b * 128:(b + 1) * 128] if key is not None else None
                self.ws.send(audio_frame(slot_id, b, blk, (changes_at or {}).get(b), kb))
                sent += 1
                inflight += 1
                if pace:
                    time.sleep(pace)
            m = self._recv(30)
            if isinstance(m, (bytes, bytearray)) and m[0] == 1:
                seq, data = parse_audio_reply(m)
                outs[seq] = data
                inflight -= 1
            elif not isinstance(m, (bytes, bytearray)):
                self.events.append((time.time(), json.loads(m)))
        dt = time.time() - t0
        return np.concatenate([outs[i] for i in range(n)], axis=1), dt


def find_plugin(plugins, *patterns, shell=False):
    import re
    for pat in patterns:
        for p in plugins:
            name = p.get("name") or ""
            if re.search(pat, name, re.I) and (not shell or "WaveShell" in (p.get("path") or "")):
                return p
    return None


def db(x):
    return 20 * np.log10(max(float(x), 1e-12))


def peak_db(y, a, z, sr=SR):
    return round(db(np.max(np.abs(y[int(a * sr):int(z * sr)]))), 2)


def sine(sec, amp, f, sr=SR, phase=0.3):
    t = np.arange(int(round(sec * sr))) / sr
    x = (amp * np.sin(2 * np.pi * f * t + phase)).astype(np.float32)
    return np.vstack([x, x])


def first_divergence(a, b, start=0, eps=1e-5):
    n = min(a.shape[-1], b.shape[-1])
    d = np.abs(a[0, start:n] - b[0, start:n]) > eps
    i = np.argmax(d) if d.any() else -1
    return None if i < 0 else start + int(i)


def save(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    sys.stdout.buffer.write(json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8") + b"\n")
