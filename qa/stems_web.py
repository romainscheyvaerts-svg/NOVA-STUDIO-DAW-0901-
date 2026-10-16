"""Lot 6c (BandLab Splitter) : « Séparer en stems » DANS LE NAVIGATEUR, sur le site sans
l'appli Windows, de bout en bout, 100 % hors production (qa_hors_prod via qalib).

Vrai moteur (onnxruntime-web 1.30.0, empreintes vérifiées) et vrai modèle (Demucs v4
htdemucs_6s, 246 Mo) : leurs adresses publiques (jsDelivr, Hugging Face) sont redirigées vers
des copies locales identiques (même SHA-256) servies par un petit serveur sur le port 8798,
un peu bridé pour voir le téléchargement. Navigateur Chromium headless (« --headless=new »,
WebGPU activé sur la vraie carte graphique), aucune fenêtre.

Usage (serveur NOVA lancé : npx vite --port 3425 --strictPort --host 127.0.0.1) :
  NOVA_URL=http://127.0.0.1:3425/ python qa/stems_web.py [A C D E F]

  A. bureau 1366 × 768, sombre, carte graphique (WebGPU) :
     taille annoncée (≈ 252 Mo) ; « Séparer » → téléchargement visible → Annuler (aucune piste,
     modèle à moitié téléchargé jamais gardé) ; 2 stems de bout en bout (pistes « Voix (stem) »,
     « Instru (stem) » calées sur le clip, original coupé, somme des stems = clip) ; fenêtre
     rouverte : « modèle déjà sur cet appareil » ; 4 stems ; palette Ctrl+K ; rien de recouvert.
  C. bureau, sombre, SANS WebGPU : repli sur le processeur annoncé, 2 stems de bout en bout.
  D. téléphone 390 × 844, sombre : sans WebGPU → « Séparer sur ton PC (Nova Studio) » +
     « Essayer quand même » ; avec WebGPU et réseau mobile → avertissement mémoire, confirmation
     « réseau mobile » avant le téléchargement, « Attendre le Wi-Fi ».
  E. thème clair : bureau (prêt) et téléphone (conseil du PC).
  F. beat du catalogue non acheté : refus (licence), aucun moteur téléchargé.

Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-151\\stems-web\\qa) : stems_web.json + captures.
"""
import http.server
import io
import json
import os
import re
import sys
import threading
import time
import wave
import zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3425/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-151\stems-web\qa")
sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, FAKE_WAV, Log, new_page, shot, save_log, balayage_chevauchement, overflow_report  # noqa: E402
from gel_pre_effet import open_project_file  # noqa: E402
from stems_separation import prepare, dismiss_popups, open_stems_menu  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CHROME_FULL = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe"
MAT = Path(r"D:\1 WORK\CONTENU\nova-bandlab\lot6_stems\materiel")
CACHE = Path(os.environ.get("STEMS_WEB_CACHE", r"D:\1 WORK\CONTENU\nova-151\stems-web\cache_modele"))
FILE_PORT = int(os.environ.get("STEMS_WEB_PORT", "8798"))
SR = 44100
CLIP = {"start": 2.0, "offset": 1.0, "duration": 10.0}

checks = []
res = {}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


# ─── Matériel : 12 s d'une vraie musique du studio (voix + instru), stéréo 44,1 kHz ──────────

def read_wav(p: Path):
    with wave.open(str(p)) as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768
    elif sw == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        v = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
        x = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float32) / (1 << 23)
    else:
        x = np.frombuffer(raw, "<f4").astype(np.float32)
    return x.reshape(-1, ch).T, sr


def music_wav() -> bytes:
    src = MAT / "silence_blanc_45s.wav"
    if src.exists():
        x, sr = read_wav(src)
        x = x[:, 10 * sr: 22 * sr]
    else:  # repli : accords + bruit (si le matériel du studio n'est pas sur ce PC)
        t = np.arange(12 * SR) / SR
        m = 0.2 * (np.sin(2 * np.pi * 220 * t) + np.sin(2 * np.pi * 277 * t)) + 0.05 * np.random.default_rng(1).standard_normal(len(t))
        x, sr = np.stack([m, m]), SR
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x.T, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project(path: Path, catalogue=False):
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    clip = {"id": "beat-clip", "name": "Silence blanc (extrait)", "type": "AUDIO", "audioRef": "audio/beat.wav", "color": "#22d3ee",
            "fadeIn": 0.05, "fadeOut": 0.5, "gain": 0.9, **CLIP}
    track = {**base, "id": "beat", "name": "Beat", "type": "AUDIO", "color": "#22d3ee", "clips": [clip]}
    if catalogue:
        track["instrumentId"] = "qa-beat-42"
    state = {
        "id": "proj-stems-web", "name": "Stems navigateur", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [track], "trackGroups": [], "markers": [], "selectedTrackId": "beat", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/beat.wav", music_wav())


PROJECT = OUT / "stems_web_projet.zip"
PROJECT_CAT = OUT / "stems_web_projet_catalogue.zip"


# ─── Copies locales du modèle et du moteur (mêmes octets que les adresses publiques) ─────────

class _Files(http.server.SimpleHTTPRequestHandler):
    rate = 90e6  # octets/s : le téléchargement dure ~3 s, assez pour le voir et l'annuler

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(CACHE), **k)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def copyfile(self, source, outputfile):
        t0, sent = time.time(), 0
        while True:
            b = source.read(1 << 20)
            if not b:
                break
            try:
                outputfile.write(b)
            except OSError:
                return  # client parti (Annuler)
            sent += len(b)
            ahead = sent / self.rate - (time.time() - t0)
            if ahead > 0:
                time.sleep(ahead)

    def log_message(self, *a):
        pass


def start_files():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", FILE_PORT), _Files)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def local_copies(page):
    """Redirige jsDelivr (moteur) et Hugging Face (modèle) vers les copies locales, si présentes."""
    if (CACHE / "smank_htdemucs_6s.onnx").exists():
        def model(route):
            u = route.request.url
            f = "smank_htdemucs_6s.onnx" if "/smank/" in u else "htdemucs_6s_webgpu.onnx"
            route.fulfill(status=302, headers={"location": f"http://127.0.0.1:{FILE_PORT}/{f}", "access-control-allow-origin": "*"})
        page.route(re.compile(r"^https://huggingface\.co/.*\.onnx$"), model)
    if (CACHE / "ort" / "ort.webgpu.bundle.min.mjs").exists():
        page.route("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/*", lambda r: r.fulfill(status=302, headers={
            "location": f"http://127.0.0.1:{FILE_PORT}/ort/" + r.request.url.rsplit("/", 1)[1], "access-control-allow-origin": "*"}))


NO_GPU = "try { Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get() { return undefined; } }); } catch (e) {}"
MOBILE = "try { Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get() { return { mobile: true, platform: 'Android', brands: [] }; } }); } catch (e) {}"
CELLULAR = "try { Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get() { return { type: 'cellular', effectiveType: '4g', saveData: false }; } }); } catch (e) {}"


def theme(t):
    return f"try {{ localStorage.setItem('nova_theme', '{t}'); }} catch (e) {{}}"


def launch(p):
    return p.chromium.launch(headless=True, executable_path=CHROME_FULL, args=[
        "--headless=new", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
        "--autoplay-policy=no-user-gesture-required"])


def run(fn, vp, name, inits=(), project=PROJECT):
    log = Log(name)
    r = {"name": name, "ok": True, "notes": []}
    t0 = time.time()
    with sync_playwright() as p:
        b = launch(p)
        ctx, page = new_page(b, vp, log)
        for s in inits:
            page.add_init_script(s)
        local_copies(page)
        page.set_default_timeout(60000)
        try:
            prepare(page, port=None, desktop=False)
            open_project_file(page, project, r, f"{name}_0_projet")
            fn(page, log, r, vp)
        except Exception as e:  # noqa
            r["ok"] = False
            r["notes"].append(f"EXCEPTION: {type(e).__name__}: {str(e)[:500]}")
            check(f"{name} : déroulé sans exception", False, str(e)[:500])
            try: shot(page, f"{name}__ECHEC")
            except Exception: pass
        finally:
            r["secs"] = round(time.time() - t0, 1)
            r["errors"] = [e["text"][:300] for e in log.errors()][:25]
            save_log(log, {"result": r})
            ctx.close(); b.close()
    res[name] = r
    return r


# ─── Outils de page ─────────────────────────────────────────────────────────────

def state(page):
    return page.evaluate("""() => (window.__novaEdit.getState().tracks || []).map(t => ({ id: t.id, name: t.name,
        instrumentId: t.instrumentId ?? null, beatStem: !!t.beatStem,
        clips: (t.clips || []).map(c => ({ id: c.id, start: c.start, offset: c.offset || 0, duration: c.duration, muted: !!c.isMuted, bufferId: c.bufferId || null })) }))""")


def stem_tracks(page):
    return [t for t in state(page) if re.search(r"\(stem\)$", t["name"] or "")]


def open_dialog(page, vp, label):
    if vp.startswith("tel"):
        dismiss_popups(page)
        page.evaluate("""() => { const t = window.__novaEdit.getState().tracks.find(x => x.name === 'Beat');
            window.dispatchEvent(new CustomEvent('nova:separate-stems', { detail: { trackId: t.id, clipId: t.clips[0].id } })); }""")
        page.get_by_test_id("stems-dialog").wait_for(timeout=8000)
        page.wait_for_timeout(600)
    else:
        open_stems_menu(page, label)


def wait_ready(page):
    page.get_by_test_id("stems-web").wait_for(timeout=20000)
    page.wait_for_timeout(300)


def close_dialog(page):
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    if page.get_by_test_id("stems-dialog").count():
        btn = page.get_by_test_id("stems-dialog").get_by_role("button", name=re.compile("^(Fermer|Annuler)$")).first
        btn.click()
        page.wait_for_timeout(300)


def sum_check(page, src_track="beat"):
    """Somme des stems = clip d'origine (buffers du registre), en dB sous l'original."""
    return page.evaluate("""async (src) => {
      const st = window.__novaEdit.getState();
      const reg = (await window.__novaAppModule('/utils/audioBufferRegistry.ts')).audioBufferRegistry;
      const orig = st.tracks.find(t => t.id === src).clips[0];
      const ob = orig.buffer || reg.get(orig.bufferId);
      const stems = st.tracks.filter(t => /\\(stem\\)$/.test(t.name)).map(t => t.clips[0]).map(c => c.buffer || reg.get(c.bufferId));
      let num = 0, den = 0;
      for (let c = 0; c < ob.numberOfChannels; c++) { const o = ob.getChannelData(c);
        for (let i = 0; i < o.length; i++) { let s = 0; for (const b of stems) s += b.getChannelData(c)[i]; num += o[i] * o[i]; den += (o[i] - s) ** 2; } }
      return { db: den ? 10 * Math.log10(den / num) : -999, longueurs: stems.map(b => b.length), original: ob.length, n: stems.length };
    }""", src_track)


def dialog_overlap(page, name):
    r = balayage_chevauchement(page, "[data-testid=stems-dialog]")
    check(f"{name} : aucun bouton de la fenêtre recouvert", not r.get("recouverts"), r.get("recouverts"))


def model_cached(page):
    return page.evaluate("async () => (await window.__novaAppModule('/services/StemsWeb.ts')).webModelCached()")


# ─── A. bureau, carte graphique ───────────────────────────────────────────────────

def scenario_a(page, log, r, vp):
    open_dialog(page, vp, "A1")
    wait_ready(page)
    backend = page.get_by_test_id("stems-web-backend").get_attribute("data-backend")
    r["backend"] = backend
    check("A : WebGPU détecté (carte graphique annoncée)", backend == "webgpu", backend)
    size = page.get_by_test_id("stems-web-size").inner_text()
    check("A : taille du 1er téléchargement annoncée (≈ 252 Mo)", re.search(r"25\d Mo", size) is not None, size)
    txt = page.get_by_test_id("stems-web").inner_text()
    check("A : 6 stems et voix lead / chœurs renvoyés vers Nova Studio", "6 stems" in txt and "voix lead" in txt.lower() and "Nova Studio" in txt, txt[:300])
    check("A : crédit des licences affiché (Meta MIT, Microsoft MIT)", "Meta (licence MIT)" in txt and "Microsoft (licence MIT)" in txt)
    shot(page, "A1_bureau_sombre_pret")
    dialog_overlap(page, "A1")

    # Annuler pendant le téléchargement
    n0 = len(state(page))
    page.get_by_test_id("stems-start").click()
    page.get_by_text(re.compile("Téléchargement du modèle : \\d")).first.wait_for(timeout=30000)
    page.wait_for_timeout(500)
    shot(page, "A2_telechargement")
    lab = page.get_by_test_id("stems-web-progress").inner_text()
    r["telechargement"] = lab
    page.get_by_test_id("stems-web-cancel").click()
    page.get_by_test_id("stems-cancelled").wait_for(timeout=8000)
    shot(page, "A3_annule")
    check("A : Annuler pendant le téléchargement → « aucune piste ajoutée »", len(state(page)) == n0, len(state(page)))
    check("A : modèle à moitié téléchargé jamais gardé", model_cached(page) == 0)

    # 2 stems de bout en bout
    t0 = time.time()
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-web-running").wait_for(timeout=10000)
    # Sur une grosse carte graphique, 12 s se séparent en ~2 s : on capture la barre si on la voit passer.
    seen = None
    for _ in range(600):
        if page.get_by_test_id("stems-web-done").count():
            break
        lab = page.get_by_test_id("stems-web-progress").inner_text() if page.get_by_test_id("stems-web-progress").count() else ""
        if "Séparation sur la carte graphique" in lab and not seen:
            seen = lab
            shot(page, "A4_separation_en_cours")
        page.wait_for_timeout(100)
    r["barre_vue"] = seen
    page.get_by_test_id("stems-web-done").wait_for(timeout=300000)
    r["deux_stems_s"] = round(time.time() - t0, 1)
    shot(page, "A5_deux_stems_faits")
    done = page.get_by_test_id("stems-web-done").inner_text()
    r["resume_2"] = done
    check("A : résumé « 2 pistes ajoutées … carte graphique »", "2 pistes ajoutées" in done and "carte graphique" in done, done)
    sts = stem_tracks(page)
    names = [t["name"] for t in sts]
    check("A : pistes « Voix (stem) » et « Instru (stem) »", names == ["Voix (stem)", "Instru (stem)"], names)
    src = next(t for t in state(page) if t["id"] == "beat")
    sc = src["clips"][0]
    aligned = all(abs(t["clips"][0]["start"] - sc["start"]) < 1e-9 and abs(t["clips"][0]["offset"] - sc["offset"]) < 1e-9
                  and abs(t["clips"][0]["duration"] - sc["duration"]) < 1e-9 for t in sts)
    check("A : stems calés sur le clip (début, découpe, durée)", aligned, {"src": sc, "stems": [t["clips"][0] for t in sts]})
    check("A : clip d'origine coupé (pas effacé)", sc["muted"] is True, sc)
    s = sum_check(page)
    r["somme_2"] = s
    check("A : somme des stems = clip (≤ -100 dB), longueurs identiques", s["db"] < -100 and all(x == s["original"] for x in s["longueurs"]), s)
    check("A : modèle gardé sur l'appareil après la 1re séparation", model_cached(page) > 240e6)

    # Fenêtre rouverte : modèle en cache, 4 stems
    close_dialog(page)
    open_dialog(page, vp, "A6")
    wait_ready(page)
    cached_txt = page.get_by_test_id("stems-web-cached").inner_text()
    check("A : « modèle déjà sur cet appareil » à la 2e ouverture", "déjà sur cet appareil" in cached_txt, cached_txt)
    page.get_by_test_id("stems-choice-4").click()
    shot(page, "A6_quatre_stems_pret_cache")
    t0 = time.time()
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-web-done").wait_for(timeout=300000)
    r["quatre_stems_s_avec_cache"] = round(time.time() - t0, 1)
    shot(page, "A7_quatre_stems_faits")
    names = [t["name"] for t in stem_tracks(page)]
    check("A : 4 stems ajoutés sous le clip (voix, batterie, basse, autres)", names[:4] == ["Voix (stem)", "Batterie (stem)", "Basse (stem)", "Autres (stem)"], names)
    midi = page.get_by_test_id("stems-midi").inner_text() if page.get_by_test_id("stems-midi").count() else ""
    check("A : « Basse → MIDI » proposé après la séparation", "Basse → MIDI" in midi, midi)
    dialog_overlap(page, "A7")
    close_dialog(page)

    # Palette Ctrl+K : la commande existe (Nova, le chat, y a donc accès)
    page.keyboard.press("Control+k")
    page.wait_for_timeout(500)
    page.keyboard.type("séparer stems")
    page.wait_for_timeout(600)
    pal = page.evaluate("() => document.body.innerText")
    check("A : palette Ctrl+K « Séparer le clip en stems »", "Séparer le clip en stems" in pal)
    shot(page, "A8_palette")
    page.keyboard.press("Escape")
    errs = [e for e in r.get("errors", [])]
    r["console_errors_pendant"] = [e["text"][:200] for e in log.errors()][:10]


# ─── C. bureau sans WebGPU : repli processeur ────────────────────────────────────────

def scenario_c(page, log, r, vp):
    open_dialog(page, vp, "C1")
    wait_ready(page)
    b = page.get_by_test_id("stems-web-backend")
    txt = b.inner_text()
    check("C : sans WebGPU → calcul sur le processeur annoncé, plus lent", b.get_attribute("data-backend") == "wasm" and "processeur" in txt and "lent" in txt, txt)
    shot(page, "C1_sans_webgpu_pret")
    t0 = time.time()
    page.get_by_test_id("stems-start").click()
    page.get_by_text(re.compile("Séparation sur le processeur")).first.wait_for(timeout=120000)
    page.wait_for_timeout(1500)
    shot(page, "C2_processeur_en_cours")
    page.get_by_test_id("stems-web-done").wait_for(timeout=600000)
    r["deux_stems_processeur_s"] = round(time.time() - t0, 1)
    done = page.get_by_test_id("stems-web-done").inner_text()
    check("C : 2 stems faits sur le processeur", "2 pistes ajoutées" in done and "processeur" in done, done)
    s = sum_check(page)
    check("C : somme des stems = clip", s["db"] < -100, s)
    shot(page, "C3_processeur_fait")


# ─── D. téléphone ───────────────────────────────────────────────────────────────────

def scenario_d_weak(page, log, r, vp):
    open_dialog(page, vp, "D1")
    wait_ready(page)
    weak = page.get_by_test_id("stems-web-weak")
    check("D : téléphone sans WebGPU → conseil « Séparer sur ton PC (Nova Studio) »", weak.count() == 1 and "Séparer sur ton PC" in weak.inner_text(), weak.inner_text() if weak.count() else None)
    check("D : bouton « Séparer » grisé tant qu'on n'a pas choisi « Essayer quand même »", page.get_by_test_id("stems-start").is_disabled())
    shot(page, "D1_tel_sombre_conseil_pc")
    ov = overflow_report(page)
    check("D : aucun débordement horizontal au téléphone", not any(o["kind"] == "page-hscroll" for o in ov), ov[:5])
    dialog_overlap(page, "D1")
    page.get_by_test_id("stems-web-force").tap()
    page.wait_for_timeout(300)
    check("D : « Essayer quand même » rend le bouton actif", not page.get_by_test_id("stems-start").is_disabled())


def scenario_d_cell(page, log, r, vp):
    open_dialog(page, vp, "D2")
    wait_ready(page)
    warn = page.get_by_test_id("stems-web-warning")
    check("D : téléphone avec WebGPU → mise en garde mémoire (enregistrer avant)", warn.count() == 1 and "Enregistre ton projet" in warn.inner_text())
    shot(page, "D2_tel_webgpu_pret")
    page.get_by_test_id("stems-start").tap()
    page.get_by_test_id("stems-web-cellular").wait_for(timeout=5000)
    t = page.get_by_test_id("stems-web-cellular").inner_text()
    check("D : réseau mobile → confirmation avant le téléchargement (taille annoncée)", "réseau mobile" in t and re.search(r"25\d Mo", t) is not None, t)
    shot(page, "D3_tel_reseau_mobile")
    dialog_overlap(page, "D3")
    page.get_by_test_id("stems-web-wait-wifi").tap()
    page.wait_for_timeout(300)
    check("D : « Attendre le Wi-Fi » : rien n'est téléchargé, retour à la fenêtre", page.get_by_test_id("stems-web").count() == 1 and model_cached(page) == 0)


# ─── E. thème clair ─────────────────────────────────────────────────────────────────

def scenario_e_desk(page, log, r, vp):
    open_dialog(page, vp, "E1")
    wait_ready(page)
    shot(page, "E1_bureau_clair_pret")
    bg = page.evaluate("() => getComputedStyle(document.querySelector('[data-testid=stems-dialog] > div')).backgroundColor")
    r["fond_fenetre"] = bg
    check("E : fenêtre claire en thème clair", bg not in ("rgb(0, 0, 0)",) and sum(int(x) for x in re.findall(r"\d+", bg)[:3]) > 450, bg)
    dialog_overlap(page, "E1")


def scenario_e_tel(page, log, r, vp):
    open_dialog(page, vp, "E2")
    wait_ready(page)
    shot(page, "E2_tel_clair_conseil_pc")
    dialog_overlap(page, "E2")


# ─── F. licence ───────────────────────────────────────────────────────────────────

def scenario_f(page, log, r, vp):
    engine_reqs = []
    page.on("request", lambda rq: engine_reqs.append(rq.url) if ("jsdelivr" in rq.url or "huggingface" in rq.url) else None)

    def billing(route):
        try:
            body = json.loads(route.request.post_data or "{}")
        except ValueError:
            body = {}
        ids = body.get("catalog_ids") or []
        if body.get("action") == "export_access":
            d = {"unlocked": False, "via": None, "reason": "catalogue_non_achete", "missing": [{"id": i, "title": "Beat QA", "kind": "beat"} for i in ids],
                 "items": [{"id": i, "title": "Beat QA", "kind": "beat", "owned": False} for i in ids]}
        else:
            d = {"plans": [], "admin": False, "free_exports_left": 0}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(d))
    page.route("**/functions/v1/nova-billing", billing)
    open_dialog(page, vp, "F1")
    page.get_by_test_id("stems-licence-refused").wait_for(timeout=15000)
    shot(page, "F1_beat_non_achete")
    check("F : beat du catalogue non acheté → refus, comme l'export", "achète sa licence" in page.get_by_test_id("stems-licence-refused").inner_text())
    check("F : aucun moteur ni modèle téléchargé", not engine_reqs, engine_reqs[:3])


SCENARIOS = {
    "A": [(scenario_a, "pc1366", "A_bureau_sombre_webgpu", (theme("dark"),), PROJECT)],
    "C": [(scenario_c, "pc1366", "C_bureau_sans_webgpu", (theme("dark"), NO_GPU), PROJECT)],
    "D": [(scenario_d_weak, "tel390", "D_tel_sans_webgpu", (theme("dark"), NO_GPU, MOBILE), PROJECT),
          (scenario_d_cell, "tel390", "D_tel_webgpu_4g", (theme("dark"), MOBILE, CELLULAR), PROJECT)],
    "E": [(scenario_e_desk, "pc1366", "E_bureau_clair", (theme("light"),), PROJECT),
          (scenario_e_tel, "tel390", "E_tel_clair", (theme("light"), NO_GPU, MOBILE), PROJECT)],
    "F": [(scenario_f, "pc1366", "F_licence_beat", (theme("dark"),), PROJECT_CAT)],
}


def main():
    make_project(PROJECT)
    make_project(PROJECT_CAT, catalogue=True)
    srv = start_files()
    todo = [a.upper() for a in sys.argv[1:]] or list(SCENARIOS)
    try:
        for k in todo:
            for fn, vp, name, inits, proj in SCENARIOS[k]:
                print(f"--- {name}", flush=True)
                r = run(fn, vp, name, inits, proj)
                errs = [e for e in r["errors"] if "favicon" not in e]
                check(f"{name} : aucune erreur dans la console", not errs, errs[:5])
    finally:
        srv.shutdown()
    ok = all(c["ok"] for c in checks)
    (OUT / "stems_web.json").write_text(json.dumps({"ok": ok, "checks": checks, "resultats": res}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{sum(c['ok'] for c in checks)}/{len(checks)} vérifications OK → {OUT / 'stems_web.json'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
