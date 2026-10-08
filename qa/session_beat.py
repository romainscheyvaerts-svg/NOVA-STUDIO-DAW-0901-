"""Session beatmaker chronométrée (trap), souris + clavier, PC 1600 × 900.

 1. nouveau projet vierge          2. ouvrir la batterie            3. kit Trap
 4. caisse claire sur 2 et 4       5. 808 (piano roll) + une note au crayon
 6. tout sélectionner + quantifier 7. fermer le piano roll (Échap)
 8. exporter le .mid               9. réimporter le .mid           10. nouvelle piste Sampler
11. exporter le beat (WAV)
Clics, touches, temps, chemin, hésitations, console ; gestes de Pro Tools / FL Studio pour la
même tâche. Chrome headless (aucune fenêtre), Nova Studio simulé, aucune écriture externe.

NOVA_URL=http://127.0.0.1:3491/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/session_beat.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro\\<phase>\\session_beat\\
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3491/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro\{PHASE}\session_beat")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from nova_pro_lib import Chrono, visible_first, open_by_palette, via_menu, app_state, save_json  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DRUMS = "[aria-labelledby='drums-title']"
PR = "[data-nova-pianoroll]"


def in_view(page, loc):
    return page.evaluate("""(el) => { const r = el.getBoundingClientRect(); if (!r.width) return false;
      if (r.bottom > innerHeight || r.right > innerWidth || r.top < 0 || r.left < 0) return false;
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && el.contains(h); }""", loc.element_handle())


def reachable(ch, sel, label):
    loc = visible_first(ch.page, sel)
    if not loc: return None
    if not in_view(ch.page, loc):
        ch.friction(f"« {label} » existe mais est hors de l'écran ou caché"); return None
    return loc


def midi_notes(page):
    return app_state(page, "s => s.tracks.filter(t => t.type === 'MIDI' || (t.clips || []).some(c => c.type === 'MIDI')).reduce((n, t) => n + t.clips.reduce((m, c) => m + ((c.notes || c.midiNotes || []).length), 0), 0)") or 0


def run(page, log, ch):
    res = {}
    ch.start("Ouvrir", "Nouveau projet vierge", protools="Ctrl+N + nom + Entrée ; FL : Ctrl+N")
    t = time.time()
    page.goto(BASE, wait_until="domcontentloaded")
    nouveau = page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first
    nouveau.wait_for(timeout=60000)
    ch.click(nouveau, "Nouveau Projet")
    page.wait_for_timeout(600); close_welcome(page)
    ch.wait_js("() => !!document.querySelector('.nova-grille canvas') && !!window.__novaEdit", 30000, "studio prêt")
    res["studio_ms"] = round((time.time() - t) * 1000)
    ch.end()
    page.keyboard.press("Escape")

    ch.start("Batterie", "Ouvrir la boîte à rythmes", protools="FL : F6 (Channel rack) ; Pro Tools : nouvelle piste instrument + plug-in (≈ 5 gestes)")
    b = reachable(ch, "button[aria-label='Batterie'], button[title^='Boîte à rythmes']", "Batterie")
    if b: ch.click(b, "Batterie")
    elif via_menu(ch, "Batterie|Boîte à rythmes"): pass
    elif open_by_palette(ch, "batterie", "pal.drums"): pass
    else:
        # Détour d'un beatmaker qui ne trouve pas : repartir d'une mélodie du catalogue (mode beat).
        ch.fail("batterie introuvable dans un projet vierge (seulement en mode beat / Mélodies) : détour par une mélodie du catalogue")
        page.goto(BASE, wait_until="domcontentloaded")
        mel = page.get_by_text("Mélodies", exact=False).first
        mel.wait_for(timeout=60000); ch.click(mel, "onglet Mélodies")
        page.wait_for_timeout(1200)
        first = page.locator("button:visible", has_text=re.compile("Neon Storm|ESSAYER")).first
        ch.click(first, "une mélodie")
        page.wait_for_timeout(1200); close_welcome(page)
        try: wait_text_gone(page, "Chargement", 90)
        except Exception: pass
        page.wait_for_timeout(1500); close_welcome(page)
        if not page.locator(DRUMS).count():
            b = reachable(ch, "button[aria-label='Batterie'], button[title^='Boîte à rythmes']", "Batterie")
            if b: ch.click(b, "Batterie")
    ok = ch.wait_js(f"() => !!document.querySelector(\"{DRUMS}\")", 8000, "batterie ouverte")
    ch.end(ok=bool(ok))
    if not ok:
        return res

    ch.start("Batterie", "Choisir le kit Trap", protools="FL : glisser un kit dans le Channel rack (≈ 3 gestes)")
    ch.click(page.get_by_role("button", name="🔥 Trap").first, "Trap")
    ch.wait_js("() => document.querySelectorAll('button[aria-label^=\"Kick, pas\"]').length >= 16", 5000, "grille de pas")
    ch.end()

    ch.start("Batterie", "Caisse claire sur 2 et 4 (pas 5 et 13)", protools="FL : 2 clics dans le step sequencer")
    for k in (5, 13):
        st = page.locator(f"button[aria-label^='Snare, pas {k}']").first
        lab = st.get_attribute("aria-label") or ""
        if "actif" not in lab: ch.click(st, f"Snare pas {k}")
    act = page.evaluate("() => [5, 13].every(k => /actif/.test(document.querySelector(`button[aria-label^='Snare, pas ${k}']`)?.getAttribute('aria-label') || ''))")
    ch.end(ok=act)
    page.screenshot(path=str(OUT / "b04_batterie.png"))

    ch.start("808", "808 : piano roll + une note au crayon", protools="FL : piste 808 + piano roll (F7) + clic au crayon (≈ 3 gestes)")
    n0 = midi_notes(page)
    b = visible_first(page, f"{DRUMS} button:has-text('808 +')") or visible_first(page, "button[aria-label='Basse 808']")
    if b: ch.click(b, "808 +")
    elif not open_by_palette(ch, "808", "pal.808"): ch.fail("808 introuvable")
    ch.wait_js(f"() => !!document.querySelector('{PR}')", 6000, "piano roll")
    page.wait_for_timeout(800)
    close_btn = page.locator(f"{PR} button[aria-label='Fermer']").locator('visible=true').first
    if close_btn.count() and not in_view(page, close_btn):
        ch.friction("bouton Fermer du piano roll hors de l'écran (barre d'outils qui déborde)")
    res["barre_piano_roll_deborde"] = page.evaluate(f"() => {{ const b = document.querySelector('{PR}'); if (!b) return null; const out = [...b.querySelectorAll('button')].filter(x => x.getClientRects().length && x.getBoundingClientRect().right > innerWidth + 1).map(x => (x.getAttribute('aria-label') || x.innerText || '').trim().slice(0, 30)); return out; }}")
    n1 = midi_notes(page)
    grid = page.evaluate(f"() => {{ const r = document.querySelector('{PR}').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }}")
    ch.mouse_click(grid[0] + grid[2] * 0.7, grid[1] + grid[3] * 0.3, "note au crayon")
    page.wait_for_timeout(300)
    n2 = midi_notes(page)
    res["notes_808"] = [n0, n1, n2]
    ch.end(ok=n2 > n1 or n1 > n0, note=f"notes {n0} → {n1} (808 posée) → {n2} (crayon)")
    page.screenshot(path=str(OUT / "b05_piano_roll.png"))

    ch.start("808", "Tout sélectionner + quantifier", protools="Ctrl+A puis Alt+0 (Quantize) : 2 raccourcis")
    ch.press("Control+a")
    q = visible_first(page, f"{PR} button[aria-label='Quantifier la sélection'], {PR} button[title^='Quantifier']")
    if q: ch.click(q, "Quantifier")
    else: ch.fail("Quantifier introuvable")
    ch.end()

    ch.start("808", "Fermer le piano roll (Échap)", protools="Fermer la fenêtre MIDI Editor : Ctrl+W / Échap")
    ch.press("Escape")
    closed = ch.wait_js(f"() => !document.querySelector('{PR}')", 2000, "piano roll fermé")
    if not closed:
        ch.cur["frictions"][-1:] = []
        ch.friction("Échap ne ferme pas le piano roll")
        b = page.locator(f"{PR} button[aria-label='Fermer']").first
        try: ch.click(b, "Fermer"); closed = True
        except Exception: pass
    ch.end(ok=bool(closed))
    for _ in range(2):
        if page.locator(DRUMS).count(): page.keyboard.press("Escape"); page.wait_for_timeout(250)

    ch.start("MIDI", "Exporter le .mid", protools="Fichier › Exporter › MIDI (3 clics + Enregistrer)")
    path = None
    try:
        with page.expect_download(timeout=20000) as dl:
            if not via_menu(ch, "Exporter en .mid"):
                if not open_by_palette(ch, "mid", None): ch.fail("export .mid introuvable")
        d = dl.value
        path = OUT / (d.suggested_filename or "beat.mid")
        d.save_as(str(path))
        res["mid"] = {"fichier": d.suggested_filename, "octets": path.stat().st_size, "MThd": path.read_bytes()[:4] == b"MThd"}
    except Exception as e:
        ch.fail(f"pas de .mid ({str(e)[:80]})")
    ch.end(note=json.dumps(res.get("mid"), ensure_ascii=False))

    ch.start("MIDI", "Réimporter le .mid", protools="Fichier › Importer › MIDI (Ctrl+Alt+I) + choisir")
    n_tr = len(app_state(page, "s => s.tracks.map(t => t.id)") or [])
    if path:
        try:
            with page.expect_file_chooser(timeout=8000) as fc:
                if not via_menu(ch, "Importer un fichier .mid"):
                    ch.fail("import .mid introuvable")
            fc.value.set_files(str(path)); ch.cur["clics"] += 1; ch.cur["chemin"].append("choisir le .mid")
            keep = page.locator("[data-testid=midi-import-project]")
            try:
                keep.first.wait_for(timeout=4000); ch.click(keep.first, "Garder le tempo du projet")
            except Exception:
                pass
            ch.wait_js(f"() => window.__novaEdit.getState().tracks.length > {n_tr} || window.__novaEdit.getState().tracks.some(t => t.clips.some(c => /\\.mid|import/i.test(c.name || '')))", 8000, "MIDI importé")
        except Exception as e:
            ch.fail(f"import impossible ({str(e)[:80]})")
    for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(200)
    ch.end()

    ch.start("Sampler", "Nouvelle piste Sampler (puis fermer)", protools="FL : Channel rack › Sampler (2 clics) ; Live : glisser Simpler")
    b = reachable(ch, "[data-testid=new-sampler-track]", "Sampler")
    if b: ch.click(b, "Sampler")
    elif not open_by_palette(ch, "sampler", "pal.sampler"): ch.fail("Sampler introuvable")
    ok = ch.wait_js("() => !!document.querySelector('[data-testid=sampler-panel], [aria-labelledby=sampler-title], [aria-label*=Sampler][role=dialog]')", 6000, "fenêtre Sampler")
    page.screenshot(path=str(OUT / "b10_sampler.png"))
    ch.press("Escape")
    ch.end(ok=bool(ok))

    ch.start("Livrer", "Exporter le beat (WAV)", protools="Bounce : Ctrl+Alt+B, Bounce, nom, Enregistrer ; FL : Ctrl+R")
    for _ in range(2):
        if page.locator("[role=dialog]").count(): page.keyboard.press("Escape"); page.wait_for_timeout(200)
    ch.press("Control+Shift+E")
    ch.wait_js("() => !!document.querySelector('[role=dialog][aria-labelledby=export-title]')", 6000, "Exporter")
    w = ch.wait_js("() => Array.from(document.querySelectorAll('[role=dialog] button')).some(b => /^\\s*EXPORTER\\s*$/.test(b.innerText) && !b.disabled)", 8000, "bouton EXPORTER")
    bt = page.locator("[role=dialog] button:visible", has_text=re.compile(r"^\s*EXPORTER\s*$"))
    if bt.count():
        try:
            with page.expect_download(timeout=120000) as dl:
                ch.click(bt.last, "EXPORTER")
            d = dl.value; p2 = OUT / f"beat_{PHASE}_{d.suggested_filename}"; d.save_as(str(p2))
            res["export"] = {"fichier": d.suggested_filename, "octets": p2.stat().st_size}
        except Exception as e:
            ch.fail(f"pas de fichier ({str(e)[:80]})")
    else:
        prim = page.evaluate("() => Array.from(document.querySelectorAll('[role=dialog] button')).filter(b => b.getClientRects().length).map(b => b.innerText.trim()).filter(Boolean).slice(-4)")
        ch.fail(f"EXPORTER introuvable ({prim})")
    ch.end(note=json.dumps(res.get("export"), ensure_ascii=False))
    return res


with sync_playwright() as p:
    b = launch(p)
    log = Log("session_beat")
    ctx, page = new_page(b, "pc", log=log)
    page.set_default_timeout(20000)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    ch = Chrono("session_beat", page, log, OUT)
    t0 = time.time()
    try:
        extra = run(page, log, ch)
    except Exception as e:
        ch.fail(f"arrêt : {type(e).__name__}: {str(e)[:200]}"); ch.end(ok=False)
        extra = {"arret": str(e)[:300]}
        page.screenshot(path=str(OUT / "arret.png"))
    rep = ch.report(); rep["phase"] = PHASE; rep["mesures"] = extra; rep["duree_totale_s"] = round(time.time() - t0, 1)
    rep["erreurs_console"] = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:15]
    rep["erreurs_pont_vst"] = sum(1 for e in log.errors() if re.search(r"876[56]", e["text"]))
    save_json(OUT / "session_beat.json", rep)
    print("\nTOTAL :", json.dumps(rep["total"], ensure_ascii=False), "| console :", len(rep["erreurs_console"]), "erreur(s), pont VST :", rep["erreurs_pont_vst"])
    ctx.close(); b.close()
