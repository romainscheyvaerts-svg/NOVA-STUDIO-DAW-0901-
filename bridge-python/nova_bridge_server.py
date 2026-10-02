#!/usr/bin/env python3
"""
NOVA BRIDGE VST3 — v5

Pont local entre Nova Studio (navigateur) et les plugins VST3 installés sur le PC
(effets, et depuis la v5 instruments : notes rendues en audio hors temps réel).

Sécurité
  - écoute uniquement sur 127.0.0.1 (jamais sur le réseau local) ;
  - en-tête Origin vérifié : localhost, le DAW sur Vercel, studiomakemusic.com,
    plus la variable d'environnement NOVA_BRIDGE_ALLOWED_ORIGINS
    (liste séparée par des virgules ; préfixe « re: » pour une expression régulière).

Protocole (WebSocket ws://127.0.0.1:8765)
  Messages JSON (contrôle) — chaque réponse renvoie le « req_id » reçu :
    HELLO / PING                → capacités, version (5 : instruments)
    GET_PLUGIN_LIST [rescan]    → plugins installés ; chacun porte is_instrument
                                  (true / false / null = pas encore lu), plus
                                  instruments_pending + probe_progress [lus, total]
                                  pendant la lecture des plugins sans moduleinfo
    LOAD_PLUGIN  slot_id path [plugin_name] sample_rate [state]
                                → name, vendor, latency_samples, buffer_latency_samples, state, is_instrument
    UNLOAD_PLUGIN slot_id
    GET_STATE / SET_STATE slot_id [state]   (état binaire du plugin en base64)
                                GET_STATE renvoie aussi « hash » (SHA-1 de l'état) ;
                                hash_only=true : sans l'état (suivi d'une fenêtre ouverte)
    RENDER_INSTRUMENT           (v5) notes → audio, réponse en trame binaire type 2
      {slot_id | path+plugin_name+state, sample_rate,
       notes:[{pitch 0–127, start s, duration s, velocity 0–1 (> 1 : lu en 0–127), channel? 0–15}],
       length_seconds, tail_seconds}
      slot_id : son réglé dans l'instance chargée (fenêtre comprise) ; sinon
      instance temporaire. Réponse : {action:"RENDER_INSTRUMENT", req_id, success,
      nch:2, nframes, sample_rate} + float32 stéréo entrelacés (comme RENDER),
      durée = length_seconds + tail_seconds.
    SHOW_EDITOR / CLOSE_EDITOR slot_id      (fenêtre native du plugin sur le PC)
    GET_PARAMS / SET_PARAM      (paramètres exposés par le plugin)
    PROCESS_AUDIO               (ancien format JSON, conservé pour compatibilité)
  Événements : EDITOR_CLOSED (avec l'état), LATENCY (latence mesurée qui change).

  Trames binaires (little-endian) :
    type 1 — bloc audio temps réel (aller et retour, même format)
      u8 type=1 | u8 L | slot_id (L octets UTF-8) | bourrage jusqu'à un multiple de 4
      | u32 seq | u16 nframes | u8 nch | u8 flags | float32[nframes*nch] entrelacés
      Réponse : même seq, nch=2. Traitement strictement dans l'ordre, par slot.
    type 2 — rendu hors temps réel (gel / export)
      u8 type=2 | u8 0 | u16 0 | u32 J | JSON (J octets) | bourrage 4 | float32 entrelacés
      JSON requête : {action:"RENDER", req_id, slot_id | path+plugin_name+state,
                      sample_rate, nch, nframes, tail_seconds}
      Réponse : même enveloppe, JSON {action:"RENDER", req_id, success, nch, nframes}.
      (RENDER_INSTRUMENT est aussi accepté dans cette enveloppe, sans audio.)

Threads : JUCE n'accepte qu'un thread « message » pour préparer/détruire un
plugin et afficher sa fenêtre (show_editor bloque jusqu'à la fermeture). Le
thread principal joue ce rôle (vst_host.JuceThread) ; le serveur WebSocket
tourne dans un thread à part, le traitement audio dans un thread par slot.
(L'hôte JUCE « nova-vst-host » n'est plus nécessaire : un seul exécutable.)
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import numpy as np
import websockets
from websockets.asyncio.server import serve, ServerConnection

import vst_host
import vst_probe
from vst_host import JuceThread, Slot, scan_vst3, render_offline, render_instrument_offline, midi_events

VERSION = 5
MAIN_SCRIPT = os.path.abspath(__file__)   # relancé avec --probe-vst3 (hors exécutable)
HOST = "127.0.0.1"
PORT = int(os.environ.get("NOVA_BRIDGE_PORT", "8765"))
ORPHAN_GRACE_S = 90          # un slot survit 90 s à une déconnexion (rechargement de page)
MAX_QUEUE_BLOCKS = 64        # au-delà, le DAW a déjà compté le bloc comme perdu

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("NovaBridge")
logging.getLogger("websockets").setLevel(logging.WARNING)  # pas une ligne par connexion


def allowed_origins() -> List[Any]:
    origins: List[Any] = [
        None,  # clients hors navigateur (outils locaux, tests) : pas d'en-tête Origin
        re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"),
        "https://nova-studio-daw-0901.vercel.app",
        re.compile(r"^https://nova-studio-daw-0901-[a-z0-9-]+\.vercel\.app$"),
        re.compile(r"^https://([a-z0-9-]+\.)?studiomakemusic\.com$"),
    ]
    for item in (os.environ.get("NOVA_BRIDGE_ALLOWED_ORIGINS") or "").split(","):
        item = item.strip()
        if not item:
            continue
        origins.append(re.compile(item[3:]) if item.startswith("re:") else item.rstrip("/"))
    return origins


# ─────────────────────────────────────────────────────────────────────────────
# TRAMES BINAIRES
# ─────────────────────────────────────────────────────────────────────────────

def _align4(n: int) -> int:
    return (n + 3) & ~3


def parse_audio_frame(buf: bytes):
    L = buf[1]
    slot_id = buf[2:2 + L].decode("utf-8")
    h = _align4(2 + L)
    seq, nframes, nch, flags = struct.unpack_from("<IHBB", buf, h)
    data = np.frombuffer(buf, dtype="<f4", count=nframes * nch, offset=h + 8)
    return slot_id, seq, nframes, nch, flags, data


def build_audio_frame(slot_id: str, seq: int, stereo: np.ndarray) -> bytes:
    sid = slot_id.encode("utf-8")
    h = _align4(2 + len(sid))
    head = bytearray(h + 8)
    head[0] = 1
    head[1] = len(sid)
    head[2:2 + len(sid)] = sid
    nframes = stereo.shape[1]
    struct.pack_into("<IHBB", head, h, seq & 0xFFFFFFFF, nframes, 2, 0)
    return bytes(head) + np.ascontiguousarray(stereo.T, dtype="<f4").tobytes()


def parse_render_frame(buf: bytes):
    (jlen,) = struct.unpack_from("<I", buf, 4)
    meta = json.loads(buf[8:8 + jlen].decode("utf-8"))
    off = _align4(8 + jlen)
    data = np.frombuffer(buf, dtype="<f4", offset=off)
    return meta, data


def build_render_frame(meta: dict, interleaved: Optional[np.ndarray]) -> bytes:
    j = json.dumps(meta).encode("utf-8")
    off = _align4(8 + len(j))
    head = bytearray(off)
    head[0] = 2
    struct.pack_into("<I", head, 4, len(j))
    head[8:8 + len(j)] = j
    body = b"" if interleaved is None else np.ascontiguousarray(interleaved, dtype="<f4").tobytes()
    return bytes(head) + body


# ─────────────────────────────────────────────────────────────────────────────
# SERVEUR
# ─────────────────────────────────────────────────────────────────────────────

class NovaBridgeServer:
    def __init__(self, juce: JuceThread):
        self.juce = juce
        self.slots: Dict[str, Slot] = {}
        self.slot_queues: Dict[str, asyncio.Queue] = {}
        self.plugins: List[Dict[str, Any]] = []
        self.scan_done: Optional[asyncio.Event] = None
        self.render_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="render")
        self.misc_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="misc")
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._refused: Dict[str, float] = {}
        # Lecture des plugins sans moduleinfo.json (instrument ou effet ?)
        self.probe_task: Optional[asyncio.Task] = None
        self.probe_progress: Optional[List[int]] = None
        self._probed: set = set()

    # --- démarrage ---------------------------------------------------------

    async def run(self):
        self.loop = asyncio.get_running_loop()
        self.scan_done = asyncio.Event()
        asyncio.create_task(self._scan())
        asyncio.create_task(self._reaper())
        self.origins = allowed_origins()
        async with serve(self._handle, HOST, PORT, process_request=self._check_origin,
                         max_size=1024 * 1024 * 1024, compression=None,
                         ping_interval=20, ping_timeout=20):
            logger.info(f"✅ Pont VST prêt sur ws://{HOST}:{PORT}  (pedalboard : {vst_host.HAS_PEDALBOARD})")
            logger.info("   Laisse cette fenêtre ouverte pendant ta session.")
            await asyncio.Future()

    def _check_origin(self, connection, request):
        """Refuse les pages qui ne sont pas Nova Studio (une page quelconque
        ouverte dans le navigateur pourrait sinon piloter le pont)."""
        origin = request.headers.get("Origin")
        for allowed in self.origins:
            if allowed is None:
                if origin is None:
                    return None
            elif isinstance(allowed, str):
                if origin == allowed:
                    return None
            elif origin is not None and allowed.fullmatch(origin):
                return None
        now = time.time()
        if now - self._refused.get(origin or "", 0) > 300:  # une ligne par origine toutes les 5 min
            self._refused[origin or ""] = now
            logger.warning(f"⛔ Origine refusée : {origin} (à ajouter dans NOVA_BRIDGE_ALLOWED_ORIGINS si c'est bien Nova Studio)")
        return connection.respond(403, "Origine non autorisée")

    async def _scan(self):
        t = time.time()
        self.plugins = await self.loop.run_in_executor(self.misc_pool, scan_vst3)
        self.scan_done.set()
        logger.info(f"📦 {len(self.plugins)} plugins VST3 trouvés ({time.time() - t:.1f} s)")
        self._start_probe()

    def _start_probe(self):
        if self.probe_task is not None and not self.probe_task.done():
            return
        self.probe_task = asyncio.create_task(self._probe())

    async def _probe(self):
        """Instrument ou effet ? Lu en arrière-plan pour les plugins sans
        moduleinfo.json (cache disque : quasi instantané après la 1re fois)."""
        try:
            while True:
                todo = sorted({p["path"] for p in self.plugins
                               if p.get("is_instrument") is None and p["path"] not in self._probed})
                if not todo:
                    return
                self._probed.update(todo)
                self.probe_progress = [0, len(todo)]

                def progress(done, total):
                    self.probe_progress = [done, total]

                results = await self.loop.run_in_executor(
                    self.misc_pool, lambda: vst_probe.probe_bundles(todo, MAIN_SCRIPT, progress))
                self.plugins = vst_probe.apply_classes(self.plugins, results)
                n = sum(1 for p in self.plugins if p.get("is_instrument"))
                logger.info(f"🎹 {n} instruments VST3 disponibles")
        except Exception as e:
            logger.warning(f"Lecture des instruments interrompue : {e}")
        finally:
            self.probe_progress = None

    def _learn_kind(self, slot: Slot):
        """Plugin chargé : on sait enfin si c'est un instrument."""
        changed = False
        for p in self.plugins:
            if p["path"] == slot.path and p.get("is_instrument") is None:
                p["is_instrument"] = slot.is_instrument
                p["category"] = "Instrument" if slot.is_instrument else "Effect"
                changed = True
        return changed

    async def _reaper(self):
        while True:
            await asyncio.sleep(10)
            now = time.time()
            for sid, slot in list(self.slots.items()):
                if slot.orphan_since and now - slot.orphan_since > ORPHAN_GRACE_S:
                    self._drop_slot(sid)
                    logger.info(f"🗑️ Slot orphelin libéré : {slot.name}")

    def _drop_slot(self, slot_id: str):
        slot = self.slots.pop(slot_id, None)
        q = self.slot_queues.pop(slot_id, None)
        if q is not None:
            q.put_nowait(None)
        if slot is not None:
            slot.unload()

    # --- connexions ---------------------------------------------------------

    async def _handle(self, ws: ServerConnection):
        origin = ws.request.headers.get("Origin") if ws.request else None
        logger.info(f"🔗 Connexion ({origin or 'sans origine'})")
        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    if not message:
                        continue
                    kind = message[0]
                    if kind == 1:
                        self._on_audio(ws, bytes(message))
                    elif kind == 2:
                        asyncio.create_task(self._on_render(ws, bytes(message)))
                    continue
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if isinstance(data, dict):
                    self._dispatch(ws, data)
        except websockets.ConnectionClosed:
            pass
        finally:
            for sid, slot in list(self.slots.items()):
                if slot.owner is ws:
                    slot.owner = None
                    slot.orphan_since = time.time()
                    self.juce.close_editor(slot)
            logger.info("🔌 Déconnexion")

    async def _send(self, ws: ServerConnection, data):
        try:
            await ws.send(data if isinstance(data, (bytes, bytearray)) else json.dumps(data))
        except Exception:
            pass

    def _reply(self, ws, req: dict, payload: dict):
        payload = {"action": req.get("action"), **payload}
        if "req_id" in req:
            payload["req_id"] = req["req_id"]
        if "slot_id" in req and "slot_id" not in payload:
            payload["slot_id"] = req["slot_id"]
        asyncio.ensure_future(self._send(ws, payload))

    def _dispatch(self, ws, req: dict):
        action = str(req.get("action", ""))
        handler = getattr(self, f"_a_{action.lower()}", None)
        if handler is None:
            self._reply(ws, req, {"success": False, "error": f"Action inconnue : {action}"})
            return
        asyncio.create_task(self._safe(handler, ws, req))

    async def _safe(self, handler, ws, req):
        try:
            await handler(ws, req)
        except Exception as e:
            logger.error(f"{req.get('action')} : {e}")
            self._reply(ws, req, {"success": False, "error": str(e)})

    async def _in_slot(self, slot: Slot, fn, *args):
        return await self.loop.run_in_executor(slot.executor, fn, *args)

    def _slot(self, req) -> Slot:
        slot = self.slots.get(str(req.get("slot_id", "")))
        if slot is None:
            raise KeyError("Plugin non chargé sur le pont")
        return slot

    # --- actions de contrôle -------------------------------------------------

    async def _a_ping(self, ws, req):
        self._reply(ws, req, {"action": "PONG", "version": VERSION, "timestamp": time.time()})

    async def _a_hello(self, ws, req):
        self._reply(ws, req, {"success": True, "version": VERSION, "binary_audio": True,
                              "render": True, "editor": vst_host.HAS_PEDALBOARD,
                              "pedalboard": vst_host.HAS_PEDALBOARD,
                              "instruments": vst_host.HAS_PEDALBOARD})

    async def _a_get_plugin_list(self, ws, req):
        if req.get("rescan"):
            self.scan_done.clear()
            self._probed.clear()
            await self._scan()
        await self.scan_done.wait()
        effects_only = bool(req.get("effects_only"))
        plugins = [p for p in self.plugins if not effects_only or p["category"] == "Effect"]
        pending = self.probe_task is not None and not self.probe_task.done()
        self._reply(ws, req, {"success": True, "plugins": plugins, "instruments_pending": pending,
                              "probe_progress": self.probe_progress if pending else None})

    async def _a_load_plugin(self, ws, req):
        slot_id = str(req.get("slot_id") or "default")
        path = req.get("path") or ""
        sr = int(req.get("sample_rate") or req.get("sampleRate") or 48000)
        existing = self.slots.get(slot_id)
        if existing is not None and existing.path == path and existing.sample_rate == sr:
            # Rechargement de page / reconnexion : on garde l'instance (et les
            # réglages faits depuis dans la fenêtre du plugin).
            existing.owner = ws
            existing.orphan_since = None
            await asyncio.wait_for(self.loop.run_in_executor(self.misc_pool, existing.loaded.wait, 30), 35)
            if existing.error:
                raise RuntimeError(existing.error)
            state = await self._in_slot(existing, existing.get_state)
            self._reply(ws, req, self._load_payload(existing, state, reused=True))
            return
        if existing is not None:
            self._drop_slot(slot_id)
        if not path:
            raise ValueError("Chemin du plugin manquant")
        slot = Slot(slot_id, path, req.get("plugin_name"), sr, self.juce)
        slot.owner = ws
        self.slots[slot_id] = slot
        q: asyncio.Queue = asyncio.Queue()
        self.slot_queues[slot_id] = q
        asyncio.create_task(self._slot_worker(slot, q))
        try:
            await self._in_slot(slot, slot.load, req.get("state"))
        except Exception as e:
            slot.error = str(e)
            slot.loaded.set()
            if self.slots.get(slot_id) is slot:
                self._drop_slot(slot_id)
            raise
        state = await self._in_slot(slot, slot.get_state)
        self._learn_kind(slot)
        kind = "instrument" if slot.is_instrument else "effet"
        logger.info(f"✅ {slot.name} chargé ({kind}, {sr} Hz, latence {slot.latency_samples} éch.)")
        self._reply(ws, req, self._load_payload(slot, state))

    def _load_payload(self, slot: Slot, state, reused=False):
        return {"success": True, "slot_id": slot.slot_id, "name": slot.name, "vendor": slot.vendor,
                "latency_samples": slot.latency_samples, "buffer_latency_samples": 0,
                "sample_rate": slot.sample_rate, "state": state, "has_editor": vst_host.HAS_PEDALBOARD,
                "is_instrument": slot.is_instrument, "reused": reused}

    async def _a_unload_plugin(self, ws, req):
        sid = str(req.get("slot_id", ""))
        if sid in self.slots:
            self._drop_slot(sid)
        self._reply(ws, req, {"success": True})

    async def _a_get_state(self, ws, req):
        slot = self._slot(req)
        state = await self._in_slot(slot, slot.get_state)
        digest = hashlib.sha1(state.encode("ascii")).hexdigest() if state else None
        payload = {"success": True, "hash": digest}
        if not req.get("hash_only"):
            payload["state"] = state
        self._reply(ws, req, payload)

    async def _a_set_state(self, ws, req):
        slot = self._slot(req)
        ok = await self._in_slot(slot, slot.set_state, req.get("state") or "")
        self._reply(ws, req, {"success": bool(ok)})

    async def _a_get_params(self, ws, req):
        slot = self._slot(req)
        self._reply(ws, req, {"action": "PARAMS", "parameters": await self._in_slot(slot, slot.parameters)})

    async def _a_set_param(self, ws, req):
        slot = self._slot(req)
        await self._in_slot(slot, slot.set_parameter, req.get("name"), req.get("value"))
        self._reply(ws, req, {"action": "PARAM_CHANGED", "name": req.get("name"), "value": req.get("value")})

    async def _a_show_editor(self, ws, req):
        slot = self._slot(req)
        if not vst_host.HAS_PEDALBOARD:
            raise RuntimeError("Fenêtres de plugins indisponibles")
        loop = self.loop

        def on_closed():
            # Appelé depuis le thread principal : état récupéré puis DAW prévenu.
            fut = asyncio.run_coroutine_threadsafe(self._editor_closed(slot), loop)
            try:
                fut.result(timeout=10)
            except Exception:
                pass

        self.juce.open_editor(slot, on_closed)
        self._reply(ws, req, {"success": True})

    async def _editor_closed(self, slot: Slot):
        if self.slots.get(slot.slot_id) is not slot:
            return
        state = await self._in_slot(slot, slot.get_state)
        if slot.owner is not None:
            await self._send(slot.owner, {"action": "EDITOR_CLOSED", "slot_id": slot.slot_id, "state": state})

    async def _a_close_editor(self, ws, req):
        slot = self.slots.get(str(req.get("slot_id", "")))
        if slot is not None:
            self.juce.close_editor(slot)
        self._reply(ws, req, {"success": True})

    async def _a_process_audio(self, ws, req):
        """Ancien format JSON (un tableau par canal). Passe par la même file que
        le binaire : ordre garanti, état du plugin conservé."""
        slot_id = str(req.get("slot_id", "default"))
        channels = req.get("channels") or []
        if not channels:
            return
        q = self.slot_queues.get(slot_id)
        if q is None:
            self._reply(ws, req, {"action": "AUDIO_PROCESSED", "channels": channels})
            return
        self._enqueue(q, (ws, "json", 0, np.array(channels, dtype=np.float32)))

    # --- audio temps réel -----------------------------------------------------

    def _enqueue(self, q: asyncio.Queue, item):
        if q.qsize() >= MAX_QUEUE_BLOCKS:
            try:
                q.get_nowait()  # le plus ancien est déjà en retard côté DAW
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(item)

    def _on_audio(self, ws, buf: bytes):
        try:
            slot_id, seq, nframes, nch, flags, data = parse_audio_frame(buf)
        except Exception:
            return
        q = self.slot_queues.get(slot_id)
        if q is None:
            return  # plugin pas (encore) chargé : le DAW compte un bloc manquant
        block = data.reshape(nframes, nch).T if nch > 1 else data.reshape(1, nframes)
        self._enqueue(q, (ws, "bin", seq, block))

    async def _slot_worker(self, slot: Slot, q: asyncio.Queue):
        """Un consommateur par slot : blocs traités et renvoyés dans l'ordre."""
        reported = None
        while True:
            item = await q.get()
            if item is None:
                return
            ws, kind, seq, block = item
            if not slot.loaded.is_set() or slot.plugin is None:
                continue
            out = await self._in_slot(slot, slot.process_block, block)
            if kind == "bin":
                await self._send(ws, build_audio_frame(slot.slot_id, seq, out))
            else:
                await self._send(ws, {"action": "AUDIO_PROCESSED", "slot_id": slot.slot_id,
                                      "channels": out.tolist()})
            # Latence réellement observée (zéros ajoutés en tête du flux)
            if slot.blocks % 64 == 0 and slot.padded_total != reported and slot.owner is not None:
                reported = slot.padded_total
                if slot.padded_total:
                    await self._send(slot.owner, {"action": "LATENCY", "slot_id": slot.slot_id,
                                                  "latency_samples": slot.latency_samples})

    # --- rendu hors temps réel -------------------------------------------------

    async def _a_render_instrument(self, ws, req):
        await self._render_instrument(ws, req)

    async def _render_instrument(self, ws, meta: dict):
        """Notes → audio à travers un instrument VST3 (réponse : trame binaire type 2)."""
        try:
            sr = int(meta.get("sample_rate") or 48000)
            notes = meta.get("notes") or []
            if not isinstance(notes, list):
                raise ValueError("Notes invalides")
            length = float(meta.get("length_seconds") or 0)
            if length <= 0:
                length = max([float(n.get("start", 0)) + float(n.get("duration", 0)) for n in notes if isinstance(n, dict)] or [0])
            duration = min(vst_host.MAX_RENDER_SECONDS, max(0.1, length + max(0.0, float(meta.get("tail_seconds") or 0))))
            events = midi_events([n for n in notes if isinstance(n, dict)], duration)
            slot = self.slots.get(str(meta.get("slot_id") or ""))
            t = time.time()
            if slot is not None and slot.plugin is not None and slot.is_instrument and slot.sample_rate == sr:
                # Instance chargée : le son choisi dans sa fenêtre, sans la fermer.
                out = await self._in_slot(slot, slot.render_midi, events, duration)
                name = slot.name
            else:
                path, pname, state = meta.get("path"), meta.get("plugin_name"), meta.get("state")
                if slot is not None and slot.plugin is not None:
                    path, pname = slot.path, slot.plugin_name
                    state = await self._in_slot(slot, slot.get_state) or state
                if not path:
                    raise ValueError("Instrument à rendre introuvable")
                out = await self.loop.run_in_executor(self.render_pool, render_instrument_offline, self.juce,
                                                      path, pname, state, events, duration, sr)
                name = os.path.basename(path)
            logger.info(f"🎹 Rendu {name} : {len(events) // 2} notes, {duration:.1f} s en {time.time() - t:.1f} s")
            reply = {"action": "RENDER_INSTRUMENT", "req_id": meta.get("req_id"), "success": True,
                     "nch": 2, "nframes": int(out.shape[1]), "sample_rate": sr}
            await self._send(ws, build_render_frame(reply, out.T.reshape(-1)))
        except Exception as e:
            logger.error(f"RENDER_INSTRUMENT : {e}")
            await self._send(ws, build_render_frame({"action": "RENDER_INSTRUMENT", "req_id": meta.get("req_id"),
                                                     "success": False, "error": str(e)}, None))

    async def _on_render(self, ws, buf: bytes):
        meta: Dict[str, Any] = {}
        try:
            meta, data = parse_render_frame(buf)
            if meta.get("action") == "RENDER_INSTRUMENT":
                await self._render_instrument(ws, meta)
                return
            nch = int(meta.get("nch") or 2)
            nframes = int(meta.get("nframes") or (data.size // nch))
            sr = int(meta.get("sample_rate") or 48000)
            audio = data[: nframes * nch].reshape(nframes, nch).T
            path, pname, state = meta.get("path"), meta.get("plugin_name"), meta.get("state")
            slot = self.slots.get(str(meta.get("slot_id") or ""))
            if slot is not None and slot.plugin is not None:
                # Réglages actuels de l'instance en cours (fenêtre du plugin comprise)
                path, pname = slot.path, slot.plugin_name
                state = await self._in_slot(slot, slot.get_state) or state
            if not path:
                raise ValueError("Plugin à rendre introuvable")
            t = time.time()
            out = await self.loop.run_in_executor(self.render_pool, render_offline, self.juce, path, pname, state,
                                                  audio, sr, float(meta.get("tail_seconds") or 0))
            logger.info(f"🎚️ Rendu {os.path.basename(path)} : {out.shape[1] / sr:.1f} s en {time.time() - t:.1f} s")
            reply = {"action": "RENDER", "req_id": meta.get("req_id"), "success": True,
                     "nch": 2, "nframes": int(out.shape[1]), "sample_rate": sr}
            await self._send(ws, build_render_frame(reply, out.T.reshape(-1)))
        except Exception as e:
            logger.error(f"RENDER : {e}")
            await self._send(ws, build_render_frame({"action": "RENDER", "req_id": meta.get("req_id"),
                                                     "success": False, "error": str(e)}, None))


def main():
    if "--probe-vst3" in sys.argv:
        vst_probe.child_main()  # processus enfant : lecture des plugins (voir vst_probe)
        return
    # Console Windows redirigée (fichier, pipe) : cp1252 refusait les accents/emojis.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    juce = JuceThread()
    print("=" * 60)
    print(f"  NOVA BRIDGE VST3 v{VERSION} : les plugins de ton PC dans Nova Studio")
    print("=" * 60)

    def serve_thread():
        try:
            asyncio.run(NovaBridgeServer(juce).run())
        except OSError as e:
            logger.error(f"Port {PORT} indisponible ({e}). Le pont est peut-être déjà lancé.")
            os._exit(1)

    threading.Thread(target=serve_thread, name="ws", daemon=True).start()
    try:
        juce.run_forever()   # thread principal : préparation des plugins et fenêtres
    except KeyboardInterrupt:
        logger.info("🛑 Arrêt du pont")
        os._exit(0)


if __name__ == "__main__":
    main()
