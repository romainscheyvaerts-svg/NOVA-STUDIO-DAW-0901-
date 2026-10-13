"""R24 · Voix par l'IA locale, de bout en bout avec le VRAI pont (nova_bridge_server.py) et le
VRAI module voix installé sur ce PC (%LOCALAPPDATA%\\NovaStudio\\voice : DeepFilterNet 3,
Whisper large-v3-turbo sur la carte graphique). Navigateur headless, aucune fenêtre.

Usage (serveur NOVA lancé : npx vite --port 3478 --strictPort) :
  NOVA_URL=http://127.0.0.1:3478/ python qa/voix_ia_locale.py

  A. site sans pont (PC)          → commandes visibles mais grisées « Disponible dans Nova Studio sur PC »
  B. appli, module absent          → taille annoncée, installation réelle du retrait de réverbe (barre),
                                     installation de la transcription lancée puis annulée
  C. appli, module installé        → retirer la réverbe (dosage, avant / après, Appliquer = AudioSuite,
                                     Revenir à l'original), transcrire (prompteur calé sur la voix, texte
                                     au-dessus du clip, correction qui garde les temps)
  D. thème clair (appli) et téléphone (site) : la transcription s'affiche au prompteur

La voix : une prise sèche de « Silence blanc » (cabine du studio) passée dans une vraie réverbe
de salon (RT60 0,8 s à 2 m) ; on a donc la version sèche pour mesurer ce qui reste de réverbe.
"""
import io, json, os, re, subprocess, sys, tempfile, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r24\scenario")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3478/")
from qalib import *  # noqa
from gel_pre_effet import fake_login, open_project_file, save_zip  # noqa
from stems_separation import prepare, start_bridge, stop_bridge, dismiss_popups  # noqa

ROOT = Path(__file__).resolve().parents[1]
DEVERB_DIR = Path(r"D:\1 WORK\CONTENU\nova-r24\deverb")
SR = 48000
CLIP_START = 2.0


def make_voice():
    """Prise sèche + réverbe de salon (fichiers de la comparaison : deverb_eval.py)."""
    import soundfile as sf
    from scipy.signal import fftconvolve
    from math import gcd
    from scipy.signal import resample_poly
    x, sr = sf.read(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files\REC_48.wav", dtype="float32", always_2d=True)
    x = x.mean(1)
    g = gcd(sr, SR)
    dry = resample_poly(x, SR // g, sr // g).astype(np.float32)
    ir, _ = sf.read(str(DEVERB_DIR / "ri_salon_RT60_0.8s_2m.wav"), dtype="float32")
    p = int(np.argmax(np.abs(ir)))
    wet = fftconvolve(dry, ir)[p: p + len(dry)].astype(np.float32)
    k = 0.5 / max(1e-9, np.abs(wet).max())
    return dry * k, wet * k


def wav_bytes(mono):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project(path: Path, wet):
    clip = {"id": "voix-clip", "name": "Voix (pièce)", "type": "AUDIO", "audioRef": "audio/voix.wav", "color": "#f472b6",
            "fadeIn": 0, "fadeOut": 0, "gain": 1.0, "start": CLIP_START, "offset": 0.0, "duration": round(len(wet) / SR, 3)}
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    state = {
        "id": "proj-voix-ia", "name": "Test voix IA", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [{**base, "id": "lead", "name": "Lead", "type": "AUDIO", "color": "#f472b6", "clips": [clip]}],
        "trackGroups": [],
        "markers": [{"id": "m-couplet", "name": "Couplet", "time": CLIP_START, "type": "MARKER", "color": "#22d3ee", "number": 1},
                    {"id": "m-refrain", "name": "Refrain", "time": CLIP_START + 14.2, "type": "MARKER", "color": "#f472b6", "number": 2}],
        "selectedTrackId": "lead", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "lyrics": "",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", wav_bytes(wet))


def clip_menu(page, label, pattern):
    """Clic droit sur le clip voix (dessiné : on vise la piste « Lead »), renvoie l'entrée voulue.
    Une fenêtre qui s'ouvre toute seule (autotune du PC, prise en main) est refermée avant."""
    for attempt in range(4):
        dismiss_popups(page, 3000 if attempt else 6000)
        y = None
        for _ in range(40):
            y = page.evaluate("""() => { for (const e of document.querySelectorAll('span, div')) {
                if (e.children.length || (e.textContent || '').trim() !== 'Lead') continue;
                const r = e.getBoundingClientRect(); if (r.x > 320 && r.x < 620 && r.height) return r.y; } return null; }""")
            if y:
                break
            page.wait_for_timeout(500)
        page.mouse.click(900, y + 60, button="right")
        page.wait_for_timeout(500)
        item = page.get_by_role("button", name=re.compile(pattern)).first
        try:
            item.wait_for(state="attached", timeout=3000)
            item.scroll_into_view_if_needed(timeout=3000)
            if item.is_visible():
                break
        except Exception:
            pass
        page.keyboard.press("Escape")
        page.wait_for_timeout(800)
    if label:
        shot(page, f"{label}_menu")
    return item


def open_voice(page, label, pattern, ready_testid):
    item = clip_menu(page, label, pattern)
    item.click()
    page.get_by_test_id("voice-dialog").wait_for(timeout=8000)
    if ready_testid:
        page.get_by_test_id(ready_testid).wait_for(timeout=30000)
    page.wait_for_timeout(500)


def open_prompter(page):
    b = page.locator('[data-nova-target="lyrics"]').locator("visible=true")
    if b.count():
        b.first.click()
    else:
        nav = page.get_by_role("button", name="Paroles", exact=True).locator("visible=true")
        if nav.count():
            nav.first.click()
        else:
            page.evaluate("window.dispatchEvent(new CustomEvent('nova:open-lyrics'))")
    page.get_by_role("region", name="Prompteur de paroles").wait_for(timeout=8000)
    page.wait_for_timeout(600)


# ─── A. site sans pont ─────────────────────────────────────────────────────────

def scenario_web(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "A0_projet_web")
    dv = clip_menu(page, "A1_web", "Retirer la réverbe")
    tx = page.get_by_role("button", name=re.compile("Transcrire les paroles")).first
    res["reverbe"] = {"grise": dv.is_disabled(), "infobulle": dv.get_attribute("title")}
    res["transcrire"] = {"grise": tx.is_disabled(), "infobulle": tx.get_attribute("title")}
    tx.scroll_into_view_if_needed()
    shot(page, "A2_web_commandes_grisees")
    page.keyboard.press("Escape")


# ─── B. module absent ──────────────────────────────────────────────────────────

def scenario_install(page, log, res, vp):
    prepare(page, port=PORT_EMPTY)
    open_project_file(page, PROJECT, res, "B0_projet")
    open_voice(page, "B1", "Retirer la réverbe", "voice-not-installed")
    shot(page, "B2_reverbe_module_absent")
    res["bouton_reverbe"] = page.get_by_test_id("voice-install").inner_text()
    page.get_by_test_id("voice-install").click()
    page.get_by_test_id("voice-installing").wait_for(timeout=15000)
    page.wait_for_timeout(2500)
    shot(page, "B3_reverbe_installation_en_cours")
    res["progression"] = page.get_by_test_id("voice-installing").inner_text()[:160]
    t0 = time.time()
    page.get_by_test_id("voice-ready").wait_for(timeout=600000)
    res["installation_reverbe_s"] = round(time.time() - t0, 1)
    shot(page, "B4_reverbe_installee")
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    # Transcription : installation lancée puis annulée.
    open_voice(page, None, "Transcrire les paroles", "voice-not-installed")
    res["bouton_transcription"] = page.get_by_test_id("voice-install").inner_text()
    shot(page, "B5_transcription_module_absent")
    page.get_by_test_id("voice-install").click()
    page.get_by_test_id("voice-installing").wait_for(timeout=15000)
    page.wait_for_timeout(6000)
    shot(page, "B6_transcription_installation_en_cours")
    page.get_by_role("button", name="Annuler l’installation").click()
    page.get_by_test_id("voice-not-installed").wait_for(timeout=60000)
    page.wait_for_timeout(500)
    shot(page, "B7_transcription_installation_annulee")
    res["apres_annulation"] = page.get_by_test_id("voice-not-installed").inner_text()[-140:]


# ─── C. module installé ────────────────────────────────────────────────────────

def project_json(page, name):
    data, files = save_zip(page, OUT / f"{name}.zip")
    return data, files


def scenario_real(page, log, res, vp):
    prepare(page, port=PORT_REAL)
    open_project_file(page, PROJECT, res, "C0_projet")
    # --- Retirer la réverbe ---
    open_voice(page, "C1", "Retirer la réverbe", "voice-ready")
    shot(page, "C2_reverbe_prete")
    page.get_by_test_id("voice-start").click()
    page.get_by_test_id("voice-running").wait_for(timeout=15000)
    page.wait_for_timeout(1500)
    shot(page, "C3_reverbe_calcul")
    t0 = time.time()
    page.get_by_test_id("voice-deverb-ready").wait_for(timeout=600000)
    res["reverbe_calcul_s"] = round(time.time() - t0, 1)
    res["reverbe_message"] = page.get_by_test_id("voice-deverb-ready").inner_text()[:200]
    res["dosage_defaut"] = page.get_by_test_id("voice-amount-value").inner_text()
    page.get_by_test_id("voice-play").click()
    page.wait_for_timeout(1200)
    page.get_by_test_id("voice-before").click()
    page.wait_for_timeout(800)
    shot(page, "C4_ecoute_avant")
    page.get_by_test_id("voice-after").click()
    page.wait_for_timeout(800)
    shot(page, "C5_ecoute_apres_80")
    page.get_by_test_id("voice-play").click()  # stop
    page.get_by_test_id("voice-apply").click()
    page.get_by_test_id("voice-dialog").wait_for(state="detached", timeout=10000)
    page.wait_for_timeout(1500)
    shot(page, "C6_reverbe_appliquee")
    data, files = project_json(page, "C_apres_reverbe")
    c = data["tracks"][0]["clips"][0]
    res["clip_apres"] = {"nom": c["name"], "audioSuite": c.get("audioSuite", {}).get("steps"), "son": c.get("audioRef"),
                         "original_garde": c.get("audioSuite", {}).get("sourceRef")}
    with zipfile.ZipFile(OUT / "C_apres_reverbe.zip") as z:
        raw = z.read(c["audioRef"])
    res["mesures_reverbe"] = measure_deverb(raw, c)
    # Revenir à l'original (menu du clip)
    clip_menu(page, None, "Revenir à l’original \\(AudioSuite\\)").click()
    page.wait_for_timeout(1500)
    data, _ = project_json(page, "C_apres_retour")
    c = data["tracks"][0]["clips"][0]
    res["clip_retour"] = {"nom": c["name"], "audioSuite": "audioSuite" in c}
    # --- Transcrire ---
    open_voice(page, "C7", "Transcrire les paroles", "voice-ready")
    shot(page, "C8_transcription_prete")
    res["langue_defaut"] = page.locator('input[name="voice-lang"]:checked').evaluate("e => e.parentElement.innerText")
    page.get_by_test_id("voice-start").click()
    t0 = time.time()
    page.get_by_test_id("voice-running").wait_for(timeout=15000)
    page.wait_for_timeout(800)
    shot(page, "C9_transcription_calcul")
    page.get_by_test_id("voice-open-prompter").wait_for(timeout=600000)
    res["transcription_s"] = round(time.time() - t0, 1)
    res["transcription_resume"] = page.get_by_test_id("voice-ready").inner_text()[:220]
    shot(page, "C10_transcription_faite")
    page.get_by_test_id("voice-open-prompter").click()
    page.get_by_role("region", name="Prompteur de paroles").wait_for(timeout=8000)
    page.wait_for_timeout(800)
    shot(page, "C11_prompteur_cale")
    res["prompteur_cale"] = page.get_by_test_id("prompter-voice-sync").count() > 0
    # Lecture : le texte défile quand il est chanté (mot chanté surligné).
    page.keyboard.press("Space")
    page.wait_for_timeout(9000)
    shot(page, "C12_prompteur_pendant_la_lecture")
    page.keyboard.press("Space")
    page.wait_for_timeout(600)
    data, _ = project_json(page, "C_apres_transcription")
    c = data["tracks"][0]["clips"][0]
    tr = c.get("transcript") or {}
    res["paroles"] = data.get("lyrics", "")
    res["transcription_clip"] = {"mots": len(tr.get("words", [])), "langue": tr.get("language"), "modele": tr.get("model"),
                                 "texte_sur_le_clip": tr.get("show"), "son": tr.get("bufferId")}
    res["premiers_mots"] = [(w["w"], w["s"]) for w in tr.get("words", [])[:8]]
    # Correction par l'artiste : « place » → « plage » ; les temps suivent.
    open_prompter(page)
    page.get_by_role("button", name="Modifier les paroles").click()
    ta = page.locator("textarea").locator("visible=true").first
    txt = ta.input_value()
    ta.fill(txt.replace("place", "plage", 1))
    page.get_by_role("button", name=re.compile("Prêt")).click()
    page.wait_for_timeout(800)
    shot(page, "C13_prompteur_corrige")
    data, _ = project_json(page, "C_apres_correction")
    tr2 = data["tracks"][0]["clips"][0].get("transcript") or {}
    old = [w for w in tr.get("words", []) if "place" in w["w"].lower()]
    new = [w for w in tr2.get("words", []) if "plage" in w["w"].lower()]
    res["correction"] = {"mot_avant": old[:1], "mot_apres": new[:1],
                         "meme_temps": bool(old and new and abs(old[0]["s"] - new[0]["s"]) < 1e-6),
                         "toujours_cale": page.get_by_test_id("prompter-voice-sync").count() > 0}
    # Texte au-dessus du clip : la capture de la fenêtre d'édition.
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    shot(page, "C14_texte_au_dessus_du_clip")


def measure_deverb(raw, clip):
    """Voix rendue par NOVA après « Appliquer » (80 %) vs voix sèche et voix de la pièce."""
    sys.path.insert(0, r"D:\1 WORK\CONTENU\nova-r24\scripts")
    import deverb_eval as d
    with wave.open(io.BytesIO(raw)) as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        y = np.frombuffer(w.readframes(n), "<i2").astype(np.float32).reshape(-1, ch).mean(1) / 32768
    off = int(round(clip.get("offset", 0) * sr))
    y = y[off: off + len(WET)]
    ends = d.phrase_ends(DRY)
    return {"sample_rate": sr, "decalage_debut_ech": off,
            "queue_db": {"seche": d.r1(d.tail_db(DRY, ends)[0]), "piece_avant": d.r1(d.tail_db(WET, ends)[0]), "apres_nova_80": d.r1(d.tail_db(y, ends)[0])},
            "c50_db": {"piece_avant": d.r1(d.c50(WET, DRY)), "apres_nova_80": d.r1(d.c50(y, DRY))},
            "lsd_db": {"piece_avant": d.r1(d.lsd(WET, DRY)), "apres_nova_80": d.r1(d.lsd(y, DRY))}}


# ─── D. thème clair et téléphone ───────────────────────────────────────────────

def scenario_light(page, log, res, vp):
    page.add_init_script("try { localStorage.setItem('nova_theme', 'light') } catch (e) {}")
    prepare(page, port=PORT_REAL)
    open_project_file(page, OUT / "C_apres_correction.zip", res, "D0_clair_projet")
    shot(page, "D1_clair_texte_au_dessus_du_clip")
    open_voice(page, None, "Transcrire les paroles", "voice-ready")
    shot(page, "D2_clair_transcription")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    open_voice(page, None, "Retirer la réverbe", "voice-ready")
    shot(page, "D3_clair_reverbe")
    page.keyboard.press("Escape")
    open_prompter(page)
    shot(page, "D4_clair_prompteur")
    res["theme"] = page.evaluate("document.documentElement.getAttribute('data-theme')")


def scenario_phone(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, OUT / "C_apres_correction.zip", res, "E0_tel_projet")
    open_prompter(page)
    shot(page, "E1_tel_prompteur")
    res["prompteur_cale"] = page.get_by_test_id("prompter-voice-sync").count() > 0
    page.evaluate("async () => { const m = await window.__novaAppModule('/engine/AudioEngine.ts'); }")
    play = page.get_by_role("button", name=re.compile("^(Lecture|Lire)")).locator("visible=true")
    if play.count():
        play.first.click()
    else:
        page.keyboard.press("Space")
    page.wait_for_timeout(8000)
    shot(page, "E2_tel_prompteur_lecture")
    res["lignes_visibles"] = page.get_by_role("region", name="Prompteur de paroles").inner_text()[:400]


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    DRY, WET = make_voice()
    PROJECT = OUT / "projet_voix_ia.zip"
    make_project(PROJECT, WET)
    PORT_REAL, PORT_EMPTY = 8781, 8780
    only = set(sys.argv[1:])
    report = {}
    if not only or "A" in only:
        report["A_web"] = run_one(scenario_web, "pc", "A_web")
    if not only or "B" in only:
        empty = Path(tempfile.mkdtemp(prefix="nova-voix-vide-"))
        os.environ["NOVA_VOICE_HOME"] = str(empty)
        br = start_bridge(PORT_EMPTY)
        try:
            report["B_installation"] = run_one(scenario_install, "pc", "B_installation")
        finally:
            stop_bridge(br)
            os.environ.pop("NOVA_VOICE_HOME", None)
            time.sleep(2)
            report["B_installation"]["dossier_temp_mo"] = round(sum(f.stat().st_size for f in empty.rglob("*") if f.is_file()) / 1e6)
            import shutil
            shutil.rmtree(empty, ignore_errors=True)
    if not only or "C" in only or "D" in only:
        br = start_bridge(PORT_REAL)
        try:
            if not only or "C" in only:
                report["C_reel"] = run_one(scenario_real, "pc", "C_reel")
            if not only or "D" in only:
                report["D_clair"] = run_one(scenario_light, "pc", "D_clair")
        finally:
            stop_bridge(br)
    if not only or "E" in only or "D" in only:
        report["E_telephone"] = run_one(scenario_phone, "tel", "E_telephone")
    (OUT / f"qa_voix_ia{'_' + ''.join(sorted(only)) if only else ''}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1))
