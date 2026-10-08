#!/usr/bin/env python3
"""
Melodyne et VocAlign en INSERT sur une piste, comme dans Pro Tools (pont v12).

Dans Pro Tools, un plugin ARA posé en insert reçoit TOUS les clips de la piste (sans
« transfert ») : son éditeur s'ancre en bas de la fenêtre Édition, et ses retouches
s'entendent en direct pendant la lecture, sans rendu. Ici :

  - un insert ARA = un « slot » du pont (même cycle de vie qu'un VST : LOAD_PLUGIN avec
    ara="melodyne"|"vocalign", UNLOAD_PLUGIN, GET_STATE / SET_STATE = archive ARA, c.-à-d. les
    retouches) servi par un processus NovaARAHost.exe (hôte natif, nova-ara-host/) ;
  - le document ARA de la piste (un son = une source, un clip = une région) est tenu à jour à
    chaque édition de NOVA (ARA_INSERT_DOC : déplacer, couper, rogner, supprimer, dupliquer) ;
  - lecture : les trames temps réel du slot (type 1) portent la position du morceau
    (drapeau TIMELINE = 4, f64 en échantillons après l'audio, -1 = transport arrêté) ;
    l'hôte les passe au rendu de lecture ARA du plugin par un tube nommé (voir
    nova-ara-host/Source/AudioPipe.h) et renvoie sa sortie : la piste joue le son du plugin ;
  - export / gel / bounce : ARA_INSERT_RENDER rend une plage du morceau à travers le plugin,
    hors ligne, à l'identique de la lecture.

Actions
  LOAD_PLUGIN  slot_id path sample_rate ara=melodyne|vocalign [state = archive base64]
  ARA_INSERT_SOURCE (trame type 2) {slot_id, id, name, sample_rate, nch, nframes, persistent_id?}
                 + float32 entrelacés : un fichier son de la piste (une fois par son)
  ARA_INSERT_DOC {slot_id, sources:[{id, name, persistent_id?}], regions:[{id, source, name,
                 offset, start, duration}], track:{name}, tempo:[{t, q}], signatures:[{q, num, den}],
                 chords:[{q, root, bass, intervals, name}], bpm}
                 → {success, applied:true, version, added, removed, updated} ou {success, applied:false, missing:[ids]}
                 (sons pas encore reçus : les envoyer par ARA_INSERT_SOURCE puis renvoyer DOC)
  ARA_INSERT_STATE {slot_id, notes?, wait_analysis_s?} → régions relues dans le plugin
  ARA_INSERT_EDITOR {slot_id, mode: dock|bounds|float|hide, parent, x, y, w, h, visible}
  ARA_INSERT_SELECT {slot_id, regions:[ids]}
  ARA_INSERT_RENDER (JSON ou trame type 2) {slot_id, start, duration, sample_rate}
                 → trame type 2 {action, req_id, success, nch:2, nframes, sample_rate} + audio
  ARA_INSERT_PARAMS / ARA_INSERT_PARAM {slot_id, title|id, value}
  Évènements : ARA_EVENT {slot_id, event: transport_request|editor_closed|content_changed|playback}
"""

import asyncio
import base64
import json
import logging
import os
import shutil
import struct
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

import ara_host
import stems_service

logger = logging.getLogger("NovaBridge.ARA")

FLAG_TIMELINE = 4
PIPE_MAGIC = 0x4152414E
MAX_BLOCK = 2048


def parse_timeline(buf: bytes, nframes: int, nch: int, flags: int) -> Optional[float]:
    """Position du morceau (échantillons) portée par une trame temps réel, -1 = arrêt ; None sans drapeau."""
    if not flags & FLAG_TIMELINE:
        return None
    L = buf[1]
    off = ((2 + L + 3) & ~3) + 8 + nframes * nch * 4
    if len(buf) < off + 8:
        return None
    return struct.unpack_from("<d", buf, off)[0]


def timeline_extra_bytes(flags: int) -> int:
    """Octets de la position (avant les réglages d'automation, drapeau PARAMS)."""
    return 8 if flags & FLAG_TIMELINE else 0


class AraInsertSlot:
    """Un insert ARA (Melodyne, VocAlign) = un NovaARAHost.exe + un document ARA de la piste.
    Interface d'un vst_host.Slot (le pont le traite comme un slot ordinaire)."""

    def __init__(self, slot_id: str, kind: str, path: str, sample_rate: int, on_event=None):
        self.slot_id = slot_id
        self.kind = kind
        self.path = path
        self.plugin_name = None
        self.sample_rate = int(sample_rate or 48000)
        self.name = ara_host.KNOWN.get(kind, {}).get("label", kind)
        self.vendor = ""
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"ara-{slot_id[:12]}")
        self.lock = threading.Lock()
        self.loaded = threading.Event()
        self.plugin = None              # l'hôte, une fois chargé
        self.host: Optional[ara_host.AraHostProcess] = None
        self.owner = None
        self.orphan_since: Optional[float] = None
        self.error: Optional[str] = None
        self.failed: Optional[str] = None
        self.fail_error: Optional[str] = None
        self.crash_reported = False
        self.is_instrument = False
        self.sidechain_inputs = 0
        self.padded_total = 0
        self.blocks = 0
        self.rendered_blocks = 0
        self.plugin_latency = 0
        self.on_event = on_event
        self.dir = Path(tempfile.mkdtemp(prefix=f"nova-ara-insert-{kind}-"))
        self.sources: Dict[str, str] = {}      # id du son → WAV
        self.sent_sources: set = set()         # sons déjà confiés à l'hôte
        self.pending_archive: Optional[str] = None
        self.pending_vst: Optional[str] = None
        self.doc_version = 0
        self._pipe = None
        self._pipe_name: Optional[str] = None
        self._zeros: Dict[int, np.ndarray] = {}
        self.last_pos = -1.0
        self._was_playing = False
        self.jumps: List[list] = []
        self._jump_watch = 0
        # Rien d'automatisable par le pont pour un insert ARA (les retouches sont dans l'archive).
        self.auto_keys: List[str] = []
        self.watching = False
        self.proc_seconds = 0.0
        self.proc_blocks = 0
        self.auto_applied = 0
        self.auto_skipped = 0
        self.key_blocks = 0
        # VocAlign : l'édition installée (VST3 « VocAlign 6 Standard VST ») n'aligne pas par ARA
        # (fabrique ARA présente, mais sa fenêtre reste en « Capture » : l'ARA de VocAlign passe par
        # la variante ARA / AAX). Mode capture transparent : le double (la piste) et le guide (la
        # lead) sont capturés tout seuls, puis la piste joue le double calé à sa place.
        # NOVA_VOCALIGN_ARA=1 : essayer l'ARA (variante ARA de VocAlign Pro / Ultra / Project).
        self.capture_mode = kind == "vocalign" and os.environ.get("NOVA_VOCALIGN_ARA") != "1"
        self.aligned: Optional[np.ndarray] = None      # (2, n) double calé, à la fréquence du slot
        self.aligned_start = 0                           # échantillon du morceau du 1er échantillon
        self.capture_sig = ""
        self.capture_state = "idle"                      # idle | waiting_guide | running | done | error
        self.capture_error: Optional[str] = None
        self.capture_seconds = 0.0
        self._capture_lock = threading.Lock()
        self._capture_thread: Optional[threading.Thread] = None
        self._capture_req: Optional[dict] = None

    @property
    def latency_samples(self) -> int:
        return int(self.plugin_latency)

    # --- cycle de vie (dans self.executor) --------------------------------------------

    def load(self, state_b64: Optional[str], context: Optional[dict] = None) -> bool:
        h = ara_host.AraHostProcess(on_event=self._event)
        if self.capture_mode:
            try:
                info = h.call("load", plugin=self.path, sample_rate=self.sample_rate, ara=False, timeout=180)
                # Fenêtre hors écran, sans activation : le bouton « Capture » du double y est cliqué.
                h.call("show_editor", offscreen=True, title="VocAlign (Nova Studio)", timeout=60)
            except Exception:
                h.close()
                raise
            self.host = h
            self.name = info.get("name") or self.name
            self.vendor = info.get("vendor") or ""
            self.plugin_latency = 0
            with self.lock:
                self.plugin = h
            self.loaded.set()
            return False
        try:
            info = h.call("load", plugin=self.path, sample_rate=self.sample_rate, timeout=180)
            so = h.call("stream_open", sample_rate=self.sample_rate, max_block=MAX_BLOCK, timeout=60)
        except Exception:
            h.close()
            raise
        self.host = h
        self.name = info.get("name") or self.name
        self.vendor = info.get("vendor") or ""
        self.plugin_latency = int(so.get("latency_samples") or info.get("latency_samples") or 0)
        self._pipe_name = so.get("pipe")
        self._open_pipe()
        self.pending_archive, self.pending_vst = unpack_state(state_b64)
        if self.pending_vst:
            try:
                h.call("set_vst_state", state_b64=self.pending_vst, timeout=60)
            except Exception as e:
                logger.warning(f"[{self.name}] réglages du plugin non restaurés : {e}")
        with self.lock:
            self.plugin = h
        self.loaded.set()
        return bool(self.pending_archive or self.pending_vst)

    def _open_pipe(self):
        last = None
        for _ in range(100):
            try:
                self._pipe = open(self._pipe_name, "r+b", buffering=0)
                return
            except OSError as e:
                last = e
                time.sleep(0.02)
        raise ara_host.AraHostError(f"Flux audio de l'hôte ARA indisponible : {last}")

    def _event(self, ev: dict):
        if self.on_event:
            try:
                self.on_event(self, ev)
            except Exception:  # pragma: no cover
                pass

    def unload(self):
        def close():
            try:
                if self._pipe is not None:
                    self._pipe.close()
            except Exception:
                pass
            self._pipe = None
            h, self.host = self.host, None
            with self.lock:
                self.plugin = None
            if h is not None:
                h.close()
            shutil.rmtree(self.dir, ignore_errors=True)
        threading.Thread(target=close, name="ara-insert-close", daemon=True).start()

    def mark_failed(self, reason: str, error: str):
        if self.failed:
            return
        self.fail_error = str(error)[:300]
        self.failed = reason
        logger.error(f"[{self.name}] insert ARA en panne ({reason}) : {self.fail_error}")

    def dry_block(self, block: np.ndarray) -> np.ndarray:
        """En panne : la piste joue ses clips tels quels (le son reçu de NOVA)."""
        x = block if block.shape[0] >= 2 else np.vstack([block, block])
        return np.array(x[:2], dtype=np.float32, copy=True)

    # --- temps réel ---------------------------------------------------------------

    def process_block(self, block: np.ndarray, changes=None, key=None, timeline: Optional[float] = None) -> np.ndarray:
        """Bloc de la piste → sortie du plugin à la position du morceau. Transport arrêté (ou
        trame sans position) : silence (le plugin n'a rien à jouer)."""
        n = block.shape[1]
        if self.capture_mode:
            return self._play_aligned(block, timeline)
        if timeline is None or timeline < 0 or self._pipe is None:
            z = self._zeros.get(n)
            if z is None:
                z = self._zeros[n] = np.zeros((2, n), np.float32)
            if self._was_playing and self._pipe is not None:
                # Transport arrêté : le plugin l'apprend (sinon Melodyne rejoue un bout de
                # l'ancienne position à la relance).
                self._was_playing = False
                try:
                    with self.lock:
                        for _ in range(4):
                            self._pipe.write(struct.pack("<IIIIq", PIPE_MAGIC, n, 2, 0, int(self.last_pos)) + z.astype("<f4").tobytes())
                            _magic, nn, nc, _fl = struct.unpack("<IIII", _read_exact(self._pipe, 16))
                            _read_exact(self._pipe, 4 * nn * nc)
                except Exception:
                    pass
            return z
        self._was_playing = True
        x = block if block.shape[0] >= 2 else np.vstack([block, block])
        x = np.ascontiguousarray(x[:2], dtype="<f4")
        pos = int(round(timeline))
        t0 = time.perf_counter()
        with self.lock:
            p = self._pipe
            p.write(struct.pack("<IIIIq", PIPE_MAGIC, n, 2, 1, pos) + x.tobytes())
            head = _read_exact(p, 16)
            magic, nn, nc, flags = struct.unpack("<IIII", head)
            data = _read_exact(p, 4 * nn * nc)
        self.proc_seconds += time.perf_counter() - t0
        self.proc_blocks += 1
        self.blocks += 1
        if flags & 1:
            self.rendered_blocks += 1
        out = np.array(np.frombuffer(data, "<f4").reshape(nc, nn)[:2], dtype=np.float32, copy=True)
        if self.last_pos >= 0 and pos != self.last_pos + n:
            # Sauts de position (relance, boucle) : position d'avant, d'après, pic des 10 blocs suivants.
            self.jumps.append([int(self.last_pos), pos, 0.0])
            self.jumps = self.jumps[-50:]
            self._jump_watch = 10
        if self._jump_watch > 0 and self.jumps:
            self._jump_watch -= 1
            self.jumps[-1][2] = max(self.jumps[-1][2], float(np.max(np.abs(out))))
        self.last_pos = pos
        return out

    def _play_aligned(self, block: np.ndarray, timeline: Optional[float]) -> np.ndarray:
        """VocAlign (capture) : le double calé, à la position du morceau ; tant qu'il n'est pas
        prêt, la piste joue ses clips tels quels (le son reçu de NOVA)."""
        n = block.shape[1]
        a = self.aligned
        if timeline is None or timeline < 0:
            return np.zeros((2, n), np.float32)
        if a is None:
            return self.dry_block(block)
        out = np.zeros((2, n), np.float32)
        i0 = int(round(timeline)) - self.aligned_start
        lo, hi = max(0, i0), min(a.shape[1], i0 + n)
        if hi > lo:
            out[:, lo - i0:hi - i0] = a[:, lo:hi]
        self.blocks += 1
        self.rendered_blocks += 1
        return out

    def aligned_range(self, start: float, duration: float, sr: int) -> np.ndarray:
        """VocAlign (capture) : plage du morceau du double calé (export, gel)."""
        n = int(round(duration * sr))
        out = np.zeros((2, n), np.float32)
        a = self.aligned
        if a is None:
            return out
        if sr != self.sample_rate:
            a = _resample(a, self.sample_rate, sr)
        i0 = int(round(start * sr)) - int(round(self.aligned_start * sr / self.sample_rate))
        lo, hi = max(0, i0), min(a.shape[1], i0 + n)
        if hi > lo:
            out[:, lo - i0:hi - i0] = a[:, lo:hi]
        return out

    # --- VocAlign : capture transparente ------------------------------------------------

    def _mix(self, regions: List[dict], w0: int, n: int) -> np.ndarray:
        """Clips (régions) posés sur la fenêtre [w0, w0 + n[ du morceau, en mono."""
        out = np.zeros(n, np.float32)
        cache: Dict[str, np.ndarray] = {}
        for r in regions:
            sid = str(r.get("source"))
            if sid not in cache:
                a, sr = stems_service.read_wav(self.sources[sid])
                a = a.mean(axis=0).astype(np.float32)
                if sr != self.sample_rate:
                    a = _resample(a[None, :], sr, self.sample_rate)[0]
                cache[sid] = a
            a = cache[sid]
            off = int(round(float(r.get("offset") or 0) * self.sample_rate))
            st = int(round(float(r.get("start") or 0) * self.sample_rate)) - w0
            ln = int(round(float(r.get("duration") or 0) * self.sample_rate))
            ln = min(ln, a.shape[0] - off)
            lo, hi = max(0, st), min(n, st + ln)
            if hi > lo:
                out[lo:hi] += a[off + (lo - st): off + (hi - st)]
        return out

    def _sync_capture(self, req: dict) -> dict:
        guide = req.get("guide") or {}
        srcs = list(req.get("sources") or []) + list(guide.get("sources") or [])
        missing = sorted({str(s.get("id")) for s in srcs if str(s.get("id")) not in self.sources})
        if missing:
            return {"success": True, "applied": False, "missing": missing}
        regions = req.get("regions") or []
        gregions = guide.get("regions") or []
        self.doc_version += 1
        if not regions:
            self.aligned, self.capture_state = None, "idle"
            return {"success": True, "applied": True, "version": self.doc_version, "capture": self.capture_state}
        if not gregions:
            self.aligned, self.capture_state = None, "waiting_guide"
            self._event({"event": "capture", "state": self.capture_state})
            return {"success": True, "applied": True, "version": self.doc_version, "capture": self.capture_state}
        sig = json.dumps([regions, gregions], sort_keys=True)
        if sig != self.capture_sig:
            self.capture_sig = sig
            self._capture_req = {"regions": regions, "guide": gregions, "sig": sig}
            self.capture_state = "running"
            self._start_capture()
        return {"success": True, "applied": True, "version": self.doc_version, "capture": self.capture_state}

    def _start_capture(self):
        with self._capture_lock:
            if self._capture_thread is not None and self._capture_thread.is_alive():
                return   # la capture en cours reprendra la dernière demande à la fin
            self._capture_thread = threading.Thread(target=self._capture_loop, name="vocalign-capture", daemon=True)
            self._capture_thread.start()

    def _capture_loop(self):
        while True:
            job = self._capture_req
            if job is None:
                return
            self._capture_req = None
            try:
                self._capture_once(job)
            except Exception as e:
                self.capture_state, self.capture_error = "error", str(e)
                self._event({"event": "capture", "state": "error", "error": str(e)})
                logger.error(f"VocAlign (capture) : {e}")
            if self._capture_req is None:
                return

    def _capture_once(self, job: dict):
        h = self.host
        if h is None:
            return
        import ara_service
        sr = self.sample_rate
        allr = job["regions"] + job["guide"]
        w0 = max(0, int(round((min(float(r["start"]) for r in allr) - 0.25) * sr)))
        w1 = int(round((max(float(r["start"]) + float(r["duration"]) for r in allr) + 0.25) * sr))
        n = max(1, w1 - w0)
        dub = self._mix(job["regions"], w0, n)
        gd = self._mix(job["guide"], w0, n)
        dp, gp, out = self.dir / "capture_double.wav", self.dir / "capture_guide.wav", self.dir / "capture_cale.wav"
        stems_service.write_wav_float(dp, dub[None, :], sr)
        stems_service.write_wav_float(gp, gd[None, :], sr)
        self.capture_state, self.capture_error = "running", None
        self._event({"event": "capture", "state": "running", "seconds": n / sr})
        t = time.time()
        kw = dict(dub=str(dp), guide=str(gp), out=str(out), passes=2, wait_s=4, realtime=True, keep=False,
                  clicks=[{"click": ara_service.VOCALIGN_DUB_CAPTURE}], target_index=1, timeout=120 + 3 * n / sr)
        try:
            r = h.call("capture_align", **kw)
        except ara_host.AraHostError as e:
            if "fenêtre" not in str(e).lower():
                raise
            # Panneau fermé (fenêtre ancrée masquée) : capture dans une fenêtre hors écran.
            h.call("editor", mode="hide", release=True, timeout=30)
            h.call("show_editor", offscreen=True, title="VocAlign (Nova Studio)", timeout=60)
            r = h.call("capture_align", **kw)
        a, asr = stems_service.read_wav(str(out))
        if asr != sr:
            a = _resample(a, asr, sr)
        st = a if a.shape[0] >= 2 else np.vstack([a, a])
        self.aligned_start = w0
        self.aligned = np.ascontiguousarray(st[:2], dtype=np.float32)
        self.capture_seconds = round(time.time() - t, 1)
        self.capture_state = "done" if self._capture_req is None else "running"
        self._event({"event": "capture", "state": "done", "seconds": self.capture_seconds, "sidechain": r.get("sidechain"),
                     "peak": r.get("peak")})
        logger.info(f"🎙️ VocAlign (insert) : double calé en {self.capture_seconds:.1f} s ({n / sr:.1f} s de son)")

    # --- état : archive ARA (retouches) + état VST3 (réglages hors ARA) ------------------

    def get_state(self) -> Optional[str]:
        if self.capture_mode:
            return None
        h = self.host
        if h is None:
            return pack_state(self.pending_archive, self.pending_vst)
        arc = self.pending_archive
        vst = self.pending_vst
        try:
            if self.doc_version:
                arc = h.call("archive", timeout=120).get("archive_b64") or arc
            vst = h.call("vst_state", timeout=60).get("state_b64") or vst
        except Exception as e:
            logger.warning(f"[{self.name}] état de l'insert ARA : {e}")
        return pack_state(arc, vst)

    def set_state(self, state: str) -> bool:
        arc, vst = unpack_state(state)
        h = self.host
        if h is None:
            self.pending_archive, self.pending_vst = arc, vst
            return True
        ok = True
        if vst:
            ok = bool(h.call("set_vst_state", state_b64=vst, timeout=60).get("restored"))
        if arc:
            if not self.doc_version:
                self.pending_archive = arc
            else:
                ok = bool(h.call("restore", archive_b64=arc, timeout=120).get("restored")) and ok
        return ok

    # Automation : rien (interface d'un Slot).
    def automatable(self):
        return []

    def set_automation_map(self, names):
        return {"missing": list(names or [])}

    def param_texts(self, names, steps=100):
        return {}

    def set_watching(self, on):
        self.watching = False

    def poll_changes(self):
        return []

    def parameters(self, names=None):
        return []

    def carry_changes(self, changes):
        pass

    # --- document -------------------------------------------------------------------

    def add_source(self, sid: str, audio: np.ndarray, sr: int):
        p = self.dir / f"src{len(self.sources)}.wav"
        stems_service.write_wav_float(p, audio, sr)
        self.sources[sid] = str(p)

    def sync_doc(self, req: dict) -> dict:
        h = self.host
        if h is None:
            raise ara_host.AraHostError("Insert ARA pas encore chargé")
        if self.capture_mode:
            return self._sync_capture(req)
        srcs = req.get("sources") or []
        missing = [str(s.get("id")) for s in srcs if str(s.get("id")) not in self.sources]
        if missing:
            return {"success": True, "applied": False, "missing": missing}
        out_sources = []
        for s in srcs:
            sid = str(s.get("id"))
            item = {"id": sid, "name": s.get("name") or sid}
            if s.get("persistent_id"):
                item["persistent_id"] = s["persistent_id"]
            if s.get("modification_id"):
                item["modification_id"] = s["modification_id"]
            if sid not in self.sent_sources:
                item["path"] = self.sources[sid]
            out_sources.append(item)
        kw = {k: req[k] for k in ("regions", "track", "tempo", "signatures", "chords", "bpm") if k in req}
        if self.pending_archive and not self.doc_version:
            kw["archive_b64"] = self.pending_archive
        res = h.call("doc", sources=out_sources, timeout=180, **kw)
        for s in out_sources:
            self.sent_sources.add(s["id"])
        if res.get("restored"):
            self.pending_archive = None
        self.doc_version = int(res.get("version") or self.doc_version + 1)
        self.plugin_latency = int(res.get("latency_samples") or self.plugin_latency)
        return {"success": True, "applied": True, **{k: v for k, v in res.items() if k not in ("id", "ok")}}


STATE_PREFIX = "NARA1."


def pack_state(archive_b64: Optional[str], vst_b64: Optional[str]) -> Optional[str]:
    """État d'un insert ARA (GET_STATE) : archive ARA (retouches) + état VST3, en une chaîne ASCII."""
    if not archive_b64 and not vst_b64:
        return None
    raw = json.dumps({"ara": archive_b64 or "", "vst": vst_b64 or ""}).encode("ascii")
    return STATE_PREFIX + base64.b64encode(raw).decode("ascii")


def unpack_state(state: Optional[str]):
    """→ (archive ARA, état VST3). Une ancienne valeur nue = archive ARA seule."""
    if not state:
        return None, None
    if state.startswith(STATE_PREFIX):
        try:
            d = json.loads(base64.b64decode(state[len(STATE_PREFIX):]).decode("ascii"))
            return (d.get("ara") or None), (d.get("vst") or None)
        except Exception:
            return None, None
    return state, None


def _resample(a: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Rééchantillonnage linéaire (sons d'une autre fréquence que la session)."""
    if sr_in == sr_out or a.shape[-1] == 0:
        return a
    n = int(round(a.shape[-1] * sr_out / sr_in))
    x = np.arange(n) * (sr_in / sr_out)
    src = np.arange(a.shape[-1])
    return np.stack([np.interp(x, src, ch).astype(np.float32) for ch in a])


def _read_exact(f, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            raise ara_host.AraHostError("Flux audio de l'hôte ARA coupé")
        buf += chunk
    return bytes(buf)


def install(Server, build_render_frame, parse_render_frame):
    """Ajoute l'insert ARA au serveur du pont (LOAD_PLUGIN ara=…, ARA_INSERT_*)."""

    orig_load = Server._a_load_plugin
    orig_show = Server._a_show_editor
    orig_close = Server._a_close_editor

    def _insert(self, req) -> AraInsertSlot:
        slot = self.slots.get(str(req.get("slot_id") or ""))
        if not isinstance(slot, AraInsertSlot):
            raise KeyError("Insert ARA non chargé sur le pont")
        return slot

    def _insert_event(self, slot: AraInsertSlot, ev: dict):
        name = ev.get("event")
        if name in ("log", "ready", "analysis_progress"):
            return
        target = slot.owner
        if target is None:
            return
        msg = {"action": "ARA_EVENT", "slot_id": slot.slot_id, **ev}
        self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._send(target, msg)))

    async def _a_load_plugin(self, ws, req):
        kind = req.get("ara")
        if not kind:
            return await orig_load(self, ws, req)
        slot_id = str(req.get("slot_id") or "default")
        path = req.get("path") or ""
        sr = int(req.get("sample_rate") or req.get("sampleRate") or 48000)
        existing = self.slots.get(slot_id)
        if isinstance(existing, AraInsertSlot) and existing.path == path and existing.sample_rate == sr and not existing.failed:
            existing.owner = ws
            existing.orphan_since = None
            await self.loop.run_in_executor(self.misc_pool, existing.loaded.wait, 300)
            if existing.error:
                raise RuntimeError(existing.error)
            existing.sent_sources.clear()   # page rechargée : le document est renvoyé en entier
            state = await self._in_slot(existing, existing.get_state)
            self._reply(ws, req, {**self._load_payload(existing, state, reused=True), "ara": existing.kind})
            return
        if existing is not None:
            self._drop_slot(slot_id)
        if not ara_host.find_host_exe():
            raise RuntimeError("L'hôte ARA (NovaARAHost.exe) n'est pas installé avec Nova Studio")
        if not path or not os.path.exists(path):
            plug = ara_host.find_ara_plugins(self.plugins or []).get(str(kind))
            if not plug:
                raise RuntimeError(f"{ara_host.KNOWN.get(kind, {}).get('label', kind)} n'est pas installé sur ce PC")
            path = plug["path"]
        slot = AraInsertSlot(slot_id, str(kind), path, sr, on_event=lambda s, e: _insert_event(self, s, e))
        slot.owner = ws
        self.slots[slot_id] = slot
        q: asyncio.Queue = asyncio.Queue()
        self.slot_queues[slot_id] = q
        asyncio.create_task(self._slot_worker(slot, q))
        try:
            await self._in_slot(slot, slot.load, req.get("state"), {"ws": ws, "slot_id": slot_id, "source": "load"})
        except Exception as e:
            slot.error = str(e)
            slot.loaded.set()
            if self.slots.get(slot_id) is slot:
                self._drop_slot(slot_id)
            raise
        if self.slots.get(slot_id) is not slot:
            slot.unload()
            raise RuntimeError("Chargement annulé")
        logger.info(f"🎛️ {slot.name} en insert ARA ({sr} Hz, latence {slot.latency_samples} éch.)")
        self._reply(ws, req, {**self._load_payload(slot, req.get("state")), "ara": slot.kind})

    async def _a_show_editor(self, ws, req):
        slot = self.slots.get(str(req.get("slot_id", "")))
        if isinstance(slot, AraInsertSlot):
            res = await self.loop.run_in_executor(self.misc_pool, lambda: slot.host.call("editor", mode="float", title=f"{slot.name} (Nova Studio)"))
            self._reply(ws, req, {"success": True, "mode": res.get("mode")})
            return
        return await orig_show(self, ws, req)

    async def _a_close_editor(self, ws, req):
        slot = self.slots.get(str(req.get("slot_id", "")))
        if isinstance(slot, AraInsertSlot):
            if slot.host is not None:
                await self.loop.run_in_executor(self.misc_pool, lambda: slot.host.call("editor", mode="hide"))
            self._reply(ws, req, {"success": True})
            return
        return await orig_close(self, ws, req)

    async def _a_ara_insert_doc(self, ws, req):
        slot = _insert(self, req)
        res = await self.loop.run_in_executor(self.misc_pool, slot.sync_doc, req)
        self._reply(ws, req, res)

    async def _ara_insert_source(self, ws, meta: dict, data):
        req_id = meta.get("req_id")
        try:
            slot = _insert(self, meta)
            nch = max(1, min(2, int(meta.get("nch") or 1)))
            n = int(meta.get("nframes") or 0)
            if data.size < n * nch:
                raise ValueError("Audio incomplet")
            audio = data[: n * nch].reshape(n, nch).T.copy()
            sr = int(meta.get("sample_rate") or slot.sample_rate)
            await self.loop.run_in_executor(self.misc_pool, slot.add_source, str(meta.get("id")), audio, sr)
            self._reply(ws, {"action": "ARA_INSERT_SOURCE", "req_id": req_id}, {"success": True, "id": meta.get("id")})
        except Exception as e:
            self._reply(ws, {"action": "ARA_INSERT_SOURCE", "req_id": req_id}, {"success": False, "error": str(e)})

    async def _a_ara_insert_state(self, ws, req):
        slot = _insert(self, req)
        kw = {"notes": bool(req.get("notes", True))}
        timeout = 60.0
        if req.get("wait_analysis_s") is not None:
            kw["wait_analysis_s"] = float(req["wait_analysis_s"])
            timeout += kw["wait_analysis_s"]
        res = await self.loop.run_in_executor(self.misc_pool, lambda: slot.host.call("doc_state", timeout=timeout, **kw))
        self._reply(ws, req, {"success": True, **{k: v for k, v in res.items() if k not in ("id", "ok")},
                              "pont_blocs": slot.blocks, "pont_blocs_rendus": slot.rendered_blocks,
                              "sauts": [list(j) for j in slot.jumps[-20:]]})

    async def _a_ara_insert_capture(self, ws, req):
        """VocAlign (capture) : état de la capture transparente."""
        slot = _insert(self, req)
        self._reply(ws, req, {"success": True, "capture_mode": slot.capture_mode, "state": slot.capture_state,
                              "error": slot.capture_error, "seconds": slot.capture_seconds,
                              "aligned_s": (slot.aligned.shape[1] / slot.sample_rate) if slot.aligned is not None else 0,
                              "aligned_start_s": slot.aligned_start / slot.sample_rate})

    async def _a_ara_insert_editor(self, ws, req):
        slot = _insert(self, req)
        kw = {k: req[k] for k in ("mode", "parent", "x", "y", "w", "h", "visible", "release") if k in req}
        if kw.get("mode") == "float":
            kw["title"] = f"{slot.name} (Nova Studio)"
        if req.get("offscreen"):
            kw["offscreen"] = True
        res = await self.loop.run_in_executor(self.misc_pool, lambda: slot.host.call("editor", timeout=60, **kw))
        self._reply(ws, req, {"success": True, **{k: v for k, v in res.items() if k not in ("id", "ok")}})

    async def _a_ara_insert_select(self, ws, req):
        slot = _insert(self, req)
        res = await self.loop.run_in_executor(self.misc_pool, lambda: slot.host.call("select", regions=list(req.get("regions") or [])))
        self._reply(ws, req, {"success": True, "selected": res.get("selected")})

    async def _a_ara_insert_params(self, ws, req):
        slot = _insert(self, req)
        res = await self.loop.run_in_executor(self.misc_pool, lambda: slot.host.call("params"))
        self._reply(ws, req, {"success": True, "params": res.get("params") or []})

    async def _a_ara_insert_param(self, ws, req):
        slot = _insert(self, req)
        kw = {k: req[k] for k in ("title", "id", "value") if k in req}
        res = await self.loop.run_in_executor(self.misc_pool, lambda: slot.host.call("set_param", **kw))
        self._reply(ws, req, {"success": True, **{k: v for k, v in res.items() if k not in ("id", "ok")}})

    async def _a_ara_insert_snapshot(self, ws, req):
        slot = _insert(self, req)
        path = str(req.get("path") or "")
        if not path.lower().endswith(".png"):
            raise ValueError("Capture : chemin .png attendu")
        res = await self.loop.run_in_executor(self.misc_pool, lambda: slot.host.call("snapshot", path=path))
        self._reply(ws, req, {"success": True, "path": res.get("path"), "width": res.get("width"), "height": res.get("height")})

    async def _a_ara_insert_render(self, ws, req):
        await _ara_insert_render(self, ws, req)

    async def _ara_insert_render(self, ws, meta: dict, _data=None):
        req_id = meta.get("req_id")
        try:
            slot = _insert(self, meta)
            sr = int(meta.get("sample_rate") or slot.sample_rate)
            start = float(meta.get("start") or 0.0)
            dur = float(meta.get("duration") or 0.0)
            if slot.capture_mode:
                # VocAlign (capture) : le double calé ; on attend la capture en cours.
                t0 = time.time()
                while slot.capture_state == "running" and time.time() - t0 < 600:
                    await asyncio.sleep(0.2)
                a = slot.aligned_range(start, dur, sr)
                head = {"action": "ARA_INSERT_RENDER", "req_id": req_id, "success": True, "nch": 2, "nframes": int(a.shape[1]),
                        "sample_rate": sr, "latency": 0, "capture": slot.capture_state}
                await self._send(ws, build_render_frame(head, a.T.reshape(-1)))
                return
            out = str(slot.dir / f"rendu_{int(time.time() * 1000)}.wav")
            t = time.time()
            res = await self.loop.run_in_executor(self.render_pool, lambda: slot.host.call(
                "render_range", out=out, start=start, duration=dur, sample_rate=sr, timeout=600 + 4 * dur))
            a, rsr = await self.loop.run_in_executor(self.misc_pool, stems_service.read_wav, out)
            try:
                os.remove(out)
            except OSError:
                pass
            logger.info(f"🎛️ {slot.name} : rendu de la piste ({dur:.1f} s) en {time.time() - t:.1f} s")
            head = {"action": "ARA_INSERT_RENDER", "req_id": req_id, "success": True, "nch": int(a.shape[0]),
                    "nframes": int(a.shape[1]), "sample_rate": rsr, "latency": res.get("latency"), "peak": res.get("peak")}
            await self._send(ws, build_render_frame(head, a.T.reshape(-1)))
        except Exception as e:
            logger.error(f"ARA_INSERT_RENDER : {e}")
            await self._send(ws, build_render_frame({"action": "ARA_INSERT_RENDER", "req_id": req_id, "success": False,
                                                     "error": str(e), "nch": 0, "nframes": 0}, None))

    for fn in (_a_load_plugin, _a_show_editor, _a_close_editor, _a_ara_insert_doc, _a_ara_insert_state, _a_ara_insert_editor,
               _a_ara_insert_select, _a_ara_insert_capture, _a_ara_insert_params, _a_ara_insert_param, _a_ara_insert_snapshot, _a_ara_insert_render):
        setattr(Server, fn.__name__, fn)
    Server._ara_insert_source = _ara_insert_source
    Server._ara_insert_render_frame = _ara_insert_render
