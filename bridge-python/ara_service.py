#!/usr/bin/env python3
"""
Actions ARA du pont (Melodyne, VocAlign) : ajoutées à NovaBridgeServer par install().

  ARA_STATUS                    → host (NovaARAHost.exe trouvé ?), plugins {melodyne, vocalign}
  ARA_OPEN   (trame type 2)     Ouvrir dans Melodyne : {req_id, session_id, plugin, sample_rate, tempo,
                                  archive_b64?, offscreen?, clips:[{id, name, track, role, start,
                                  persistent_id, nch, nframes}]} + audio float32 entrelacé des clips
                                  à la suite. → {success, session_id, restored, notes, analysis_seconds}
  ARA_ALIGN  (trame type 2)     Aligner avec VocAlign : {req_id, session_id, sample_rate, interactive,
                                  guide:{…, nch, nframes}, dubs:[{…}]} + audio (guide puis doubles).
                                  interactive=false : rendu direct (« en un clic »), réponses comme
                                  ARA_COMMIT. interactive=true : fenêtre ouverte, attendre ARA_COMMIT.
  ARA_COMMIT session_id         « Valider » : rendu de chaque clip (trame ARA_RENDERED par clip, audio
                                  float32) puis {action: ARA_COMMIT, success, archive_b64?}
  ARA_SHOW   session_id         remet la fenêtre du plugin au premier plan
  ARA_TRANSPORT session_id playing? position? tempo?
  ARA_CLOSE  session_id         ferme la session (et la fenêtre)
  Évènements : ARA_EVENT {session_id, event, …} (editor_closed, transport_request, playback…)
"""

import asyncio
import logging
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

import ara_host
import stems_service

logger = logging.getLogger("NovaBridge.ARA")

# VocAlign 6 (mode capture) : bouton « Capture » du Dub, en fractions de la fenêtre du plugin.
VOCALIGN_DUB_CAPTURE = [69 / 900, 180 / 350]
SESSION_IDLE_S = 3 * 3600


class AraSession:
    def __init__(self, sid: str, kind: str, owner):
        self.sid = sid
        self.kind = kind            # "melodyne" | "vocalign"
        self.owner = owner
        self.hosts: Dict[str, ara_host.AraHostProcess] = {}   # clip id → hôte (VocAlign : un par double)
        self.clips: List[dict] = []
        self.dir = Path(tempfile.mkdtemp(prefix=f"nova-ara-{kind}-"))
        self.lock = threading.Lock()
        self.touched = time.time()

    def close(self):
        for h in list(self.hosts.values()):
            try:
                h.close()
            except Exception:
                pass
        self.hosts.clear()
        shutil.rmtree(self.dir, ignore_errors=True)


def _split_audio(meta_clips: List[dict], data: np.ndarray):
    """Audio entrelacé des clips à la suite → [(nch, n) float32]."""
    out, off = [], 0
    for c in meta_clips:
        nch = max(1, min(2, int(c.get("nch") or 1)))
        n = int(c.get("nframes") or 0)
        seg = data[off: off + n * nch]
        if seg.size < n * nch:
            raise ValueError(f"Audio incomplet pour le clip {c.get('name') or c.get('id')}")
        out.append(seg.reshape(n, nch).T.copy())
        off += n * nch
    return out


def install(Server, build_render_frame):
    """Ajoute les actions ARA à la classe du serveur."""

    def _sessions(self) -> Dict[str, AraSession]:
        if not hasattr(self, "_ara_sessions"):
            self._ara_sessions = {}
        return self._ara_sessions

    def _ara_plugins(self) -> Dict[str, Dict[str, Any]]:
        return ara_host.find_ara_plugins(self.plugins or [])

    def _ara_event(self, sess: AraSession, ev: dict):
        if ev.get("event") in ("analysis_progress", "content_changed", "log", "ready"):
            return
        msg = {"action": "ARA_EVENT", "session_id": sess.sid, **ev}
        self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._send(sess.owner, msg)))

    async def _a_ara_status(self, ws, req):
        if self.scan_done is not None:
            try:
                await asyncio.wait_for(self.scan_done.wait(), 30)
            except asyncio.TimeoutError:
                pass
        exe = ara_host.find_host_exe()
        self._reply(ws, req, {"success": True, "host": bool(exe), "plugins": self._ara_plugins(),
                              "sessions": len(self._sessions())})

    async def _ara_run(self, fn, *args):
        return await self.loop.run_in_executor(self.misc_pool, fn, *args)

    def _new_host(self, sess: AraSession):
        return ara_host.AraHostProcess(on_event=lambda e: self._ara_event(sess, e))

    async def _ara_open(self, ws, meta: dict, data):
        req_id = meta.get("req_id")
        sid = str(meta.get("session_id") or req_id)
        kind = str(meta.get("plugin") or "melodyne")
        sess = None
        try:
            plug = self._ara_plugins().get(kind)
            if not plug:
                raise ara_host.AraHostError(f"{ara_host.KNOWN.get(kind, {}).get('label', kind)} n'est pas installé sur ce PC")
            sr = int(meta.get("sample_rate") or 44100)
            clips = meta.get("clips") or []
            audio = _split_audio(clips, data)
            old = self._sessions().pop(sid, None)
            if old:
                await self._ara_run(old.close)
            sess = AraSession(sid, kind, ws)
            self._sessions()[sid] = sess
            spec = []
            for c, a in zip(clips, audio):
                p = sess.dir / f"{len(spec)}.wav"
                stems_service.write_wav_float(p, a, sr)
                spec.append({"id": str(c["id"]), "path": str(p), "name": c.get("name") or "Clip",
                             "track": c.get("track") or c.get("name") or "Piste", "role": c.get("role") or "edit",
                             "start": float(c.get("start") or 0), "persistent_id": str(c.get("persistent_id") or c["id"])})
            sess.clips = spec

            def work():
                h = self._new_host(sess)
                sess.hosts["*"] = h
                info = h.call("load", plugin=plug["path"], sample_rate=sr, timeout=180)
                st = h.call("setup", clips=spec, tempo=float(meta.get("tempo") or 120),
                            archive_b64=meta.get("archive_b64") or "", timeout=120)
                an = h.call("analyze", timeout_s=float(meta.get("analysis_timeout_s") or 180), timeout=240)
                if meta.get("show_editor", True):
                    h.call("show_editor", offscreen=bool(meta.get("offscreen")),
                           title=f"{plug['label']} — {spec[0]['name']} (Nova Studio)")
                return info, st, an

            t = time.time()
            info, st, an = await self._ara_run(work)
            notes = {c["id"]: {**ara_host.notes_summary(c["notes"]), "notes": c["notes"][:400]} for c in an.get("clips", [])}
            logger.info(f"🎛️ {plug['label']} (ARA) : {len(spec)} clip(s) analysé(s) en {time.time() - t:.1f} s"
                        + (" — retouches restaurées" if st.get("restored") else ""))
            self._reply(ws, {"action": "ARA_OPEN", "req_id": req_id},
                        {"success": True, "session_id": sid, "plugin": kind, "plugin_name": info.get("name"),
                         "plugin_version": info.get("version"), "restored": bool(st.get("restored")),
                         "analysis_seconds": an.get("analysis_seconds"), "notes": notes})
        except Exception as e:
            logger.error(f"ARA_OPEN : {e}")
            if sess is not None:
                self._sessions().pop(sid, None)
                await self._ara_run(sess.close)
            self._reply(ws, {"action": "ARA_OPEN", "req_id": req_id}, {"success": False, "error": str(e)})

    async def _ara_align(self, ws, meta: dict, data):
        req_id = meta.get("req_id")
        sid = str(meta.get("session_id") or req_id)
        sess = None
        try:
            plug = self._ara_plugins().get("vocalign")
            if not plug:
                raise ara_host.AraHostError("VocAlign n'est pas installé sur ce PC")
            sr = int(meta.get("sample_rate") or 44100)
            guide = meta.get("guide") or {}
            dubs = meta.get("dubs") or []
            if not dubs:
                raise ValueError("Aucun clip à aligner")
            audio = _split_audio([guide] + dubs, data)
            old = self._sessions().pop(sid, None)
            if old:
                await self._ara_run(old.close)
            sess = AraSession(sid, "vocalign", ws)
            self._sessions()[sid] = sess
            gpath = sess.dir / "guide.wav"
            stems_service.write_wav_float(gpath, audio[0], sr)
            interactive = bool(meta.get("interactive"))
            spec = []
            for i, (d, a) in enumerate(zip(dubs, audio[1:])):
                p = sess.dir / f"dub{i}.wav"
                stems_service.write_wav_float(p, a, sr)
                spec.append({"id": str(d["id"]), "path": str(p), "name": d.get("name") or f"Double {i + 1}",
                             "out": str(sess.dir / f"dub{i}_aligne.wav"), "dur": a.shape[1] / sr})
            sess.clips = spec

            def work():
                results = []
                for i, c in enumerate(spec):
                    h = self._new_host(sess)
                    sess.hosts[c["id"]] = h
                    h.call("load", plugin=plug["path"], sample_rate=sr, ara=False, timeout=180)
                    # Fenêtre visible en mode interactif (la première), sinon hors écran et sans activation.
                    show_here = interactive and i == 0
                    h.call("show_editor", offscreen=not show_here,
                           title=f"VocAlign — {c['name']} sur le guide (Nova Studio)")
                    time.sleep(0.5)
                    r = h.call("capture_align", dub=c["path"], guide=str(gpath), out=c["out"],
                               passes=1 if interactive else 2, wait_s=4, realtime=True, keep=interactive,
                               clicks=[{"click": VOCALIGN_DUB_CAPTURE}], target_index=1,
                               timeout=120 + 3 * len(audio[0][0]) / sr)
                    results.append(r)
                    if not interactive:
                        h.close()
                        sess.hosts.pop(c["id"], None)
                return results

            t = time.time()
            results = await self._ara_run(work)
            logger.info(f"🎙️ VocAlign : {len(spec)} double(s) {'capturé(s)' if interactive else 'aligné(s)'} en {time.time() - t:.1f} s")
            if interactive:
                self._reply(ws, {"action": "ARA_ALIGN", "req_id": req_id},
                            {"success": True, "session_id": sid, "waiting": True, "sidechain": results[0].get("sidechain")})
                return
            await self._ara_send_renders(ws, req_id, "ARA_ALIGN", sess, [(c["id"], c["out"]) for c in spec])
            self._sessions().pop(sid, None)
            await self._ara_run(sess.close)
        except Exception as e:
            logger.error(f"ARA_ALIGN : {e}")
            if sess is not None:
                self._sessions().pop(sid, None)
                await self._ara_run(sess.close)
            await self._send(ws, build_render_frame({"action": "ARA_ALIGN", "req_id": req_id, "success": False,
                                                     "error": str(e), "nch": 0, "nframes": 0}, None))

    async def _ara_send_renders(self, ws, req_id, action, sess: AraSession, files, extra=None):
        for i, (cid, path) in enumerate(files):
            a, sr = await self._ara_run(stems_service.read_wav, path)
            head = {"action": "ARA_RENDERED", "req_id": req_id, "session_id": sess.sid, "clip_id": cid,
                    "index": i, "count": len(files), "nch": int(a.shape[0]), "nframes": int(a.shape[1]), "sample_rate": sr}
            await self._send(ws, build_render_frame(head, a.T.reshape(-1)))
        await self._send(ws, build_render_frame({"action": action, "req_id": req_id, "session_id": sess.sid,
                                                 "success": True, "nch": 0, "nframes": 0, "count": len(files),
                                                 **(extra or {})}, None))

    def _ara_session(self, req) -> AraSession:
        sess = self._sessions().get(str(req.get("session_id") or ""))
        if sess is None:
            raise ara_host.AraHostError("Session fermée : rouvre le clip")
        sess.touched = time.time()
        return sess

    async def _a_ara_commit(self, ws, req):
        req_id = req.get("req_id")
        try:
            sess = self._ara_session(req)

            def work():
                if sess.kind == "vocalign":
                    files = []
                    for c in sess.clips:
                        h = sess.hosts.get(c["id"])
                        if h is None:
                            continue
                        h.call("capture_output", out=c["out"], realtime=True, keep=False, timeout=120 + 2 * c["dur"])
                        files.append((c["id"], c["out"]))
                    return files, None
                h = sess.hosts["*"]
                out = h.call("render", out_dir=str(sess.dir / "rendu"), timeout=600)
                arc = h.call("archive", timeout=120)
                return [(r["id"], r["path"]) for r in out["rendered"]], arc

            files, arc = await self._ara_run(work)
            extra = {"archive_b64": arc["archive_b64"], "archive_size": arc["size"]} if arc else {}
            await self._ara_send_renders(ws, req_id, "ARA_COMMIT", sess, files, extra)
            if req.get("close", True):
                self._sessions().pop(sess.sid, None)
                await self._ara_run(sess.close)
        except Exception as e:
            logger.error(f"ARA_COMMIT : {e}")
            await self._send(ws, build_render_frame({"action": "ARA_COMMIT", "req_id": req_id, "success": False,
                                                     "error": str(e), "nch": 0, "nframes": 0}, None))

    async def _a_ara_show(self, ws, req):
        sess = self._ara_session(req)
        h = next(iter(sess.hosts.values()), None)
        if h is None:
            raise ara_host.AraHostError("Session sans fenêtre")
        await self._ara_run(lambda: h.call("show_editor", offscreen=False))
        self._reply(ws, req, {"success": True})

    async def _a_ara_transport(self, ws, req):
        sess = self._ara_session(req)
        h = next(iter(sess.hosts.values()), None)
        kw = {k: req[k] for k in ("playing", "position", "tempo") if k in req}
        res = await self._ara_run(lambda: h.call("transport", **kw)) if h else {}
        self._reply(ws, req, {"success": True, **{k: res.get(k) for k in ("playing", "position", "audio_device")}})

    async def _a_ara_close(self, ws, req):
        sess = self._sessions().pop(str(req.get("session_id") or ""), None)
        if sess is not None:
            await self._ara_run(sess.close)
        self._reply(ws, req, {"success": True})

    def ara_reap(self):
        """Sessions abandonnées (onglet fermé sans valider) : fermées après SESSION_IDLE_S."""
        now = time.time()
        for sid, s in list(self._sessions().items()):
            if now - s.touched > SESSION_IDLE_S or not any(h.alive() for h in s.hosts.values()) and s.hosts:
                self._sessions().pop(sid, None)
                threading.Thread(target=s.close, daemon=True).start()

    for fn in (_sessions, _ara_plugins, _ara_event, _a_ara_status, _ara_run, _new_host, _ara_open, _ara_align,
               _ara_send_renders, _ara_session, _a_ara_commit, _a_ara_show, _a_ara_transport, _a_ara_close, ara_reap):
        setattr(Server, fn.__name__, fn)
