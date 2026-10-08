"""Session d'enregistrement voix chronométrée (comme un ingé de studio, souris + clavier, PC).

Rejoue une vraie séance rap / R&B dans Nova Studio (appli Windows simulée), Chrome headless :
 1. ouvrir le studio            2. importer le beat (WAV)        3. tempo 140 BPM
 4. 2 pistes voix (lead+double) 5. preset « Voix lead Make Music » sur la lead
 6. armer les 2 pistes          7. 3 prises en Loop Record       8. comp (choisir une prise)
 9. respirations               10. justesse (fenêtre)           11. édition : séparer, fondus, gain de clip, modes
12. exporter la démo (WAV)
Pour chaque étape : clics, touches, temps, chemin pris, hésitations (bouton hors de l'écran,
introuvable, deux chemins…), erreurs de la console ; et le nombre de gestes de Pro Tools pour la
même tâche (PROTOOLS_CARTOGRAPHIE.md). La session prend le chemin le plus court DISPONIBLE
(bouton visible, raccourci, menu ☰, palette Ctrl+K si elle existe) : avant / après comparables.

NOVA_URL=http://127.0.0.1:3491/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/session_voix.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro\\<phase>\\session_voix\\ (session_voix.json + captures)
"""
import io, json, math, os, re, struct, sys, time, wave
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3491/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro\{PHASE}\session_voix")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa: E402
from nova_pro_lib import Chrono, visible_first, open_by_palette, via_menu, clip_point, track_point, app_state, canvas_box, save_json  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100


def beat_wav(path, bpm=140, bars=4):
    """Beat trap synthétique : kick + 808 sur chaque temps, hi-hats en croches."""
    spb = 60 / bpm
    n = int(SR * spb * 4 * bars)
    out = bytearray()
    for i in range(n):
        t = i / SR
        tb = t % spb
        th = t % (spb / 2)
        v = 0.55 * math.sin(2 * math.pi * (50 + 90 * math.exp(-tb * 25)) * tb) * math.exp(-tb * 6)
        v += 0.12 * math.sin(2 * math.pi * 7000 * th) * math.exp(-th * 80)
        s = int(max(-1, min(1, v)) * 32767)
        out += struct.pack("<hh", s, s)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(bytes(out))


def in_view(page, loc):
    """Le bouton est-il réellement atteignable (dans l'écran, pas recouvert) ?"""
    return page.evaluate("""(el) => { const r = el.getBoundingClientRect(); if (!r.width) return false;
      if (r.bottom > innerHeight || r.right > innerWidth || r.top < 0 || r.left < 0) return false;
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && el.contains(h); }""", loc.element_handle())


def reachable(ch, sel, label):
    loc = visible_first(ch.page, sel)
    if not loc: return None
    if not in_view(ch.page, loc):
        ch.friction(f"« {label} » existe mais est hors de l'écran ou caché")
        return None
    return loc


def tracks(page):
    return app_state(page, "s => s.tracks.map(t => ({ id: t.id, name: t.name, type: t.type, armed: !!t.isTrackArmed, clips: t.clips.length, plugins: (t.plugins || []).map(p => p.name || p.type), takes: t.clips.filter(c => c.takeNumber).length }))") or []


def run(page, log, ch):
    res = {}
    # 1. Ouvrir le studio --------------------------------------------------------------
    ch.start("Ouvrir", "Nouveau projet vierge (accueil → studio prêt)", protools="Fichier › Nouvelle session : 1 raccourci (Ctrl+N) + nom + Entrée")
    t = time.time()
    page.goto(BASE, wait_until="domcontentloaded")
    nouveau = page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first
    nouveau.wait_for(timeout=60000)
    res["accueil_ms"] = round((time.time() - t) * 1000)
    ch.click(nouveau, "Nouveau Projet")
    page.wait_for_timeout(600)
    close_welcome(page)
    try: wait_text_gone(page, "Chargement", 90)
    except Exception: pass
    ch.wait_js("() => !!document.querySelector('.nova-grille canvas') && !!window.__novaEdit", 30000, "arrangement prêt")
    res["studio_ms"] = round((time.time() - t) * 1000)
    res["pistes_initiales"] = [t["name"] for t in tracks(page)]
    page.mouse.move(5, 5)
    page.screenshot(path=str(OUT / "v01_studio.png"))
    ch.end(note=f"accueil {res['accueil_ms']} ms, studio prêt {res['studio_ms']} ms")
    page.keyboard.press("Escape")

    # 2. Importer le beat ------------------------------------------------------------------
    ch.start("Préparer", "Importer le beat (WAV)", protools="Fichier › Importer › Audio : Ctrl+Maj+I + choisir le fichier (1 raccourci, 1 choix)")
    wav = OUT / "beat_140.wav"; beat_wav(wav)
    n0 = len(tracks(page))
    done = False
    with page.expect_file_chooser(timeout=8000) as fc:
        b = reachable(ch, "button[aria-label='Importer un fichier audio'], button[title^='Importer un fichier audio']", "Importer")
        if b: ch.click(b, "Importer (barre)"); done = True
        elif via_menu(ch, "Importer un fichier audio"): done = True
        elif open_by_palette(ch, "importer audio", "pal.importAudio"): done = True
        else:
            ch.fail("import audio introuvable (mode simple : ni barre, ni menu ☰)")
            page.evaluate("() => { const i = document.querySelector('input[type=file][accept^=\"audio\"]'); if (i) i.click(); }")
    try:
        fc.value.set_files(str(wav))
        ch.cur["clics"] += 1; ch.cur["chemin"].append("choisir le fichier")
    except Exception as e:
        ch.fail(f"pas de sélecteur de fichier ({str(e)[:60]})")
    ch.wait_js(f"() => window.__novaEdit.getState().tracks.length > {n0} || window.__novaEdit.getState().tracks.some(t => t.clips.some(c => /beat_140/i.test(c.name || '')))", 20000, "beat importé")
    ch.end()
    page.keyboard.press("Escape")

    # 3. Tempo 140 -------------------------------------------------------------------------
    ch.start("Préparer", "Tempo à 140 BPM", protools="Double-clic sur le tempo du transport + saisie + Entrée (1 clic, 4 touches)")
    b = reachable(ch, "[data-testid=open-tempo]", "Tempo")
    if b:
        ch.click(b, "Tempo")
    elif not open_by_palette(ch, "tempo", "pal.tempo"):
        ch.fail("fenêtre Tempo introuvable")
    inp = page.locator("input[aria-label='Tempo en BPM']").locator("visible=true")
    try: inp.first.wait_for(timeout=5000)
    except Exception: ch.fail("champ du tempo introuvable")
    if inp.count():
        inp.first.click(click_count=3); ch.cur["clics"] += 1
        ch.type("140"); ch.press("Enter")
    ch.wait_js("() => Math.abs(window.__novaEdit.getState().bpm - 140) < 0.01", 5000, "tempo 140")
    ch.press("Escape")
    ch.end()

    # 4. Deux pistes voix -------------------------------------------------------------------
    ch.start("Préparer", "Créer 2 pistes voix (lead + double), armées", protools="Piste › Nouvelle : Ctrl+Maj+N, « 2 », Entrée, puis renommer (1 raccourci + 2 touches + 2 renommages)")
    n0 = len(tracks(page))
    ids0 = {t["id"] for t in tracks(page)}
    for i in range(2):
        b = reachable(ch, "button[aria-label='Ajouter une piste voix']", "Piste voix")
        if b: ch.click(b, "Piste voix")
        elif open_by_palette(ch, "piste voix", "pal.voiceTrack"): pass
        else:
            # Bouton présent dans la page mais inatteignable : on le déclenche quand même (étape KO)
            # pour mesurer la suite de la séance.
            ch.fail("« Piste voix » inatteignable (hors de l'écran)")
            page.evaluate("() => document.querySelector(\"button[aria-label='Ajouter une piste voix']\")?.click()")
        page.wait_for_timeout(500)
    ch.wait_js(f"() => window.__novaEdit.getState().tracks.length >= {n0 + 2}", 6000, "2 pistes en plus")
    tr = tracks(page)
    res["pistes_apres_creation"] = [t["name"] for t in tr]
    new_ids = [t["id"] for t in tr if t["id"] not in ids0]
    res["nouvelles"] = [t["name"] for t in tr if t["id"] in new_ids]
    ch.end()
    LEAD = new_ids[0] if new_ids else None
    DOUBLE = new_ids[1] if len(new_ids) > 1 else None

    # 5. Preset de piste -------------------------------------------------------------------
    ch.start("Préparer", "Preset « Voix lead Make Music » sur la lead", protools="Nom de piste › clic droit › Track Preset › choisir (3 clics)")
    lead = next((t for t in tracks(page) if t["id"] == LEAD), None)
    opened = False
    if lead:
        page.evaluate("(id) => { const s = window.__novaEdit; }", lead["id"])
        hdr = page.locator(f"[data-track-header='{lead['id']}'], [data-trackid='{lead['id']}']").locator("visible=true")
        target = hdr.first if hdr.count() else page.get_by_text(lead["name"], exact=True).locator("visible=true").last
        try:
            ch.click(target, f"clic droit sur {lead['name']}", button="right")
            it = page.locator("[role=menu] button", has_text=re.compile("Track Preset")).locator("visible=true")
            if it.count(): ch.click(it.first, "Track Preset…"); opened = True
            else: ch.friction("menu de piste sans « Track Preset »"); page.keyboard.press("Escape")
        except Exception as e:
            ch.friction(f"clic droit impossible ({str(e)[:50]})")
    if not opened:
        page.keyboard.press("Escape")
        if open_by_palette(ch, "preset voix lead", "pal.trackPreset"): opened = True
    dlg = page.locator("[data-testid=track-preset-dialog]")
    if ch.wait_js("() => !!document.querySelector('[data-testid=track-preset-dialog]')", 4000, "fenêtre Track Presets"):
        item = dlg.locator("button, li", has_text=re.compile("Voix lead Make Music")).locator("visible=true")
        if item.count():
            ch.click(item.first, "Voix lead Make Music")
            ap = dlg.locator("[data-testid=track-preset-apply]").locator("visible=true")
            if ap.count(): ch.click(ap.first, "Appliquer")
        else:
            ch.fail("« Voix lead Make Music » absent de la liste")
    page.wait_for_timeout(600)
    if lead:
        pl = app_state(page, f"s => (s.tracks.find(t => t.id === '{lead['id']}') || {{}}).plugins?.length || 0")
        if not pl: ch.fail("aucun effet posé sur la lead")
        res["effets_lead"] = pl
    page.keyboard.press("Escape")
    ch.end()

    # 6. Armer les 2 pistes -------------------------------------------------------------------
    ch.start("Enregistrer", "Armer les 2 pistes", protools="Bouton R de chaque piste (2 clics)")
    voice = [t for t in tracks(page) if t["id"] in (LEAD, DOUBLE)]
    for t in voice:
        if not t["armed"]:
            ok = page.evaluate("(id) => { const b = document.querySelector(`[data-track-header='${id}'] button[aria-label*='Armer'], [data-track-header='${id}'] button[title*='rmer']`); if (b) { b.click(); return true; } return false; }", t["id"])
            if ok: ch.cur["clics"] += 1
            else: ch.friction(f"bouton R de {t['name']} introuvable par le test")
    armed = [t["name"] for t in tracks(page) if t["armed"]]
    res["armees"] = armed
    both = all(t["armed"] for t in tracks(page) if t["id"] in (LEAD, DOUBLE))
    ch.end(ok=both, note=f"armées : {armed}")

    # 7. Loop Record : 3 prises -------------------------------------------------------------
    ch.start("Enregistrer", "3 prises en Loop Record (boucle de 2 mesures)", protools="Sélecteur sur 2 mesures, Loop Record (Alt+L), Ctrl+Espace, Espace : 1 glisser + 3 touches")
    loop_end = 2 * 4 * 60 / 140
    pt0 = track_point(page, LEAD, 0.02); pt1 = track_point(page, LEAD, loop_end)
    ch.press("4")  # Sélecteur (F7)
    if pt0 and pt1: ch.drag(pt0[0], pt0[1], pt1[0], pt1[1], "plage de 2 mesures")
    ch.press("l")
    st = app_state(page, "s => ({ on: s.isLoopActive, a: s.loopStart, b: s.loopEnd })")
    if st and abs(st["b"] - st["a"] - loop_end) > 0.3:
        ch.friction(f"L ne boucle pas la plage sélectionnée (boucle {st['a']:.2f}→{st['b']:.2f} s)")
    if st and not st["on"]: ch.press("l"); st = app_state(page, "s => ({ on: s.isLoopActive, a: s.loopStart, b: s.loopEnd })")
    res["boucle"] = st
    ch.press("5")  # Smart Tool
    ch.press("Home")
    ch.press("r")
    page.wait_for_timeout(700)
    casque = page.get_by_role("button", name=re.compile("Oui, j.ai un casque")).locator("visible=true")
    if casque.count():
        ch.friction("question « casque ? » au 1er REC (1 clic de plus, une fois)")
        ch.click(casque.first, "Oui, j'ai un casque")
        if not ch.wait_js("() => window.__novaEdit.getState().isRecording", 2500, ""):
            ch.cur["frictions"][-1:] = []
            ch.cur["ok"] = True
            ch.friction("après la question du casque, il faut relancer REC")
            ch.press("r")
    started = ch.wait_js("() => window.__novaEdit.getState().isRecording", 6000, "enregistrement lancé")
    secs = 3 * ((st or {}).get("b", loop_end) - (st or {}).get("a", 0)) + 1.2
    page.wait_for_timeout(int(secs * 1000))
    ch.press("Space")
    ch.wait_js("() => !window.__novaEdit.getState().isRecording", 15000, "fin de prise")
    page.wait_for_timeout(1500)
    takes = app_state(page, f"s => s.tracks.filter(t => ['{LEAD}', '{DOUBLE}'].includes(t.id)).map(t => ({{ n: t.name, clips: t.clips.length, takes: t.clips.filter(c => c.takeNumber).length, lanes: (t.takeLanes || t.takes || []).length }}))")
    res["prises"] = takes
    best = max((max(t["clips"], t["takes"], t["lanes"]) for t in (takes or [])), default=0)
    ch.end(ok=bool(started) and best >= 3, note=f"prises : {takes} (secondes enregistrées ≈ {secs:.1f})")
    page.screenshot(path=str(OUT / "v07_prises.png"))

    # 8. Comp : choisir une prise ---------------------------------------------------------------
    ch.start("Éditer", "Comp : écouter / garder la prise 2", protools="Clic droit sur le clip › Matching Alternates › prise (2 clics)")
    pr = page.locator("button", has_text=re.compile(r"^Prises \(\d+\)")).locator("visible=true")
    if pr.count():
        ch.click(pr.last, "Prises (n)")
        opt = page.locator("button, [role=menuitem]", has_text=re.compile(r"Prise 2|Garder")).locator("visible=true")
        if opt.count(): ch.click(opt.first, "Prise 2 / Garder")
        else: ch.friction("liste des prises sans « Prise 2 »")
    else:
        ch.fail("pastille « Prises (n) » introuvable")
    page.keyboard.press("Escape")
    ch.end()

    # 9. Respirations -------------------------------------------------------------------------
    ch.start("Éditer", "Respirations de la lead (fenêtre, appliquer)", protools="Pas d'outil natif : plug-in AudioSuite (RX Breath Control) ≈ 5 clics")
    x, y = track_point(page, LEAD, 1.2) or (0, 0)
    ch.mouse_click(x, y, "clip de la lead")
    ch.press("Control+Alt+r")
    if ch.wait_js("() => /Respirations/.test(document.querySelector('[role=dialog]')?.innerText || '')", 4000, "fenêtre Respirations"):
        ap = page.locator("[role=dialog] button", has_text=re.compile("^Appliquer$")).locator("visible=true")
        if ap.count(): ch.click(ap.first, "Appliquer")
    page.keyboard.press("Escape")
    ch.end()

    # 10. Justesse -----------------------------------------------------------------------------
    ch.start("Éditer", "Justesse note par note (ouvrir puis fermer)", protools="Clip › ARA › Melodyne (clic droit + 2 clics), fenêtre en bas")
    ch.mouse_click(x, y, "clip de la lead", button="right")
    page.wait_for_timeout(250)
    page.screenshot(path=str(OUT / "v10_menu_clip.png"))
    it = page.locator("[role=menu] button", has_text=re.compile("Justesse")).locator("visible=true")
    if it.count():
        ch.click(it.first, "Justesse…")
    elif not open_by_palette(ch, "justesse", "pal.pitch"):
        ch.fail("justesse introuvable")
    ch.wait_js("() => !!document.querySelector('[data-testid=pitch-editor]')", 8000, "éditeur de justesse")
    page.screenshot(path=str(OUT / "v10_justesse.png"))
    ch.press("Escape")
    if page.locator("[data-testid=pitch-editor]").count(): ch.friction("Échap ne ferme pas la justesse"); page.locator("[data-testid=pitch-editor] button[aria-label^=Fermer]").first.click()
    ch.end()

    # 11. Édition -----------------------------------------------------------------------------
    ch.start("Éditer", "Séparer, fondus rapides, +0,5 dB de gain de clip, mode Grid puis Slip", protools="B (séparer) ou Ctrl+E, Ctrl+F, Ctrl+Maj+↑, F4, F2 : 5 raccourcis")
    n_before = app_state(page, f"s => s.tracks.find(t => t.id === '{LEAD}').clips.length")
    ch.mouse_click(x, y, "clip")
    page.evaluate("async () => { const { playheadStore } = await window.__novaAppModule('/utils/playheadStore.ts').catch(() => ({})); }")
    ch.press("Control+e")
    ch.press("Control+Alt+f")
    ch.press("Control+Shift+ArrowUp")
    ch.press("F4"); ch.press("F2")
    n_after = app_state(page, f"s => s.tracks.find(t => t.id === '{LEAD}').clips.length")
    mode = page.evaluate("() => window.__novaEditMode && window.__novaEditMode.get().mode")
    ch.end(note=f"clips {n_before} → {n_after}, mode {mode}")

    # 12. Export -------------------------------------------------------------------------------
    ch.start("Livrer", "Exporter la démo (WAV, tout le morceau)", protools="Fichier › Bounce : Ctrl+Alt+B, Bounce, nom, Enregistrer (1 raccourci + 2 clics + saisie)")
    ch.press("Control+Shift+E")
    ok = ch.wait_js("() => !!document.querySelector('[role=dialog][aria-labelledby=export-title]')", 6000, "fenêtre Exporter")
    if ok:
        # « VÉRIFICATION… » (compte admin / Nova Pro vérifié en ligne, jusqu'à 4 s) : on attend comme l'ingé.
        w = ch.wait_js("() => Array.from(document.querySelectorAll('[role=dialog] button')).some(b => /^\s*(EXPORTER|PAYER|Télécharger)/i.test(b.innerText) && !b.disabled)", 8000, "bouton EXPORTER actif")
        if w and w > 1500: ch.friction(f"bouton « VÉRIFICATION… » pendant {w} ms avant de pouvoir exporter")
        bt = page.locator("[role=dialog] button:visible", has_text=re.compile(r"^\s*EXPORTER\s*$"))
        if bt.count():
            try:
                with page.expect_download(timeout=120000) as dl:
                    ch.click(bt.last, "EXPORTER")
                d = dl.value
                path = OUT / f"demo_{PHASE}.{(d.suggested_filename or 'x.wav').split('.')[-1]}"
                d.save_as(str(path))
                res["export"] = {"fichier": d.suggested_filename, "octets": path.stat().st_size}
            except Exception as e:
                ch.fail(f"pas de fichier exporté ({str(e)[:80]})")
        else:
            prim = page.evaluate("() => Array.from(document.querySelectorAll('[role=dialog] button')).filter(b => b.getClientRects().length).map(b => b.innerText.trim()).filter(Boolean).slice(-4)")
            page.screenshot(path=str(OUT / "v12_export.png"))
            ch.fail(f"bouton Exporter introuvable (boutons : {prim})")
    ch.end(note=json.dumps(res.get("export"), ensure_ascii=False))
    page.keyboard.press("Escape")
    return res


with sync_playwright() as p:
    b = launch(p)
    log = Log("session_voix")
    ctx, page = new_page(b, "pc", log=log)
    page.set_default_timeout(20000)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    ch = Chrono("session_voix", page, log, OUT)
    t0 = time.time()
    try:
        extra = run(page, log, ch)
    except Exception as e:
        ch.fail(f"arrêt : {type(e).__name__}: {str(e)[:200]}"); ch.end(ok=False)
        extra = {"arret": str(e)[:300]}
        page.screenshot(path=str(OUT / "arret.png"))
    rep = ch.report()
    rep["phase"] = PHASE
    rep["mesures"] = extra
    rep["duree_totale_s"] = round(time.time() - t0, 1)
    rep["erreurs_console"] = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:15]
    rep["erreurs_pont_vst"] = sum(1 for e in log.errors() if re.search(r"876[56]", e["text"]))
    save_json(OUT / "session_voix.json", rep)
    print("\nTOTAL :", json.dumps(rep["total"], ensure_ascii=False), "| console :", len(rep["erreurs_console"]), "erreur(s), pont VST :", rep["erreurs_pont_vst"])
    ctx.close(); b.close()
