"""Session de mix chronométrée (20 pistes, rap / trap), souris + clavier, PC 1600 × 900.

 1. ouvrir le projet (20 pistes, 2 bus, 2 retours)   2. console (Ctrl+=) et retour
 3. VCA des voix (6 pistes)                           4. envoi Reverb sur la lead, Écho sur la double
 5. automation du volume de la lead (mode Latch, fader pendant la lecture)
 6. side-chain : compresseur sur la 808, clé = Kick (« 808 sous le kick »)
 7. mètres : LUFS du master après 4 s de lecture     8. Master Nova (cible Spotify)
 9. export des stems par bus                         10. export du mix avec titre et artiste
Clics, touches, temps, chemin, hésitations, console ; gestes Pro Tools pour la même tâche.
Chrome headless (aucune fenêtre), Nova Studio simulé, aucune écriture externe.

NOVA_URL=http://127.0.0.1:3491/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/session_mix.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro\\<phase>\\session_mix\\
"""
import json, os, re, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3491/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro\{PHASE}\session_mix")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa: E402
from nova_pro_lib import Chrono, visible_first, open_by_palette, via_menu, track_point, app_state, save_json  # noqa: E402
from projet_mix import make_mix_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ST = lambda page, e: app_state(page, e)  # noqa: E731


def scroll_to(page, tid):
    page.evaluate("(id) => document.querySelector(`[data-track-header='${id}']`)?.scrollIntoView({ block: 'center' })", tid)
    page.wait_for_timeout(200)


def run(page, log, ch, zpath):
    res = {}
    # 1. Ouvrir ---------------------------------------------------------------------------
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=60000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
    page.wait_for_timeout(800); close_welcome(page); wait_text_gone(page, "Chargement", 90); page.wait_for_timeout(800)
    page.keyboard.press("Escape")
    ch.start("Ouvrir", "Ouvrir le projet de 20 pistes (fichier .zip)", protools="Fichier › Ouvrir une session (Ctrl+O) + choisir : 1 raccourci + 1 choix")
    t = time.time()
    b = visible_first(page, "button[aria-label='Ouvrir un projet']")
    if b: ch.click(b, "Ouvrir")
    elif not via_menu(ch, "^\\s*Ouvrir un projet"):
        open_by_palette(ch, "ouvrir", "pal.open")
    f = page.get_by_role("button", name=re.compile("Fichier sur l.ordinateur")).locator("visible=true")
    ch.click(f.first, "Fichier sur l'ordinateur")
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(zpath))
    ch.cur["clics"] += 1; ch.cur["chemin"].append("choisir le fichier")
    page.get_by_text("Projet chargé").first.wait_for(timeout=60000)
    ch.wait_js("() => window.__novaEdit.getState().tracks.length >= 25", 20000, "25 pistes")
    res["ouverture_ms"] = round((time.time() - t) * 1000)
    ch.end(note=f"{res['ouverture_ms']} ms")
    page.mouse.click(5, 300); page.keyboard.press("Escape")

    # 2. Console ---------------------------------------------------------------------------
    ch.start("Mix", "Console de mixage (Ctrl+=) puis retour à l'arrangement", protools="Fenêtre › Mixage : Ctrl+= (1 raccourci), retour Ctrl+=")
    t = time.time()
    ch.press("Control+Equal")
    ms = ch.wait_js("() => !!document.querySelector('[data-testid^=mixer-strip], [data-mixer-strip], .nova-mixer, [data-nova-mixer]') || /MASTER/.test(document.querySelector('main')?.innerText || '')", 10000, "console affichée")
    res["console_ms"] = ms
    page.screenshot(path=str(OUT / "m02_console.png"))
    ch.press("Control+Equal")
    ch.wait_js("() => !!document.querySelector('.nova-grille canvas')", 8000, "arrangement")
    ch.end(note=f"console {ms} ms")

    # 3. VCA des voix ------------------------------------------------------------------------
    ch.start("Mix", "VCA des 6 voix (lead, double, 4 backs)", protools="Sélection des 6 pistes (2 clics), Piste › Nouvelle VCA, affectation au groupe : ≈ 6 gestes")
    b = visible_first(page, "[data-testid=dock-track-list]")
    if b: ch.click(b, "Pistes")
    elif not open_by_palette(ch, "liste des pistes", "pal.trackList"): ch.fail("liste des pistes introuvable")
    panel = page.locator("[role=dialog][aria-label='Liste des pistes']")
    try: panel.wait_for(timeout=4000)
    except Exception: ch.fail("liste des pistes pas ouverte")
    for nm in ["Lead", "Double", "Back 1", "Back 2", "Back 3", "Back 4"]:
        row = panel.get_by_text(nm, exact=True).locator("visible=true")
        if row.count(): ch.click(row.first, nm)
        else: ch.friction(f"« {nm} » absent de la liste")
    vca = panel.locator("button", has_text=re.compile(r"\+ VCA")).locator("visible=true")
    if vca.count(): ch.click(vca.first, "+ VCA")
    else: ch.fail("bouton + VCA introuvable")
    ok = ch.wait_js("() => window.__novaEdit.getState().tracks.some(t => t.isVca)", 3000, "VCA créé")
    res["vca"] = ST(page, "s => s.tracks.filter(t => t.isVca).map(t => ({ n: t.name, membres: (t.vcaMembers || t.memberIds || []).length }))")
    page.keyboard.press("Escape")
    ch.end(ok=bool(ok))

    # 4. Envois ------------------------------------------------------------------------------
    ch.start("Mix", "Envoi Reverb sur la lead, Écho sur la double", protools="Insérer un envoi (2 clics : sélecteur d'envoi › bus), régler le niveau (1 glisser), ×2")
    for tid, ret, lab in (("t8", "ret-verb", "Reverb"), ("t9", "ret-echo", "Écho")):
        scroll_to(page, tid)
        eb = page.locator(f"[data-track-header='{tid}'] button[title^='Envois']").locator("visible=true")
        if not eb.count(): ch.fail(f"bouton Envois de la piste {tid} introuvable"); continue
        ch.click(eb.first, f"Envois ({lab})")
        panel = page.locator(f"[data-testid=sends-panel-{tid}]")
        row = panel.locator("div", has_text=re.compile(f"^{lab}", re.I)).locator("visible=true")
        fader = panel.locator(f"[data-send-id='{ret}'], [aria-label*='{lab}' i]").locator("visible=true")
        target = fader.first if fader.count() else (row.last if row.count() else None)
        if target is None:
            ch.fail(f"retour « {lab} » de la session absent des envois de la piste (seulement : {panel.inner_text()[:80]!r})")
        else:
            bb = target.bounding_box()
            ch.drag(bb["x"] + 4, bb["y"] + bb["height"] / 2, bb["x"] + bb["width"] * 0.7, bb["y"] + bb["height"] / 2, f"fader d'envoi {lab}")
        page.wait_for_timeout(200)
        lvl = ST(page, f"s => (s.tracks.find(t => t.id === '{tid}').sends.find(x => x.id === '{ret}') || {{}}).level || 0")
        if not lvl: ch.fail(f"aucun envoi vers « {lab} » après le geste")
        res[f"envoi_{tid}"] = lvl
        ch.click(eb.first, "refermer les envois")
    ch.end()

    # 5. Automation ----------------------------------------------------------------------------
    ch.start("Mix", "Automation du volume de la lead (Latch, fader pendant 3 s de lecture)", protools="Mode Latch (2 clics), lecture, fader, stop (1 glisser + 2 touches)")
    scroll_to(page, "t8")
    sel_btn = page.locator("[data-track-header='t8'] button[aria-label^=\"Mode d'automation\"]").locator("visible=true")
    if sel_btn.count():
        ch.click(sel_btn.first, "mode d'automation")
        latch = page.locator("button, [role=menuitem], [role=option]", has_text=re.compile(r"^\s*(Latch|LATCH)")).locator("visible=true")
        if latch.count(): ch.click(latch.first, "Latch")
        else: ch.friction("mode Latch introuvable dans le menu")
    else:
        ch.fail("sélecteur de mode d'automation introuvable (mode simple ?)")
    ch.press("Home"); ch.press("Space")
    page.wait_for_timeout(600)
    fad = page.locator("[data-track-header='t8'] input[type=range], [data-track-header='t8'] [role=slider]").locator("visible=true")
    if fad.count():
        bb = fad.first.bounding_box()
        ch.drag(bb["x"] + bb["width"] * 0.8, bb["y"] + bb["height"] / 2, bb["x"] + bb["width"] * 0.35, bb["y"] + bb["height"] / 2, "fader de volume")
    else:
        ch.friction("fader de volume de la piste introuvable par le test")
    page.wait_for_timeout(1500)
    ch.press("Space")
    pts = ST(page, "s => (s.tracks.find(t => t.id === 't8').automationLanes || []).reduce((n, l) => n + (l.points || []).length, 0)")
    res["points_automation"] = pts
    ch.end(ok=bool(pts), note=f"{pts} point(s)")

    # 6. Side-chain ------------------------------------------------------------------------------
    ch.start("Mix", "Side-chain : compresseur sur la 808, clé = Kick", protools="Insert Dyn3 (3 clics), clé : sélecteur Key Input › bus (2 clics), bouton Key (1 clic) : ≈ 6 gestes + un envoi vers le bus")
    scroll_to(page, "t4")
    fx = page.locator("[data-track-header='t4'] button", has_text=re.compile(r"^FX$")).locator("visible=true")
    if fx.count(): ch.click(fx.first, "FX de la 808")
    add = page.locator("button", has_text=re.compile("Ajouter un effet")).locator("visible=true")
    if add.count(): ch.click(add.first, "Ajouter un effet")
    search = page.locator("input[aria-label='Chercher un effet']").locator("visible=true")
    if search.count():
        ch.type("comp"); ch.press("Enter")
    else:
        comp = page.locator("button, [role=menuitem], [role=option], li", has_text=re.compile(r"Compress", re.I)).locator("visible=true")
        if comp.count(): ch.click(comp.first, "Compresseur")
        else:
            ch.fail("« compresseur » introuvable : 28 noms commerciaux sans catégorie ni recherche (le compresseur s'appelle « Leveler »)")
            lev = page.locator("[role=menu] button", has_text=re.compile(r"^\s*Leveler\s*$")).locator("visible=true")
            if lev.count(): ch.click(lev.first, "Leveler (deviné)")
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / "m06_compresseur.png"))
    preset = page.locator("button", has_text=re.compile("808 sous le kick")).locator("visible=true")
    if not preset.count():
        sc = page.locator("button", has_text=re.compile(r"side.?chain|Clé|Préréglages trap", re.I)).locator("visible=true")
        if sc.count(): ch.click(sc.first, "side-chain"); preset = page.locator("button", has_text=re.compile("808 sous le kick")).locator("visible=true")
    if preset.count(): ch.click(preset.first, "808 sous le kick")
    else: ch.friction("préréglage « 808 sous le kick » introuvable")
    keysel = page.locator("select").filter(has=page.locator("option", has_text="Kick")).locator("visible=true")
    if keysel.count():
        keysel.first.select_option(label="Kick"); ch.cur["clics"] += 1; ch.cur["chemin"].append("clé = Kick")
    page.wait_for_timeout(400)
    sc_state = ST(page, "s => { const t = s.tracks.find(t => t.id === 't4'); const p = (t.plugins || []).find(p => /COMP/i.test(p.type)); return p ? { type: p.type, cle: p.sidechainSourceName || p.sidechainSourceId || null } : null; }")
    res["sidechain"] = sc_state
    ok = bool(sc_state and sc_state.get("cle"))
    for _ in range(3): page.keyboard.press("Escape"); page.wait_for_timeout(150)
    ch.end(ok=ok, note=json.dumps(sc_state, ensure_ascii=False))

    # 7. LUFS --------------------------------------------------------------------------------
    ch.start("Mètres", "LUFS du master après 4 s de lecture", protools="Fenêtre › Mètre (ou insert Pro Limiter / Youlean) : 2 clics + lecture")
    ch.press("Home"); ch.press("Space"); page.wait_for_timeout(4000); ch.press("Space")
    chip = visible_first(page, "[data-testid=lufs-chip]")
    if chip: ch.click(chip, "puce LUFS")
    else: ch.fail("puce LUFS introuvable")
    page.wait_for_timeout(500)
    txt = page.evaluate("() => (document.querySelector('[role=dialog][aria-label*=Loudness], [aria-label=\"Loudness du master\"]')?.innerText || '').slice(0, 300)")
    m = re.search(r"(−|-)?\d+[,.]\d\s*LUFS", txt or "")
    res["lufs"] = m.group(0) if m else (txt or "")[:120]
    page.screenshot(path=str(OUT / "m07_lufs.png"))
    ch.press("Escape")
    ch.end(ok=bool(txt))

    # 8. Master Nova -----------------------------------------------------------------------------
    ch.start("Master", "Master Nova, cible Spotify", protools="Pas de mastering intégré (Ozone en insert : ≈ 5 gestes)")
    mb = visible_first(page, "[data-nova-open-master]")
    if mb: ch.click(mb, "Master Nova")
    elif not open_by_palette(ch, "master", "pal.masterNova"): ch.fail("Master Nova introuvable")
    ch.wait_js("() => !!document.querySelector('[data-nova-master]')", 5000, "Master Nova")
    sp = page.locator("[data-nova-master] button", has_text=re.compile("Spotify")).locator("visible=true")
    if sp.count(): ch.click(sp.first, "Spotify")
    else: ch.friction("cible Spotify introuvable")
    go = page.locator("[data-nova-master] button", has_text=re.compile(r"^(Appliquer|Masteriser|Lancer|Mastering)", re.I)).locator("visible=true")
    if go.count(): ch.click(go.first, go.first.inner_text()[:20])
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "m08_master.png"))
    ch.press("Escape")
    ch.end()

    # 9 / 10. Exports -------------------------------------------------------------------------------
    for tag, source, extra in (("stems_bus", "STEMS", "buses"), ("mix_meta", "MASTER", None)):
        ch.start("Livrer", "Export des stems par bus" if source == "STEMS" else "Export du mix avec titre et artiste",
                 protools="Stems : un Bounce par bus (solo, Bounce, nom) ×2 ≈ 10 gestes" if source == "STEMS" else "Bounce (Ctrl+Alt+B) + métadonnées hors Pro Tools : ≈ 4 gestes")
        for _ in range(3):
            if not page.locator("[role=dialog][aria-labelledby=export-title]").count(): break
            page.keyboard.press("Escape"); page.wait_for_timeout(300)
        ch.press("Control+Shift+E")
        ch.wait_js("() => !!document.querySelector('[role=dialog][aria-labelledby=export-title]')", 6000, "Exporter")
        page.screenshot(path=str(OUT / f"m09_export_{tag}.png"))
        if not page.locator("[data-export-vue=avancee]").count():
            adv = page.get_by_role("button", name=re.compile("Réglages avancés")).locator("visible=true")
            if adv.count(): ch.click(adv.first, "Réglages avancés")
        src = page.get_by_test_id(f"export-source-{source}")
        try: src.first.wait_for(timeout=4000)
        except Exception: ch.fail("choix Mix / Stems introuvable")
        if src.count(): ch.click(src.first, source)
        if extra:
            s_el = page.locator('[data-export-vue=avancee] label:has(> span:text-is("Découpage")) select')
            if s_el.count(): s_el.first.select_option(extra); ch.cur["clics"] += 1; ch.cur["chemin"].append("Découpage : par bus")
            else: ch.fail("choix « par bus » introuvable")
        else:
            for lab, val in (("Titre du morceau", "Nuit blanche"), ("Ton nom d'artiste", "Léo QA")):
                inp = page.locator(f"[role=dialog] input[placeholder=\"{lab}\"]").locator("visible=true")
                if inp.count(): inp.first.fill(val); ch.cur["clics"] += 1; ch.cur["touches"] += len(val); ch.cur["chemin"].append(f"saisie {lab}")
                else: ch.friction(f"champ « {lab} » introuvable")
        ch.wait_js("() => { const b = document.querySelector('[data-testid=export-go]'); return b && !b.disabled; }", 8000, "EXPORTER actif")
        try:
            with page.expect_download(timeout=180000) as dl:
                ch.click(page.get_by_test_id("export-go"), "EXPORTER")
            d = dl.value
            path = OUT / f"{tag}_{d.suggested_filename}"
            d.save_as(str(path))
            info = {"fichier": d.suggested_filename, "octets": path.stat().st_size}
            if path.suffix == ".zip":
                info["contenu"] = zipfile.ZipFile(path).namelist()[:12]
            res[tag] = info
            ch.end(note=json.dumps(info, ensure_ascii=False)[:200])
        except Exception as e:
            ch.fail(f"pas de fichier ({str(e)[:80]})"); ch.end()
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
    return res


with sync_playwright() as p:
    b = launch(p)
    log = Log("session_mix")
    ctx, page = new_page(b, "pc", log=log)
    page.set_default_timeout(20000)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    zpath = OUT / "mix20.zip"; make_mix_project(zpath, 20, "Nuit blanche")
    ch = Chrono("session_mix", page, log, OUT)
    t0 = time.time()
    try:
        extra = run(page, log, ch, zpath)
    except Exception as e:
        ch.fail(f"arrêt : {type(e).__name__}: {str(e)[:200]}"); ch.end(ok=False)
        extra = {"arret": str(e)[:300]}
        page.screenshot(path=str(OUT / "arret.png"))
    rep = ch.report(); rep["phase"] = PHASE; rep["mesures"] = extra; rep["duree_totale_s"] = round(time.time() - t0, 1)
    rep["erreurs_console"] = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:15]
    rep["erreurs_pont_vst"] = sum(1 for e in log.errors() if re.search(r"876[56]", e["text"]))
    save_json(OUT / "session_mix.json", rep)
    print("\nTOTAL :", json.dumps(rep["total"], ensure_ascii=False), "| console :", len(rep["erreurs_console"]), "erreur(s), pont VST :", rep["erreurs_pont_vst"])
    ctx.close(); b.close()
