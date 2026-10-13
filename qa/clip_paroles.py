"""Lot 2a · Clip vertical avec les paroles synchronisées (TikTok / Reels), 100 % hors production.

Ce que le scénario prouve (Chrome headless, aucune fenêtre, Supabase simulé par qa_hors_prod) :
  A. Bureau : projet de test (beat importé discret + voix en « bips » dont la transcription
     mot par mot est connue). Palette Ctrl+K → « Clip pour TikTok / Reels ». Droits : instru
     importée, export pas payé → clip limité comme l'extrait (30 s, sur la voix). Aperçu en
     direct des 4 styles et des 4 fonds (captures du canevas). Export d'un clip de 15 s, puis
     d'un clip de 30 s (durée mesurée). Fenêtre de partage → bouton du clip.
  B. Téléphone (390 × 844, au doigt) : Exporter → « Extrait 30 s pour les réseaux » → clip ;
     style « Gros sous-titres » + visualiseur ; export de 15 s.
  C. Projet sans paroles (site) : « Taper les paroles » (pas de « Transcrire » sur le web),
     paroles tapées puis enregistrées → calées comme le prompteur.
  D. Appli Windows simulée + compte admin simulé : bouton « Transcrire les paroles » qui ouvre
     la fenêtre de transcription ; clip complet (60 s débloqué).
Chaque MP4 est vérifié avec ffprobe / ffmpeg (VÉRIFICATION seulement, l'appli ne s'en sert pas) :
  1080 × 1920, H.264 + AAC, durée, piste audio, et calage au premier mot : l'image où le 1er mot
  passe en jaune et l'attaque du son de ce mot tombent au même instant (écart ≤ 1 image, 33 ms).
Des images du clip sont extraites en PNG pour être regardées.

  NOVA_URL=http://127.0.0.1:3451/ python qa/clip_paroles.py
Sorties : QA_OUT (par défaut D:\\1 WORK\\CONTENU\\nova-bandlab\\lot2a_clip\\qa)
"""
import io, json, os, re, subprocess, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3451/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot2a_clip\qa")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402
from qalib import launch, new_page, Log, save_log, OUT, BASE  # noqa: E402
if os.environ.get("QA_NAVIGATEUR") == "chrome":  # Chrome installé (headless, sans fenêtre) : H.264 et AAC du vrai navigateur
    qalib.CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
from gel_pre_effet import open_project_file  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
FPS = 30
VOICE_AT = 6.0          # début du clip voix dans le morceau (s)
SONG = 70.0             # longueur du projet (s) : 60 s possibles en clip complet
LINES = [
    (1.2, "Je fais du son la nuit"),
    (4.6, "Les lumières de la ville"),
    (8.0, "Brillent sur mon micro"),
    (11.4, "Tout le monde dort encore"),
    (14.8, "Moi je pose ma voix"),
    (18.2, "Sur le beat qui tourne"),
    (21.6, "Jusqu'au lever du jour"),
    (25.0, "Et ça sonne comme moi"),
]
STEP = 0.42
DESKTOP_JS = "window.__novaDesktop = { version: '1.1.3', platform: 'windows', ui: 'qa', bridges: { asio: 8766, vst: 8765 } };"
TOL = 1.0 / FPS + 0.002  # 1 image

RES = {"scenario": "clip_paroles", "base": BASE, "runs": {}, "echecs": []}


def ko(msg):
    RES["echecs"].append(msg)
    print("KO  " + msg, flush=True)


def ok(msg):
    print("OK  " + msg, flush=True)


# ─── Projet de test ──────────────────────────────────────────────────────────

def wav_bytes(mono):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def words():
    out = []
    for t0, line in LINES:
        for i, w in enumerate(line.split()):
            s = round(t0 + i * STEP, 3)
            out.append({"w": w, "s": s, "e": round(s + 0.3, 3), **({"b": True} if i == 0 else {})})
    return out


def make_project(path, with_transcript=True):
    n_voice = int(30 * SR)
    voice = np.zeros(n_voice, np.float32)
    t = np.arange(int(0.3 * SR)) / SR
    env = np.minimum(1, t / 0.004) * np.exp(-t * 3)
    burst = (0.6 * np.sin(2 * np.pi * 330 * t) + 0.25 * np.sin(2 * np.pi * 660 * t)) * env
    for w in words():
        i = int(round(w["s"] * SR))
        voice[i:i + len(burst)] += burst[: max(0, n_voice - i)]
    tb = np.arange(int(SONG * SR)) / SR
    beat = (0.02 * np.sin(2 * np.pi * 110 * tb) + 0.012 * np.sin(2 * np.pi * 164.8 * tb)).astype(np.float32)

    def clip(cid, name, ref, start, n, **kw):
        return {"id": cid, "name": name, "type": "AUDIO", "audioRef": ref, "color": "#f472b6", "fadeIn": 0, "fadeOut": 0,
                "gain": 1.0, "start": start, "offset": 0.0, "duration": round(n / SR, 3), **kw}
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    lead_clip = clip("prise-1", "Prise 1", "audio/lead.wav", VOICE_AT, n_voice)
    if with_transcript:
        lead_clip["transcript"] = {"version": 1, "language": "fr", "model": "qa", "words": words(), "at": 1}
    tracks = [
        {**base, "id": "instrumental", "name": "Beat", "type": "AUDIO", "color": "#22d3ee", "clips": [clip("beat", "Beat", "audio/beat.wav", 0.0, len(beat))]},
        {**base, "id": "lead", "name": "Lead", "type": "AUDIO", "color": "#f472b6", "clips": [lead_clip]},
    ]
    state = {
        "id": "proj-clip-paroles" + ("" if with_transcript else "-vide"), "name": "Nuit blanche", "bpm": 120,
        "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "lead", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "lyrics": "",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/lead.wav", wav_bytes(voice))
        z.writestr("audio/beat.wav", wav_bytes(beat))


# ─── Vérification des vidéos (ffprobe / ffmpeg) ──────────────────────────────

def ffprobe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                       capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return json.loads(r.stdout or "{}")


def video_frames(path, w=135, h=240):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"scale={w}:{h}", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                       capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    a = np.frombuffer(r.stdout, np.uint8)
    return a.reshape(-1, h, w, 3)


def audio_samples(path):
    # Remis sur l'horloge du fichier (first_pts=0) : un décalage de piste se verrait ici.
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return np.frombuffer(r.stdout, np.float32)


def frame_png(path, t, dest):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1", str(dest)],
                   capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return dest


def check_video(path, label, expect_dur, range_start):
    out = {"fichier": str(path), "taille_mo": round(path.stat().st_size / 1e6, 2)}
    info = ffprobe(path)
    vs = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    au = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    out["format"] = info.get("format", {}).get("format_name")
    if not vs: ko(f"{label} : pas de piste vidéo"); return out
    v = vs[0]
    out.update({"video": v.get("codec_name"), "profil": v.get("profile"), "largeur": v.get("width"), "hauteur": v.get("height"),
                "images_par_s": v.get("avg_frame_rate"), "duree_video": float(v.get("duration") or 0), "debut_video": float(v.get("start_time") or 0)})
    if (v.get("width"), v.get("height")) != (1080, 1920): ko(f"{label} : dimensions {v.get('width')}×{v.get('height')} (1080×1920 attendu)")
    if v.get("codec_name") != "h264": ko(f"{label} : vidéo {v.get('codec_name')} (h264 attendu)")
    if abs(out["duree_video"] - expect_dur) > 0.1: ko(f"{label} : durée vidéo {out['duree_video']:.3f} s ({expect_dur} attendu)")
    if not au: ko(f"{label} : pas de piste audio"); return out
    a = au[0]
    out.update({"audio": a.get("codec_name"), "frequence": int(a.get("sample_rate") or 0), "canaux": a.get("channels"),
                "duree_audio": float(a.get("duration") or 0), "debut_audio": float(a.get("start_time") or 0)})
    if a.get("codec_name") != "aac": ko(f"{label} : audio {a.get('codec_name')} (aac attendu)")
    if abs(out["duree_audio"] - expect_dur) > 0.1: ko(f"{label} : durée audio {out['duree_audio']:.3f} s ({expect_dur} attendu)")

    # Calage : à chaque début de ligne du passage, l'image où le 1er mot passe en jaune et
    # l'attaque de son « bip » doivent tomber ensemble (écart ≤ 1 image), sans dérive au fil du clip.
    starts = [VOICE_AT + t0 - range_start for t0, _ in LINES]
    starts = [e for e in starts if 0.3 < e < expect_dur - 0.3]
    first_word = starts[0] if starts else 0.0
    out["premier_mot_attendu_s"] = round(first_word, 3)
    frames = video_frames(path)
    out["images"] = int(frames.shape[0])
    if abs(frames.shape[0] - round(expect_dur * FPS)) > 1: ko(f"{label} : {frames.shape[0]} images ({round(expect_dur * FPS)} attendues)")
    R, G, B = frames[..., 0].astype(int), frames[..., 1].astype(int), frames[..., 2].astype(int)
    yellow = ((R > 200) & (G > 175) & (B < 140)).reshape(frames.shape[0], -1).sum(axis=1) > 12
    samples = audio_samples(path)
    peak = float(np.abs(samples).max() or 1)
    loud = np.abs(samples) > 0.3 * peak
    mesures = []
    for e in starts:
        i0 = int(np.ceil((e - 0.25) * FPS))
        vi = np.nonzero(yellow[i0:])[0]
        s0 = int((e - 0.25) * SR)
        ai = np.nonzero(loud[s0:])[0]
        if not len(vi) or not len(ai):
            ko(f"{label} : ligne à {e:.2f} s introuvable (image {bool(len(vi))}, son {bool(len(ai))})"); continue
        tv = (i0 + vi[0]) / FPS + out["debut_video"]
        ta = (s0 + ai[0]) / SR
        mesures.append({"attendu_s": round(e, 3), "image_s": round(tv, 4), "son_s": round(ta, 4), "ecart_image_son_ms": round((tv - ta) * 1000, 1), "ecart_son_attendu_ms": round((ta - e) * 1000, 1)})
    out["calage_lignes"] = mesures
    if not mesures: ko(f"{label} : aucun mot repéré en jaune"); return out
    m0 = mesures[0]
    out.update({"mot_en_jaune_s": m0["image_s"], "attaque_son_s": m0["son_s"], "ecart_image_son_ms": m0["ecart_image_son_ms"]})
    pire = max(abs(m["ecart_image_son_ms"]) for m in mesures)
    pire_son = max(abs(m["ecart_son_attendu_ms"]) for m in mesures)
    out["pire_ecart_image_son_ms"] = pire
    out["pire_ecart_son_attendu_ms"] = pire_son
    if pire > TOL * 1000: ko(f"{label} : écart image / son jusqu'à {pire} ms (> 1 image)")
    else: ok(f"{label} : 1er mot en jaune à {m0['image_s']:.3f} s, son à {m0['son_s']:.3f} s ; {len(mesures)} lignes, pire écart image / son {pire} ms, son / attendu {pire_son} ms")
    if pire_son > TOL * 1000: ko(f"{label} : son décalé jusqu'à {pire_son} ms de l'attendu")
    # Images à regarder : ligne annoncée (blanche), 1er mot en jaune, milieu, fin.
    shots = []
    for name, tt in (("ligne_annoncee", max(0, first_word - 0.2)), ("premier_mot", first_word + 0.05), ("milieu", expect_dur / 2), ("fin", expect_dur - 0.2)):
        shots.append(str(frame_png(path, tt, OUT / f"{label}_image_{name}.png")))
    out["captures"] = shots
    return out


# ─── Gestes ─────────────────────────────────────────────────────────────────

def dismiss(page, ms=2500):
    t0 = time.time()
    while (time.time() - t0) * 1000 < ms:
        b = page.get_by_role("button", name=re.compile(r"^(Plus tard|C'est parti)$")).locator("visible=true")
        if b.count():
            try: b.first.click(timeout=2000)
            except Exception: pass
        page.wait_for_timeout(300)


def wait_rights(page):
    t0 = time.time()
    while time.time() - t0 < 15:
        txt = page.get_by_test_id("clip-rights").inner_text()
        if "Vérification" not in txt:
            return page.get_by_test_id("clip-rights").get_attribute("data-full"), txt
        page.wait_for_timeout(300)
    return None, "vérification bloquée"


def set_range_input(page, selector, value):
    page.evaluate("""([sel, v]) => { const el = document.querySelector(sel); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }""", [selector, value])


def tap(page, testid, touch=False):
    loc = page.get_by_test_id(testid).locator("visible=true").first
    loc.scroll_into_view_if_needed()
    if touch: loc.tap()
    else: loc.click()
    page.wait_for_timeout(250)


def export_clip(page, label, touch=False, timeout_s=400):
    t0 = time.time()
    got = []
    page.on("download", lambda d: got.append(d))
    tap(page, "clip-export", touch)
    page.get_by_test_id("clip-done").or_(page.get_by_test_id("clip-error")).wait_for(timeout=timeout_s * 1000)
    if page.get_by_test_id("clip-error").count():
        raise RuntimeError("erreur : " + page.get_by_test_id("clip-error").inner_text())
    meta = page.evaluate("() => { const m = window.__novaClipTest || {}; return { name: m.name, method: m.method, videoCodec: m.videoCodec, audioCodec: m.audioCodec, frames: m.frames, encodeMs: m.encodeMs, drawMs: m.drawMs, totalMs: m.totalMs, range: m.range, firstWord: m.firstWord, full: m.rights && m.rights.full, size: m.blob && m.blob.size }; }")
    meta["secondes_mur"] = round(time.time() - t0, 1)
    dest = OUT / f"{label}.mp4"
    for _ in range(20):
        if got: break
        page.wait_for_timeout(250)
    if got:
        got[0].save_as(str(dest))
        meta["recupere"] = "téléchargement"
    else:
        # Téléphone : feuille de partage du système (absente en headless) → on lit le fichier créé.
        b64 = page.evaluate("""async () => { const b = window.__novaClipTest.blob; const buf = new Uint8Array(await b.arrayBuffer()); let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); }""")
        import base64
        dest.write_bytes(base64.b64decode(b64))
        meta["recupere"] = "fichier lu dans la page"
    meta["fichier"] = str(dest)
    meta["texte_fin"] = page.get_by_test_id("clip-done").inner_text()
    return dest, meta


def preview_shot(page, name):
    p = OUT / f"{name}.png"
    page.get_by_test_id("clip-preview").screenshot(path=str(p))
    return str(p)


def no_hscroll(page):
    return page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")


# ─── Scénarios ──────────────────────────────────────────────────────────────

def run_bureau(p, zpath):
    log = Log("clip_bureau")
    r = {"captures": []}
    b = launch(p)
    ctx, page = new_page(b, "pc", log)
    try:
        open_project_file(page, zpath, r, "A0_projet")
        dismiss(page)
        # Palette Ctrl+K
        page.keyboard.press("Control+k")
        page.locator("[data-testid=command-palette]").wait_for(timeout=6000)
        page.keyboard.type("clip tiktok")
        page.wait_for_timeout(500)
        first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
        r["palette_premier"] = first
        if first != "pal.lyricClip": ko(f"palette : 1re action {first} (pal.lyricClip attendu)")
        page.keyboard.press("Enter")
        page.get_by_test_id("lyric-clip").wait_for(timeout=10000)
        ok("palette Ctrl+K → fenêtre du clip")
        full, txt = wait_rights(page)
        r["droits"] = {"complet": full, "texte": txt}
        if full != "0": ko(f"droits : clip complet sans export payé ({txt})")
        else: ok("droits : instru importée, export pas payé → limité comme l'extrait")
        if not page.get_by_test_id("clip-dur-45").is_disabled(): ko("45 s permis sans licence")
        src = page.get_by_test_id("clip-lyrics-source").inner_text()
        r["paroles"] = src
        if "mot par mot" not in src: ko(f"paroles : {src}")
        tap(page, "clip-dur-15"); tap(page, "clip-range-voix")
        page.wait_for_timeout(400)
        # Aperçu des 4 styles × fonds (position 3 s dans le clip).
        for style, bg in (("tiktok", "degrade"), ("neon", "couleur"), ("minimal", "image"), ("tombent", "visualiseur")):
            tap(page, f"clip-style-{style}"); tap(page, f"clip-bg-{bg}")
            set_range_input(page, "input[aria-label=\"Position dans l'aperçu\"]", 3.0)
            page.wait_for_timeout(500)
            r["captures"].append(preview_shot(page, f"A1_apercu_{style}_{bg}"))
        page.screenshot(path=str(OUT / "A2_fenetre_bureau.png")); r["captures"].append(str(OUT / "A2_fenetre_bureau.png"))
        # Export 15 s : gros sous-titres, dégradé.
        tap(page, "clip-style-tiktok"); tap(page, "clip-bg-degrade")
        dest, meta = export_clip(page, "clip_bureau_15s")
        r["export_15s"] = meta
        ok(f"export 15 s : {meta['method']} {meta['videoCodec']} en {meta['totalMs']} ms (encodage {meta['encodeMs']} ms)")
        page.screenshot(path=str(OUT / "A3_clip_pret.png"))
        r["video_15s"] = check_video(dest, "bureau_15s", 15, meta["range"]["start"])
        # Export 30 s (mesure de durée).
        tap(page, "clip-dur-30"); tap(page, "clip-range-voix")
        tap(page, "clip-style-tiktok"); tap(page, "clip-bg-visualiseur")
        dest30, meta30 = export_clip(page, "clip_bureau_30s_visualiseur")
        r["export_30s"] = meta30
        ok(f"export 30 s : {meta30['method']} en {meta30['totalMs']} ms (encodage {meta30['encodeMs']} ms dont dessin {meta30.get('drawMs')} ms)")
        r["video_30s"] = check_video(dest30, "bureau_30s", 30, meta30["range"]["start"])
        # Échap ferme ; fenêtre de partage → bouton du clip.
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        if page.get_by_test_id("lyric-clip").count(): ko("Échap ne ferme pas la fenêtre du clip")
        page.get_by_role("button", name="Partager le projet").locator("visible=true").first.click()
        page.get_by_test_id("share-lyric-clip").wait_for(timeout=6000)
        page.screenshot(path=str(OUT / "A4_fenetre_partage.png"))
        tap(page, "share-lyric-clip")
        page.get_by_test_id("lyric-clip").wait_for(timeout=8000)
        ok("fenêtre de partage → « Clip pour TikTok / Reels »")
    except Exception as e:  # noqa
        ko(f"bureau : {type(e).__name__}: {str(e)[:300]}")
        try: page.screenshot(path=str(OUT / "A_ECHEC.png"))
        except Exception: pass
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors()][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["bureau"] = r


def run_telephone(p, zpath):
    log = Log("clip_telephone")
    r = {"captures": []}
    b = launch(p)
    ctx, page = new_page(b, "tel390", log)
    try:
        open_project_file(page, zpath, r, "B0_projet_tel")
        dismiss(page)
        # Exporter → « Extrait 30 s pour les réseaux » → clip.
        exp = page.get_by_role("button", name=re.compile(r"^\W*Exporter( le mix)?\s*$")).locator("visible=true").first
        if not exp.is_visible():
            page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.tap(); page.wait_for_timeout(500)
            exp = page.get_by_role("button", name=re.compile(r"^\W*Exporter( le mix)?\s*$")).locator("visible=true").first
        exp.tap(); page.wait_for_timeout(1200)
        page.get_by_text("Extrait 30 s pour les réseaux").first.tap()
        page.get_by_test_id("share-lyric-clip").wait_for(timeout=8000)
        page.screenshot(path=str(OUT / "B1_partage_tel.png"))
        tap(page, "share-lyric-clip", touch=True)
        page.get_by_test_id("lyric-clip").wait_for(timeout=8000)
        ok("téléphone : Exporter → extrait → clip")
        full, txt = wait_rights(page)
        r["droits"] = {"complet": full, "texte": txt}
        if full != "0": ko(f"téléphone, droits : {txt}")
        page.screenshot(path=str(OUT / "B1b_fenetre_tel_ouverture.png"))
        tap(page, "clip-dur-15", True); tap(page, "clip-range-voix", True)
        tap(page, "clip-style-tiktok", True); tap(page, "clip-bg-visualiseur", True)
        set_range_input(page, "input[aria-label=\"Position dans l'aperçu\"]", 3.0)
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "B2_fenetre_tel_haut.png"))
        r["sans_defilement_horizontal"] = no_hscroll(page)
        if not r["sans_defilement_horizontal"]: ko("téléphone : défilement horizontal")
        page.get_by_test_id("clip-export").scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / "B3_fenetre_tel_bas.png"))
        # L'aperçu reste visible en haut pendant le réglage (collé en haut de la fenêtre).
        box = page.get_by_test_id("clip-preview").bounding_box()
        r["apercu_visible_en_bas_de_page"] = bool(box and box["y"] >= -2 and box["y"] + box["height"] <= 844 * 0.5)
        if not r["apercu_visible_en_bas_de_page"]: ko(f"téléphone : aperçu sorti de l'écran pendant le réglage ({box})")
        dest, meta = export_clip(page, "clip_telephone_15s", touch=True)
        r["export_15s"] = meta
        ok(f"téléphone, export 15 s : {meta['method']} en {meta['totalMs']} ms")
        page.screenshot(path=str(OUT / "B4_clip_pret_tel.png"))
        r["video_15s"] = check_video(dest, "telephone_15s", 15, meta["range"]["start"])
    except Exception as e:  # noqa
        ko(f"téléphone : {type(e).__name__}: {str(e)[:300]}")
        try: page.screenshot(path=str(OUT / "B_ECHEC.png"))
        except Exception: pass
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors()][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["telephone"] = r


def open_clip_by_palette(page):
    page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=6000)
    page.keyboard.type("clip tiktok"); page.wait_for_timeout(400)
    page.keyboard.press("Enter")
    page.get_by_test_id("lyric-clip").wait_for(timeout=10000)


def run_sans_paroles(p, zpath):
    log = Log("clip_sans_paroles")
    r = {}
    b = launch(p)
    ctx, page = new_page(b, "pc", log)
    try:
        open_project_file(page, zpath, r, "C0_projet_sans_paroles")
        dismiss(page)
        open_clip_by_palette(page)
        page.get_by_test_id("clip-empty-lyrics").wait_for(timeout=6000)
        page.screenshot(path=str(OUT / "C1_sans_paroles_site.png"))
        r["bouton_transcrire_sur_le_site"] = page.get_by_test_id("clip-transcribe").count()
        if r["bouton_transcrire_sur_le_site"]: ko("site : « Transcrire » proposé sans l'appli Windows")
        tap(page, "clip-type-lyrics")
        page.get_by_test_id("clip-lyrics-input").fill("Je fais du son la nuit\nLes lumières de la ville\nBrillent sur mon micro\nTout le monde dort encore")
        tap(page, "clip-lyrics-save")
        src = page.get_by_test_id("clip-lyrics-source").inner_text()
        r["paroles_tapees"] = src
        if "prompteur" not in src: ko(f"paroles tapées : {src}")
        else: ok("site : paroles tapées → calées comme le prompteur")
        set_range_input(page, "input[aria-label=\"Position dans l'aperçu\"]", 2.0)
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "C2_paroles_tapees.png"))
    except Exception as e:  # noqa
        ko(f"sans paroles : {type(e).__name__}: {str(e)[:300]}")
        try: page.screenshot(path=str(OUT / "C_ECHEC.png"))
        except Exception: pass
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors()][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["sans_paroles"] = r


def run_appli_admin(p, zpath):
    log = Log("clip_appli_admin")
    r = {}
    b = launch(p)
    ctx, page = new_page(b, "pc", log)

    def billing(route, request):
        try: action = json.loads(request.post_data or "{}").get("action")
        except Exception: action = None
        if request.method == "OPTIONS":
            return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}, body="")
        if action == "status":
            return route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps({"plans": [], "admin": True}))
        return route.fallback()
    page.route(re.compile(r".*/functions/v1/nova-billing.*"), billing)
    try:
        open_project_file(page, zpath, r, "D0_projet_appli")
        dismiss(page)
        # Appli Windows simulée APRÈS l'ouverture du projet (la porte de connexion de l'appli est
        # testée par desktop_gate.py) : le module voix se lit à chaque affichage (isNovaDesktop).
        page.evaluate(DESKTOP_JS)
        open_clip_by_palette(page)
        full, txt = wait_rights(page)
        r["droits"] = {"complet": full, "texte": txt}
        if full != "1": ko(f"admin : clip pas complet ({txt})")
        else: ok("admin : clip complet")
        if page.get_by_test_id("clip-dur-60").is_disabled(): ko("admin : 60 s pas permis")
        page.get_by_test_id("clip-transcribe").wait_for(timeout=5000)
        page.screenshot(path=str(OUT / "D1_appli_transcrire.png"))
        tap(page, "clip-transcribe")
        page.get_by_test_id("voice-dialog").wait_for(timeout=8000)
        page.screenshot(path=str(OUT / "D2_fenetre_transcription.png"))
        ok("appli Windows : « Transcrire les paroles » ouvre la transcription")
    except Exception as e:  # noqa
        ko(f"appli / admin : {type(e).__name__}: {str(e)[:300]}")
        try: page.screenshot(path=str(OUT / "D_ECHEC.png"))
        except Exception: pass
    finally:
        r["erreurs_console"] = [e["text"][:200] for e in log.errors()][:20]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    RES["runs"]["appli_admin"] = r


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    zp = OUT / "projet_clip_paroles.zip"
    zv = OUT / "projet_clip_sans_paroles.zip"
    make_project(zp, True)
    make_project(zv, False)
    only = set(sys.argv[1:])
    with sync_playwright() as p:  # un seul navigateur à la fois (machine partagée)
        if not only or "bureau" in only: run_bureau(p, zp)
        if not only or "telephone" in only: run_telephone(p, zp)
        if not only or "sans_paroles" in only: run_sans_paroles(p, zv)
        if not only or "appli" in only: run_appli_admin(p, zv)
    (OUT / "clip_paroles.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in RES.items() if k != "runs"}, ensure_ascii=False))
    sys.exit(1 if RES["echecs"] else 0)


if __name__ == "__main__":
    main()
