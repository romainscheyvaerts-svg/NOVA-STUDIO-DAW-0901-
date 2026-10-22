"""B7 (reprise de R24) · Voix par l'IA locale, de bout en bout avec le VRAI pont
(nova_bridge_server.py du worktree, port de test 8803) et le VRAI module voix installé sur ce PC
(%LOCALAPPDATA%\\NovaStudio\\voice : Whisper large-v3-turbo sur la carte graphique, DeepFilterNet 3
+ retrait de la réverbe tardive). Navigateurs headless, aucune fenêtre, Supabase simulé
(qa_hors_prod via qalib) : jamais la production.

Usage (serveur NOVA lancé : npx vite --port 3441 --strictPort) :
  NOVA_URL=http://127.0.0.1:3441/ python qa/voix_ia_locale.py [A B C D E]

  A. site sans pont (PC)        → menu Voix du clip et menu de piste : commandes grisées, raison en infobulle
  B. appli, module absent        → taille annoncée, installation lancée : barre de progression, puis annulée
  C. appli, module installé      → transcrire une PISTE (3 clips, dont une prise mutée) sur la carte graphique,
                                   prompteur calé, parole corrigée à la main (les temps suivent),
                                   recherche d'un mot : champ du prompteur et palette Ctrl+K (« trouver "j'arrive" »)
                                   → la tête de lecture saute sur le mot (vérité : horodatage de la synthèse vocale),
                                   déréverbération d'une prise (100 %), Ctrl+Z / Ctrl+Y, « Revenir à l'original »,
                                   mesure de la réverbe retirée sur le son rendu par NOVA (voix sèche connue)
  D. thème clair (appli)         → projet rouvert (sauvegarde) : texte sur les clips, prompteur, recherche
  E. téléphone 390 × 844 (site)  → projet rouvert : prompteur calé, recherche d'un mot au doigt, saut

Matériel de test :
  - Prise 1 / Prise 2 (mutée) : vraies prises rap sèches du studio (REC_224 / REC_230, même couplet) ;
  - « Message » : phrase de synthèse vocale Windows avec l'horodatage exact de chaque mot (« j'arrive » à 1,770 s) ;
  - « Voix pièce » : prise sèche de « Silence blanc » passée dans une vraie réverbe de salon (RT60 0,8 s à 2 m) :
    la version sèche sert à mesurer ce qui reste de réverbe.
Sortie : D:\\1 WORK\\CONTENU\\nova-r24\\scenario (QA_OUT) ; code 0 si toutes les vérifications passent.
"""
import io, json, os, re, shutil, subprocess, sys, tempfile, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r24\scenario")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3441/")
from qalib import *  # noqa
from qalib import OUT, run_one, shot, menu_pick  # noqa
from gel_pre_effet import open_project_file, save_zip  # noqa
from stems_separation import prepare, start_bridge, stop_bridge, dismiss_popups  # noqa

ROOT = Path(__file__).resolve().parents[1]
R24 = Path(r"D:\1 WORK\CONTENU\nova-r24")
SESSION = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")
PORT = int(os.environ.get("QA_VOIX_PORT", "8803"))
SR = 48000
T_LEAD = 2.0      # prises rap
T_MSG = 32.0      # phrase « j'arrive »
T_ROOM = 2.0      # voix dans la pièce (piste à part)
TTS_WAV = R24 / "tts" / "jarrive.wav"


# ─── Matériel ──────────────────────────────────────────────────────────────────

def load48(path):
    import soundfile as sf
    from math import gcd
    from scipy.signal import resample_poly
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    x = x.mean(1)
    if sr != SR:
        g = gcd(sr, SR)
        x = resample_poly(x, SR // g, sr // g).astype(np.float32)
    return x


def make_room_voice():
    """Prise sèche + réverbe de salon (fichiers de la comparaison R24 : deverb_eval.py)."""
    import soundfile as sf
    from scipy.signal import fftconvolve
    dry = load48(SESSION / "REC_48.wav")
    ir, _ = sf.read(str(R24 / "deverb" / "ri_salon_RT60_0.8s_2m.wav"), dtype="float32")
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


# SAPI donne la position comme si le son était à 16 kHz alors que le fichier est écrit à 22,05 kHz
# (même correction que le corpus R24, scripts/tts_corpus.py).
SAPI_POS_SCALE = 16000 / 22050


def tts_truth():
    words = json.loads(Path(str(TTS_WAV) + ".json").read_text(encoding="utf-8-sig"))
    return {w["w"]: w["t"] * SAPI_POS_SCALE for w in words}


def make_project(path: Path):
    p1 = load48(SESSION / "REC_224.wav")
    p2 = load48(SESSION / "REC_230.wav")
    msg = load48(TTS_WAV)
    p1 *= 0.5 / max(1e-9, np.abs(p1).max())
    p2 *= 0.5 / max(1e-9, np.abs(p2).max())
    msg *= 0.5 / max(1e-9, np.abs(msg).max())
    dry, wet = make_room_voice()

    def clip(cid, name, ref, start, n, **kw):
        return {"id": cid, "name": name, "type": "AUDIO", "audioRef": ref, "color": "#f472b6", "fadeIn": 0, "fadeOut": 0,
                "gain": 1.0, "start": start, "offset": 0.0, "duration": round(n / SR, 3), **kw}
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    lead = {**base, "id": "lead", "name": "Lead", "type": "AUDIO", "color": "#f472b6",
            "clips": [clip("prise-1", "Prise 1", "audio/prise1.wav", T_LEAD, len(p1), takeNumber=1),
                      clip("prise-2", "Prise 2", "audio/prise2.wav", T_LEAD, len(p2), takeNumber=2, isMuted=True),
                      clip("message", "Message", "audio/message.wav", T_MSG, len(msg))],
            "takeMeta": [{"n": 1, "name": "Prise 1"}, {"n": 2, "name": "Prise 2"}]}
    room = {**base, "id": "room", "name": "Voix pièce", "type": "AUDIO", "color": "#22d3ee",
            "clips": [clip("voix-piece", "Voix (pièce)", "audio/piece.wav", T_ROOM, len(wet))]}
    state = {
        "id": "proj-voix-ia-b7", "name": "Test voix IA (B7)", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [lead, room], "trackGroups": [], "markers": [],
        "selectedTrackId": "lead", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "lyrics": "",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/prise1.wav", wav_bytes(p1))
        z.writestr("audio/prise2.wav", wav_bytes(p2))
        z.writestr("audio/message.wav", wav_bytes(msg))
        z.writestr("audio/piece.wav", wav_bytes(wet))
    return dry, wet


# ─── Gestes ───────────────────────────────────────────────────────────────────

# En-tête de piste de la fenêtre d'édition : le nom le plus à droite (la liste des pistes, à gauche,
# peut porter le même nom), à moins de 700 px du bord.
HEADER_JS = """(n) => { let best = null; for (const e of document.querySelectorAll('span, div')) {
    if (e.children.length || (e.textContent || '').trim() !== n) continue;
    const r = e.getBoundingClientRect(); if (!r.height || r.x > 700 || r.x < 0) continue;
    if (!best || r.x > best.x0) best = { x0: r.x, x: r.x + Math.min(20, r.width / 2), y: r.y + r.height / 2 }; } return best; }"""


def header_y(page, name):
    for _ in range(40):
        y = page.evaluate(HEADER_JS, name)
        y = y and y["y"]
        if y:
            return y
        page.wait_for_timeout(500)
    raise RuntimeError(f"piste « {name} » introuvable")


def header_x(page, name):
    return page.evaluate(HEADER_JS, name)["x"]


def clip_menu(page, track, x=900, dy=40):
    """Clic droit sur un clip de la piste `track` (clips dessinés : on vise la ligne de la piste)."""
    for attempt in range(4):
        dismiss_popups(page, 3000 if attempt else 6000)
        y = header_y(page, track)
        page.mouse.click(x, y + dy - 20)
        page.mouse.click(x, y + dy - 20, button="right")
        page.wait_for_timeout(500)
        if page.locator("[role=menu]").count():
            return
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)
    raise RuntimeError("menu du clip introuvable")


def track_menu(page, track):
    for attempt in range(4):
        dismiss_popups(page, 3000 if attempt else 6000)
        y = header_y(page, track)
        page.mouse.click(header_x(page, track), y, button="right")
        page.wait_for_timeout(500)
        if page.locator("[role=menu]").count():
            return
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)
    raise RuntimeError("menu de piste introuvable")


def menu_item(page, pattern):
    rx = re.compile(pattern)
    from qalib import menu_open_for
    menu_open_for(page, rx)
    return page.locator("[role=menu] button", has_text=rx).locator("visible=true").first


def open_voice(page, ready_testid):
    page.get_by_test_id("voice-dialog").wait_for(timeout=8000)
    if ready_testid:
        page.get_by_test_id(ready_testid).wait_for(timeout=30000)
    page.wait_for_timeout(500)


def open_prompter(page):
    if page.get_by_role("region", name="Prompteur de paroles").count():
        return
    page.evaluate("window.dispatchEvent(new CustomEvent('nova:open-lyrics'))")
    page.get_by_role("region", name="Prompteur de paroles").wait_for(timeout=8000)
    page.wait_for_timeout(600)


def playhead(page):
    return page.evaluate("async () => (await window.__novaAppModule('/utils/playheadStore.ts')).playheadStore.get()")


def project_json(page, name):
    return save_zip(page, OUT / f"{name}.zip")


# ─── A. site sans pont ─────────────────────────────────────────────────────────

def scenario_web(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "A0_projet_web")
    clip_menu(page, "Voix pièce")
    dv = menu_item(page, "Retirer la réverbe")
    tx = menu_item(page, "Transcrire les paroles")
    res["menu_clip"] = {"reverbe_grisee": dv.is_disabled(), "transcrire_grise": tx.is_disabled(), "infobulle": tx.get_attribute("title")}
    shot(page, "A1_web_menu_voix_grise")
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    track_menu(page, "Lead")
    it = menu_item(page, r"Transcrire les paroles de la piste")
    res["menu_piste"] = {"libelle": it.inner_text().strip(), "grise": it.is_disabled(), "infobulle": it.get_attribute("title")}
    shot(page, "A2_web_menu_piste_grise")
    page.keyboard.press("Escape")


# ─── B. module absent : installation (progression) puis annulation ────────────

def scenario_install(page, log, res, vp):
    prepare(page, port=PORT)
    open_project_file(page, PROJECT, res, "B0_projet")
    clip_menu(page, "Voix pièce")
    menu_item(page, "Transcrire les paroles").click()
    open_voice(page, "voice-not-installed")
    shot(page, "B1_transcription_module_absent")
    res["ecran_absent"] = page.get_by_test_id("voice-not-installed").inner_text()[:400]
    res["bouton"] = page.get_by_test_id("voice-install").inner_text()
    page.get_by_test_id("voice-install").click()
    page.get_by_test_id("voice-installing").wait_for(timeout=15000)
    pcts = []
    for _ in range(10):
        page.wait_for_timeout(1500)
        pb = page.locator("[data-testid=voice-installing] [role=progressbar]").first
        pcts.append((pb.get_attribute("aria-valuenow"), page.get_by_test_id("voice-installing").inner_text()[:120]))
    shot(page, "B2_installation_en_cours")
    res["progression"] = pcts
    page.get_by_role("button", name="Annuler l’installation").click()
    page.get_by_test_id("voice-not-installed").wait_for(timeout=90000)
    page.wait_for_timeout(500)
    shot(page, "B3_installation_annulee")
    res["apres_annulation"] = page.get_by_test_id("voice-not-installed").inner_text()[-200:]


# ─── C. module installé ────────────────────────────────────────────────────────

def bridge_log_tx():
    """Lignes « 📝 Transcription : X s, N mots en Y s (cuda) » du journal du pont."""
    txt = (OUT / f"pont-{PORT}.log").read_text(encoding="utf-8", errors="replace")
    return [{"audio_s": float(m.group(1)), "mots": int(m.group(2)), "calcul_s": float(m.group(3)), "materiel": m.group(4)}
            for m in re.finditer(r"Transcription : ([\d.]+) s, (\d+) mots en ([\d.]+) s \((\w+)\)", txt)]


def search_in_prompter(page, query, label):
    open_prompter(page)
    box = page.get_by_test_id("prompter-word-search")
    box.fill("")
    box.type(query, delay=30)
    page.get_by_test_id("prompter-word-results").wait_for(timeout=5000)
    page.wait_for_timeout(300)
    shot(page, label)
    return [h.inner_text() for h in page.get_by_test_id("prompter-word-hit").all()]


def scenario_real(page, log, res, vp):
    truth = tts_truth()
    prepare(page, port=PORT)
    open_project_file(page, PROJECT, res, "C0_projet")
    # --- 1. Transcrire toute la piste « Lead » (menu de piste) ---
    track_menu(page, "Lead")
    shot(page, "C1_menu_piste")
    it = menu_item(page, r"Transcrire les paroles de la piste")
    res["menu_piste"] = it.inner_text().strip()
    it.click()
    open_voice(page, "voice-ready")
    shot(page, "C2_transcription_prete")
    res["langue_defaut"] = page.locator('input[name="voice-lang"]:checked').evaluate("e => e.parentElement.innerText")
    page.get_by_test_id("voice-start").click()
    t0 = time.time()
    page.get_by_test_id("voice-running").wait_for(timeout=15000)
    page.wait_for_timeout(2500)
    shot(page, "C3_transcription_calcul")
    res["pendant_le_calcul"] = page.get_by_test_id("voice-running").inner_text()[:300]
    page.get_by_test_id("voice-open-prompter").wait_for(timeout=600000)
    res["transcription_interface_s"] = round(time.time() - t0, 1)
    res["transcription_resume"] = page.get_by_test_id("voice-ready").inner_text()[:300]
    shot(page, "C4_transcription_faite")
    res["pont_par_clip"] = bridge_log_tx()
    # --- 2. Prompteur calé sur la voix ---
    page.get_by_test_id("voice-open-prompter").click()
    page.get_by_role("region", name="Prompteur de paroles").wait_for(timeout=8000)
    page.wait_for_timeout(800)
    res["prompteur_cale"] = page.get_by_test_id("prompter-voice-sync").count() > 0
    shot(page, "C5_prompteur_cale")
    data, _ = project_json(page, "C_apres_transcription")
    lead = data["tracks"][0]
    tr = {c["id"]: c.get("transcript") or {} for c in lead["clips"]}
    res["transcriptions"] = {k: {"mots": len(v.get("words", [])), "langue": v.get("language"), "modele": v.get("model"),
                                 "texte": " ".join(w["w"] for w in v.get("words", []))[:400]} for k, v in tr.items()}
    res["paroles"] = data.get("lyrics", "")[:600]
    # Vérité de la synthèse : début transcrit de chaque mot vs horodatage exact (temps du son du clip).
    msg_words = tr.get("message", {}).get("words", [])
    ecarts = []
    for w in msg_words:
        k = re.sub(r"[^\w'’-]", "", w["w"]).replace("’", "'")
        cand = [t for name, t in truth.items() if name.lower() == k.lower()]
        if cand:
            ecarts.append(round((w["s"] - cand[0]) * 1000))
    res["horodatage_message_ms"] = ecarts
    # --- 3. Parole corrigée à la main (le mot garde son temps) ---
    open_prompter(page)
    page.get_by_role("button", name="Modifier les paroles").click()
    ta = page.locator("textarea").locator("visible=true").first
    txt = ta.input_value()
    m = re.search(r"\bminute\b", txt)
    ta.fill(txt.replace("minute", "seconde", 1) if m else txt)
    page.get_by_role("button", name=re.compile("Prêt")).click()
    page.wait_for_timeout(800)
    shot(page, "C6_prompteur_corrige")
    data2, _ = project_json(page, "C_apres_correction")
    tr2 = next(c for c in data2["tracks"][0]["clips"] if c["id"] == "message").get("transcript") or {}
    old = [w for w in msg_words if "minute" in w["w"].lower()]
    new = [w for w in tr2.get("words", []) if "seconde" in w["w"].lower()]
    res["correction"] = {"trouve_dans_le_texte": bool(m), "mot_avant": old[:1], "mot_apres": new[:1],
                         "meme_temps": bool(old and new and abs(old[0]["s"] - new[0]["s"]) < 1e-6),
                         "toujours_cale": page.get_by_test_id("prompter-voice-sync").count() > 0}
    # --- 4. Recherche dans le prompteur : « j'arrive » ---
    hits = search_in_prompter(page, "j'arrive", "C7_recherche_prompteur")
    res["recherche_prompteur"] = hits[:5]
    page.get_by_test_id("prompter-word-hit").first.click()
    page.wait_for_timeout(1200)
    ph = playhead(page)
    res["saut_prompteur"] = {"tete_de_lecture": round(ph, 3), "verite": round(T_MSG + truth["j'arrive"], 3), "ecart_ms": round((ph - T_MSG - truth["j'arrive"]) * 1000)}
    page.get_by_role("button", name="Fermer le prompteur").click()
    page.wait_for_timeout(600)
    shot(page, "C8_saut_sur_le_mot")
    # --- 5. Palette Ctrl+K : « trouver "anxiété" » (2 prises, dont la mutée), puis « trouver "j'arrive" » ---
    page.mouse.click(800, 860)
    page.keyboard.press("Control+k")
    page.get_by_test_id("command-palette").wait_for(timeout=5000)
    page.get_by_test_id("palette-input").type('trouver "anxiété"', delay=25)
    page.wait_for_timeout(600)
    opts = page.locator("[data-testid=command-palette] [role=option]")
    res["palette_anxiete"] = [o.inner_text().replace("\n", " · ")[:160] for o in opts.all()[:6]]
    shot(page, "C9_palette_anxiete")
    page.keyboard.press("ArrowDown")  # 2e résultat
    page.keyboard.press("Enter")
    page.wait_for_timeout(1200)
    res["palette_anxiete_saut"] = {"tete_de_lecture": round(playhead(page), 3)}
    shot(page, "C10_saut_prise_mutee")
    page.keyboard.press("Control+k")
    page.get_by_test_id("command-palette").wait_for(timeout=5000)
    page.get_by_test_id("palette-input").type('trouver "j\'arrive"', delay=25)
    page.wait_for_timeout(600)
    res["palette_jarrive"] = [o.inner_text().replace("\n", " · ")[:160] for o in opts.all()[:4]]
    shot(page, "C11_palette_jarrive")
    page.keyboard.press("Enter")
    page.wait_for_timeout(1500)
    ph = playhead(page)
    res["saut_palette"] = {"tete_de_lecture": round(ph, 3), "verite": round(T_MSG + truth["j'arrive"], 3), "ecart_ms": round((ph - T_MSG - truth["j'arrive"]) * 1000)}
    res["avis_apres_saut"] = page.evaluate("""() => { const el = [...document.querySelectorAll('[role=status], [aria-live]')].map(e => (e.innerText || '').trim()).find(t => t.includes('j’arrive') || t.includes("j'arrive")); return el || null; }""")
    shot(page, "C12_saut_palette_timeline")
    page.keyboard.press("Control+k")
    page.get_by_test_id("palette-input").type('trouver "zzzglorp"', delay=20)
    page.wait_for_timeout(500)
    res["palette_vide"] = page.get_by_test_id("palette-words-empty").inner_text() if page.get_by_test_id("palette-words-empty").count() else None
    shot(page, "C13_palette_aucun_mot")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    # --- 6. Déréverbération de « Voix (pièce) » ---
    clip_menu(page, "Voix pièce")
    shot(page, "C14_menu_voix")
    menu_item(page, "Retirer la réverbe").click()
    open_voice(page, "voice-ready")
    shot(page, "C15_reverbe_prete")
    page.get_by_test_id("voice-start").click()
    page.get_by_test_id("voice-running").wait_for(timeout=15000)
    page.wait_for_timeout(1200)
    shot(page, "C16_reverbe_calcul")
    t0 = time.time()
    page.get_by_test_id("voice-deverb-ready").wait_for(timeout=600000)
    res["reverbe_interface_s"] = round(time.time() - t0, 1)
    res["reverbe_message"] = page.get_by_test_id("voice-deverb-ready").inner_text()[:260]
    res["dosage_defaut"] = page.get_by_test_id("voice-amount-value").inner_text()
    page.get_by_test_id("voice-play").click(); page.wait_for_timeout(1000)
    page.get_by_test_id("voice-before").click(); page.wait_for_timeout(500)
    shot(page, "C17_ecoute_avant")
    page.get_by_test_id("voice-after").click(); page.wait_for_timeout(500)
    shot(page, "C18_ecoute_apres")
    page.get_by_test_id("voice-play").click()
    page.get_by_test_id("voice-apply").click()
    page.get_by_test_id("voice-dialog").wait_for(state="detached", timeout=10000)
    page.wait_for_timeout(1500)
    shot(page, "C19_reverbe_appliquee")
    data, _ = project_json(page, "C_apres_reverbe")
    c = data["tracks"][1]["clips"][0]
    res["clip_apres"] = {"nom": c["name"], "etapes": [s.get("name") for s in (c.get("audioSuite") or {}).get("steps", [])],
                         "son": c.get("audioRef"), "original_garde": bool((c.get("audioSuite") or {}).get("sourceRef"))}
    with zipfile.ZipFile(OUT / "C_apres_reverbe.zip") as z:
        raw = z.read(c["audioRef"])
        names = z.namelist()
    res["original_dans_le_projet"] = sum(1 for n in names if n.startswith("audio/"))
    res["mesures_reverbe"] = measure_deverb(raw, c)
    # Annulation et rétablissement (Ctrl+Z / Ctrl+Y)
    page.mouse.click(800, 860)
    page.keyboard.press("Control+z"); page.wait_for_timeout(1200)
    d_undo, _ = project_json(page, "C_apres_annulation")
    page.keyboard.press("Control+y"); page.wait_for_timeout(1200)
    d_redo, _ = project_json(page, "C_apres_retablir")
    res["annulation"] = {"apres_ctrl_z_audiosuite": "audioSuite" in d_undo["tracks"][1]["clips"][0],
                         "apres_ctrl_y_audiosuite": "audioSuite" in d_redo["tracks"][1]["clips"][0]}
    # Revenir à l'original (menu du clip)
    clip_menu(page, "Voix pièce")
    menu_item(page, "Revenir à l’original \\(avant traitement\\)").click()
    page.wait_for_timeout(1500)
    d_rev, _ = project_json(page, "C_apres_retour")
    c = d_rev["tracks"][1]["clips"][0]
    res["clip_retour"] = {"nom": c["name"], "audioSuite": "audioSuite" in c}
    shutil.copy(OUT / "C_apres_correction.zip", OUT / "projet_final_b7.zip")


def measure_deverb(raw, clip):
    """Voix rendue par NOVA après « Appliquer » (dosage par défaut) vs voix sèche et voix de la pièce."""
    sys.path.insert(0, str(R24 / "scripts"))
    import deverb_eval as d
    with wav_compat(raw) as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        sw = w.getsampwidth()
        frames = w.readframes(n)
    if sw == 4:
        y = np.frombuffer(frames, "<f4").reshape(-1, ch).mean(1)
    elif sw == 3:
        b = np.frombuffer(frames, np.uint8).reshape(-1, 3)
        v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        v = np.where(v & 0x800000, v - 0x1000000, v)
        y = (v.reshape(-1, ch).mean(1) / 8388608).astype(np.float32)
    else:
        y = np.frombuffer(frames, "<i2").astype(np.float32).reshape(-1, ch).mean(1) / 32768
    off = int(round(clip.get("offset", 0) * sr))
    if sr != SR:  # projet à 44,1 kHz : retour à 48 kHz, comme la voix sèche de référence
        from math import gcd
        from scipy.signal import resample_poly
        y = y[off:]
        g = gcd(sr, SR)
        y = resample_poly(y, SR // g, sr // g).astype(np.float32)
    else:
        y = y[off:]
    y = d.align(y[: len(WET) + SR], DRY)[0] if hasattr(d, "align") else y
    y = np.pad(y, (0, max(0, len(WET) - len(y))))[: len(WET)]
    ends = d.phrase_ends(DRY)
    q_dry, q_wet, q_y = d.tail_db(DRY, ends)[0], d.tail_db(WET, ends)[0], d.tail_db(y, ends)[0]
    return {"sample_rate": sr, "fins_de_phrase": len(ends), "decalage_debut_ech": off,
            "queue_db": {"seche": d.r1(q_dry), "piece_avant": d.r1(q_wet), "apres_nova": d.r1(q_y)},
            "reverbe_retiree_db": d.r1(q_y - q_wet),
            "c50_db": {"piece_avant": d.r1(d.c50(WET, DRY)), "apres_nova": d.r1(d.c50(y, DRY))},
            "lsd_db": {"piece_avant": d.r1(d.lsd(WET, DRY)), "apres_nova": d.r1(d.lsd(y, DRY))}}


# ─── D. thème clair (appli) ─────────────────────────────────────────────────────

def scenario_light(page, log, res, vp):
    page.add_init_script("try { localStorage.setItem('nova_theme', 'light') } catch (e) {}")
    prepare(page, port=PORT)
    open_project_file(page, OUT / "projet_final_b7.zip", res, "D0_clair_projet")
    shot(page, "D1_clair_texte_au_dessus_du_clip")
    hits = search_in_prompter(page, "anxiété", "D2_clair_recherche")
    res["recherche"] = hits[:4]
    page.get_by_test_id("prompter-word-hit").first.click()
    page.wait_for_timeout(1000)
    res["tete_de_lecture"] = round(playhead(page), 3)
    page.keyboard.press("Control+k")
    page.get_by_test_id("palette-input").type('trouver "porte"', delay=25)
    page.wait_for_timeout(600)
    shot(page, "D3_clair_palette")
    page.keyboard.press("Escape")
    track_menu(page, "Lead")
    shot(page, "D4_clair_menu_piste")
    page.keyboard.press("Escape")
    res["theme"] = page.evaluate("document.documentElement.getAttribute('data-theme')")


# ─── E. téléphone 390 × 844 (site) ─────────────────────────────────────────────

def scenario_phone(page, log, res, vp):
    truth = tts_truth()
    prepare(page, port=None, desktop=False)
    open_project_file(page, OUT / "projet_final_b7.zip", res, "E0_tel_projet")
    open_prompter(page)
    shot(page, "E1_tel_prompteur")
    res["prompteur_cale"] = page.get_by_test_id("prompter-voice-sync").count() > 0
    box = page.get_by_test_id("prompter-word-search")
    r = box.bounding_box()
    res["champ_visible"] = bool(r) and r["x"] >= 0 and r["x"] + r["width"] <= 390 and r["height"] >= 30
    box.tap()
    box.type("j'arrive", delay=40)
    page.get_by_test_id("prompter-word-results").wait_for(timeout=5000)
    page.wait_for_timeout(300)
    shot(page, "E2_tel_recherche")
    hit = page.get_by_test_id("prompter-word-hit").first
    hb = hit.bounding_box()
    res["resultat_au_doigt"] = {"hauteur": round(hb["height"]) if hb else None, "dans_l_ecran": bool(hb) and hb["x"] + hb["width"] <= 390}
    hit.tap()
    page.wait_for_timeout(1200)
    ph = playhead(page)
    res["saut"] = {"tete_de_lecture": round(ph, 3), "ecart_ms": round((ph - T_MSG - truth["j'arrive"]) * 1000)}
    shot(page, "E3_tel_apres_saut")
    res["debordement"] = overflow_report(page)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    PROJECT = OUT / "projet_voix_ia_b7.zip"
    DRY, WET = make_project(PROJECT)
    only = set(a.upper() for a in sys.argv[1:])
    report = {"port_pont": PORT, "url": os.environ["NOVA_URL"]}

    def want(k):
        return not only or k in only
    if want("A"):
        report["A_web"] = run_one(scenario_web, "pc", "A_web")
    if want("B"):
        empty = Path(tempfile.mkdtemp(prefix="nova-voix-vide-"))
        os.environ["NOVA_VOICE_HOME"] = str(empty)
        br = start_bridge(PORT)
        try:
            report["B_installation"] = run_one(scenario_install, "pc", "B_installation")
        finally:
            stop_bridge(br)
            os.environ.pop("NOVA_VOICE_HOME", None)
            time.sleep(2)
            shutil.rmtree(empty, ignore_errors=True)
    if want("C") or want("D"):
        br = start_bridge(PORT)
        try:
            if want("C"):
                report["C_reel"] = run_one(scenario_real, "pc", "C_reel")
            if want("D"):
                report["D_clair"] = run_one(scenario_light, "pc", "D_clair")
        finally:
            stop_bridge(br)
    if want("E"):
        report["E_telephone"] = run_one(scenario_phone, "tel390", "E_telephone")

    # ─── Vérifications ───
    checks = {}
    A, B, C, D, E = (report.get(k) or {} for k in ("A_web", "B_installation", "C_reel", "D_clair", "E_telephone"))
    if A:
        checks["A · site : commandes voix grisées avec la raison"] = A.get("ok") and (A.get("menu_clip") or {}).get("transcrire_grise") and (A.get("menu_piste") or {}).get("grise") \
            and "Nova Studio" in ((A.get("menu_piste") or {}).get("infobulle") or "")
    if B:
        pcts = [int(p[0] or 0) for p in B.get("progression") or []]
        checks["B · installation : taille annoncée, barre qui avance, annulation propre"] = B.get("ok") and "Go" in (B.get("bouton") or "") \
            and bool(pcts) and max(pcts) > 0 and "annulée" in (B.get("apres_annulation") or "").lower()
    if C:
        tx = C.get("transcriptions") or {}
        checks["C · piste transcrite (3 clips, prise mutée comprise) sur la carte graphique"] = C.get("ok") and all((tx.get(k) or {}).get("mots", 0) > 5 for k in ("prise-1", "prise-2", "message")) \
            and all(p["materiel"] == "cuda" for p in C.get("pont_par_clip") or [{"materiel": "?"}])
        checks["C · prompteur calé sur la voix"] = bool(C.get("prompteur_cale"))
        checks["C · parole corrigée à la main : même temps, toujours calé"] = bool((C.get("correction") or {}).get("meme_temps")) and bool((C.get("correction") or {}).get("toujours_cale"))
        checks["C · « j'arrive » (prompteur) : saut à ±150 ms du mot"] = abs((C.get("saut_prompteur") or {}).get("ecart_ms", 9999)) <= 150
        checks["C · « trouver \"j'arrive\" » (palette) : saut à ±150 ms du mot"] = abs((C.get("saut_palette") or {}).get("ecart_ms", 9999)) <= 150
        checks["C · « anxiété » trouvé dans les 2 prises (dont la mutée)"] = len(C.get("palette_anxiete") or []) >= 2 and any("mise de côté" in x for x in C.get("palette_anxiete") or [])
        checks["C · mot absent : message qui dit quoi faire"] = "Transcrire les paroles" in (C.get("palette_vide") or "")
        mr = C.get("mesures_reverbe") or {}
        checks["C · réverbe de la pièce retirée ≥ 10 dB (son rendu par NOVA)"] = (mr.get("reverbe_retiree_db") or 0) <= -10
        checks["C · dosage proposé 100 %"] = (C.get("dosage_defaut") or "").startswith("100")
        checks["C · original gardé, Ctrl+Z / Ctrl+Y, revenir à l'original"] = (C.get("clip_apres") or {}).get("original_garde") and (C.get("annulation") or {}).get("apres_ctrl_z_audiosuite") is False \
            and (C.get("annulation") or {}).get("apres_ctrl_y_audiosuite") is True and (C.get("clip_retour") or {}).get("audioSuite") is False
    if D:
        checks["D · thème clair : projet rouvert, recherche après réouverture"] = D.get("ok") and bool(D.get("recherche")) and D.get("theme") == "light"
    if E:
        checks["E · téléphone : champ visible, saut au doigt à ±150 ms"] = E.get("ok") and E.get("champ_visible") and abs((E.get("saut") or {}).get("ecart_ms", 9999)) <= 150 \
            and not [o for o in E.get("debordement") or [] if o.get("kind") == "page-hscroll"]
    report["verifications"] = checks
    report["ok"] = bool(checks) and all(checks.values()) and all((report.get(k) or {"ok": True}).get("ok", True) for k in ("A_web", "B_installation", "C_reel", "D_clair", "E_telephone"))
    (OUT / f"qa_voix_ia_b7{'_' + ''.join(sorted(only)) if only else ''}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    for k, v in checks.items():
        print(("OK   " if v else "ÉCHEC"), k)
    for k in ("A_web", "B_installation", "C_reel", "D_clair", "E_telephone"):
        if report.get(k) and report[k].get("notes"):
            print(k, report[k]["notes"])
    print("OK" if report["ok"] else "ÉCHEC")
    sys.exit(0 if report["ok"] else 1)
