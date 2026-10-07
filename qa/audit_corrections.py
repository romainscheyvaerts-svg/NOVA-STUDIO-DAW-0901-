"""Captures avant / après des corrections de l'audit d'usage (07/10/2026).

  NOVA_URL=http://localhost:3418/ python qa/audit_corrections.py avant b2 b6
  NOVA_URL=http://localhost:3418/ python qa/audit_corrections.py apres b2

Chaque scénario écrit `<code>_<phase>_*.png` dans D:\\1 WORK\\CONTENU\\nova-audit-corrections
et un résumé JSON `<code>_<phase>.json`. Navigateur headless : aucune fenêtre.
"""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-audit-corrections")
from qalib import launch, new_page, shot, OUT, Log  # noqa: E402
from scenarios import open_studio, visible, body, btn, close_welcome, do_take, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PHASE = sys.argv[1] if len(sys.argv) > 1 else "apres"
ONLY = [a.lower() for a in sys.argv[2:]]


def mk(b, vp="pc", mode="simple", name="x"):
    log = Log(name)
    ctx, pg = new_page(b, vp, log)
    pg.add_init_script(f"try {{ localStorage.setItem('nova_simple_mode', '{'1' if mode == 'simple' else '0'}'); localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0') }} catch (e) {{}}")
    pg._log = log
    return ctx, pg


def S(pg, code, label):
    return shot(pg, f"{code}_{PHASE}_{label}")


def errors(pg):
    return [e["text"][:250] for e in pg._log.entries if e["kind"] in ("console.error", "pageerror")]


def take(pg, secs=3):
    pg.keyboard.press("Home"); pg.keyboard.press("r")
    pg.wait_for_timeout(1500 + secs * 1000)
    pg.keyboard.press("r"); pg.wait_for_timeout(3500)


def headers(pg):
    """Pistes à l'écran : nom, y, armée, sélectionnée."""
    return pg.evaluate("""() => Array.from(document.querySelectorAll('[data-track-header]')).map(h => {
      const r = h.getBoundingClientRect();
      return {name: h.getAttribute('data-track-name'), y: Math.round(r.y), h: Math.round(r.height),
              armed: h.getAttribute('data-armed') === '1', selected: h.getAttribute('data-selected') === '1',
              onScreen: r.y >= 0 && r.bottom <= innerHeight, clips: +(h.getAttribute('data-clips') || 0)};
    })""")


# ------------------------------------------------------------------ B2
def b2(b, R):
    ctx, pg = mk(b, "pc", "simple", "b2")
    open_studio(pg, R)
    take(pg)  # une prise sur REC (comme l'artiste)
    btn(pg, re.compile("Piste voix", re.I)).click(); pg.wait_for_timeout(1500)
    S(pg, "b2", "01_piste_voix")
    R["pistes_apres_ajout"] = headers(pg)
    take(pg)
    S(pg, "b2", "02_prise_suivante")
    R["pistes_apres_prise"] = headers(pg)
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(600)
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(600)
    R["apres_2_annulations"] = [h["name"] for h in headers(pg)]
    # Piste du bas sélectionnée : la nouvelle arrive dessous, hors de l'écran → défilement.
    pg.locator("[data-track-header='back-2']").first.click(); pg.wait_for_timeout(300)
    pg.evaluate("() => document.querySelectorAll('.custom-scroll').forEach(e => e.scrollTop = 0)")
    pg.wait_for_timeout(300)
    btn(pg, re.compile("Piste voix", re.I)).click(); pg.wait_for_timeout(1500)
    S(pg, "b2", "03_sous_back2")
    R["sous_back2"] = [h for h in headers(pg) if h["name"] in ("BACK 2", "VOIX")]
    R["errors"] = errors(pg)
    ctx.close()


# ------------------------------------------------------------------ B6
def b6(b, R):
    ctx, pg = mk(b, "pc", "simple", "b6")
    hang = {"n": 0}

    def hold(route, request):
        hang["n"] += 1  # jamais de réponse : réseau coupé en plein chargement

    ctx.route(re.compile(r"(storage/v1/object/public/instruments|stream-instrumental)"), hold)
    pg.goto(os.environ.get("NOVA_URL", "http://localhost:3418/"), wait_until="domcontentloaded")
    pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=20000)
    pg.get_by_text("NOCTAMBULE", exact=True).first.click()
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    pg.wait_for_timeout(2000)
    S(pg, "b6", "01_chargement_2s")
    pg.wait_for_timeout(15000)
    S(pg, "b6", "02_apres_17s")
    R["texte_17s"] = re.findall(r"[^\n]*(?:beat|Beat|connexion|Réessayer)[^\n]*", body(pg))[:8]
    pg.keyboard.press("r"); pg.wait_for_timeout(2500)
    S(pg, "b6", "03_rec_pendant_chargement")
    R["enregistre"] = pg.evaluate("() => /Enregistrement|● REC|REC ·/.test(document.body.innerText)")
    R["texte_rec"] = re.findall(r"[^\n]*(?:beat|Beat|chargement|Chargement)[^\n]*", body(pg))[:8]
    R["requetes_bloquees"] = hang["n"]
    # Le réseau revient : « Réessayer » charge le beat.
    retry = pg.get_by_role("button", name=re.compile("Réessayer"))
    if retry.count():
        ctx.unroute(re.compile(r"(storage/v1/object/public/instruments|stream-instrumental)"))
        retry.first.click()
        try:
            wait_text_gone(pg, "Chargement", 30)
        except Exception:
            pass
        pg.wait_for_timeout(1500)
        S(pg, "b6", "04_reessayer_ok")
        R["apres_reessayer_beat_clips"] = pg.evaluate("() => +(document.querySelector('[data-track-header=instrumental]')?.getAttribute('data-clips') || 0)")
        R["bandeau_encore"] = pg.locator("[data-testid=beat-load-banner]").count()
    R["errors"] = errors(pg)
    ctx.close()


# ------------------------------------------------------------------ G1
def g1(b, R, vp="pc"):
    ctx, pg = mk(b, vp, "simple", f"g1_{vp}")
    open_studio(pg, R)
    pg.keyboard.press("Home"); pg.keyboard.press("r"); pg.wait_for_timeout(3000)
    S(pg, "g1", f"{vp}_01_pendant_prise")
    pg.keyboard.press("r"); pg.wait_for_timeout(4500)
    S(pg, "g1", f"{vp}_02_apres_prise")
    R[f"{vp}_nova_ouvert"] = pg.evaluate("() => !!document.querySelector('[data-testid=nova-chat-panel]')")
    R[f"{vp}_cartes"] = pg.evaluate("() => document.querySelectorAll('[role=region][aria-label]').length")
    pill = pg.locator("[data-testid='nova-tip-pill']")
    R[f"{vp}_pastille"] = pill.first.inner_text().strip() if pill.count() else None
    if pill.count():
        pill.first.click(); pg.wait_for_timeout(800)
        S(pg, "g1", f"{vp}_03_conseil_ouvert")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
        S(pg, "g1", f"{vp}_04_echap")
    R[f"{vp}_errors"] = errors(pg)
    ctx.close()


def g1_all(b, R):
    g1(b, R, "pc"); g1(b, R, "tab")


# ------------------------------------------------------------------ B5
def open_console(pg):
    for attempt in range(2):
        t = pg.locator("button", has_text=re.compile(r"^\s*(Console|Mixer)\s*$", re.I)).locator("visible=true")
        if t.count():
            t.first.click(); pg.wait_for_timeout(1200); return True
        m = pg.get_by_role("button", name="Ouvrir le menu").locator("visible=true")
        if not m.count():
            break
        m.first.click(); pg.wait_for_timeout(500)
    return False


def trap(pg):
    pg.locator("button[title='Choisir un style de mix pour ta voix']").first.click(); pg.wait_for_timeout(800)
    pg.get_by_role("dialog", name=re.compile("Mix auto")).get_by_role("button", name="Trap autotune").first.click()
    pg.wait_for_timeout(1500)
    pg.keyboard.press("Escape"); pg.mouse.click(5, 5); pg.wait_for_timeout(500)


def b5(b, R):
    for vp in ("pc", "tab"):
        ctx, pg = mk(b, vp, "avance", f"b5_{vp}")
        open_studio(pg, R)
        trap(pg)
        open_console(pg)
        S(pg, "b5", f"{vp}_01_console")
        R[f"{vp}_slots"] = pg.locator(".fx-slot").all_inner_texts()[:10]
        more = pg.locator("[data-testid^='mixer-inserts-plus-']")
        R[f"{vp}_plus"] = more.first.inner_text().strip() if more.count() else None
        if more.count():
            more.first.click(); pg.wait_for_timeout(500)
            S(pg, "b5", f"{vp}_02_liste")
            R[f"{vp}_liste"] = pg.locator("[data-testid=insert-list]").first.inner_text()[:300] if pg.locator("[data-testid=insert-list]").count() else None
            pg.keyboard.press("Escape")
        R[f"{vp}_errors"] = errors(pg)
        ctx.close()


def g16(b, R):
    """Fenêtres d'effet de la chaîne « Trap autotune » : titres, réglages, gains, bypass."""
    ctx, pg = mk(b, "pc", "avance", "g16")
    open_studio(pg, R)
    trap(pg)
    chips = pg.locator(".fx-slot button[aria-label^='Ouvrir']")
    chips.first.click(); pg.wait_for_timeout(1000)
    seen = []
    for i in range(8):
        txt = pg.locator("body").inner_text()
        S(pg, "g16", f"{i + 1:02d}")
        seen.append({"i": i + 1, "power_buttons": pg.locator("button[aria-label*='ctiver'], button[title*='ctiver'], button[title*='Bypass'], button[aria-label*='Bypass']").locator("visible=true").count(),
                     "x_mult": re.findall(r"\d+[.,]\d+x", txt)[:4], "anglais": re.findall(r"(THRESHOLD|RANGE|MAKEUP|ATTACK|RELEASE|BYPASS|SURGICAL|PROFESSIONAL|DYNAMIC|BELL|SHELF|DRIVE|MIX|OUTPUT|INPUT|HOLD|RATIO|KNEE)", txt)[:12]})
        nxt = pg.get_by_role("button", name="Effet suivant")
        if not nxt.count() or nxt.first.is_disabled():
            break
        nxt.first.click(); pg.wait_for_timeout(900)
    R["fenetres"] = seen
    R["errors"] = errors(pg)
    ctx.close()


def g2(b, R):
    ctx, pg = mk(b, "pc", "avance", "g2")
    open_studio(pg, R)
    trap(pg)
    sb = pg.locator("button[aria-label^='Envois de']").locator("visible=true")
    if sb.count():
        sb.first.click(); pg.wait_for_timeout(500)
        S(pg, "g2", "01_envois_piste")
        R["piste"] = re.findall(r"(Écho 1/4|Reverb courte|Reverb longue|Delay 1/4|Verb Pro|Hall Space)", body(pg))[:6]
        sb.first.click(); pg.wait_for_timeout(300)
    open_console(pg)
    S(pg, "g2", "02_console")
    k = pg.locator("[title^='Envoi vers']")
    R["console"] = [k.nth(i).get_attribute("title")[:40] for i in range(min(3, k.count()))]
    R["console_txt"] = [k.nth(i).inner_text()[:30] for i in range(min(3, k.count()))]
    R["errors"] = errors(pg)
    ctx.close()


def g20(b, R):
    ctx, pg = mk(b, "pc", "avance", "g20")
    open_studio(pg, R)
    open_console(pg)
    S(pg, "g20", "01_console")
    m = pg.locator("[data-strip-id='master']")
    if m.count():
        bb = m.first.bounding_box()
        R["master_visible"] = bool(bb) and bb["x"] + bb["width"] <= 1600 + 2
    pg.get_by_role("button", name="Ajouter un bus").first.click(); pg.wait_for_timeout(900)
    S(pg, "g20", "02_nouveau_bus")
    inp = pg.locator("[data-testid^='strip-rename-']")
    R["renommage_ouvert"] = inp.count() > 0
    if inp.count():
        R["nom_propose"] = inp.first.input_value()
        inp.first.fill("Bus voix"); inp.first.press("Enter"); pg.wait_for_timeout(400)
    R["bus_affiche"] = "Bus voix" in body(pg) or "BUS VOIX" in body(pg)
    S(pg, "g20", "03_renomme")
    g = pg.get_by_role("button", name="Créer un groupe de pistes")
    if g.count():
        g.first.click(); pg.wait_for_timeout(500)
        S(pg, "g21", "01_menu_groupe")
        menu = pg.locator("[data-testid=group-menu]")
        if menu.count():
            bb = menu.first.bounding_box()
            R["menu_groupe"] = {"x": round(bb["x"]), "y": round(bb["y"]), "h": round(bb["height"]), "dans_ecran": bb["y"] >= 0 and bb["y"] + bb["height"] <= 900}
            R["menu_pistes"] = menu.first.inner_text()[:300]
        pg.keyboard.press("Escape")
    # Export (G19) : en mode avancé, on arrive directement sur Mix / Stems / Voix seules.
    pg.mouse.click(800, 450); pg.wait_for_timeout(200)
    ex = pg.locator("button[title*='Exporter'], button[aria-label*='Exporter']").locator("visible=true")
    if ex.count():
        ex.first.click(); pg.wait_for_timeout(1200)
        S(pg, "g19", "01_export_avance")
        R["export_stems_visible"] = pg.locator("[data-testid=export-source-STEMS]").count() > 0
    R["errors"] = errors(pg)
    ctx.close()


def g7(b, R):
    ctx, pg = mk(b, "pc", "simple", "g7")
    open_studio(pg, R)
    take(pg, 3)
    pg.keyboard.press("Escape"); pg.mouse.click(1000, 600); pg.wait_for_timeout(300)
    rec = pg.locator("[data-track-header='track-rec-main']").first.bounding_box()
    tl = pg.locator("[data-track-header='track-rec-main']").first.bounding_box()
    tl = tl["x"] + tl["width"] + 2
    cy = rec["y"] + 4
    pg.mouse.move(tl + 5, cy + 12); pg.wait_for_timeout(400)
    S(pg, "g7", "01_survol_coin")
    h = pg.locator("[data-testid=fade-hint]")
    R["aide_survol"] = h.first.inner_text() if h.count() else None
    pg.mouse.down(); pg.mouse.move(tl + 30, cy + 14, steps=5); pg.mouse.move(tl + 60, cy + 14, steps=5); pg.wait_for_timeout(200)
    S(pg, "g8", "01_glisser_fondu")
    t = pg.locator("[data-testid=drag-tip]")
    R["bulle_glisser"] = t.first.inner_text() if t.count() else None
    pg.mouse.up(); pg.wait_for_timeout(300)
    pg.mouse.click(tl + 25, cy + 45, button="right"); pg.wait_for_timeout(500)
    S(pg, "g7", "02_menu_clip")
    btns = pg.locator("[data-testid^=fade-out-]")
    R["boutons_fondu"] = btns.count()
    if btns.count():
        pg.locator("[data-testid=fade-out-beat]").first.click(); pg.wait_for_timeout(500)
        S(pg, "g7", "03_fondu_sortie_1temps")
    R["errors"] = errors(pg)
    ctx.close()


def g3(b, R):
    ctx, pg = mk(b, "pc", "simple", "g3")
    open_studio(pg, R)
    pg.mouse.click(1000, 600); pg.wait_for_timeout(200)
    pg.mouse.click(1200, 132, button="right"); pg.wait_for_timeout(600)
    S(pg, "g3", "01_clic_droit_regle")
    R["menus"] = pg.evaluate("() => Array.from(document.querySelectorAll('div.fixed')).filter(d => /Ajouter|Grille|Quantization|ARRANGEMENT|marqueur/i.test(d.innerText) && d.getBoundingClientRect().width < 400).map(d => { const r = d.getBoundingClientRect(); return {t: d.innerText.slice(0,60), x: Math.round(r.x), y: Math.round(r.y), b: Math.round(r.bottom)}; })")
    pg.keyboard.press("Escape"); pg.mouse.click(1000, 600); pg.wait_for_timeout(300)
    pg.mouse.click(1450, 820, button="right"); pg.wait_for_timeout(600)
    S(pg, "g4", "01_menu_grille")
    R["menu_grille"] = pg.evaluate("() => { const d = Array.from(document.querySelectorAll('div.fixed')).find(d => /Grille|Quantization/i.test(d.innerText)); if (!d) return null; const r = d.getBoundingClientRect(); return {t: d.innerText.slice(0,300), b: Math.round(r.bottom), r: Math.round(r.right)}; }")
    # Menu grille ouvert, puis clic droit sur la règle : un seul menu doit rester.
    pg.mouse.click(1200, 132, button="right"); pg.wait_for_timeout(600)
    S(pg, "g3", "02_grille_puis_regle")
    R["menus_apres_2_clics"] = pg.evaluate("() => Array.from(document.querySelectorAll('div.fixed')).filter(d => /Grille et pistes|Quantization|marqueur ici/i.test(d.innerText) && d.getBoundingClientRect().width < 400).length")
    R["errors"] = errors(pg)
    ctx.close()


def g22(b, R):
    ctx, pg = mk(b, "pc", "avance", "g22")
    open_studio(pg, R)
    t = pg.locator("button", has_text=re.compile(r"^\s*Auto\s*$")).locator("visible=true")
    if t.count():
        t.first.click(); pg.wait_for_timeout(1200)
    S(pg, "g22", "01_automation")
    R["texte"] = [l for l in body(pg).split(chr(10)) if re.search(r"Automation|Clic|Volume|dB", l)][:8]
    R["anglais"] = re.findall(r"(AUTOMATION EDITOR|Click to|SHIFT|Add Parameter)", body(pg))
    R["errors"] = errors(pg)
    ctx.close()


SCEN = {"b2": b2, "b6": b6, "g1": g1_all, "b5": b5, "g16": g16, "g2": g2, "g20": g20, "g7": g7, "g3": g3, "g22": g22}

if __name__ == "__main__":
    todo = [k for k in SCEN if not ONLY or k in ONLY]
    with sync_playwright() as p:
        br = launch(p)
        for k in todo:
            R = {"name": f"{k}_{PHASE}"}
            t = time.time()
            try:
                SCEN[k](br, R)
            except Exception as e:  # noqa
                R["EXCEPTION"] = f"{type(e).__name__}: {str(e)[:400]}"
            R["secs"] = round(time.time() - t, 1)
            (OUT / f"{k}_{PHASE}.json").write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
            print(k, json.dumps({x: y for x, y in R.items() if x not in ("welcome_buttons",)}, ensure_ascii=False)[:1500])
        br.close()
