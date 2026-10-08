#!/usr/bin/env python3
"""
NOVA BRIDGE VST3 — v11

Pont local entre Nova Studio (navigateur) et les plugins VST3 installés sur le PC
(effets, et depuis la v5 instruments : notes rendues en audio hors temps réel).

Sécurité
  - écoute uniquement sur 127.0.0.1 (jamais sur le réseau local) ;
  - en-tête Origin vérifié : localhost, le DAW sur Vercel, studiomakemusic.com,
    plus la variable d'environnement NOVA_BRIDGE_ALLOWED_ORIGINS
    (liste séparée par des virgules ; préfixe « re: » pour une expression régulière).

Protocole (WebSocket ws://127.0.0.1:8765)
  Messages JSON (contrôle) — chaque réponse renvoie le « req_id » reçu :
    HELLO / PING                → capacités, version (5 : instruments, 6 : fenêtres de licence,
                                  7 : paramètres par valeur texte, params_text=true,
                                  10 : pannes isolées, crash_events=true, quarantine=true)
    GET_PLUGIN_LIST [rescan]    → plugins installés ; chacun porte is_instrument
                                  (true / false / null = pas encore lu), plus
                                  instruments_pending + probe_progress [lus, total]
                                  pendant la lecture des plugins sans moduleinfo ;
                                  (v6) scan_status (ok, error, activation, hang, crash)
                                  et license (activation / nag) quand c'est connu.
                                  rescan=true relit aussi les plugins en attente d'activation
                                  et (v10) lève la quarantaine des plugins qui avaient planté ;
                                  chaque plugin en quarantaine porte quarantined=true
    LOAD_PLUGIN  slot_id path [plugin_name] sample_rate [state] [quiet]
                                → name, vendor, latency_samples, buffer_latency_samples, state, is_instrument
                                  (v7) quiet=true : chargement posé par NOVA lui-même (autotune,
                                  mix auto). Une fenêtre de licence / démo est cachée et fermée
                                  au lieu d'être ramenée devant, et le chargement échoue avec
                                  license_required=true : le DAW passe au plugin suivant.
                                  (v10) Plugin qui a fait planter le pont 2 fois en se chargeant :
                                  success=false, quarantined=true, error en clair. Un slot en panne
                                  (voir PLUGIN_CRASHED) est rechargé à neuf, pas réutilisé.
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
    GET_PARAMS [names]          paramètres exposés par le plugin. Chacun : name (clé), display_name,
                                  value (brute 0–1) et depuis la v7 : text (valeur affichée par le
                                  plugin, ex. « F# », « Minor », « 20 »), num_steps, is_boolean,
                                  is_discrete, range [min, max, pas] et values (liste des choix
                                  possibles quand il y en a 128 au plus). names : filtre facultatif.
    SET_PARAM name value        (valeur brute 0–1, ancien format)
    SET_PARAMS (v7) slot_id params:[{name, text | real | value}]
                                → results:[{name, ok, text, value, error?}] (valeur RELUE sur le
                                  plugin après réglage), latency_samples, latency_changed. text :
                                  valeur affichée (« F# », « Harmonic Minor », « On ») ; real : valeur
                                  dans l'unité du plugin (20.0 pour 20 ms) ; value : brute 0–1.
                                  Si la latence annoncée change (mode basse latence), le plugin est
                                  re-préparé et un événement LATENCY suit.
    PROCESS_AUDIO               (ancien format JSON, conservé pour compatibilité)
    (v8) Séparation de stems (module optionnel Demucs, voir stems_service.py) :
    STEMS_STATUS                → installed, installing, install (dernier événement), variant, size_bytes
    STEMS_INSTALL [variant]     → installation en arrière-plan (événements STEMS_EVENT kind=install)
    STEMS_CANCEL job_id | install=true
    STEMS_SEPARATE              en trame binaire type 2 : {action, req_id, job_id, stems:2|4,
                                  sample_rate, nch, nframes, project, clip} + float32 entrelacés.
                                  Progression : STEMS_EVENT {kind:"separate", job_id, event, pct, message}.
                                  Puis une trame type 2 par stem : {action:"STEMS_STEM", req_id, job_id,
                                  key, label, index, count, nch, nframes, sample_rate, path} + audio,
                                  et la réponse finale {action:"STEMS_SEPARATE", req_id, success,
                                  stems, seconds, device, outdir | error, code: not_installed|cancelled|error}.
    (v9) Plugins ARA2 (Melodyne, VocAlign) par l'hôte natif NovaARAHost.exe : voir ara_service.py
    (ARA_STATUS, ARA_OPEN, ARA_ALIGN, ARA_COMMIT, ARA_SHOW, ARA_TRANSPORT, ARA_CLOSE, ARA_EVENT).
    (v12) Melodyne / VocAlign en INSERT sur une piste, comme Pro Tools : voir ara_insert.py
    (LOAD_PLUGIN ara=…, ARA_INSERT_SOURCE / DOC / STATE / EDITOR / SELECT / RENDER / PARAM(S)) ;
    trames type 1 : flags & 4 (TIMELINE) → f64 position du morceau (échantillons, -1 = arrêt) juste
    après l'audio, avant les réglages d'automation.
    (v11) Automation des VST (R9) :
    AUTOMATABLE slot_id         → parameters:[{name, display_name, value, text, label?, num_steps?,
                                  is_boolean?}] : réglages automatisables, lus sans conversion texte
                                  (rapide même pour 700 réglages)
    SET_AUTOMATION_MAP slot_id names:[…]
                                → table index → réglage des trames temps réel (drapeau PARAMS) ;
                                  missing : réglages inconnus du plugin
    PARAM_TEXTS slot_id names:[…] [steps=100]
                                → texts:{name:[texte affiché pour 0, 1/steps, … 1]}
    WATCH_PARAMS slot_id on     → écriture Touch / Latch : les réglages bougés dans la fenêtre du
                                  plugin sont signalés par PARAM_CHANGED {slot_id, changes:[{name,
                                  value, text}]} (relevé toutes les ~40 ms) ; pendant 0,4 s après un
                                  geste, l'automation reçue ne reprend pas la main sur ce réglage
    AUTOMATION_STATS slot_id    → applied, skipped (automation posée / laissée au geste en cours)
    RENDER : automation:[{name, frames:[…], values:[…]}] (images depuis le début du son envoyé,
             valeurs brutes 0–1) rejouée à l'échantillon près.
  Événements : EDITOR_CLOSED (avec l'état), LATENCY (latence mesurée qui change),
    (v10) PLUGIN_CRASHED {slot_id, reason: exception|nan|hang, error, name} : le plugin
      a levé une exception, sort des NaN en continu ou s'est figé (> 2 s sur un bloc).
      Le slot passe alors le signal SEC (retardé de sa latence) : la piste continue
      sans l'effet ; le DAW peut recharger le plugin (LOAD_PLUGIN, même slot_id).
      Envoyé une fois, à la connexion propriétaire du slot.
    (v6) LICENSE_WINDOW {type:"license_window", plugin, path, plugin_name, title,
      status: activation|nag, source: load|render, slot_id?} : un plugin vient
      d'ouvrir une fenêtre (activation de licence, enregistrement…), ramenée au
      premier plan ; le chargement / rendu attend qu'elle soit fermée (15 min max).
      Envoyé à la connexion concernée, sinon à toutes.

  Isolation (v10) : la sortie de chaque plugin est nettoyée (NaN / infini → 0,
    ±4 max) ; un traitement figé ne bloque ni la boucle réseau ni les autres slots
    (un exécuteur par slot, déchargement dans un thread à part). Un plantage NATIF
    pendant le chargement est reconnu au démarrage suivant (marqueurs disque,
    vst_host.CrashGuard) ; le superviseur de l'appli relance le pont.

  Instances : un slot par effet / instrument chargé ; les rendus hors slot
  réutilisent une instance hors ligne par plugin (vst_host.OfflinePool).

  Trames binaires (little-endian) :
    type 1 — bloc audio temps réel (aller et retour, même format)
      u8 type=1 | u8 L | slot_id (L octets UTF-8) | bourrage jusqu'à un multiple de 4
      | u32 seq | u16 nframes | u8 nch | u8 flags | float32[nframes*nch] entrelacés
      Réponse : même seq, nch=2. Traitement strictement dans l'ordre, par slot.
      (v11) flags & 1 (PARAMS) : après l'audio, u16 count | u16 0 | count × (u16 index,
        u16 décalage dans le bloc, f32 valeur brute 0–1) : réglages posés à l'échantillon
        près (bloc découpé), index dans la table SET_AUTOMATION_MAP.
      (v11) flags & 2 (SIDECHAIN) : nch=4, canaux 3-4 = clé de side-chain (voir vst_sidechain) :
        passée à l'entrée clé du plugin quand l'hôte sait l'alimenter (LOAD_PLUGIN
        sidechain_inputs > 0), sinon ignorée. HELLO sidechain=true : hôte natif présent.
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

import ara_insert
import ara_service
import license_watch
import stems_service
import vst_automation
import vst_host
import vst_sidechain
import vst_probe
import plugin_guard
from vst_host import JuceThread, Slot, scan_vst3, render_offline, render_instrument_offline, midi_events, calibrate_gr_offline

VERSION = 12
MAIN_SCRIPT = os.path.abspath(__file__)   # relancé avec --probe-vst3 (hors exécutable)
HOST = "127.0.0.1"
PORT = int(os.environ.get("NOVA_BRIDGE_PORT", "8765"))
ORPHAN_GRACE_S = 90          # un slot survit 90 s à une déconnexion (rechargement de page)
MAX_QUEUE_BLOCKS = 64        # au-delà, le DAW a déjà compté le bloc comme perdu

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("NovaBridge")
logging.getLogger("websockets").setLevel(logging.WARNING)  # pas une ligne par connexion


class LicenseRequired(RuntimeError):
    """Chargement discret (quiet) interrompu par une fenêtre de licence / démo."""


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


def parse_audio_extras(buf: bytes, nframes: int, nch: int, flags: int):
    """(v11) Réglages horodatés qui suivent l'audio (drapeau PARAMS)."""
    if not flags & vst_automation.FLAG_PARAMS:
        return None
    L = buf[1]
    off = _align4(2 + L) + 8 + nframes * nch * 4 + ara_insert.timeline_extra_bytes(flags)
    return vst_automation.parse_param_section(buf, off) or None


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
        # Fenêtres de licence : connexions à prévenir, mémoire entre lancements.
        self.clients: set = set()
        self.licenses = license_watch.LicenseLog()
        # Séparation de stems (module optionnel installé à la demande)
        self.stems = stems_service.StemsService()
        self.stems_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stems")

    # --- démarrage ---------------------------------------------------------

    async def run(self):
        self.loop = asyncio.get_running_loop()
        self.scan_done = asyncio.Event()
        if vst_host.CRASH_GUARD is None:
            vst_host.CRASH_GUARD = vst_host.CrashGuard()
        for path in vst_host.CRASH_GUARD.recover():
            n = vst_host.CRASH_GUARD.count(path)
            state = "mis en quarantaine" if vst_host.CRASH_GUARD.is_quarantined(path) else "surveillé"
            logger.warning(f"💥 Le pont s'était arrêté en chargeant {os.path.basename(path)} ({n} fois) : {state}")
        vst_host.WATCHER = license_watch.LicenseWatcher(
            on_window=lambda w, info: self.loop.call_soon_threadsafe(self._license_window, w, info),
            ignore_title=self._is_editor_title,
            excluded_pids=vst_probe.probe_pids,
            on_clean=lambda w: self.loop.call_soon_threadsafe(self._license_clean, w))
        asyncio.create_task(self._scan())
        asyncio.create_task(self._reaper())
        self.origins = allowed_origins()
        async with serve(self._handle, HOST, PORT, process_request=self._check_origin,
                         max_size=1024 * 1024 * 1024, compression=None,
                         ping_interval=20, ping_timeout=20):
            logger.info(f"✅ Pont VST prêt sur ws://{HOST}:{PORT}  (moteur VST : {vst_host.ENGINE})")
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
        """Plugin chargé : on sait enfin si c'est un instrument (et la lecture
        en arrière-plan n'a plus à le relire, même s'il demandait une activation)."""
        changed = False
        for p in self.plugins:
            unsettled = p.get("scan_status") in ("activation", "hang", "crash")
            if p["path"] == slot.path and (p.get("is_instrument") is None or unsettled):
                p["is_instrument"] = slot.is_instrument
                p["category"] = "Instrument" if slot.is_instrument else "Effect"
                p["scan_status"] = "ok"
                changed = True
        if changed:
            self.misc_pool.submit(vst_probe.record_loaded, slot.path, slot.plugin_name, slot.is_instrument)
        return changed

    # --- fenêtres de licence ---------------------------------------------------

    def _is_editor_title(self, title: str) -> bool:
        """La fenêtre d'édition ouverte par le DAW n'est pas une demande de licence."""
        slot = self.juce.editor_slot
        return bool(slot is not None and title and title == slot.name)

    def _display_name(self, path: str, plugin_name: Optional[str], fallback: str) -> str:
        for p in self.plugins:
            if p["path"] == path and (p.get("plugin_name") or None) == (plugin_name or None):
                return p["name"]
        return fallback

    def _license_window(self, w, info: dict):
        """(Boucle asyncio) Un plugin a ouvert une fenêtre au chargement : déjà
        ramenée au premier plan par le surveillant ; on prévient le DAW."""
        title = info.get("title") or ""
        name = self._display_name(w.path, w.plugin_name, w.label)
        status = self.licenses.window(w.path, w.plugin_name, name, title)
        for p in self.plugins:
            if p["path"] == w.path:
                p["license"] = status
                p["license_title"] = title
        if status == "nag":
            logger.info(f"🔑 {name} ouvre encore sa fenêtre (version d'essai ou rappel ?) : il n'est plus chargé automatiquement")
        msg = {"action": "LICENSE_WINDOW", "type": "license_window", "plugin": name, "path": w.path,
               "plugin_name": w.plugin_name, "title": title, "status": status,
               "source": w.context.get("source", "load"), "quiet": bool(w.context.get("quiet"))}
        if w.context.get("slot_id"):
            msg["slot_id"] = w.context["slot_id"]
        target = w.context.get("ws")
        for ws in ([target] if target in self.clients else list(self.clients)):
            asyncio.ensure_future(self._send(ws, msg))

    def _needs_activation(self, path: str, plugin_name: Optional[str]) -> bool:
        if self.licenses.status(path, plugin_name):
            return True
        return any(p["path"] == path and (p.get("license") or p.get("scan_status") == "activation") for p in self.plugins)

    def _license_clean(self, w):
        """Chargé sans fenêtre (20 s de surveillance) : licence en ordre."""
        if self.licenses.clean(w.path, w.plugin_name):
            logger.info(f"🔑 {self._display_name(w.path, w.plugin_name, w.label)} : licence en ordre")
            for p in self.plugins:
                if p["path"] == w.path and p.get("license"):
                    p.pop("license", None)
                    p.pop("license_title", None)

    async def _reaper(self):
        while True:
            await asyncio.sleep(10)
            now = time.time()
            for sid, slot in list(self.slots.items()):
                if slot.orphan_since and now - slot.orphan_since > ORPHAN_GRACE_S:
                    self._drop_slot(sid)
                    logger.info(f"🗑️ Slot orphelin libéré : {slot.name}")
            # Instances hors ligne inutilisées / mémoire presque pleine
            await self.loop.run_in_executor(self.misc_pool, vst_host.OFFLINE.reap)
            self.ara_reap()

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
        self.clients.add(ws)
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
            self.clients.discard(ws)
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
                              "render": True, "editor": vst_host.HAS_VST,
                              "pedalboard": vst_host.ENGINE == "pedalboard", "engine": vst_host.ENGINE,
                              "instruments": vst_host.HAS_VST,
                              "license_events": license_watch.IS_WINDOWS,
                              "params_text": True, "stems": True, "calibrate_gr": vst_host.HAS_VST,
                              # Plugins d'un shell (Waves) chargés par leur nom ; plugins qui
                              # plantent isolés (« unstable » dans la liste et au chargement).
                              "shells": True, "plugin_guard": True,
                              "crash_events": True, "quarantine": True,
                              # (v11) automation des réglages à l'échantillon près, écriture depuis la fenêtre
                              "automation": vst_host.HAS_VST, "param_watch": vst_host.HAS_VST,
                              # (v11, R10) clé de side-chain des VST3 : seulement avec l'hôte natif
                              # (pedalboard désactive les bus d'entrée auxiliaires, voir vst_sidechain)
                              "sidechain": vst_sidechain.host_feeds_sidechain(), "sidechain_protocol": True,
                              "ara": bool(ara_service.ara_host.find_host_exe()),
                              # (v12) Melodyne / VocAlign en insert sur une piste, comme Pro Tools
                              "ara_insert": bool(ara_service.ara_host.find_host_exe())})

    async def _a_get_plugin_list(self, ws, req):
        if req.get("rescan"):
            self.scan_done.clear()
            self._probed.clear()
            # Choix explicite : les plugins en attente d'activation sont relus.
            await self.loop.run_in_executor(self.misc_pool, vst_probe.forget_unsettled)
            if vst_host.CRASH_GUARD is not None:
                vst_host.CRASH_GUARD.clear()  # on réessaie les plugins qui avaient planté
            await self._scan()
        await self.scan_done.wait()
        effects_only = bool(req.get("effects_only"))
        plugins = []
        for p in self.plugins:
            if effects_only and p["category"] != "Effect":
                continue
            lic = p.get("license") or self.licenses.status(p["path"], p.get("plugin_name"))
            item = {**p, "license": lic} if lic else p
            if vst_host.CRASH_GUARD is not None and vst_host.CRASH_GUARD.is_quarantined(p["path"]):
                item = {**item, "quarantined": True}
            plugins.append(item)
        pending = self.probe_task is not None and not self.probe_task.done()
        self._reply(ws, req, {"success": True, "plugins": plugins, "instruments_pending": pending,
                              "probe_progress": self.probe_progress if pending else None})

    async def _a_load_plugin(self, ws, req):
        slot_id = str(req.get("slot_id") or "default")
        path = req.get("path") or ""
        sr = int(req.get("sample_rate") or req.get("sampleRate") or 48000)
        existing = self.slots.get(slot_id)
        if existing is not None and existing.failed:
            # Slot en panne : rechargé à neuf (nouvelle instance, nouvel exécuteur).
            self._drop_slot(slot_id)
            existing = None
        guard = vst_host.CRASH_GUARD
        if path and guard is not None and guard.is_quarantined(path):
            msg = guard.message(path)
            logger.warning(f"🚫 {msg}")
            self._reply(ws, req, {"success": False, "error": msg, "quarantined": True})
            return
        if existing is not None and existing.path == path and existing.sample_rate == sr:
            # Rechargement de page / reconnexion : on garde l'instance (et les
            # réglages faits depuis dans la fenêtre du plugin).
            existing.owner = ws
            existing.orphan_since = None
            # Une fenêtre de licence peut retenir le premier chargement plusieurs minutes.
            wait = vst_host.LICENSE_WAIT_S
            await asyncio.wait_for(self.loop.run_in_executor(self.misc_pool, existing.loaded.wait, wait), wait + 5)
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
        ctx = {"ws": ws, "slot_id": slot_id, "source": "load", "quiet": bool(req.get("quiet"))}
        try:
            await self._in_slot(slot, slot.load, req.get("state"), ctx)
            if ctx.get("license_seen"):
                raise LicenseRequired(f"{slot.name} demande une licence ou une activation : il n'est pas utilisé")
        except (plugin_guard.PluginUnstable, vst_host.PluginQuarantined) as e:
            # Plugin qui plante : essai isolé raté (plugin_guard) ou quarantaine (pont v10). Refusé, le pont continue.
            slot.error = str(e)
            slot.loaded.set()
            if self.slots.get(slot_id) is slot:
                self._drop_slot(slot_id)
            self._reply(ws, req, {"success": False, "error": str(e), "unstable": isinstance(e, plugin_guard.PluginUnstable), "quarantined": isinstance(e, vst_host.PluginQuarantined)})
            return
        except LicenseRequired as e:
            slot.error = str(e)
            slot.loaded.set()
            if self.slots.get(slot_id) is slot:
                self._drop_slot(slot_id)
            logger.info(f"🔑 {e}")
            self._reply(ws, req, {"success": False, "error": str(e), "license_required": True})
            return
        except Exception as e:
            slot.error = str(e)
            slot.loaded.set()
            if self.slots.get(slot_id) is slot:
                self._drop_slot(slot_id)
            if self._needs_activation(path, req.get("plugin_name")):
                # Fenêtre d'activation fermée sans activer : beaucoup de plugins ne
                # la rouvrent qu'au prochain lancement de l'hôte.
                name = self._display_name(path, req.get("plugin_name"), os.path.basename(path)[:-5])
                raise RuntimeError(f"{name} n'est pas activé : active sa licence (relance le pont VST pour revoir "
                                   f"sa fenêtre d'activation)") from e
            raise
        if self.slots.get(slot_id) is not slot:
            # Retiré pendant le chargement (DAW lassé d'attendre une fenêtre de licence) :
            # l'instance arrivée entre-temps est libérée sur le thread JUCE.
            slot.unload()
            raise RuntimeError("Chargement annulé")
        state = await self._in_slot(slot, slot.get_state)
        self._learn_kind(slot)
        kind = "instrument" if slot.is_instrument else "effet"
        logger.info(f"✅ {slot.name} chargé ({kind}, {sr} Hz, latence {slot.latency_samples} éch.)")
        self._reply(ws, req, self._load_payload(slot, state))

    def _load_payload(self, slot: Slot, state, reused=False):
        return {"success": True, "slot_id": slot.slot_id, "name": slot.name, "vendor": slot.vendor,
                "latency_samples": slot.latency_samples, "buffer_latency_samples": 0,
                "sample_rate": slot.sample_rate, "state": state, "has_editor": vst_host.HAS_VST,
                "is_instrument": slot.is_instrument, "reused": reused,
                # (R10) None : l'hôte ne sait pas alimenter l'entrée clé ; 0 : pas d'entrée clé ; 2 : clé stéréo
                "sidechain_inputs": slot.sidechain_inputs}

    async def _a_unload_plugin(self, ws, req):
        sid = str(req.get("slot_id", ""))
        slot = self.slots.get(sid)
        if slot is not None:
            self._drop_slot(sid)
            # Plus utilisé nulle part : son instance hors ligne part avec lui.
            if not any(s.path == slot.path for s in self.slots.values()):
                self.misc_pool.submit(vst_host.OFFLINE.reap, slot.path)
        self._reply(ws, req, {"success": True})

    # --- tests (NOVA_BRIDGE_DEBUG=1) : fenêtre de licence simulée -------------------

    async def _a_debug_license_window(self, ws, req):
        if os.environ.get("NOVA_BRIDGE_DEBUG") != "1":
            raise RuntimeError("Action de test désactivée")
        import ctypes
        title = str(req.get("title") or "Software Activation: Test Plugin")
        path = str(req.get("path") or "C:\\Test\\Test Plugin.vst3")
        w = vst_host.WATCHER.begin(path, req.get("plugin_name"), {"ws": ws, "source": "load"})
        threading.Thread(target=lambda: ctypes.windll.user32.MessageBoxW(None, "Fenêtre de licence simulée (test du pont)", title, 0x40),
                         daemon=True).start()
        self.loop.call_later(1.0, w.end)
        self._reply(ws, req, {"success": True})

    async def _a_debug_windows(self, ws, req):
        if os.environ.get("NOVA_BRIDGE_DEBUG") != "1":
            raise RuntimeError("Action de test désactivée")
        import ctypes
        u = ctypes.windll.user32
        u.GetForegroundWindow.restype = ctypes.c_void_p
        fg = u.GetForegroundWindow()
        buf = ctypes.create_unicode_buffer(512)
        u.InternalGetWindowText(ctypes.c_void_p(fg), buf, 512)
        mine = license_watch.windows_of(license_watch.descendants(os.getpid()))
        if req.get("close_title"):
            for h, info in mine.items():
                if info["title"] == req["close_title"]:
                    license_watch.close_window(h)
        self._reply(ws, req, {"success": True, "foreground": buf.value,
                              "windows": [i["title"] for i in mine.values()]})

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
        names = req.get("names") if isinstance(req.get("names"), list) else None
        self._reply(ws, req, {"action": "PARAMS", "success": True,
                              "parameters": await self._in_slot(slot, slot.parameters, names)})

    async def _a_set_params(self, ws, req):
        slot = self._slot(req)
        items = req.get("params") if isinstance(req.get("params"), list) else []
        probe = req.get("probe_latency")
        res = await self._in_slot(slot, slot.set_parameters, items, None if probe is None else bool(probe))
        self._reply(ws, req, {"success": True, **res})
        if res.get("latency_changed") or probe:
            logger.info(f"⏱️ {slot.name} : latence {res.get('plugin_latency_before')} → "
                        f"{res.get('plugin_latency_after')} éch.")
            if slot.owner is not None:
                await self._send(slot.owner, {"action": "LATENCY", "slot_id": slot.slot_id,
                                              "latency_samples": slot.latency_samples})

    async def _a_set_param(self, ws, req):
        slot = self._slot(req)
        await self._in_slot(slot, slot.set_parameter, req.get("name"), req.get("value"))
        self._reply(ws, req, {"action": "PARAM_CHANGED", "name": req.get("name"), "value": req.get("value")})

    # --- automation (v11, R9) ------------------------------------------------------

    async def _a_automatable(self, ws, req):
        slot = self._slot(req)
        self._reply(ws, req, {"success": True, "parameters": await self._in_slot(slot, slot.automatable)})

    async def _a_set_automation_map(self, ws, req):
        slot = self._slot(req)
        names = req.get("names") if isinstance(req.get("names"), list) else []
        res = await self._in_slot(slot, slot.set_automation_map, names)
        self._reply(ws, req, {"success": True, **res})

    async def _a_param_texts(self, ws, req):
        slot = self._slot(req)
        names = [str(n) for n in (req.get("names") or []) if n] if isinstance(req.get("names"), list) else []
        texts = await self._in_slot(slot, slot.param_texts, names, int(req.get("steps") or 100))
        self._reply(ws, req, {"success": True, "texts": texts})

    async def _a_automation_stats(self, ws, req):
        slot = self._slot(req)
        if req.get("reset"):
            slot.proc_seconds, slot.proc_blocks, slot.auto_applied, slot.auto_skipped = 0.0, 0, 0, 0
        avg = slot.proc_seconds / slot.proc_blocks * 1e6 if slot.proc_blocks else 0.0
        self._reply(ws, req, {"success": True, "applied": slot.auto_applied, "skipped": slot.auto_skipped,
                              "watching": slot.watching, "blocks": slot.proc_blocks, "avg_block_us": round(avg, 1),
                              "key_blocks": slot.key_blocks, "sidechain_inputs": slot.sidechain_inputs,
                              "last_gr_db": round(float(getattr(slot.plugin, "last_gr_db", 0.0) or 0.0), 2)})

    async def _a_watch_params(self, ws, req):
        slot = self._slot(req)
        on = bool(req.get("on"))
        await self._in_slot(slot, slot.set_watching, on)
        if on and not getattr(slot, "_watch_task", None):
            slot._watch_task = asyncio.create_task(self._watch_loop(slot))
        self._reply(ws, req, {"success": True, "watching": slot.watching})

    async def _watch_loop(self, slot: Slot):
        """Relevé des réglages bougés dans la fenêtre du plugin (écriture Touch / Latch).
        Intervalle ≥ 40 ms et ≥ 8 × la durée d'un relevé (la charge reste minime)."""
        try:
            while slot.watching and self.slots.get(slot.slot_id) is slot and not slot.failed:
                t0 = time.perf_counter()
                moved = await self._in_slot(slot, slot.poll_changes)
                cost = time.perf_counter() - t0
                if moved and slot.owner is not None:
                    h = slot._cpp or {}
                    for m in moved:
                        cp = h.get(m["name"])
                        m["text"] = vst_host._text_of(cp) if cp is not None else ""
                    await self._send(slot.owner, {"action": "PARAM_CHANGED", "slot_id": slot.slot_id, "changes": moved})
                await asyncio.sleep(max(0.04, 8 * cost))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"[{slot.name}] relevé des réglages : {e}")
        finally:
            slot._watch_task = None

    async def _a_debug_editor_set(self, ws, req):
        """(Tests, NOVA_BRIDGE_DEBUG=1) Bouge un réglage comme le ferait la fenêtre du
        plugin (sans passer par Nova) : simule un geste Touch sans afficher de fenêtre."""
        if os.environ.get("NOVA_BRIDGE_DEBUG") != "1":
            raise RuntimeError("Action de test désactivée")
        slot = self._slot(req)
        name, value = str(req.get("name") or ""), float(req.get("value"))

        def now():
            h = slot.handles()
            cp = h.get(name)
            if cp is None:
                raise KeyError(f"Réglage inconnu : {name}")
            with slot.lock:
                cp.raw_value = value
        await self._in_slot(slot, now)
        self._reply(ws, req, {"success": True})

    async def _a_show_editor(self, ws, req):
        slot = self._slot(req)
        if not vst_host.HAS_VST:
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
        self._enqueue(q, (ws, "json", 0, np.array(channels, dtype=np.float32), None, None))

    # --- audio temps réel -----------------------------------------------------

    def _enqueue(self, q: asyncio.Queue, item, slot: Optional[Slot] = None):
        if q.qsize() >= MAX_QUEUE_BLOCKS:
            try:
                old = q.get_nowait()  # le plus ancien est déjà en retard côté DAW
                # Ses réglages d'automation ne sont pas perdus : posés au bloc suivant.
                if slot is not None and old is not None and len(old) > 4 and old[4]:
                    slot.carry_changes(old[4])
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(item)

    def _on_audio(self, ws, buf: bytes):
        try:
            slot_id, seq, nframes, nch, flags, data = parse_audio_frame(buf)
            changes = parse_audio_extras(buf, nframes, nch, flags)
            # (v12) Insert ARA : position du morceau portée par la trame (drapeau TIMELINE).
            timeline = ara_insert.parse_timeline(buf, nframes, nch, flags)
        except Exception:
            return
        q = self.slot_queues.get(slot_id)
        if q is None:
            return  # plugin pas (encore) chargé : le DAW compte un bloc manquant
        block = data.reshape(nframes, nch).T if nch > 1 else data.reshape(1, nframes)
        key = None
        if flags & vst_automation.FLAG_SIDECHAIN and nch >= 4:
            block, key = block[:2], block[2:4]
        item = (ws, "bin", seq, block, changes, key) if timeline is None else (ws, "bin", seq, block, changes, key, timeline)
        self._enqueue(q, item, self.slots.get(slot_id))

    async def _slot_worker(self, slot: Slot, q: asyncio.Queue):
        """Un consommateur par slot : blocs traités et renvoyés dans l'ordre.
        Ne s'arrête jamais sur une erreur. Plugin figé (bloc > HANG_TIMEOUT_S) :
        le slot passe en panne « hang », les blocs suivants repartent secs sans
        toucher à l'exécuteur bloqué ; les autres slots ne sont pas concernés."""
        reported = None
        while True:
            item = await q.get()
            if item is None:
                return
            try:
                ws, kind, seq, block, changes, key = item[:6]
                timeline = item[6] if len(item) > 6 else None
                if not slot.loaded.is_set() or (slot.plugin is None and not slot.failed):
                    continue
                if slot.failed:
                    out = slot.dry_block(block)
                else:
                    extra = (changes, key) if (changes or key is not None) else ()
                    if timeline is not None:
                        extra = (changes, key, timeline)
                    fut = self.loop.run_in_executor(slot.executor, slot.process_block, block, *extra)
                    try:
                        out = await asyncio.wait_for(asyncio.shield(fut), vst_host.HANG_TIMEOUT_S)
                    except asyncio.TimeoutError:
                        slot.mark_failed("hang", f"le plugin ne répond plus (bloc > {vst_host.HANG_TIMEOUT_S:g} s)")
                        out = slot.dry_block(block)
                if slot.failed and not slot.crash_reported:
                    self._report_crash(slot)
                if kind == "bin":
                    await self._send(ws, build_audio_frame(slot.slot_id, seq, out))
                else:
                    await self._send(ws, {"action": "AUDIO_PROCESSED", "slot_id": slot.slot_id,
                                          "channels": out.tolist()})
                # Latence réellement observée (zéros ajoutés en tête du flux)
                if not slot.failed and slot.blocks % 64 == 0 and slot.padded_total != reported and slot.owner is not None:
                    reported = slot.padded_total
                    if slot.padded_total:
                        await self._send(slot.owner, {"action": "LATENCY", "slot_id": slot.slot_id,
                                                      "latency_samples": slot.latency_samples})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Jamais de worker mort : un slot sans consommateur rendait du silence à vie.
                logger.error(f"[{slot.name}] bloc perdu : {e}")

    def _report_crash(self, slot: Slot):
        """PLUGIN_CRASHED, une fois, à la connexion propriétaire du slot."""
        slot.crash_reported = True
        msg = {"action": "PLUGIN_CRASHED", "slot_id": slot.slot_id, "reason": slot.failed,
               "error": slot.fail_error, "name": slot.name}
        target = slot.owner
        if target is not None:
            asyncio.ensure_future(self._send(target, msg))

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
            ctrls = meta.get("controllers") or []
            events = midi_events([n for n in notes if isinstance(n, dict)], duration,
                                 [c for c in ctrls if isinstance(c, dict)] if isinstance(ctrls, list) else None)
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
                                                      path, pname, state, events, duration, sr,
                                                      {"ws": ws, "source": "render"})
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
            if meta.get("action") == "STEMS_SEPARATE":
                await self._stems_separate(ws, meta, data)
                return
            if meta.get("action") == "ARA_OPEN":
                await self._ara_open(ws, meta, data)
                return
            if meta.get("action") == "ARA_ALIGN":
                await self._ara_align(ws, meta, data)
                return
            if meta.get("action") == "ARA_INSERT_SOURCE":
                await self._ara_insert_source(ws, meta, data)
                return
            if meta.get("action") == "ARA_INSERT_RENDER":
                await self._ara_insert_render_frame(ws, meta, data)
                return
            if meta.get("action") == "CALIBRATE_GR":
                await self._calibrate_gr(ws, meta, data)
                return
            nch = int(meta.get("nch") or 2)
            nframes = int(meta.get("nframes") or (data.size // nch))
            sr = int(meta.get("sample_rate") or 48000)
            audio = data[: nframes * nch].reshape(nframes, nch).T
            key = None
            if meta.get("sidechain") and nch >= 4:
                audio, key = audio[:2], audio[2:4]
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
                                                  audio, sr, float(meta.get("tail_seconds") or 0),
                                                  {"ws": ws, "source": "render"}, meta.get("automation"), key)
            logger.info(f"🎚️ Rendu {os.path.basename(path)} : {out.shape[1] / sr:.1f} s en {time.time() - t:.1f} s")
            reply = {"action": "RENDER", "req_id": meta.get("req_id"), "success": True,
                     "nch": 2, "nframes": int(out.shape[1]), "sample_rate": sr}
            await self._send(ws, build_render_frame(reply, out.T.reshape(-1)))
        except Exception as e:
            logger.error(f"RENDER : {e}")
            await self._send(ws, build_render_frame({"action": "RENDER", "req_id": meta.get("req_id"),
                                                     "success": False, "error": str(e)}, None))


async def _calibrate_gr(self, ws, meta: dict, data):
    """(v10) Calage « réduction cible » d'un compresseur VST : rendu hors ligne
    de la voix envoyée, dichotomie sur le réglage, puis le réglage trouvé est
    posé sur l'instance de la piste (slot)."""
    try:
        nch = int(meta.get("nch") or 2)
        nframes = int(meta.get("nframes") or (data.size // nch))
        sr = int(meta.get("sample_rate") or 48000)
        audio = data[: nframes * nch].reshape(nframes, nch).T
        slot = self.slots.get(str(meta.get("slot_id") or ""))
        if slot is None or slot.plugin is None:
            raise ValueError("Plugin de la piste introuvable sur le pont")
        state = await self._in_slot(slot, slot.get_state)
        t = time.time()
        res = await self.loop.run_in_executor(
            self.render_pool, calibrate_gr_offline, self.juce, slot.path, slot.plugin_name, state, audio, sr,
            str(meta.get("param")), float(meta.get("lo")), float(meta.get("hi")), int(meta.get("sense") or 1),
            float(meta.get("target_db") or 5.0), {"ws": ws, "source": "calibrate"})
        applied = await self._in_slot(slot, slot.set_parameters, [{"name": meta.get("param"), "real": res["value"]}], None)
        logger.info(f"🎯 Calage {slot.name} : {meta.get('param')} = {res.get('text')} -> {res['gr_db']:.2f} dB au VU "
                    f"({len(res['steps'])} rendus, {time.time() - t:.1f} s)")
        reply = {"action": "CALIBRATE_GR", "req_id": meta.get("req_id"), "success": True, "nch": 2, "nframes": 0,
                 "value": res["value"], "text": res.get("text"), "gr_db": res["gr_db"], "reached": res["reached"],
                 "why": res.get("why"), "steps": res["steps"], "applied": applied.get("results")}
        await self._send(ws, build_render_frame(reply, None))
    except Exception as e:
        logger.error(f"CALIBRATE_GR : {e}")
        await self._send(ws, build_render_frame({"action": "CALIBRATE_GR", "req_id": meta.get("req_id"),
                                                 "success": False, "error": str(e)}, None))


NovaBridgeServer._calibrate_gr = _calibrate_gr


def _stems_server_methods():
    """Actions de séparation de stems (ajoutées à NovaBridgeServer)."""

    async def _a_stems_status(self, ws, req):
        self._reply(ws, req, {"success": True, **self.stems.status()})

    async def _a_stems_install(self, ws, req):
        variant = str(req.get("variant") or "cpu")
        if variant not in ("cpu", "cuda", "auto"):
            variant = "cpu"

        def on_event(ev):
            msg = {"action": "STEMS_EVENT", "kind": "install", **ev}
            for c in list(self.clients):
                self.loop.call_soon_threadsafe(lambda c=c: asyncio.ensure_future(self._send(c, msg)))

        started = self.stems.start_install(on_event, variant=variant)
        logger.info("🧩 Installation de la séparation de stems " + ("lancée" if started else "déjà en cours"))
        self._reply(ws, req, {"success": True, "started": started, **self.stems.status()})

    async def _a_stems_cancel(self, ws, req):
        if req.get("install"):
            ok = self.stems.cancel_install()
        else:
            ok = self.stems.cancel(str(req.get("job_id") or ""))
        self._reply(ws, req, {"success": True, "cancelled": ok})

    async def _stems_separate(self, ws, meta: dict, data):
        req_id = meta.get("req_id")
        job_id = str(meta.get("job_id") or req_id)
        try:
            nch = max(1, min(2, int(meta.get("nch") or 2)))
            nframes = int(meta.get("nframes") or (data.size // nch))
            sr = int(meta.get("sample_rate") or 48000)
            if nframes < sr // 2:
                raise stems_service.StemsError("Clip trop court pour être séparé (une demi-seconde minimum).")
            if nframes > sr * stems_service.MAX_SECONDS:
                raise stems_service.StemsError("Clip trop long (20 minutes maximum) : coupe-le avant de le séparer.")
            if not self.stems.installed():
                raise stems_service.StemsNotInstalled()
            audio = data[: nframes * nch].reshape(nframes, nch).T
            outdir = self.stems.output_dir(str(meta.get("project") or "Projet"), str(meta.get("clip") or "clip"))
            outdir.mkdir(parents=True, exist_ok=True)
            src = outdir / "Original.wav"
            stems_service.write_wav_float(src, audio, sr)

            def on_event(ev):
                msg = {"action": "STEMS_EVENT", "kind": "separate", "job_id": job_id, **ev}
                self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._send(ws, msg)))

            t = time.time()
            res = await self.loop.run_in_executor(
                self.stems_pool, lambda: self.stems.separate(job_id, src, outdir, int(meta.get("stems") or 4), on_event))
            logger.info(f"🎚️ Stems ({len(res['stems'])}) : {nframes / sr:.1f} s séparées en {time.time() - t:.1f} s ({res['device']})")
            for i, s in enumerate(res["stems"]):
                audio_s, sr_s = await self.loop.run_in_executor(self.misc_pool, stems_service.read_wav, s["path"])
                head = {"action": "STEMS_STEM", "req_id": req_id, "job_id": job_id, "key": s["key"],
                        "label": s["label"], "index": i, "count": len(res["stems"]), "nch": int(audio_s.shape[0]),
                        "nframes": int(audio_s.shape[1]), "sample_rate": sr_s, "path": s["path"]}
                await self._send(ws, build_render_frame(head, audio_s.T.reshape(-1)))
            await self._send(ws, build_render_frame({"action": "STEMS_SEPARATE", "req_id": req_id, "job_id": job_id,
                                                     "success": True, "nch": 0, "nframes": 0, **res}, None))
        except Exception as e:
            code = ("not_installed" if isinstance(e, stems_service.StemsNotInstalled)
                    else "cancelled" if isinstance(e, stems_service.StemsCancelled) else "error")
            if code != "cancelled":
                logger.error(f"STEMS_SEPARATE : {e}")
            await self._send(ws, build_render_frame({"action": "STEMS_SEPARATE", "req_id": req_id, "job_id": job_id,
                                                     "success": False, "error": str(e), "code": code}, None))

    for fn in (_a_stems_status, _a_stems_install, _a_stems_cancel, _stems_separate):
        setattr(NovaBridgeServer, fn.__name__, fn)


_stems_server_methods()
ara_service.install(NovaBridgeServer, build_render_frame)
ara_insert.install(NovaBridgeServer, build_render_frame, parse_render_frame)


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
