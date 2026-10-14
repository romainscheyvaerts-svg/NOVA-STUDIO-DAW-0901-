"""Lot 2b · La caméra pendant la prise, puis la vidéo de la performance (100 % hors production).

Chrome headless, aucune fenêtre, Supabase simulé (qa_hors_prod). FAUSSE caméra seulement :
  --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<y4m>
La vidéo de test (fabriquée ici) : 640 × 360 à 30 i/s, en boucle de 2 s, un FLASH blanc d'une
image toutes les secondes (images 15 et 45), un code-barres du n° d'image et une barre qui défile.
Le micro est simulé dans le contexte du moteur (getUserMedia → MediaStreamDestination, comme
qa/prise_horloge.py) : un CLIC y est joué au même instant que chaque flash.

« Même instant » : l'instant de capture du flash donné par le navigateur lui-même
(requestVideoFrameCallback · captureTime, sur un lecteur à part, indépendant du code NOVA),
converti sur l'horloge du son par getOutputTimestamp ; le clic est programmé à cet instant.

Ce que le scénario prouve :
  A. Bureau 1600 × 900 (sombre) : palette Ctrl+K « filmer » → panneau ; autorisation expliquée ;
     caméra allumée (fausse), format 9:16 ; voyant REC pendant la prise ; prise 1 avec 6 flashs
     + clics → vidéo rangée avec la prise ; « Mesurer avec un clap » → décalage mesuré (c'est le
     retard propre du micro simulé) ; prise 2 → export MP4 (mix + image) mesuré par ffprobe /
     ffmpeg : écart image ↔ son de chaque flash ≤ 33 ms (une image). Sans compensation (prise 1)
     l'écart est mesuré aussi. Export avec les paroles (karaoké). Droits : limité (30 s) sans
     export payé. Couper la caméra en un geste.
  B. Prise audio identique avec ou sans caméra : mêmes clics au même échantillon (0 d'écart).
  C. Stockage plein simulé (navigator.storage.estimate) : message actionnable, prise audio sans vidéo.
  D. Téléphone 390 × 844 (clair, au doigt) : pastille « 🎥 Filmer la prise » quand la piste est
     armée, panneau, caméra avant / arrière, 16:9, prise, export ; pas de défilement horizontal.
  E. Le panneau dit que la vidéo n'est pas envoyée en collaboration ni dans le cloud.
  G. Prise de 3 minutes filmée : aucune image sautée, pire intervalle, Mo par minute, image décodée.

  NOVA_URL=http://127.0.0.1:3460/ python qa/video_prise.py [bureau] [identique] [plein] [telephone]
Sorties : QA_OUT (par défaut D:\\1 WORK\\CONTENU\\nova-bandlab\\lot2b_camera\\qa)
"""
import io, json, os, re, subprocess, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3460/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot2b_camera\qa")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402
from qalib import new_page, Log, save_log, OUT, BASE  # noqa: E402
from gel_pre_effet import open_project_file  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
SR = 48000
CAM_W, CAM_H, CAM_FPS, LOOP = 640, 360, 30, 60
FLASH_FRAMES = (15, 45)          # un flash par seconde
TOL_MS = 1000.0 / 30             # une image
SONG = 40.0
RES = {"scenario": "video_prise", "base": BASE, "runs": {}, "echecs": []}


def ko(msg):
    RES["echecs"].append(msg)
    print("KO " + msg, flush=True)


def ok(msg):
    print("OK " + msg, flush=True)


# ─── Fichiers de test ───────────────────────────────────────────────────────

def make_y4m(path):
    """Fausse caméra : fond en dégradé, un « visage » qui bouge et « chante », le n° d'image, un code-barres ;
    flash blanc plein cadre aux images 15 et 45 (une fois par seconde)."""
    from PIL import Image, ImageDraw, ImageFont
    try:
        big = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 44)
        small = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 18)
    except Exception:
        big = small = ImageFont.load_default()
    grad = np.tile(np.linspace(30, 80, CAM_H, dtype=np.float32)[:, None], (1, CAM_W)).astype(np.uint8)
    with open(path, "wb") as f:
        f.write(f"YUV4MPEG2 W{CAM_W} H{CAM_H} F{CAM_FPS}:1 Ip A1:1 C420jpeg\n".encode())
        for i in range(LOOP):
            if i in FLASH_FRAMES:
                im = Image.new("L", (CAM_W, CAM_H), 235)
                ImageDraw.Draw(im).text((CAM_W // 2, CAM_H // 2), "FLASH", fill=60, font=big, anchor="mm")
            else:
                im = Image.fromarray(grad, "L")
                d = ImageDraw.Draw(im)
                cx, cy = CAM_W // 2 + int(50 * np.sin(2 * np.pi * i / LOOP)), 150
                d.ellipse((cx - 55, cy - 70, cx + 55, cy + 70), fill=150)
                d.ellipse((cx - 25, cy - 20, cx - 12, cy - 7), fill=40)
                d.ellipse((cx + 12, cy - 20, cx + 25, cy - 7), fill=40)
                mo = 6 + int(14 * abs(np.sin(2 * np.pi * i / 15)))
                d.ellipse((cx - 18, cy + 22, cx + 18, cy + 22 + mo), fill=50)
                d.rectangle((CAM_W // 2 - 8, 250, CAM_W // 2 + 8, 300), fill=110)
                d.text((CAM_W // 2, 325), f"image {i:02d}", fill=200, font=small, anchor="mm")
                for b in range(6):
                    x0 = CAM_W // 2 - 90 + b * 30
                    d.rectangle((x0, 12, x0 + 24, 30), fill=200 if (i >> b) & 1 else 70)
            y = np.asarray(im, np.uint8)
            u = np.full((CAM_H // 2, CAM_W // 2), 128, np.uint8)
            f.write(b"FRAME\n"); f.write(y.tobytes()); f.write(u.tobytes()); f.write(u.tobytes())


def wav_bytes(mono):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project(path):
    tb = np.arange(int(SONG * SR)) / SR
    beat = (0.02 * np.sin(2 * np.pi * 110 * tb) + 0.012 * np.sin(2 * np.pi * 164.8 * tb)).astype(np.float32)
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    beat_clip = {"id": "beat", "name": "Beat", "type": "AUDIO", "audioRef": "audio/beat.wav", "color": "#22d3ee", "fadeIn": 0, "fadeOut": 0,
                 "gain": 1.0, "start": 0.0, "offset": 0.0, "duration": SONG}
    tracks = [
        {**base, "id": "instrumental", "name": "Beat", "type": "AUDIO", "color": "#22d3ee", "clips": [beat_clip]},
        {**base, "id": "lead", "name": "Lead", "type": "AUDIO", "color": "#f472b6", "clips": []},
    ]
    state = {
        "id": "proj-video-prise", "name": "Prise filmée", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "lead", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "lyrics": "Je fais du son la nuit\nLes lumières de la ville\nBrillent sur mon micro\nTout le monde dort encore\nMoi je reste éveillé\nJusqu'au lever du jour",
        "lyricsStart": 0.5, "lyricsSpeed": 1,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/beat.wav", wav_bytes(beat))


# ─── Navigateur ─────────────────────────────────────────────────────────────

def launch(p, y4m):
    return p.chromium.launch(headless=True, executable_path=qalib.CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-video-capture={y4m}",
        "--autoplay-policy=no-user-gesture-required",
    ])


# Micro simulé dans le contexte du moteur (la caméra, elle, reste la fausse caméra de Chrome).
MIC_INIT = r"""(() => {
  window.__qaMicLatency = 0.21;
  try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_qa_video_debug', '1');
        localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}
  const md = navigator.mediaDevices; if (!md) return;
  const orig = md.getUserMedia.bind(md);
  window.__qaGum = [];
  window.__qaEnsureMic = async () => {
    const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
    if (!E.ctx) await E.init();
    const ctx = E.ctx;
    if (!window.__qaMic || window.__qaMic.ctx !== ctx) {
      const voice = ctx.createGain(), dest = ctx.createMediaStreamDestination(); voice.connect(dest);
      const room = ctx.createConstantSource(); room.offset.value = 0.0005; room.connect(voice); room.start();
      window.__qaMic = { ctx, voice, dest, clicks: [] };
    }
    return window.__qaMic;
  };
  md.getUserMedia = async (c) => {
    window.__qaGum.push(JSON.stringify(c || {}));
    if (c && c.video) { if (c.audio) throw new Error('QA : la caméra ne doit jamais demander le son'); return orig(c); }
    await window.__qaEnsureMic();
    // Micro qui annonce sa latence d'entrée (comme un vrai pilote) : 200 ms de plus que le transport du flux.
    return new MediaStream(window.__qaMic.dest.stream.getAudioTracks().map(t => { const c2 = t.clone(); const gs = c2.getSettings.bind(c2);
      c2.getSettings = () => ({ ...gs(), latency: window.__qaMicLatency ?? 0.01 }); return c2; }));
  };
})();"""

# Témoin indépendant : un lecteur à part sur la caméra, captureTime de chaque image (navigateur).
WATCH = r"""async () => {
  const V = window.__novaVideoTake; if (!V || !V.stream) return { erreur: 'caméra éteinte' };
  if (window.__qaWatch) return { deja: true };
  const v = document.createElement('video'); v.muted = true; v.playsInline = true;
  v.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:36px;opacity:0.01;pointer-events:none;z-index:-1';
  v.srcObject = new MediaStream([V.stream.getVideoTracks()[0].clone()]); document.body.appendChild(v); await v.play();
  const c = document.createElement('canvas'); c.width = 16; c.height = 9; const g = c.getContext('2d', { willReadFrequently: true });
  const W = window.__qaWatch = { frames: [], flashes: [], arm: 0, scheduled: [] };
  await window.__qaEnsureMic();
  const cb = (now, md) => {
    const M = window.__qaMic, ctx = M.ctx;
    g.drawImage(v, 0, 0, 16, 9); const d = g.getImageData(0, 0, 16, 9).data; let L = 0; for (let i = 0; i < d.length; i += 4) L += d[i]; L /= 144;
    const cap = md.captureTime || md.presentationTime || now;
    const prev = W.frames[W.frames.length - 1];
    W.frames.push({ cap, L }); if (W.frames.length > 4000) W.frames.splice(0, 2000);
    if (L > 180 && (!prev || prev.L < 180)) {
      W.flashes.push(cap);
      if (W.arm > 0) {
        // Le clic « arrive au micro » à l'instant de capture du flash : le micro simulé a une latence
        // d'entrée annoncée de MIC_LAT (getSettings().latency), le son paraît donc MIC_LAT plus tard.
        W.arm--;
        const ts = ctx.getOutputTimestamp(); const lead = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
        const c = ts.contextTime + (cap - ts.performanceTime) / 1000 + lead + window.__qaMicLatency - 0.01;
        const b = ctx.createBuffer(1, 48, ctx.sampleRate); const x = b.getChannelData(0); for (let q = 0; q < 48; q++) x[q] = 0.7 * (q % 2 ? 1 : -1) * Math.exp(-q / 16);
        const s = ctx.createBufferSource(); s.buffer = b; s.connect(M.voice); s.start(c);
        W.scheduled.push({ P: cap, c, avance_ms: +((c - ctx.currentTime) * 1000).toFixed(1) });
      }
    }
    v.requestVideoFrameCallback(cb);
  };
  v.requestVideoFrameCallback(cb);
  return { ok: true };
}"""

def ffprobe_frames(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time,best_effort_timestamp_time", "-of", "json", str(path)],
                       capture_output=True, text=True, creationflags=NOWIN)
    fr = json.loads(r.stdout or "{}").get("frames", [])
    return [float(f.get("pts_time") or f.get("best_effort_timestamp_time") or 0) for f in fr]


def ffprobe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True, creationflags=NOWIN)
    return json.loads(r.stdout or "{}")


def video_luma(path, w, h):
    """Luminosité moyenne du HAUT de chaque image (au-dessus de la bande des paroles), images 1:1."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"scale={w}:{h},format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
                       capture_output=True, creationflags=NOWIN)
    a = np.frombuffer(r.stdout, np.uint8).reshape(-1, h, w)
    return a[:, : h // 2, :].reshape(a.shape[0], -1).mean(axis=1)


def audio_samples(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True, creationflags=NOWIN)
    return np.frombuffer(r.stdout, np.float32)


def onsets(x, rel=0.3, gap=0.3):
    peak = float(np.abs(x).max() or 1)
    loud = np.abs(x) > rel * peak
    out, last = [], -1e9
    idx = np.nonzero(loud[1:] & ~loud[:-1])[0] + 1
    for i in idx:
        if i - last >= gap * SR:
            out.append(i / SR); last = i
    return out


def measure_mp4(path, label, expect=None):
    """Chaque flash à l'image contre l'attaque du clic dans le son du MP4 (ffprobe / ffmpeg)."""
    info = ffprobe(path)
    vs = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    au = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    out = {"fichier": str(path), "taille_mo": round(path.stat().st_size / 1e6, 2)}
    if not vs or not au:
        ko(f"{label} : pistes {len(vs)} vidéo / {len(au)} audio"); return out
    v, a = vs[0], au[0]
    out.update({"video": v.get("codec_name"), "largeur": v.get("width"), "hauteur": v.get("height"), "duree_video": float(v.get("duration") or 0),
                "debut_video": float(v.get("start_time") or 0), "audio": a.get("codec_name"), "duree_audio": float(a.get("duration") or 0),
                "debut_audio": float(a.get("start_time") or 0), "images_par_s_moy": v.get("avg_frame_rate")})
    if v.get("codec_name") != "h264" or a.get("codec_name") != "aac": ko(f"{label} : codecs {v.get('codec_name')} + {a.get('codec_name')} (h264 + aac attendus)")
    if expect and (v.get("width"), v.get("height")) != expect: ko(f"{label} : {v.get('width')}×{v.get('height')} ({expect} attendu)")
    pts = ffprobe_frames(path)
    W, H = (36, 64) if (v.get("height") or 0) > (v.get("width") or 0) else (64, 36)
    L = video_luma(path, W, H)
    n = min(len(pts), len(L))
    out["images"] = n
    flashes = [pts[i] for i in range(1, n) if L[i] > 180 and L[i - 1] <= 180]
    x = audio_samples(path)
    on = onsets(x)
    out["flashs_s"] = [round(f, 4) for f in flashes]
    out["clics_s"] = [round(o, 4) for o in on]
    pairs = []
    for o in on:
        near = [f for f in flashes if abs(f - o) < 0.4]
        if near:
            f = min(near, key=lambda q: abs(q - o))
            pairs.append({"clic_s": round(o, 4), "flash_s": round(f, 4), "ecart_ms": round((f - o) * 1000, 1)})
    out["paires"] = pairs
    if pairs:
        e = [p["ecart_ms"] for p in pairs]
        out["ecart_moyen_ms"] = round(float(np.mean(e)), 1)
        out["pire_ecart_ms"] = round(float(max(abs(q) for q in e)), 1)
    return out


# ─── Gestes ─────────────────────────────────────────────────────────────────

def dismiss(page, ms=2000):
    t0 = time.time()
    while (time.time() - t0) * 1000 < ms:
        b = page.get_by_role("button", name=re.compile(r"^(Plus tard|C'est parti)$")).locator("visible=true")
        if b.count():
            try: b.first.click(timeout=2000)
            except Exception: pass
        page.wait_for_timeout(300)


def tap(page, testid, touch=False):
    loc = page.get_by_test_id(testid).locator("visible=true").first
    loc.scroll_into_view_if_needed()
    if touch: loc.tap()
    else: loc.click()
    page.wait_for_timeout(250)


def cam_state(page):
    return page.evaluate("() => { const s = window.__novaVideoTake?.state; return s ? { status: s.status, recording: s.recording, frames: s.frames, bytes: s.bytes, codec: s.codec, label: s.label, size: s.size, format: s.format, storage: s.storage, notice: s.notice, last: s.last, offsetMs: s.offsetMs } : null; }")


def wait_state(page, pred, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = cam_state(page)
        if s and pred(s): return s
        page.wait_for_timeout(200)
    return cam_state(page)


def open_panel_palette(page):
    page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=6000)
    page.keyboard.type("filmer la prise"); page.wait_for_timeout(400)
    first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
    page.keyboard.press("Enter")
    page.get_by_test_id("video-take-panel").wait_for(timeout=10000)
    return first


def record_take(page, n_clicks, label, rec_key="r", touch=False, extra_wait=0.8):
    """Prise filmée : REC, clics aux flashs, arrêt. Rend (prévisions, flashs réels vus, id de la vidéo)."""
    page.evaluate("() => { window.__qaSaved = null; window.addEventListener('nova:video-take-saved', e => { window.__qaSaved = e.detail; }, { once: true }); }")
    page.wait_for_timeout(2600)  # flashs vus avant la prise (période et phase)
    page.evaluate("() => { try { document.activeElement && document.activeElement.blur(); } catch (e) {} }")
    if touch: page.locator("button[aria-label='Enregistrer']").locator("visible=true").first.tap()
    else: page.keyboard.press(rec_key)
    s = wait_state(page, lambda s: s["recording"], 10)
    if not s or not s["recording"]:
        raise RuntimeError(f"{label} : la vidéo n'a pas démarré avec REC ({s})")
    page.wait_for_timeout(500)
    page.evaluate("(n) => { window.__qaWatch.scheduled = []; window.__qaWatch.arm = n; }", n_clicks)
    t0 = time.time()
    while time.time() - t0 < n_clicks * 1.2 + 4 and page.evaluate("() => window.__qaWatch.arm") > 0:
        page.wait_for_timeout(200)
    page.wait_for_timeout(int(extra_wait * 1000 + 400))
    sch = {"prevus": page.evaluate("() => window.__qaWatch.scheduled.slice()")}
    if len(sch["prevus"]) < n_clicks: raise RuntimeError(f"{label} : {len(sch['prevus'])} clics programmés sur {n_clicks}")
    shot = OUT / f"{label}_rec.png"
    page.screenshot(path=str(shot))
    if touch: page.locator("button[aria-label=\"Arrêter l'enregistrement\"]").locator("visible=true").first.tap()
    else: page.keyboard.press(rec_key)
    t0 = time.time()
    saved = None
    while time.time() - t0 < 20:
        saved = page.evaluate("() => window.__qaSaved")
        if saved: break
        page.wait_for_timeout(250)
    if not saved: raise RuntimeError(f"{label} : vidéo non rangée après la prise ({cam_state(page)})")
    flashes = page.evaluate("() => window.__qaWatch.flashes.slice()")
    return sch, flashes, saved["id"], str(shot)


def take_meta(page, tid):
    return page.evaluate("""async (id) => { const S = await window.__novaAppModule('/utils/videoTakeStore.ts'); const m = await S.getMeta(id);
      if (!m) return null; const { chunkTs, luma, motion, clock, ...rest } = m; return { ...rest, nTimes: (m.times || []).length, times: (m.times || []).slice(0, 4),
        span: m.times && m.times.length ? [Math.min(...m.times), Math.max(...m.times)] : null, clockPairs: clock.length, keyframes: m.keyframes.length,
        flashTimes: (m.times || []).filter((t, i) => (luma[i] || 0) > 180 && ((luma[i - 1] || 0) <= 180)) }; }""", tid)


def export_video(page, label, touch=False, timeout_s=400):
    got = []
    page.on("download", lambda d: got.append(d))
    t0 = time.time()
    tap(page, "video-export-run", touch)
    page.get_by_test_id("video-export-done").or_(page.get_by_test_id("video-export-error")).wait_for(timeout=timeout_s * 1000)
    if page.get_by_test_id("video-export-error").count():
        raise RuntimeError("erreur : " + page.get_by_test_id("video-export-error").inner_text())
    meta = page.evaluate("() => { const m = window.__novaPerfTest || {}; return { name: m.name, range: m.range, frames: m.frames, filmed: m.filmed, offsetMs: m.offsetMs, totalMs: m.totalMs, full: m.rights && m.rights.full, size: m.blob && m.blob.size }; }")
    meta["secondes_mur"] = round(time.time() - t0, 1)
    dest = OUT / f"{label}.mp4"
    for _ in range(20):
        if got: break
        page.wait_for_timeout(250)
    if got:
        got[0].save_as(str(dest)); meta["recupere"] = "téléchargement"
    else:
        import base64
        b64 = page.evaluate("""async () => { const b = window.__novaPerfTest.blob; const buf = new Uint8Array(await b.arrayBuffer()); let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); }""")
        dest.write_bytes(base64.b64decode(b64)); meta["recupere"] = "fichier lu dans la page"
    meta["fichier"] = str(dest)
    return dest, meta


def open_export(page, tid):
    page.locator(f"[data-testid=video-take-item][data-id='{tid}'] [data-testid=video-take-export]").first.click()
    page.get_by_test_id("video-export").wait_for(timeout=8000)
    t0 = time.time()
    while time.time() - t0 < 15 and "Vérification" in page.get_by_test_id("video-rights").inner_text():
        page.wait_for_timeout(300)
    page.wait_for_timeout(500)


def frame_png(path, t, dest):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1", str(dest)], capture_output=True, creationflags=NOWIN)
    return str(dest)


def frame_png_at_pts(path, pts, dest):
    """Image EXACTE dont l'instant est >= pts (fréquence variable : choix par instant)."""
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-vf", f"select='gte(t,{pts - 0.0005:.4f})'", "-fps_mode", "passthrough", "-frames:v", "1", str(dest)],
                   capture_output=True, creationflags=NOWIN)
    return str(dest)


def no_hscroll(page):
    return page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")


def setup_page(b, vp, label, theme="dark", extra_init=None):
    os.environ["QA_THEME"] = theme
    log = Log(label)
    ctx, page = new_page(b, vp, log)
    ctx.grant_permissions(["camera", "microphone"])
    ctx.add_init_script(MIC_INIT)
    if extra_init: ctx.add_init_script(extra_init)
    return log, ctx, page


# ─── Scénarios ──────────────────────────────────────────────────────────────

def run_bureau(p, zpath, y4m):
    r = {"captures": []}
    b = launch(p, y4m)
    log, ctx, page = setup_page(b, "pc", "video_bureau", "dark")
    try:
        open_project_file(page, zpath, r, "A0_projet")
        dismiss(page)
        page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
        first = open_panel_palette(page)
        r["palette_premier"] = first
        if first != "pal.videoTake": ko(f"palette : 1re action {first} (pal.videoTake attendu)")
        else: ok("palette Ctrl+K « filmer la prise » → panneau caméra")
        page.get_by_test_id("video-take-intro").wait_for(timeout=5000)
        page.screenshot(path=str(OUT / "A1_panneau_autorisation.png")); r["captures"].append(str(OUT / "A1_panneau_autorisation.png"))
        intro = page.get_by_test_id("video-take-intro").inner_text()
        priv = page.get_by_test_id("video-take-privacy").inner_text()
        r["textes"] = {"autorisation": intro, "confidentialite": priv}
        if "caméra" not in intro or "micro" not in intro: ko(f"autorisation pas expliquée : {intro}")
        if "collaboration" not in priv or "cloud" not in priv: ko(f"collaboration / cloud pas dit : {priv}")
        else: ok(f"autorisation expliquée et « {priv.strip()} »")
        tap(page, "video-format-vertical")
        tap(page, "video-take-on")
        s = wait_state(page, lambda s: s["status"] == "on", 15)
        r["camera"] = s
        if s["status"] != "on": raise RuntimeError(f"caméra pas allumée : {s}")
        ok(f"caméra allumée : {s['label']} {s['size']} · codec {s['codec']}")
        gum = page.evaluate("() => window.__qaGum")
        r["getUserMedia"] = gum
        if any('"video"' in g and '"audio":true' in g for g in gum): ko("la caméra a demandé le son")
        page.evaluate(WATCH)
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / "A2_camera_allumee.png")); r["captures"].append(str(OUT / "A2_camera_allumee.png"))

        # Prise 1 : sans compensation (décalage de la caméra = 0).
        sch1, fl1, id1, shot1 = record_take(page, 6, "A3_prise1")
        r["captures"].append(shot1)
        r["prise1"] = {"prevus": sch1, "flashs_vus": fl1[-12:], "id": id1, "meta": take_meta(page, id1)}
        ok(f"prise 1 filmée et rangée : {r['prise1']['meta'].get('frames')} images, {r['prise1']['meta'].get('status')}")
        m1 = r["prise1"]["meta"]
        if m1.get("bufferIds") != m1.get("bufferIds") or not m1.get("bufferIds"): ko("prise 1 : vidéo sans lien vers la prise audio")

        # Export de la prise 1 SANS compensation : écart brut (retard propre du micro simulé).
        open_export(page, id1)
        page.screenshot(path=str(OUT / "A4_fenetre_export.png")); r["captures"].append(str(OUT / "A4_fenetre_export.png"))
        full = page.get_by_test_id("video-rights").get_attribute("data-full")
        r["droits"] = {"complet": full, "texte": page.get_by_test_id("video-rights").inner_text()}
        if full != "0": ko(f"droits : vidéo complète sans export payé ({r['droits']['texte']})")
        else: ok("droits : instru importée, export pas payé → limitée comme l'extrait (30 s sur la voix)")
        if page.get_by_test_id("video-lyrics-toggle").count(): page.get_by_test_id("video-lyrics-toggle").uncheck()
        dest1, ex1 = export_video(page, "A5_prise1_sans_compensation")
        r["export_prise1"] = ex1
        mm1 = measure_mp4(dest1, "prise 1 (sans compensation)", (720, 1280))
        r["mp4_prise1"] = mm1
        ok(f"prise 1, sans compensation : écart image − son {r['mp4_prise1'].get('ecart_moyen_ms')} ms en moyenne (pire {r['mp4_prise1'].get('pire_ecart_ms')} ms) sur {len(mm1.get('paires', []))} flashs")

        # Mesure du décalage par le clap (ici : les flashs et les clics de la prise 1).
        tap(page, "video-measure")
        page.get_by_test_id("video-measure-result").wait_for(timeout=15000)
        r["mesure_clap"] = page.get_by_test_id("video-measure-result").inner_text()
        r["decalage_camera_ms"] = cam_state(page)["offsetMs"]
        ok(f"clap : {r['mesure_clap']}")
        page.screenshot(path=str(OUT / "A6_mesure_clap.png")); r["captures"].append(str(OUT / "A6_mesure_clap.png"))
        page.keyboard.press("Escape"); page.wait_for_timeout(400)

        # Prise 2 : compensée → export, écart ≤ 1 image.
        sch2, fl2, id2, shot2 = record_take(page, 6, "A7_prise2")
        r["captures"].append(shot2)
        r["prise2"] = {"prevus": sch2, "id": id2, "meta": take_meta(page, id2)}
        open_export(page, id2)
        if page.get_by_test_id("video-lyrics-toggle").count(): page.get_by_test_id("video-lyrics-toggle").uncheck()
        dest2, ex2 = export_video(page, "A8_prise2_compensee")
        r["export_prise2"] = ex2
        mm2 = measure_mp4(dest2, "prise 2 (compensée)", (720, 1280))
        r["mp4_prise2"] = mm2
        pire = r["mp4_prise2"].get("pire_ecart_ms")
        if pire is None or len(mm2.get("paires", [])) < 5: ko(f"prise 2 : flashs / clics non retrouvés dans le MP4 ({mm2.get('flashs_s')} / {mm2.get('clics_s')})")
        elif pire > TOL_MS: ko(f"prise 2 : écart image − son jusqu'à {pire} ms (> 1 image)")
        else: ok(f"prise 2 compensée : {len(mm2['paires'])} flashs, écart moyen {r['mp4_prise2']['ecart_moyen_ms']} ms, pire {pire} ms (≤ 33 ms)")
        for t in (mm2.get("flashs_s") or [])[:1]:
            r["captures"].append(frame_png_at_pts(dest2, t - 0.034, OUT / "A8_image_avant_flash.png"))
            r["captures"].append(frame_png_at_pts(dest2, t, OUT / "A8_image_flash.png"))
            r["captures"].append(frame_png_at_pts(dest2, t + 0.3, OUT / "A8_image_apres_flash.png"))

        # Avec les paroles (karaoké) : mêmes mesures, images à regarder.
        page.get_by_test_id("video-lyrics-toggle").check()
        tap(page, "video-style-tiktok")
        page.wait_for_timeout(600)
        page.get_by_test_id("video-export-preview").screenshot(path=str(OUT / "A9_apercu_paroles.png")); r["captures"].append(str(OUT / "A9_apercu_paroles.png"))
        dest3, ex3 = export_video(page, "A10_prise2_paroles")
        r["export_paroles"] = ex3
        mm3 = measure_mp4(dest3, "prise 2 avec paroles", (720, 1280))
        r["mp4_paroles"] = mm3
        if (r["mp4_paroles"].get("pire_ecart_ms") or 99) > TOL_MS: ko(f"paroles : écart {r['mp4_paroles'].get('pire_ecart_ms')} ms")
        else: ok(f"export avec paroles : pire écart {r['mp4_paroles']['pire_ecart_ms']} ms")
        for nm, t in (("debut", 1.0), ("milieu", ex3["range"]["duration"] / 2), ("fin", ex3["range"]["duration"] - 0.5)):
            r["captures"].append(frame_png(dest3, t, OUT / f"A10_image_paroles_{nm}.png"))
        page.keyboard.press("Escape"); page.wait_for_timeout(400)

        # Couper la caméra en un geste.
        tap(page, "video-take-off")
        s = wait_state(page, lambda s: s["status"] == "off", 5)
        live = page.evaluate("() => (window.__novaVideoTake.stream ? window.__novaVideoTake.stream.getVideoTracks().filter(t => t.readyState === 'live').length : 0)")
        if s["status"] != "off" or live: ko(f"couper la caméra : {s['status']}, pistes vivantes {live}")
        else: ok("« Couper la caméra » : caméra éteinte en un geste")
        page.screenshot(path=str(OUT / "A11_camera_coupee.png")); r["captures"].append(str(OUT / "A11_camera_coupee.png"))
    except Exception as e:  # noqa
        ko(f"bureau : {type(e).__name__}: {str(e)[:400]}")
        try: page.screenshot(path=str(OUT / "A_ECHEC.png"))
        except Exception: pass
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors()][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["bureau"] = r


# Même prise (clics à des n° d'échantillon connus), sans puis avec la caméra : moteur seul (comme prise_horloge).
SAME_TAKE = r"""async (withCam) => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const { TrackType } = await window.__novaAppModule('/types.ts');
  const M = await window.__qaEnsureMic(); await E.resume();
  const ctx = E.ctx, sr = ctx.sampleRate;
  const V = window.__novaVideoTake;
  if (withCam && V.state.status !== 'on') { await V.open(); }
  if (!withCam && V.state.status === 'on') V.close();
  const tid = 'voix-identique';
  const track = { id: tid, name: tid, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [], plugins: [], clips: [], outputTrackId: 'master', isTrackArmed: true };
  E.updateTrack(track, [track]);
  const err = await E.armTrack(tid, { alone: true });
  if (err) return { erreur: err };
  await new Promise(r => setTimeout(r, 700));
  let saved = null; const onSaved = e => { saved = e.detail; }; window.addEventListener('nova:video-take-saved', onSaved);
  const ok = await E.startRecording(0, tid);
  if (!ok) return { erreur: 'startRecording a échoué' };
  const t0 = Math.ceil((ctx.currentTime + 0.4) * sr), step = Math.round(0.25 * sr), N = 16;
  const want = [];
  for (let i = 0; i < N; i++) {
    const f = t0 + i * step + (i % 3) * 37; want.push(f);
    const b = ctx.createBuffer(1, 32, sr); const x = b.getChannelData(0); for (let q = 0; q < 32; q++) x[q] = 0.6 * Math.cos(q / 3);
    const s = ctx.createBufferSource(); s.buffer = b; s.connect(M.voice); s.start(f / sr);
  }
  const at = s => new Promise(r => { const chk = () => (ctx.currentTime >= s ? r() : setTimeout(chk, 5)); chk(); });
  await at(want[N - 1] / sr + 0.6);
  const takes = await E.stopRecordingAll();
  E.disarmTrack(tid);
  for (let i = 0; i < 60 && withCam && !saved; i++) await new Promise(r => setTimeout(r, 200));
  window.removeEventListener('nova:video-take-saved', onSaved);
  const x = takes[0] && takes[0].clip.buffer ? takes[0].clip.buffer.getChannelData(0) : null;
  if (!x) return { erreur: 'pas de prise' };
  const found = []; for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > 0.3 && Math.abs(x[i - 1]) <= 0.3) { found.push(i); i += 64; }
  const rel = found.map(f => f - found[0]), wrel = want.map(w => w - want[0]);
  const segs = found.map(f => Array.from(x.subarray(f - 16, f + 48)));
  const vid = saved ? await (await window.__novaAppModule('/utils/videoTakeStore.ts')).getMeta(saved.id) : null;
  return { sr, cas: withCam ? 'avec caméra' : 'sans caméra', trouves: found.length, attendus: N,
    intervalles_exacts: rel.length === wrel.length && rel.every((r, i) => r === wrel[i]), ecarts: rel.map((r, i) => r - (wrel[i] ?? 0)),
    segments: segs, longueur: x.length, video: vid ? { frames: vid.frames, status: vid.status, bufferIds: vid.bufferIds } : null, clip: takes[0].clip.id };
}"""


def run_identique(p, y4m):
    r = {}
    b = launch(p, y4m)
    log, ctx, page = setup_page(b, "pc", "video_identique", "dark")
    try:
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_function("() => !!window.__novaAppModule && document.readyState === 'complete'", timeout=60000)
        page.wait_for_timeout(2500)
        page.evaluate("async () => { await window.__novaAppModule('/utils/videoTakeRecorder.ts'); }")
        a = page.evaluate(SAME_TAKE, False)
        c = page.evaluate(SAME_TAKE, True)
        for k, v in (("sans_camera", a), ("avec_camera", c)):
            r[k] = {x: v.get(x) for x in v if x != "segments"}
        if a.get("erreur") or c.get("erreur"): raise RuntimeError(f"{a.get('erreur')} / {c.get('erreur')}")
        sa, sc = np.array(a["segments"], np.float32), np.array(c["segments"], np.float32)
        same_shape = sa.shape == sc.shape
        diff = float(np.abs(sa - sc).max()) if same_shape else None
        r["difference_max_echantillons"] = diff
        r["video_avec_camera"] = c.get("video")
        if not (a["intervalles_exacts"] and c["intervalles_exacts"]): ko(f"prise identique : intervalles {a['ecarts']} / {c['ecarts']}")
        elif not same_shape or diff != 0.0: ko(f"prise identique : échantillons différents (écart max {diff})")
        elif not c.get("video") or not c["video"]["frames"]: ko("prise identique : la vidéo n'a pas été filmée avec la caméra")
        else: ok(f"prise audio identique au bit près avec ou sans caméra : {a['trouves']} clics au même échantillon, écart max {diff} ; vidéo de {c['video']['frames']} images à côté")
    except Exception as e:  # noqa
        ko(f"identique : {type(e).__name__}: {str(e)[:300]}")
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["identique"] = r


LONG_TAKE = r"""async (secs) => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const { TrackType } = await window.__novaAppModule('/types.ts');
  await window.__qaEnsureMic(); await E.resume();
  const V = window.__novaVideoTake;
  if (V.state.status !== 'on') await V.open();
  const tid = 'voix-longue';
  const track = { id: tid, name: tid, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [], plugins: [], clips: [], outputTrackId: 'master', isTrackArmed: true };
  E.updateTrack(track, [track]);
  const err = await E.armTrack(tid, { alone: true }); if (err) return { erreur: err };
  await new Promise(r => setTimeout(r, 700));
  let saved = null; window.addEventListener('nova:video-take-saved', e => { saved = e.detail; }, { once: true });
  const heap0 = performance.memory ? performance.memory.usedJSHeapSize : null;
  if (!(await E.startRecording(0, tid))) return { erreur: 'startRecording' };
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, secs * 1000));
  const heap1 = performance.memory ? performance.memory.usedJSHeapSize : null;
  const takes = await E.stopRecordingAll(); E.disarmTrack(tid);
  for (let i = 0; i < 100 && !saved; i++) await new Promise(r => setTimeout(r, 200));
  if (!saved) return { erreur: 'vidéo non rangée' };
  const S = await window.__novaAppModule('/utils/videoTakeStore.ts');
  const m = await S.getMeta(saved.id);
  const gaps = []; for (let i = 1; i < m.chunkTs.length; i++) gaps.push((m.chunkTs[i] - m.chunkTs[i - 1]) / 1000);
  const X = await window.__novaAppModule('/utils/videoTakeExport.ts');
  const mid = await X.frameAt(m, (m.times[0] + m.times[m.times.length - 1]) / 2);
  return { secondes: secs, images: m.frames, sautees: m.dropped, images_par_s: +(m.frames / m.durationSec).toFixed(2), octets: m.bytes, mo_par_minute: +(m.bytes / 1e6 / (secs / 60)).toFixed(1),
    pire_intervalle_ms: Math.max(...gaps), duree_video_s: m.durationSec, duree_prise_s: takes[0] && +takes[0].clip.duration.toFixed(2),
    image_du_milieu_decodee: !!mid, tas_mo_avant: heap0 && +(heap0 / 1e6).toFixed(1), tas_mo_apres: heap1 && +(heap1 / 1e6).toFixed(1) };
}"""


def run_longue(p, y4m, secs=180):
    r = {}
    b = launch(p, y4m)
    log, ctx, page = setup_page(b, "pc", "video_longue", "dark")
    try:
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_function("() => !!window.__novaAppModule && document.readyState === 'complete'", timeout=60000)
        page.wait_for_timeout(2500)
        page.evaluate("async () => { await window.__novaAppModule('/utils/videoTakeRecorder.ts'); await window.__novaVideoTake.open(); }")
        res = page.evaluate(LONG_TAKE, secs)
        r.update(res)
        if res.get("erreur"): ko(f"prise longue : {res['erreur']}")
        elif res["sautees"] or res["images"] < secs * 29 or res["pire_intervalle_ms"] > 100 or not res["image_du_milieu_decodee"]:
            ko(f"prise longue ({secs} s) : {res}")
        else: ok(f"prise de {secs} s filmée : {res['images']} images ({res['images_par_s']} i/s), 0 sautée, pire intervalle {res['pire_intervalle_ms']} ms, {res['mo_par_minute']} Mo/min")
    except Exception as e:  # noqa
        ko(f"prise longue : {type(e).__name__}: {str(e)[:300]}")
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["longue"] = r


# Place disponible simulée : window.__qaFree (octets libres) ; quota 10 Go.
STORAGE_INIT = r"""(() => { window.__qaFree = 5 * 1024 * 1024 * 1024;
  try { const st = navigator.storage; const orig = st.estimate.bind(st);
    st.estimate = async () => { const e = await orig(); const quota = 10 * 1024 ** 3; return { ...e, quota, usage: quota - window.__qaFree }; }; } catch (e) {} })();"""


def run_plein(p, zpath, y4m):
    r = {"captures": []}
    b = launch(p, y4m)
    log, ctx, page = setup_page(b, "pc", "video_plein", "dark", STORAGE_INIT)
    try:
        open_project_file(page, zpath, r, "C0_projet")
        dismiss(page)
        page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
        open_panel_palette(page)
        tap(page, "video-take-on")
        wait_state(page, lambda s: s["status"] == "on", 15)
        page.evaluate(WATCH)
        # 1. Plus de place pendant la prise : la vidéo s'arrête, la prise audio continue.
        page.evaluate("() => { window.__qaSaved = null; window.addEventListener('nova:video-take-saved', e => { window.__qaSaved = e.detail; }, { once: true }); }")
        page.evaluate("() => { try { document.activeElement && document.activeElement.blur(); } catch (e) {} }")
        page.keyboard.press("r")
        wait_state(page, lambda s: s["recording"], 10)
        page.wait_for_timeout(1500)
        page.evaluate("() => { window.__qaFree = 20 * 1024 * 1024; }")
        s = wait_state(page, lambda s: not s["recording"], 8)
        audio_on = page.locator("button[aria-label=\"Arrêter l'enregistrement\"]").count() > 0
        r["pendant"] = {"etat": s, "prise_audio_continue": audio_on}
        page.screenshot(path=str(OUT / "C1_stockage_plein_pendant.png")); r["captures"].append(str(OUT / "C1_stockage_plein_pendant.png"))
        if s["recording"] or not s.get("notice") or "Stockage plein" not in s["notice"]: ko(f"stockage plein pendant la prise : {s}")
        elif not audio_on: ko("stockage plein : la prise audio s'est arrêtée aussi")
        else: ok(f"stockage plein pendant la prise : vidéo arrêtée, prise audio continue — « {s['notice'][:90]}… »")
        page.wait_for_timeout(1000)
        page.evaluate("() => { try { document.activeElement && document.activeElement.blur(); } catch (e) {} }")
        page.keyboard.press("r")
        for _ in range(60):
            if page.evaluate("() => window.__qaSaved"): break
            page.wait_for_timeout(250)
        saved = page.evaluate("() => window.__qaSaved")
        meta = take_meta(page, saved["id"]) if saved else None
        r["video_partielle"] = meta and {k: meta.get(k) for k in ("status", "stopReason", "frames", "durationSec")}
        if not meta or meta.get("status") != "partial": ko(f"stockage plein : vidéo pas marquée partielle ({r['video_partielle']})")
        else: ok(f"vidéo gardée jusqu'à l'arrêt ({meta['durationSec']} s, « {meta.get('stopReason')} »), marquée « arrêtée avant la fin »")
        # 2. Déjà plein avant la prise : message actionnable, la prise part sans vidéo.
        page.evaluate("() => window.__novaVideoTake.refreshStorage()")
        page.wait_for_timeout(400)
        lvl = page.get_by_test_id("video-take-storage").get_attribute("data-level")
        txt = page.get_by_test_id("video-take-storage").inner_text()
        r["avant"] = {"niveau": lvl, "texte": txt}
        page.get_by_test_id("video-take-storage").scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / "C2_stockage_plein_avant.png")); r["captures"].append(str(OUT / "C2_stockage_plein_avant.png"))
        if lvl != "full" or "supprime" not in txt: ko(f"stockage plein avant la prise : {lvl} « {txt} »")
        else: ok(f"stockage plein avant la prise : « {txt} »")
        page.evaluate("() => { try { document.activeElement && document.activeElement.blur(); } catch (e) {} }")
        page.keyboard.press("r"); page.wait_for_timeout(1500)
        s2 = cam_state(page)
        audio2 = page.locator("button[aria-label=\"Arrêter l'enregistrement\"]").count() > 0
        page.keyboard.press("r"); page.wait_for_timeout(1200)
        r["prise_sans_video"] = {**s2, "prise_audio_en_cours": audio2}
        if s2["recording"] or not s2.get("notice") or "Pas assez de place" not in s2["notice"] or not audio2: ko(f"prise sans place : {r['prise_sans_video']}")
        else: ok("prise sans place : l'audio s'enregistre, la vidéo non, message clair")
        # Libérer de la place : supprimer une vidéo (confirmation).
        n0 = page.get_by_test_id("video-take-item").count()
        page.get_by_test_id("video-take-delete").first.click(); page.get_by_test_id("video-take-delete-yes").click(); page.wait_for_timeout(600)
        n1 = page.get_by_test_id("video-take-item").count()
        r["suppression"] = [n0, n1]
        if n1 != n0 - 1: ko(f"suppression d'une vidéo : {n0} → {n1}")
        else: ok("« 🗑 » + confirmation : la vidéo est supprimée (la prise audio reste)")
    except Exception as e:  # noqa
        ko(f"stockage plein : {type(e).__name__}: {str(e)[:300]}")
        try: page.screenshot(path=str(OUT / "C_ECHEC.png"))
        except Exception: pass
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["plein"] = r


def run_telephone(p, zpath, y4m, theme="light"):
    r = {"captures": []}
    pre = "D" if theme == "light" else "E"
    b = launch(p, y4m)
    log, ctx, page = setup_page(b, "tel390", f"video_tel_{theme}", theme)
    try:
        open_project_file(page, zpath, r, f"{pre}0_projet")
        dismiss(page)
        page.locator("button[aria-label='Activer le micro']").locator("visible=true").first.tap()
        page.get_by_test_id("video-take-pill").wait_for(timeout=10000)
        page.screenshot(path=str(OUT / f"{pre}1_tel_pastille.png")); r["captures"].append(str(OUT / f"{pre}1_tel_pastille.png"))
        ok(f"téléphone ({theme}) : piste armée → pastille « 🎥 Filmer la prise »")
        page.get_by_test_id("video-take-pill").locator("button").first.tap()
        page.get_by_test_id("video-take-panel").wait_for(timeout=8000)
        tap(page, "video-format-horizontal", True)
        page.screenshot(path=str(OUT / f"{pre}2_tel_panneau.png")); r["captures"].append(str(OUT / f"{pre}2_tel_panneau.png"))
        tap(page, "video-take-on", True)
        s = wait_state(page, lambda s: s["status"] == "on", 15)
        if s["status"] != "on": raise RuntimeError(f"caméra : {s}")
        page.wait_for_timeout(800)
        flip = page.get_by_test_id("video-take-flip")
        r["bouton_avant_arriere"] = flip.count() > 0 and flip.first.inner_text()
        if not flip.count(): ko("téléphone : pas de bouton caméra avant / arrière")
        else:
            flip.first.tap(); s2 = wait_state(page, lambda s: s["status"] == "on" and s.get("format") == "16:9", 10)
            r["apres_retournement"] = page.evaluate("() => ({ facing: window.__novaVideoTake.state.facing, gum: window.__qaGum.slice(-1)[0] })")
            if '"environment"' not in (r["apres_retournement"]["gum"] or ""): ko(f"caméra arrière non demandée : {r['apres_retournement']}")
            else: ok("téléphone : « Caméra arrière » demande la caméra arrière (facingMode environment)")
            page.get_by_test_id("video-take-flip").first.tap(); wait_state(page, lambda s: s["status"] == "on", 10)
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / f"{pre}3_tel_camera.png")); r["captures"].append(str(OUT / f"{pre}3_tel_camera.png"))
        r["sans_defilement_horizontal"] = no_hscroll(page)
        if not r["sans_defilement_horizontal"]: ko("téléphone : défilement horizontal")
        if theme == "light":
            page.evaluate(WATCH)
            # Panneau réduit pour voir REC ; la prise se lance au doigt.
            page.get_by_role("button", name="Réduire le panneau caméra").tap()
            page.get_by_test_id("video-take-mini").wait_for(timeout=4000)
            sch, fl, tid, shot = record_take(page, 4, f"{pre}4_tel_prise", touch=True)
            r["captures"].append(shot)
            page.get_by_role("button", name="Agrandir le panneau caméra").tap()
            page.get_by_test_id("video-take-panel").wait_for(timeout=4000)
            open_export(page, tid)
            page.screenshot(path=str(OUT / f"{pre}5_tel_export.png")); r["captures"].append(str(OUT / f"{pre}5_tel_export.png"))
            r["export_sans_defilement_horizontal"] = no_hscroll(page)
            if not r["export_sans_defilement_horizontal"]: ko("téléphone : défilement horizontal dans l'export")
            dest, ex = export_video(page, f"{pre}6_tel_16-9", touch=True)
            r["export"] = ex
            mm = measure_mp4(dest, "téléphone 16:9", (1280, 720))
            r["mp4"] = mm
            if (mm.get("pire_ecart_ms") or 99) > TOL_MS or len(mm.get("paires", [])) < 3: ko(f"téléphone : écart {mm.get('pire_ecart_ms')} ms sur {len(mm.get('paires', []))} flashs")
            else: ok(f"téléphone 16:9 (1280 × 720) : {len(mm['paires'])} flashs, pire écart image − son {mm['pire_ecart_ms']} ms")
            page.screenshot(path=str(OUT / f"{pre}7_tel_export_fini.png")); r["captures"].append(str(OUT / f"{pre}7_tel_export_fini.png"))
            for nm, t in (("debut", 0.8), ("milieu", ex["range"]["duration"] / 2)):
                r["captures"].append(frame_png(dest, t, OUT / f"{pre}6_image_{nm}.png"))
    except Exception as e:  # noqa
        ko(f"téléphone {theme} : {type(e).__name__}: {str(e)[:300]}")
        try: page.screenshot(path=str(OUT / f"{pre}_ECHEC.png"))
        except Exception: pass
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"][f"telephone_{theme}"] = r


def run_bureau_clair(p, zpath, y4m):
    """Captures en thème clair au bureau : panneau, caméra allumée, fenêtre d'export."""
    r = {"captures": []}
    b = launch(p, y4m)
    log, ctx, page = setup_page(b, "pc1366", "video_bureau_clair", "light")
    try:
        open_project_file(page, zpath, r, "F0_projet")
        dismiss(page)
        page.wait_for_function("() => !!window.__novaEdit", timeout=30000)
        open_panel_palette(page)
        page.screenshot(path=str(OUT / "F1_clair_panneau.png")); r["captures"].append(str(OUT / "F1_clair_panneau.png"))
        tap(page, "video-take-on")
        wait_state(page, lambda s: s["status"] == "on", 15)
        page.evaluate(WATCH)
        sch, fl, tid, shot = record_take(page, 3, "F2_clair_prise")
        r["captures"].append(shot)
        open_export(page, tid)
        page.get_by_test_id("video-lyrics-toggle").check(); page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / "F3_clair_export.png")); r["captures"].append(str(OUT / "F3_clair_export.png"))
        if page.get_by_test_id("video-export-run").is_disabled(): ko("prise courte (≈ 4 s) : export refusé")
        else: ok("prise courte (≈ 4 s) : export permis")
        ok("bureau 1366 × 768, thème clair : panneau, prise filmée, fenêtre d'export")
    except Exception as e:  # noqa
        ko(f"bureau clair : {type(e).__name__}: {str(e)[:300]}")
        try: page.screenshot(path=str(OUT / "F_ECHEC.png"))
        except Exception: pass
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["bureau_clair"] = r


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    y4m = OUT / "fausse_camera_flash.y4m"
    if not y4m.exists(): make_y4m(y4m)
    zp = OUT / "projet_video_prise.zip"
    make_project(zp)
    only = set(sys.argv[1:])
    with sync_playwright() as p:  # un seul navigateur à la fois
        if not only or "bureau" in only: run_bureau(p, zp, y4m)
        if not only or "identique" in only: run_identique(p, y4m)
        if not only or "longue" in only: run_longue(p, y4m)
        if not only or "plein" in only: run_plein(p, zp, y4m)
        if not only or "telephone" in only: run_telephone(p, zp, y4m, "light")
        if not only or "telephone_sombre" in only: run_telephone(p, zp, y4m, "dark")
        if not only or "clair" in only: run_bureau_clair(p, zp, y4m)
    (OUT / "video_prise.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps({k: v for k, v in RES.items() if k != "runs"}, ensure_ascii=False))
    sys.exit(1 if RES["echecs"] else 0)


if __name__ == "__main__":
    main()
