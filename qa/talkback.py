"""💬 Talkback : bouton « Talk » de la barre, touche N, casque de l'artiste au studio, collaboration en direct.

Tout est hors production : navigateurs headless (aucune fenêtre), faux micro de Chrome
(--use-fake-device-for-media-stream : un son à 1 kHz = « la voix de l'ingé »), Supabase simulé
(qa_hors_prod), séance de collaboration simulée (qa/collab_sim.py : daw-session + Realtime), WebRTC
entre deux pages headless. Aucune carte son ASIO, aucun vrai micro, ni les ports 8765 / 8766.

A. Studio (même PC, hors collaboration), bureau 1600 × 900 sombre :
   1. bouton visible en mode avancé, absent en mode simple (et N n'y fait rien) ; micro PAS demandé avant le 1er appui ;
   2. N court = reste ouvert (verrouillé) ; 2e appui = coupé ; N maintenu = ouvert tant qu'on tient ;
      bouton : clic court = verrouillé, maintenu = tant qu'on tient ;
   3. mesures (FFT, 1 kHz = voix, 220 Hz = beat) : la voix est dans la SORTIE CASQUE (mix casque), absente du
      master, de la sortie d'écoute de la régie et de l'export (renderProject) ; la musique du casque baisse
      de −15 dB (dim) pendant qu'on parle, puis revient ;
   4. N tapé dans un champ (palette Ctrl+K) : rien ; la palette « talkback » ouvre / coupe ;
   5. PRISE : le talkback ouvert se coupe au REC (message), N pendant la prise est refusé (message),
      entrée talkback à 0 et voix absente du casque pendant toute la prise ;
   6. sans mix casque : la voix part sur la sortie d'écoute (jamais le master) ;
   7. micro coupé dès qu'on relâche, RENDU au bout de 20 s (rien ne tourne) ;
   8. rien de recouvert (bouton, REC, pastille), thème clair 1366 × 768, téléphone (pas de bouton hors collaboration).
B. Collaboration (Max, ingé, PC ; Nina, artiste invitée) :
   1. Nina appuie sur N (court) : le talkback EN DIRECT s'ouvre (CollabRtc) et reste ouvert ; chez Max,
      pastille « 🎙️ Nina te parle » dans la barre (hors panneau) et sa voix arrive (niveau mesuré) ; 2e appui = coupé ;
   2. Max maintient N : chez Nina « Max te parle » + sa voix ; relâché = coupé ;
   3. pendant la prise de Nina, la voix de Max est coupée chez elle (règle existante).

NOVA_URL=http://127.0.0.1:3504/ python qa/talkback.py [--sans-collab]
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-talkback\\qa) : talkback.json + captures.
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3504/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-talkback\qa")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, CHROME, Log, new_page, shot, save_log  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
TALK_HZ, BEAT_HZ = 1000, 220
MIC_WAV = OUT / "micro_talkback_1khz.wav"
CUE_ID = "casque-artiste"
TID_REC = "track-rec-main"

checks = []
res = {"studio": {}, "collab": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def tone_wav(hz, seconds, amp=0.3, sr=SR) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    x = amp * np.sin(2 * np.pi * hz * t)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project(path: Path):
    base = {"isMuted": False, "isSolo": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0, "sends": [], "plugins": []}
    tracks = [
        {**base, "id": "instrumental", "name": "Beat", "type": "AUDIO", "color": "#f59e0b", "isTrackArmed": False, "volume": 0.8, "outputTrackId": "master",
         "clips": [{"id": "beat1", "name": "Beat", "start": 0, "duration": 20, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#f59e0b", "type": "AUDIO", "audioRef": "audio/beat.wav", "gain": 1}]},
        {**base, "id": TID_REC, "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "isTrackArmed": True, "volume": 1.0, "outputTrackId": "master", "clips": []},
    ]
    state = {
        "id": "proj-talkback", "name": "Talkback", "bpm": 90, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": True, "loopStart": 0, "loopEnd": 16,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": TID_REC, "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "vocalMixStyle": "voix-brute",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/beat.wav", tone_wav(BEAT_HZ, 20, amp=0.3))


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}
"""


def launch(p):
    if not MIC_WAV.exists():
        MIC_WAV.write_bytes(tone_wav(TALK_HZ, 240, amp=0.3))
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={MIC_WAV}", "--autoplay-policy=no-user-gesture-required"])


def open_project(page, f: Path, label, touch=False):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.route_web_socket(re.compile(r"^ws://(127\.0\.0\.1|localhost):876[56]"), lambda ws: ws.close())
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=90000)
    b = page.get_by_text("Charger Projet").first
    b.tap() if touch else b.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        c = page.get_by_text("Charger depuis l'ordinateur").first
        c.tap() if touch else c.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard", "C'est noté"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.DAW_CONTROL && !!window.__novaCollab", timeout=30000)
    shot(page, label)


def tb(page):
    return page.evaluate("() => window.__novaCollab.talkback()")


def notice(page):
    """Ce que l'ingé voit : la pastille à côté du bouton Talk (pendant une prise, Nova ne fait pas surgir de bulle)."""
    loc = page.get_by_test_id("talkback-blocked")
    return loc.inner_text() if loc.count() else ""


# Niveaux (dB, FFT 8192, médiane sur la durée) à 1 kHz (voix du talkback) et 220 Hz (beat), sur un nœud du moteur :
# 'master' = master (avant la sortie : ce que l'export et le mix diffusé contiennent), 'main' = sortie d'écoute
# de la régie, sinon l'id d'un mix casque (sa sortie vers la carte).
BAND_JS = """async ([which, secs, f1, f2]) => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const ctx = audioEngine.getAudioContext();
  const node = which === 'master' ? audioEngine['masterAnalyzer'] : which === 'main' ? audioEngine['mainOut'] : audioEngine.getCueOutput(which);
  if (!ctx || !node) return null;
  const an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
  node.connect(an);
  const bins = new Float32Array(an.frequencyBinCount);
  const band = (hz) => { const i = Math.round(hz / (ctx.sampleRate / an.fftSize)); let m = -200; for (let k = i - 3; k <= i + 3; k++) m = Math.max(m, bins[k]); return m; };
  const a = [], b = [];
  const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) { await new Promise(r => setTimeout(r, 90)); an.getFloatFrequencyData(bins); a.push(band(f1)); b.push(band(f2)); }
  try { node.disconnect(an); } catch (e) {}
  const med = (v) => { const s = [...v].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); };
  return { talk: med(a), beat: med(b), n: a.length };
}"""


def band(page, which, secs=1.2):
    return page.evaluate(BAND_JS, [which, secs, TALK_HZ, BEAT_HZ])


# Export : le moteur de l'export (renderProject) pendant que le talkback est OUVERT ; énergie à 1 kHz et 220 Hz.
EXPORT_JS = """async ([f1, f2]) => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const s = window.DAW_CONTROL.getState();
  const buf = await audioEngine.renderProject(s.tracks, 3, 0, 48000);
  const x = buf.getChannelData(0);
  const goertzel = (hz) => { const w = 2 * Math.PI * hz / buf.sampleRate; let re = 0, im = 0; for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); } return 20 * Math.log10(Math.hypot(re, im) / x.length * 2 + 1e-12); };
  return { talk: +goertzel(f1).toFixed(1), beat: +goertzel(f2).toFixed(1), secs: buf.duration };
}"""

COVER_JS = """(sel) => [...document.querySelectorAll(sel)].filter(b => b.offsetParent !== null).map(b => {
  const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  return { id: b.getAttribute('data-testid') || b.getAttribute('data-nova-target') || b.tagName, ok: inView && !!hit && (hit === b || b.contains(hit)),
           over: hit && hit !== b && !b.contains(hit) ? (hit.getAttribute('aria-label') || hit.className || hit.tagName).toString().slice(0, 80) : null,
           w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
})"""
COVER_SEL = "[data-testid=transport-talkback], [data-nova-target=rec], [data-testid=talkback-talking]"


def key_tap(page, ms=110):
    page.keyboard.down("n"); page.wait_for_timeout(ms); page.keyboard.up("n")


def neutral_focus(page):
    page.evaluate("() => { const a = document.activeElement; if (a && a.blur) a.blur(); }")


def set_cue(page, on=True):
    mixes = [{"id": CUE_ID, "name": "Casque artiste", "pair": 1, "click": 0, "master": 1,
              # La voix armée est coupée DANS CE MIX : on mesure le talkback seul (le retour du micro de la prise n'y est pas).
              "levels": {TID_REC: {"level": 1, "pan": 0, "muted": True}}}] if on else []
    page.evaluate("(m) => window.DAW_CONTROL.setCueMixes(m)", mixes)
    page.wait_for_timeout(500)


def run_studio(p):
    r = res["studio"]
    proj = OUT / "talkback_studio.novaproj.zip"
    make_project(proj)
    b = launch(p)
    log = Log("talkback_studio")
    ctx, page = new_page(b, "pc", log)
    open_project(page, proj, "A00_projet")
    btn = page.get_by_test_id("transport-talkback")

    # ---- 1. visible en mode avancé, absent en mode simple ; aucun micro demandé avant le 1er appui
    check("A1 bouton « Talk » visible en mode avancé (barre de transport)", btn.is_visible())
    title = btn.get_attribute("title") or ""
    check("A1 infobulle : raccourci N, appui court / maintenu, casque, jamais dans le mix / l'export / les prises",
          "touche N" in title and "appui court" in title and "maintenu" in title and "jamais dans le mix" in title, title)
    t0 = tb(page)
    check("A1 rien ne tourne avant le 1er appui (micro du talkback pas demandé)", not t0["holdsMic"] and not t0["open"], t0)
    page.evaluate("async () => (await window.__novaAppModule('/utils/simpleMode.ts')).simpleModeStore.setPref(true)")
    page.wait_for_timeout(600)
    simple_visible = page.get_by_test_id("transport-talkback").count() > 0 and page.get_by_test_id("transport-talkback").is_visible()
    neutral_focus(page); key_tap(page); page.wait_for_timeout(400)
    t1 = tb(page)
    check("A1 mode simple hors collaboration : pas de bouton, N ne fait rien (barre épurée)", not simple_visible and not t1["open"] and not t1["holdsMic"], {"visible": simple_visible, **t1})
    shot(page, "A01_mode_simple_sans_talkback")
    page.evaluate("async () => (await window.__novaAppModule('/utils/simpleMode.ts')).simpleModeStore.setPref(false)")
    page.wait_for_timeout(600)

    # ---- moteur lancé, beat en boucle, un mix casque (artiste)
    set_cue(page, True)
    page.evaluate("() => { window.DAW_CONTROL.setLoop(true, 0, 16); window.DAW_CONTROL.seek(0); }")
    page.evaluate("() => window.DAW_CONTROL.togglePlay()")
    page.wait_for_timeout(1500)
    base_cue = band(page, CUE_ID)
    r["casque_avant"] = base_cue
    check("A3 casque avant le talkback : le beat (220 Hz) y est, pas de voix à 1 kHz", base_cue and base_cue["beat"] > -70 and base_cue["talk"] < base_cue["beat"] - 40, base_cue)

    # ---- 2. N court : verrouillé
    neutral_focus(page); key_tap(page, 110)
    page.wait_for_timeout(900)
    s = tb(page)
    r["n_court"] = s
    check("A2 N court (110 ms) : ouvert et VERROUILLÉ (reste ouvert après le relâchement)", s["open"] and s["latched"] and s["local"], s)
    check("A2 bouton rouge « ouvert » (aria-pressed) pendant qu'on parle", btn.get_attribute("aria-pressed") == "true" and btn.get_attribute("data-latched") == "1")
    shot(page, "A02_talkback_ouvert_verrouille")
    cue_on, main_on, master_on = band(page, CUE_ID), band(page, "main"), band(page, "master")
    r["ouvert"] = {"casque": cue_on, "ecoute_regie": main_on, "master": master_on}
    check("A3 voix du talkback DANS le casque (1 kHz ≥ +40 dB au-dessus d'avant)", cue_on["talk"] > base_cue["talk"] + 40, {"avant": base_cue, "ouvert": cue_on})
    check("A3 voix ABSENTE du master (export, mix diffusé)", master_on["talk"] < master_on["beat"] - 40 and master_on["talk"] < cue_on["talk"] - 40, master_on)
    check("A3 voix ABSENTE de la sortie d'écoute de la régie (pas de larsen)", main_on["talk"] < cue_on["talk"] - 40, main_on)
    dim = round(cue_on["beat"] - base_cue["beat"], 1)
    r["dim_db"] = dim
    check("A3 dim : la musique du casque baisse d'environ −15 dB pendant qu'on parle", -18.5 <= dim <= -11.5, {"dim": dim})
    exp = page.evaluate(EXPORT_JS, [TALK_HZ, BEAT_HZ])
    r["export_talkback_ouvert"] = exp
    check("A3 export (moteur de l'export) pendant le talkback : pas de voix à 1 kHz, le beat oui", exp["beat"] > -40 and exp["talk"] < exp["beat"] - 60, exp)

    # 2e appui : coupé
    key_tap(page, 110); page.wait_for_timeout(500)
    s2 = tb(page)
    cue_off = band(page, CUE_ID)
    r["deuxieme_appui"] = {"etat": s2, "casque": cue_off}
    mic_off = page.evaluate("async () => { const m = await window.__novaAppModule('/services/LocalTalkback.ts'); const st = m.localTalkback['stream']; return st ? st.getAudioTracks().map(t => t.enabled) : null; }")
    check("A2 2e appui court : coupé", not s2["open"] and not s2["local"], s2)
    check("A7 coupé : piste du micro coupée (enabled = false) et voix hors du casque", mic_off == [False] and cue_off["talk"] < cue_on["talk"] - 40, {"micro": mic_off, "casque": cue_off})
    check("A3 dim relâché : la musique du casque revient", abs(cue_off["beat"] - base_cue["beat"]) < 2.5, {"avant": base_cue, "apres": cue_off})

    # N maintenu
    page.keyboard.down("n"); page.wait_for_timeout(700)
    s3 = tb(page)
    held_cue = band(page, CUE_ID, 0.8)
    page.keyboard.up("n"); page.wait_for_timeout(400)
    s4 = tb(page)
    r["n_maintenu"] = {"pendant": s3, "casque": held_cue, "apres": s4}
    check("A2 N maintenu : ouvert tant qu'on tient (non verrouillé), voix dans le casque", s3["open"] and not s3["latched"] and held_cue["talk"] > base_cue["talk"] + 40, r["n_maintenu"])
    check("A2 N relâché après un appui long : coupé", not s4["open"], s4)

    # Bouton à la souris : clic court = verrouillé ; 2e clic = coupé ; maintenu = tant qu'on tient
    bb = btn.bounding_box()
    page.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    page.mouse.down(); page.wait_for_timeout(90); page.mouse.up(); page.wait_for_timeout(500)
    m1 = tb(page)
    cover = page.evaluate(COVER_JS, COVER_SEL)
    shot(page, "A02b_bouton_clic_court")
    page.mouse.down(); page.wait_for_timeout(90); page.mouse.up(); page.wait_for_timeout(300)
    m2 = tb(page)
    page.mouse.down(); page.wait_for_timeout(700)
    m3 = tb(page)
    page.mouse.up(); page.wait_for_timeout(300)
    m4 = tb(page)
    r["bouton"] = {"clic_court": m1, "deuxieme_clic": m2, "maintenu": m3, "relache": m4}
    check("A2 bouton : clic court = verrouillé, 2e clic = coupé", m1["open"] and m1["latched"] and not m2["open"], r["bouton"])
    check("A2 bouton maintenu = ouvert tant qu'on tient, relâché = coupé", m3["open"] and not m3["latched"] and not m4["open"], r["bouton"])
    check("A8 bouton Talk et REC non recouverts (1600 × 900, sombre)", all(c["ok"] for c in cover) and len(cover) >= 2, cover)

    # ---- 4. saisie dans un champ : rien ; palette « talkback »
    neutral_focus(page)
    page.keyboard.press("Control+k"); page.wait_for_timeout(700)
    inp = page.locator("input:focus")
    typed_ok = inp.count() > 0
    page.keyboard.type("n"); page.wait_for_timeout(500)
    s5 = tb(page)
    check("A4 N tapé dans un champ texte (recherche de la palette) : le talkback ne s'ouvre pas", typed_ok and not s5["open"], s5)
    page.keyboard.press("Backspace")
    page.keyboard.type("talkback"); page.wait_for_timeout(600)
    pal_txt = page.locator("[role=dialog]").first.inner_text() if page.locator("[role=dialog]").count() else ""
    shot(page, "A04_palette_talkback")
    page.keyboard.press("Enter"); page.wait_for_timeout(1000)
    s6 = tb(page)
    check("A4 palette Ctrl+K « talkback » : la commande existe (avec sa touche) et ouvre le talkback (verrouillé)", "Talkback" in pal_txt and s6["open"] and s6["latched"], {"palette": pal_txt[:300], "etat": s6})

    # ---- 5. PRISE : coupé au REC, refusé pendant, voix jamais dans le casque pendant la prise
    page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    page.wait_for_timeout(1500)
    s7 = tb(page)
    n1 = notice(page)
    rec_on = page.evaluate("() => !!window.DAW_CONTROL.getState().isRecording")
    neutral_focus(page); key_tap(page); page.wait_for_timeout(800)
    s8 = tb(page)
    n2 = notice(page)
    talk_gain = page.evaluate("async () => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts'); return audioEngine.getTalkbackPlan().talkGain; }")
    cover_rec = page.evaluate(COVER_JS, COVER_SEL + ", [data-testid=talkback-blocked]")
    cue_rec = band(page, CUE_ID, 1.5)
    shot(page, "A05_prise_talkback_refuse")
    page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
    page.wait_for_timeout(2500)
    takes = page.evaluate(f"() => window.DAW_CONTROL.getState().tracks.find(t => t.id === '{TID_REC}').clips.length")
    r["prise"] = {"enregistre": rec_on, "au_rec": s7, "n_pendant": s8, "gain_entree_talkback": talk_gain, "casque_pendant": cue_rec, "prises": takes, "messages": [n1[:300], n2[:300]]}
    check("A5 REC avec le talkback ouvert : il se coupe tout seul", rec_on and not s7["open"] and not s7["local"], r["prise"])
    check("A5 dit à côté du bouton : « 🎙️ Coupé pendant la prise » (au REC, puis à l'appui sur N)", "Coupé pendant la prise" in n1 and "Coupé pendant la prise" in n2, [n1, n2])
    check("A5 la pastille ne recouvre ni Talk ni REC", all(c["ok"] for c in cover_rec), cover_rec)
    check("A5 N pendant la prise : refusé (reste coupé)", not s8["open"] and not s8["local"], s8)
    check("A5 pendant la prise : entrée talkback à 0, aucune voix du talkback dans le casque", (talk_gain or 0) < 1e-3 and cue_rec["talk"] < base_cue["talk"] + 15, {"gain": talk_gain, "casque": cue_rec, "avant": base_cue})
    check("A5 la prise est bien enregistrée (le talkback n'a rien gêné)", takes >= 1, takes)

    # ---- 6. sans mix casque : sortie d'écoute, jamais le master
    # Piste voix désarmée : son retour micro (le même faux micro à 1 kHz) ne doit pas fausser la mesure de l'écoute.
    page.evaluate(f"() => {{ const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === '{TID_REC}'); window.DAW_CONTROL.updateTrack({{ ...t, isTrackArmed: false, isMuted: true }}); }}")
    page.wait_for_timeout(800)
    set_cue(page, False)
    page.evaluate("() => { if (!window.DAW_CONTROL.getState().isPlaying) window.DAW_CONTROL.togglePlay(); }")
    page.wait_for_timeout(800)
    main_before = band(page, "main")
    neutral_focus(page); key_tap(page); page.wait_for_timeout(900)
    s9 = tb(page)
    main_tb, master_tb = band(page, "main"), band(page, "master")
    r["sans_mix_casque"] = {"etat": s9, "ecoute_avant": main_before, "ecoute": main_tb, "master": master_tb}
    check("A6 sans mix casque : route « sortie d'écoute », voix dans l'écoute", s9["route"] == "main" and main_tb["talk"] > main_before["talk"] + 40, r["sans_mix_casque"])
    check("A6 sans mix casque : voix jamais dans le master ; dim sur l'écoute", master_tb["talk"] < main_tb["talk"] - 40 and -18.5 <= main_tb["beat"] - main_before["beat"] <= -11.5, r["sans_mix_casque"])
    # Réglages audio › Talkback (micro, dim, niveau, route) depuis la palette.
    page.keyboard.press("Control+k"); page.wait_for_timeout(500)
    page.keyboard.type("réglages du talkback"); page.wait_for_timeout(500); page.keyboard.press("Enter"); page.wait_for_timeout(1500)
    sets = page.get_by_test_id("talkback-settings")
    sets_ok = sets.count() > 0
    if sets_ok:
        sets.scroll_into_view_if_needed(); page.wait_for_timeout(400)
    route_txt = page.get_by_test_id("talkback-route").inner_text() if page.get_by_test_id("talkback-route").count() else ""
    shot(page, "A06_reglages_talkback")
    check("A6 Réglages audio › Talkback : micro, baisse de la musique, volume, route expliquée (larsen)",
          sets_ok and page.get_by_test_id("talkback-device").count() > 0 and page.get_by_test_id("talkback-dim").count() > 0 and "larsen" in route_txt, route_txt)
    page.keyboard.press("Escape"); page.wait_for_timeout(500)
    neutral_focus(page); key_tap(page); page.wait_for_timeout(500)
    page.evaluate("() => { if (window.DAW_CONTROL.getState().isPlaying) window.DAW_CONTROL.togglePlay(); }")

    # ---- 7. micro rendu au bout de 20 s
    s10 = tb(page)
    page.wait_for_timeout(21500)
    s11 = tb(page)
    r["micro_rendu"] = {"juste_apres": s10, "apres_21s": s11}
    check("A7 coupé : micro gardé quelques secondes (premier mot pas perdu), puis RENDU après 20 s", not s10["open"] and s10["holdsMic"] and not s11["holdsMic"], r["micro_rendu"])
    r["erreurs_console"] = log.errors()[:10]
    save_log(log)
    ctx.close()

    # ---- 8. thème clair 1366 × 768 et téléphone
    os.environ["QA_THEME"] = "light"
    log2 = Log("talkback_clair")
    ctx2, pg2 = new_page(b, "pc1366", log2)
    open_project(pg2, proj, "A08_clair_projet")
    neutral_focus(pg2); key_tap(pg2); pg2.wait_for_timeout(1200)
    s12 = tb(pg2)
    cover2 = pg2.evaluate(COVER_JS, COVER_SEL)
    shot(pg2, "A08_clair_1366_talkback_ouvert")
    check("A8 thème clair 1366 × 768 : talkback ouvert, bouton et REC non recouverts", s12["open"] and all(c["ok"] for c in cover2) and len(cover2) >= 2, {"etat": s12, "cover": cover2})
    key_tap(pg2); pg2.wait_for_timeout(300)
    ctx2.close()
    os.environ.pop("QA_THEME", None)
    ctx3, pg3 = new_page(b, "tel390", Log("talkback_tel"))
    open_project(pg3, proj, "A08_tel_projet", touch=True)
    tel_vis = pg3.get_by_test_id("transport-talkback").count() > 0 and pg3.get_by_test_id("transport-talkback").is_visible()
    shot(pg3, "A08_telephone_hors_collab")
    check("A8 téléphone hors collaboration : pas de bouton Talk (barre épurée)", not tel_vis, tel_vis)
    ctx3.close()
    b.close()


# ------------------------------------------------------------------------------------------- collaboration
def run_collab(p):
    r = res["collab"]
    from collab_sim import FakeNovaCloud, FakeRealtime  # noqa
    from collab_artiste import connect_logged_out, connect_engineer, seance_project, launch_rtc, mix_level, MAX_UID, NINA_UID, NINA_MAIL, NINA_PASS  # noqa
    from gel_pre_effet import prepare, open_project_file  # noqa
    from feat_lib import dismiss, wait_for, collab, open_panel, close_panel, REC_INIT  # noqa

    cloud = FakeNovaCloud(per_device=True, codes=True, strict=True, pro={MAX_UID})
    rt = FakeRealtime()
    src = OUT / "talkback_seance_max.novaproj.zip"
    seance_project(src)
    b = launch_rtc(p)
    lE, lT = Log("talkback_inge"), Log("talkback_artiste")
    cE, E = new_page(b, "pc", lE)
    E.add_init_script(REC_INIT)
    prepare(E, None, desktop=False)
    connect_engineer(E, cloud, rt, "E", MAX_UID, "max@test.local")
    cT, T = new_page(b, "pc1366", lT)
    T.add_init_script(REC_INIT)
    prepare(T, None, desktop=False)
    connect_logged_out(T, cloud, rt, "T", NINA_UID, NINA_MAIL)
    E.goto(BASE, wait_until="domcontentloaded", timeout=180000)
    E.get_by_text("Charger Projet").first.wait_for(timeout=180000)
    open_project_file(E, src, {}, "B00_seance_de_max")
    dismiss(E); open_panel(E)
    E.get_by_test_id("collab-role").select_option("engineer")
    E.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
    E.get_by_role("button", name="Démarrer la collaboration en direct").click()
    wait_for(E, lambda: collab(E, "c.role()") == "engineer", 90, what="séance de Max en ligne")
    E.wait_for_timeout(1500)
    sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
    link = collab(E, "c.invite ? c.invite() : null") or f"{BASE}?session={sid}.{cloud.sessions[sid]['secret']}&invite=1"
    close_panel(E)

    T.goto(link, wait_until="domcontentloaded", timeout=180000)
    wait_for(T, lambda: T.get_by_test_id("collab-arrival").count() > 0, 120, step=200, what="carte d'arrivée")
    T.wait_for_timeout(1200); dismiss(T)
    if T.get_by_test_id("arrival-login").count():
        T.get_by_label("Ton nom", exact=True).fill("Nina")
        T.get_by_test_id("arrival-login").get_by_label("E-mail").fill(NINA_MAIL)
        T.get_by_test_id("arrival-login").get_by_label("Mot de passe").fill(NINA_PASS)
        T.get_by_test_id("arrival-join").click()
    else:
        art = T.get_by_test_id("arrival-role-artist")
        if not art.locator("input:checked").count() and not T.locator("[data-testid=arrival-role-artist][data-quick='1']").count():
            art.click()
        T.get_by_label("Ton nom", exact=True).fill("Nina")
        T.get_by_test_id("arrival-join").click()
        wait_for(T, lambda: T.get_by_placeholder("E-mail").count() > 0 or collab(T, "c.role()") == "artist", 30, what="connexion demandée")
        if T.get_by_placeholder("E-mail").count():
            T.get_by_placeholder("E-mail").fill(NINA_MAIL)
            T.get_by_placeholder("Mot de passe").fill(NINA_PASS)
            T.get_by_role("button", name="Se connecter").click()
    wait_for(T, lambda: collab(T, "c.role()") == "artist", 90, step=200, what="Nina reliée")
    T.wait_for_timeout(2500); dismiss(T)
    # Max voit Nina en ligne
    wait_for(E, lambda: E.evaluate("() => document.body.innerText.includes('Nina')"), 40, step=300, what="Nina visible chez Max")
    check("B0 séance simulée : Max (ingé) et Nina (artiste) reliés", collab(E, "c.role()") == "engineer" and collab(T, "c.role()") == "artist")
    btnE = E.get_by_test_id("transport-talkback")
    check("B0 chez Max : bouton Talk dans la barre pendant la collaboration", btnE.is_visible(), btnE.get_attribute("title"))
    check("B0 infobulle collaboration : « en direct »", "en direct" in (btnE.get_attribute("title") or ""), btnE.get_attribute("title"))

    # ---- 1. Nina : N court → talkback en direct verrouillé ; pastille chez Max (hors panneau)
    neutral_focus(T); key_tap(T, 110)
    t_open = time.time()
    try:
        s = wait_for(E, lambda: E.get_by_test_id("talkback-talking").count() > 0, 30, step=150, what="« 🎙️ Nina te parle » dans la barre de Max")
    except AssertionError:
        s = None
    st_T = tb(T)
    pill = E.get_by_test_id("talkback-talking").inner_text() if E.get_by_test_id("talkback-talking").count() else ""
    lvl_E = mix_level(E, ":talk", 2.5)
    shot(E, "B01_max_pastille_nina_te_parle"); shot(T, "B01_nina_parle_touche_N")
    coverE = E.evaluate(COVER_JS, COVER_SEL)
    r["nina_parle"] = {"etat_nina": st_T, "pastille": pill, "delai_s": s, "niveau_chez_max_db": lvl_E, "panneau_ouvert_chez_max": E.locator("[aria-labelledby='collab-title']").count() > 0}
    check("B1 Nina, N court : talkback EN DIRECT ouvert et verrouillé (CollabRtc)", st_T["open"] and st_T["latched"] and st_T["talkOn"] and not st_T["local"], st_T)
    check("B1 chez Max, hors du panneau : pastille « 🎙️ Nina te parle » dans la barre", "Nina te parle" in pill and not r["nina_parle"]["panneau_ouvert_chez_max"], r["nina_parle"])
    check("B1 la voix de Nina arrive chez Max (niveau > −60 dB)", lvl_E is not None and lvl_E > -60, lvl_E)
    check("B1 la pastille ne recouvre rien (barre de Max)", all(c["ok"] for c in coverE), coverE)
    key_tap(T, 110)
    try:
        wait_for(E, lambda: E.get_by_test_id("talkback-talking").count() == 0, 20, step=150, what="pastille retirée")
        gone = True
    except AssertionError:
        gone = False
    st_T2 = tb(T)
    check("B1 Nina, 2e appui : coupé ; la pastille disparaît chez Max", not st_T2["open"] and not st_T2["talkOn"] and gone, st_T2)

    # ---- 2. Max maintient N : chez Nina « Max te parle » + sa voix ; relâché = coupé
    neutral_focus(E)
    E.keyboard.down("n")
    try:
        s2 = wait_for(T, lambda: re.search(r"Max te parle", T.evaluate("() => document.body.innerText")) is not None, 30, step=150, what="« Max te parle » chez Nina")
    except AssertionError:
        s2 = None
    st_E = tb(E)
    lvl_T = mix_level(T, ":talk", 2.5)
    shot(T, "B02_nina_max_te_parle"); shot(E, "B02_max_maintient_N")
    E.keyboard.up("n"); E.wait_for_timeout(800)
    st_E2 = tb(E)
    r["max_parle"] = {"pendant": st_E, "delai_s": s2, "niveau_chez_nina_db": lvl_T, "apres": st_E2}
    check("B2 Max maintient N : talkback en direct ouvert (non verrouillé), Nina voit « Max te parle »", st_E["open"] and not st_E["latched"] and st_E["talkOn"] and s2 is not None, r["max_parle"])
    check("B2 la voix de Max arrive chez Nina (niveau > −60 dB)", lvl_T is not None and lvl_T > -60, lvl_T)
    check("B2 Max relâche N : coupé", not st_E2["open"] and not st_E2["talkOn"], st_E2)

    # ---- 3. prise de Nina : la voix de Max coupée chez elle (règle existante)
    neutral_focus(E); key_tap(E, 110); E.wait_for_timeout(1200)
    rec = T.get_by_test_id("guest-rec") if T.get_by_test_id("guest-rec").count() else T.get_by_role("button", name=re.compile(r"^(Enregistrer)$")).locator("visible=true").first
    rec.click(); T.wait_for_timeout(2500)
    muted = T.evaluate("() => { const el = document.querySelector('audio[data-collab-audio$=\":talk\"]'); return el ? el.muted : null; }")
    rec_T = T.evaluate("() => !!window.__novaTest.getState().isRecording")
    shot(T, "B03_nina_prise_talkback_coupe")
    rec.click(); T.wait_for_timeout(2000)
    key_tap(E, 110); E.wait_for_timeout(500)
    r["prise_nina"] = {"enregistre": rec_T, "talk_de_max_coupe_chez_nina": muted}
    check("B3 pendant la prise de Nina : la voix du talkback de Max est coupée chez elle", rec_T and muted is True, r["prise_nina"])
    r["erreurs_console"] = {"max": lE.errors()[:8], "nina": lT.errors()[:8]}
    save_log(lE); save_log(lT)
    b.close()


def main():
    t0 = time.time()
    with sync_playwright() as p:
        for name, fn in (("studio", run_studio), ("collab", run_collab)):
            if name == "collab" and "--sans-collab" in sys.argv:
                continue
            try:
                fn(p)
            except Exception as e:  # noqa
                import traceback
                check(f"{name} : déroulé sans exception", False, f"{type(e).__name__}: {str(e)[:500]}")
                res[name]["trace"] = traceback.format_exc()[-2500:]
    ok = all(c["ok"] for c in checks)
    out = {"ok": ok, "verifications": checks, "resultats": res, "duree_s": round(time.time() - t0)}
    (OUT / "talkback.json").write_text(json.dumps(out, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"\n{sum(c['ok'] for c in checks)}/{len(checks)} vérifications OK · {OUT}")
    return ok


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
