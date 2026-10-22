"""Lot 1 « Voix propre » : « ✨ Nettoyer la voix » de bout en bout, sur le SITE sans pont
(RNNoise WASM dans un Worker), navigateurs headless, aucune fenêtre, Supabase simulé
(qa_hors_prod via qalib) : jamais la production.

Usage (serveur NOVA lancé : npx vite --port 3450 --strictPort) :
  NOVA_URL=http://127.0.0.1:3450/ python qa/voix_propre.py [A B C D E]

  A. bureau 1600 × 900, thème sombre :
     menu du clip → « ✨ Nettoyer la voix… » ; réverbe grisée sur le site avec la raison
     et le lien vers Nova Studio ; calcul (barre de progression, temps réel du navigateur) ;
     avant / après ; Léger → Fort sans refaire le gros du calcul ; « Appliquer » ;
     projet enregistré : étape AudioSuite « Voix nettoyée », original gardé, bruit des
     silences mesuré sur le son rendu par NOVA (prise sèche connue) ; Ctrl+Z / Ctrl+Y ;
     « Revenir à l'original » : la prise d'origine au bit près ; palette Ctrl+K « nettoyer » ;
     le gate renommé « Gate de bruit » (façade du kit hw gardée).
  B. bureau, thème clair : palette puis fenêtre (réglages, résultat).
  C. téléphone 390 × 844, thème sombre : bouton NETTOYER de la barre du clip, fenêtre en
     bas d'écran, calcul, Appliquer ; aucun débordement horizontal.
  D. téléphone, thème clair : fenêtre (réglages, résultat).
  E. appli Windows (bureau, sombre) avec le VRAI pont du worktree (port de test 8805) et le
     VRAI module voix de ce PC (dossier NovaStudio/voice de LOCALAPPDATA) : moteur DeepFilterNet 3
     annoncé, réverbe cochable, calcul sur le PC, résumé, Appliquer. Sauté (et signalé) si
     le module n'est pas installé.

Matériel : 12 s d'une vraie prise rap sèche du studio (REC_224) + bruit de ventilation à
−30 dBFS (qa/mesure_voix_propre.make_noise), voix à −20 dBFS efficaces.
Sortie : D:\\1 WORK\\CONTENU\\nova-bandlab\\lot1_voix_propre\\scenario (QA_OUT) ; code 0 si tout passe.
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot1_voix_propre\scenario")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3450/")
from qalib import *  # noqa
from qalib import OUT, run_one, shot, overflow_report  # noqa
from gel_pre_effet import open_project_file, save_zip  # noqa
from stems_separation import prepare, dismiss_popups, start_bridge, stop_bridge  # noqa
from voix_ia_locale import clip_menu, menu_item, header_y  # noqa
import mesure_voix_propre as mv  # noqa

SR = 48000
T_CLIP = 1.0
SESSION = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")


# ─── Matériel ──────────────────────────────────────────────────────────────────

def make_project(path: Path):
    clean = mv.load48(SESSION / "REC_224.wav")[: 12 * SR]
    clean = (clean * 10 ** ((-20 - mv.active_rms_db(clean)) / 20)).astype(np.float32)
    noisy = clean + mv.make_noise("ventilation", len(clean), 42) * 10 ** (-30 / 20)
    q = np.clip(np.round(noisy * 32767), -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(q.tobytes())
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    voix = {**base, "id": "voix", "name": "Voix", "type": "AUDIO", "color": "#f472b6",
            "clips": [{"id": "prise", "name": "Prise bruitée", "type": "AUDIO", "audioRef": "audio/prise.wav", "color": "#f472b6",
                       "fadeIn": 0, "fadeOut": 0, "gain": 1.0, "start": T_CLIP, "offset": 0.0, "duration": round(len(q) / SR, 3)}]}
    state = {
        "id": "proj-voix-propre", "name": "Test voix propre (lot 1)", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [voix], "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "lyrics": "",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/prise.wav", buf.getvalue())
    return clean, q.astype(np.float32) / 32767


def read_wav_bytes(raw):
    with wav_compat(raw) as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
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
    return y, sr


def clip_audio(zpath, clip):
    with zipfile.ZipFile(zpath) as z:
        y, sr = read_wav_bytes(z.read(clip["audioRef"]))
    off = int(round((clip.get("offset") or 0) * sr))
    return y[off: off + int(round(clip["duration"] * sr))], sr


def to48(y, sr):
    """Le projet tourne à la fréquence du moteur (44,1 kHz ici) : retour à 48 kHz pour comparer à la prise sèche."""
    if sr == SR:
        return y
    from math import gcd
    from scipy.signal import resample_poly
    g = gcd(sr, SR)
    return resample_poly(y, SR // g, sr // g).astype(np.float32)


def lsb_gap(a, b):
    n = min(len(a), len(b))
    return {"echantillons": [len(a), len(b)], "ecart_max_lsb": round(float(np.max(np.abs(a[:n] - b[:n]))) * 32768, 4) if n else None}


def theme(t):
    os.environ["QA_THEME"] = t


# ─── Gestes ───────────────────────────────────────────────────────────────────

def open_from_clip_menu(page):
    clip_menu(page, "Voix", x=700)
    it = menu_item(page, "Nettoyer la voix")
    shot(page, f"{PFX}01_menu_clip")
    it.click()
    page.get_by_test_id("voice-clean-dialog").wait_for(timeout=10000)
    page.get_by_test_id("voice-clean-setup").wait_for(timeout=10000)
    page.wait_for_timeout(400)


def run_clean(page, res, label):
    t0 = time.time()
    page.get_by_test_id("voice-clean-start").click()
    try:
        page.get_by_test_id("voice-clean-running").wait_for(timeout=5000)
        page.wait_for_timeout(250)
        shot(page, f"{PFX}{label}_calcul")
        res["progression_vue"] = page.locator("[data-testid=voice-clean-running] [role=progressbar]").first.get_attribute("aria-valuenow")
    except Exception:
        res["progression_vue"] = "trop rapide"
    page.get_by_test_id("voice-clean-ready").wait_for(timeout=180000)
    res["temps_interface_s"] = round(time.time() - t0, 2)
    page.wait_for_timeout(300)
    res["resume"] = page.get_by_test_id("voice-clean-summary").inner_text()


PFX = ""


# ─── A. bureau sombre ─────────────────────────────────────────────────────────

def scenario_desktop(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, f"{PFX}00_projet")
    dismiss_popups(page, 3000)
    d0, _ = save_zip(page, OUT / "A_avant.zip")
    ref, ref_sr = clip_audio(OUT / "A_avant.zip", d0["tracks"][0]["clips"][0])
    res["frequence_projet"] = ref_sr
    open_from_clip_menu(page)
    shot(page, f"{PFX}02_fenetre_reglages")
    rv = page.get_by_test_id("voice-clean-reverb")
    res["reverbe_grisee_sur_le_site"] = rv.is_disabled()
    res["lien_nova_studio"] = page.get_by_test_id("voice-clean-get-desktop").count() > 0
    res["moteur_annonce"] = page.get_by_test_id("voice-clean-engine").inner_text()
    res["force_par_defaut"] = page.locator("[role=radiogroup][aria-label='Force du nettoyage'] [aria-checked=true]").inner_text()
    run_clean(page, res, "03")
    shot(page, f"{PFX}04_resultat_moyen")
    # Avant / après pendant l'écoute
    page.get_by_test_id("voice-clean-play").click(); page.wait_for_timeout(700)
    page.get_by_test_id("voice-clean-before").click(); page.wait_for_timeout(400)
    shot(page, f"{PFX}05_ecoute_avant")
    page.get_by_test_id("voice-clean-after").click(); page.wait_for_timeout(400)
    res["ecoute"] = page.get_by_test_id("voice-clean-play").inner_text().strip()
    page.get_by_test_id("voice-clean-play").click()
    # Fort : sans refaire le gros du calcul
    t = time.time()
    page.get_by_test_id("voice-clean-strength-strong").click()
    page.wait_for_function("() => { const b = document.querySelector('[data-testid=voice-clean-apply]'); return b && !b.disabled && /Fort/.test(b.textContent); }", timeout=60000)
    res["changement_force_s"] = round(time.time() - t, 2)
    res["resume_fort"] = page.get_by_test_id("voice-clean-summary").inner_text()
    shot(page, f"{PFX}06_resultat_fort")
    page.get_by_test_id("voice-clean-apply").click()
    page.get_by_test_id("voice-clean-dialog").wait_for(state="detached", timeout=10000)
    page.wait_for_timeout(1200)
    shot(page, f"{PFX}07_applique")
    data, _ = save_zip(page, OUT / "A_apres_nettoyage.zip")
    c = data["tracks"][0]["clips"][0]
    a = c.get("audioSuite") or {}
    res["clip_apres"] = {"nom": c["name"], "etapes": [s.get("name") for s in a.get("steps", [])], "types": [s.get("type") for s in a.get("steps", [])],
                         "original_garde": bool(a.get("sourceRef"))}
    y, sr = clip_audio(OUT / "A_apres_nettoyage.zip", c)
    y = to48(y, sr)
    n = min(len(y), len(CLEAN))
    nr, nsil = mv.noise_reduction_db(NOISY[:n], y[:n], CLEAN[:n])
    res["bruit_silences_db"] = nr
    res["trames_silence"] = nsil
    res["spectre_voix"] = mv.spectral_dev(y[:n], CLEAN[:n])
    # Ctrl+Z / Ctrl+Y
    page.mouse.click(800, 860)
    page.keyboard.press("Control+z"); page.wait_for_timeout(1200)
    d_undo, _ = save_zip(page, OUT / "A_apres_annulation.zip")
    cu = d_undo["tracks"][0]["clips"][0]
    yu, _ = clip_audio(OUT / "A_apres_annulation.zip", cu)
    page.keyboard.press("Control+y"); page.wait_for_timeout(1200)
    d_redo, _ = save_zip(page, OUT / "A_apres_retablir.zip")
    res["annulation"] = {"ctrl_z_audiosuite": "audioSuite" in cu, "ctrl_y_audiosuite": "audioSuite" in d_redo["tracks"][0]["clips"][0],
                         "ctrl_z": lsb_gap(yu, ref)}
    # Revenir à l'original (menu du clip)
    clip_menu(page, "Voix", x=700)
    menu_item(page, "Revenir à l’original \\(avant traitement\\)").click()
    page.wait_for_timeout(1500)
    d_rev, _ = save_zip(page, OUT / "A_apres_retour.zip")
    cr = d_rev["tracks"][0]["clips"][0]
    yr, _ = clip_audio(OUT / "A_apres_retour.zip", cr)
    res["retour_original"] = {"nom": cr["name"], "audioSuite": "audioSuite" in cr, **lsb_gap(yr, ref)}
    shot(page, f"{PFX}08_retour_original")
    # Palette Ctrl+K
    page.mouse.click(700, header_y(page, "Voix") + 20)
    page.keyboard.press("Control+k")
    page.get_by_test_id("command-palette").wait_for(timeout=5000)
    page.get_by_test_id("palette-input").type("nettoyer", delay=25)
    page.wait_for_timeout(500)
    opts = page.locator("[data-testid=command-palette] [role=option]")
    res["palette"] = [o.inner_text().replace("\n", " · ")[:120] for o in opts.all()[:4]]
    shot(page, f"{PFX}09_palette")
    page.keyboard.press("Enter")
    page.get_by_test_id("voice-clean-dialog").wait_for(timeout=8000)
    res["palette_ouvre_la_fenetre"] = True
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    # Gate de bruit : façade du kit hw, nouveau nom
    page.evaluate("async () => { const h = await import('/qa/harness/hwPlugins2b.tsx'); return h.mountHwPlugin('DENOISER', false); }")
    page.locator("[data-qa-hw] [data-nova-plugin]").first.wait_for(timeout=20000)
    page.wait_for_timeout(1200)
    txt = page.locator("[data-qa-hw]").inner_text().lower()
    res["gate"] = {"texte": txt[:120], "gate_de_bruit": "gate de bruit" in txt, "anti_bruit_absent": "anti-bruit" not in txt and "denoiser" not in txt,
                   "facade_hw": page.locator("[data-qa-hw] .hw-faceplate, [data-qa-hw] [class*='hw-']").count() > 0}
    shot(page, f"{PFX}10_gate_de_bruit")
    page.evaluate("async () => { const h = await import('/qa/harness/hwPlugins2b.tsx'); h.unmountHwPlugin(); }")


# ─── B. bureau clair ──────────────────────────────────────────────────────────

def scenario_desktop_light(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, f"{PFX}00_projet")
    dismiss_popups(page, 3000)
    page.mouse.click(700, header_y(page, "Voix") + 20)
    page.keyboard.press("Control+k")
    page.get_by_test_id("command-palette").wait_for(timeout=5000)
    page.get_by_test_id("palette-input").type("bruit voix", delay=25)
    page.wait_for_timeout(500)
    shot(page, f"{PFX}01_palette")
    page.keyboard.press("Enter")
    page.get_by_test_id("voice-clean-setup").wait_for(timeout=8000)
    page.wait_for_timeout(400)
    shot(page, f"{PFX}02_fenetre_reglages")
    run_clean(page, res, "03")
    shot(page, f"{PFX}04_resultat")
    res["theme"] = page.evaluate("document.documentElement.getAttribute('data-theme')")
    res["debordement"] = overflow_report(page)


# ─── C / D. téléphone ─────────────────────────────────────────────────────────

def tap(page, loc):
    bb = loc.bounding_box()
    page.touchscreen.tap(bb["x"] + min(40, bb["width"] / 2), bb["y"] + bb["height"] / 2)
    page.wait_for_timeout(300)


def scenario_phone(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, f"{PFX}00_projet")
    dismiss_popups(page, 3000)
    clip_el = page.locator("[data-clip-id='prise']").locator("visible=true")
    if not clip_el.count():
        for name in ("Arrangement", "Studio", "Pistes"):
            t = page.get_by_role("button", name=re.compile(name, re.I)).locator("visible=true")
            if t.count():
                tap(page, t.first)
            if clip_el.count():
                break
    tap(page, clip_el.first)
    shot(page, f"{PFX}01_barre_du_clip")
    b = page.get_by_test_id("mobile-clip-clean")
    b.scroll_into_view_if_needed()
    bb = b.bounding_box()
    res["bouton"] = {"largeur": round(bb["width"]), "hauteur": round(bb["height"]), "texte": b.inner_text().strip()}
    tap(page, b)
    page.get_by_test_id("voice-clean-setup").wait_for(timeout=8000)
    page.wait_for_timeout(500)
    shot(page, f"{PFX}02_fenetre_reglages")
    res["debordement_reglages"] = [o for o in overflow_report(page) if o.get("kind") == "page-hscroll"]
    small = page.evaluate("""() => [...document.querySelectorAll('[data-testid=voice-clean-dialog] button, [data-testid=voice-clean-dialog] input')]
      .filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { t: (e.innerText || e.getAttribute('aria-label') || e.type || '').trim().slice(0, 30), h: Math.round(r.height), w: Math.round(r.width) }; })
      .filter(x => x.t && x.h < 40 && x.t !== 'checkbox')""")
    res["boutons_trop_petits"] = small
    tap(page, page.get_by_test_id("voice-clean-start"))
    page.get_by_test_id("voice-clean-ready").wait_for(timeout=180000)
    page.wait_for_timeout(400)
    res["resume"] = page.get_by_test_id("voice-clean-summary").inner_text()
    shot(page, f"{PFX}03_resultat")
    res["debordement_resultat"] = [o for o in overflow_report(page) if o.get("kind") == "page-hscroll"]
    if APPLY_ON_PHONE:
        tap(page, page.get_by_test_id("voice-clean-apply"))
        page.get_by_test_id("voice-clean-dialog").wait_for(state="detached", timeout=10000)
        page.wait_for_timeout(1000)
        shot(page, f"{PFX}04_applique")
        res["applique"] = True


APPLY_ON_PHONE = True
BRIDGE_PORT = int(os.environ.get("QA_VOIX_PROPRE_PORT", "8805"))
VOICE_HOME = Path(os.environ.get("LOCALAPPDATA", "")) / "NovaStudio" / "voice"


# ─── E. appli Windows + vrai pont ──────────────────────────────────────────────

def scenario_windows(page, log, res, vp):
    prepare(page, port=BRIDGE_PORT, desktop=True)
    open_project_file(page, PROJECT, res, f"{PFX}00_projet")
    dismiss_popups(page, 6000)
    open_from_clip_menu(page)
    page.wait_for_function("() => /DeepFilterNet/.test(document.querySelector('[data-testid=voice-clean-engine]')?.textContent || '')", timeout=20000)
    res["moteur_annonce"] = page.get_by_test_id("voice-clean-engine").inner_text()
    rv = page.get_by_test_id("voice-clean-reverb")
    res["reverbe_cochable"] = not rv.is_disabled()
    if res["reverbe_cochable"] and not rv.is_checked():
        rv.check()
    shot(page, f"{PFX}02_fenetre_reglages_appli")
    run_clean(page, res, "03")
    shot(page, f"{PFX}04_resultat_appli")
    t = time.time()
    page.get_by_test_id("voice-clean-strength-strong").click()
    page.wait_for_function("() => { const b = document.querySelector('[data-testid=voice-clean-apply]'); return b && !b.disabled && /Fort/.test(b.textContent); }", timeout=60000)
    res["changement_force_s"] = round(time.time() - t, 2)
    res["resume_fort"] = page.get_by_test_id("voice-clean-summary").inner_text()
    page.get_by_test_id("voice-clean-apply").click()
    page.get_by_test_id("voice-clean-dialog").wait_for(state="detached", timeout=10000)
    page.wait_for_timeout(1000)
    shot(page, f"{PFX}05_applique_appli")
    data, _ = save_zip(page, OUT / "E_apres_nettoyage.zip")
    c = data["tracks"][0]["clips"][0]
    y, sr = clip_audio(OUT / "E_apres_nettoyage.zip", c)
    y = to48(y, sr)
    n = min(len(y), len(CLEAN))
    res["bruit_silences_db"], res["trames_silence"] = mv.noise_reduction_db(NOISY[:n], y[:n], CLEAN[:n])
    res["etapes"] = [s_.get("name") for s_ in (c.get("audioSuite") or {}).get("steps", [])]
    txt = (OUT / f"pont-{BRIDGE_PORT}.log").read_text(encoding="utf-8", errors="replace") if (OUT / f"pont-{BRIDGE_PORT}.log").is_file() else ""
    res["pont_reverbe_retiree"] = len(re.findall(r"Réverbe retirée", txt))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    PROJECT = OUT / "projet_voix_propre.zip"
    CLEAN, NOISY = make_project(PROJECT)
    only = set(a.upper() for a in sys.argv[1:])
    report = {"url": os.environ["NOVA_URL"]}

    def want(k):
        return not only or k in only
    if want("A"):
        theme("dark"); PFX = "A"
        report["A_bureau_sombre"] = run_one(scenario_desktop, "pc", "A_bureau_sombre")
    if want("B"):
        theme("light"); PFX = "B"
        report["B_bureau_clair"] = run_one(scenario_desktop_light, "pc", "B_bureau_clair")
    if want("C"):
        theme("dark"); PFX = "C"; APPLY_ON_PHONE = True
        report["C_telephone_sombre"] = run_one(scenario_phone, "tel390", "C_telephone_sombre")
    if want("D"):
        theme("light"); PFX = "D"; APPLY_ON_PHONE = False
        report["D_telephone_clair"] = run_one(scenario_phone, "tel390", "D_telephone_clair")
    if want("E"):
        if (VOICE_HOME / "tools" / "deep-filter.exe").is_file():
            theme("dark"); PFX = "E"
            br = start_bridge(BRIDGE_PORT)
            try:
                report["E_appli_windows"] = run_one(scenario_windows, "pc", "E_appli_windows")
            finally:
                stop_bridge(br)
        else:
            report["E_appli_windows_saute"] = "module voix (DeepFilterNet 3) absent de ce PC"

    checks = {}
    A, B, C, D, E = (report.get(k) or {} for k in ("A_bureau_sombre", "B_bureau_clair", "C_telephone_sombre", "D_telephone_clair", "E_appli_windows"))
    if A:
        checks["A · site : réverbe grisée avec le lien Nova Studio, moteur annoncé, Moyen par défaut"] = A.get("ok") and A.get("reverbe_grisee_sur_le_site") and A.get("lien_nova_studio") \
            and "RNNoise" in (A.get("moteur_annonce") or "") and A.get("force_par_defaut") == "Moyen"
        checks["A · calcul dans le navigateur : résumé avec le bruit retiré"] = bool(re.search(r"Bruit de fond (−|retiré)", A.get("resume") or ""))
        checks["A · Léger/Moyen/Fort : nouveau réglage en moins de 5 s"] = (A.get("changement_force_s") or 99) < 5
        checks["A · bruit des silences baissé d'au moins 15 dB (son rendu par NOVA)"] = (A.get("bruit_silences_db") or 0) <= -15
        ca = A.get("clip_apres") or {}
        checks["A · AudioSuite : étape « Voix nettoyée (Fort) », original gardé"] = ca.get("types") == ["AI_VOICE_CLEAN"] and ca.get("etapes") == ["Voix nettoyée (Fort)"] and ca.get("original_garde")
        an = A.get("annulation") or {}
        checks["A · Ctrl+Z rend la prise d'origine au bit près, Ctrl+Y rétablit"] = an.get("ctrl_z_audiosuite") is False and an.get("ctrl_y_audiosuite") is True and (an.get("ctrl_z") or {}).get("ecart_max_lsb") == 0
        ro = A.get("retour_original") or {}
        checks["A · « Revenir à l'original » : prise d'origine au bit près"] = ro.get("audioSuite") is False and ro.get("ecart_max_lsb") == 0
        checks["A · palette Ctrl+K « nettoyer » ouvre la fenêtre"] = bool(A.get("palette_ouvre_la_fenetre")) and any("Nettoyer la voix" in x for x in A.get("palette") or [])
        g = A.get("gate") or {}
        checks["A · gate renommé « Gate de bruit », façade hw gardée"] = bool(g.get("gate_de_bruit")) and bool(g.get("anti_bruit_absent")) and bool(g.get("facade_hw"))
    if B:
        checks["B · bureau clair : palette, fenêtre, résultat"] = B.get("ok") and B.get("theme") == "light" and "Bruit de fond" in (B.get("resume") or "")
    for k, R in (("C", C), ("D", D)):
        if R:
            checks[f"{k} · téléphone : bouton NETTOYER, fenêtre sans débordement, cibles ≥ 40 px, résultat"] = R.get("ok") and not R.get("debordement_reglages") \
                and not R.get("debordement_resultat") and not R.get("boutons_trop_petits") and "Bruit de fond" in (R.get("resume") or "") \
                and (R.get("bouton") or {}).get("hauteur", 0) >= 44
    if E:
        checks["E · appli Windows : DeepFilterNet 3 annoncé, réverbe cochable, calcul sur le PC"] = E.get("ok") and "DeepFilterNet" in (E.get("moteur_annonce") or "")             and E.get("reverbe_cochable") and "DeepFilterNet 3 sur ton PC" in (E.get("resume") or "") and "réverbe de la pièce" in (E.get("resume") or "")
        checks["E · appli Windows : Fort sans relancer le PC, bruit des silences ≥ 15 dB, une seule passe du pont"] = (E.get("changement_force_s") or 99) < 8             and (E.get("bruit_silences_db") or 0) <= -15 and E.get("pont_reverbe_retiree") == 1 and E.get("etapes") == ["Voix nettoyée (Fort)"]
    report["verifications"] = checks
    report["ok"] = bool(checks) and all(checks.values()) and all((report.get(k) or {"ok": True}).get("ok", True) for k in ("A_bureau_sombre", "B_bureau_clair", "C_telephone_sombre", "D_telephone_clair", "E_appli_windows"))
    (OUT / f"qa_voix_propre{'_' + ''.join(sorted(only)) if only else ''}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    for k, v in checks.items():
        print(("OK   " if v else "ÉCHEC"), k)
    for k in ("A_bureau_sombre", "B_bureau_clair", "C_telephone_sombre", "D_telephone_clair", "E_appli_windows"):
        if report.get(k) and (report[k].get("notes") or report[k].get("errors")):
            print(k, report[k].get("notes"), report[k].get("errors")[:5])
    print("OK" if report["ok"] else "ÉCHEC")
    sys.exit(0 if report["ok"] else 1)
