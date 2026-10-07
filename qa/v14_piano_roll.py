"""Scénario V14 (piano roll) dans un Chrome headless, avec captures.

- gamme du projet : notes hors gamme grisées, « coller à la gamme », « seulement la gamme » ;
- outil accords : un clic = un accord dans la gamme ;
- notes fantômes d'une autre piste MIDI ;
- clavier de l'ordinateur : notes jouées sur la piste, raccourcis libres quand il est coupé,
  prise MIDI enregistrée dans le clip, Ctrl+Z l'annule.
Usage : NOVA_URL=http://localhost:3417/ python qa/v14_piano_roll.py [pc|tel|tab]
"""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://localhost:3417/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v14-v15")
from qalib import launch, new_page, shot, overflow_report, BASE  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

VP = sys.argv[1] if len(sys.argv) > 1 else "pc"
res = {"vp": VP, "etapes": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else note)


SPY = """async () => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  if (!window.__spy) {
    window.__spy = [];
    const o = audioEngine.triggerTrackAttack.bind(audioEngine);
    audioEngine.triggerTrackAttack = (id, p, v, t) => { window.__spy.push({ id, p, v }); return o(id, p, v, t); };
  }
  return true;
}"""

notes_js = "() => Array.from(document.querySelectorAll('[data-nova-pianoroll] [data-nova-note]')).map(e => +e.getAttribute('data-nova-note'))"


def grid_click(pg, pitch_row_selector, x_frac=0.3):
    """Clique dans la grille à la hauteur d'une touche du clavier latéral."""
    key = pg.locator(pitch_row_selector).first
    kb = key.bounding_box()
    grid = pg.locator("[data-nova-pianoroll] .custom-scroll").first.bounding_box()
    pg.mouse.click(grid["x"] + grid["width"] * x_frac, kb["y"] + kb["height"] / 2)
    pg.wait_for_timeout(250)


def key_row(pg, pitch):
    sel = f"[data-nova-pianoroll] [data-pitch='{pitch}']"
    # On fait défiler la GRILLE (le clavier latéral la suit) jusqu'à la note.
    pg.evaluate("""(p) => { const k = document.querySelector(`[data-nova-pianoroll] [data-pitch='${p}']`);
      const g = document.querySelector('[data-nova-pianoroll] .custom-scroll'); if (!k || !g) return;
      g.scrollTop = Math.max(0, k.offsetTop - g.clientHeight / 2); g.dispatchEvent(new Event('scroll')); }""", pitch)
    pg.wait_for_timeout(200)
    return sel


with sync_playwright() as p:
    b = launch(p)
    ctx, pg = new_page(b, VP)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    t0 = time.time()
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text("Mélodies", exact=False).first.click(timeout=30000)
    pg.wait_for_timeout(1500)
    pg.get_by_text("Neon Storm", exact=False).first.click()
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    wait_text_gone(pg, "Chargement", 60)
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    pg.evaluate(SPY)
    # « Faire une instru » ouvre la batterie : on la ferme.
    drums = pg.locator("[aria-labelledby='drums-title']")
    if drums.count():
        cl = drums.locator("button[aria-label^='Fermer'], button[title^='Fermer']")
        if cl.count(): cl.first.click()
        else: pg.keyboard.press("Escape")
        pg.wait_for_timeout(600)
    shot(pg, f"v14_{VP}_00_projet")

    # 1. Piste MIDI (mélodie) + outil accords
    pg.locator("button[title^='Nouvelle piste MIDI']").first.click()
    pg.wait_for_timeout(1200)
    pg.locator("[data-nova-pianoroll]").first.wait_for(timeout=10000)
    # Tonalité : La mineur (si le beat n'en a pas, on la choisit dans le menu)
    pg.locator("[data-nova-roll='gamme']").first.click(); pg.wait_for_timeout(300)
    pg.get_by_label("Note de la tonalité").select_option("9"); pg.wait_for_timeout(200)
    pg.get_by_label("Gamme", exact=True).select_option("MINOR"); pg.wait_for_timeout(300)
    shot(pg, f"v14_{VP}_01_menu_gamme")
    gamme_txt = pg.locator("[data-nova-roll='gamme']").first.inner_text()
    ok("tonalite_affichee", "La mineur" in gamme_txt, gamme_txt)
    pg.mouse.click(3, 3); pg.wait_for_timeout(200)
    pg.locator("[data-nova-roll='accords']").first.click(); pg.wait_for_timeout(300)
    shot(pg, f"v14_{VP}_02_menu_accords")
    pg.get_by_role("button", name=re.compile("^Accord de la gamme")).first.click(); pg.wait_for_timeout(200)
    before = pg.evaluate(notes_js)
    grid_click(pg, key_row(pg, 57), 0.15)   # La2 → La mineur
    grid_click(pg, key_row(pg, 60), 0.35)   # Do3 → Do majeur
    grid_click(pg, key_row(pg, 62), 0.55)   # Ré3 → Ré mineur
    after = pg.evaluate(notes_js)
    new = sorted(after[len(before):]) if len(after) > len(before) else []
    in_key = all(n % 12 in (9, 11, 0, 2, 4, 5, 7) for n in after)
    ok("accords_poses_dans_la_gamme", len(after) - len(before) == 9 and in_key, {"notes": sorted(after)})
    bandeau = pg.locator("[data-nova-roll='bandeau']").first.inner_text() if pg.locator("[data-nova-roll='bandeau']").count() else ""
    shot(pg, f"v14_{VP}_03_accords_poses")
    res["bandeau_accord"] = bandeau
    pg.keyboard.press("Escape"); pg.wait_for_timeout(800)

    # 2. 808 : notes fantômes de la mélodie, gamme grisée, aimant, seulement la gamme
    pg.locator("button[title^='Basse 808']").first.click()
    pg.wait_for_timeout(1500)
    pg.locator("[data-nova-pianoroll]").first.wait_for(timeout=10000)
    ghosts = pg.locator("[data-nova-ghost]").count()
    ok("notes_fantomes_visibles", ghosts >= 9, ghosts)
    key_row(pg, 52)
    shot(pg, f"v14_{VP}_04_808_fantomes_gamme")
    # note hors gamme posée sans aimant → grisée
    pg.locator("[data-nova-roll='accords']").count()  # outil accords désactivé sur cette piste (état local)
    n0 = pg.evaluate(notes_js)
    grid_click(pg, key_row(pg, 46), 0.6)   # La#1 : hors La mineur
    n1 = pg.evaluate(notes_js)
    grey = pg.locator("[data-nova-pianoroll] [data-hors-gamme='1']").count()
    ok("note_hors_gamme_grisee", 46 in n1 and grey >= 1, {"hors_gamme": grey})
    # aimant
    pg.locator("[data-nova-roll='gamme']").first.click(); pg.wait_for_timeout(300)
    pg.get_by_text("Coller à la gamme", exact=True).first.click(); pg.wait_for_timeout(200)
    pg.mouse.click(3, 3); pg.wait_for_timeout(200)
    grid_click(pg, key_row(pg, 46), 0.75)
    n2 = pg.evaluate(notes_js)
    added = [x for x in n2 if x not in n1] or (n2[len(n1):] if len(n2) > len(n1) else [])
    ok("aimant_de_gamme", len(n2) == len(n1) + 1 and all(x % 12 in (9, 11, 0, 2, 4, 5, 7) for x in added), {"posee": added})
    # remettre dans la gamme (une étape)
    pg.locator("[data-nova-roll='gamme']").first.click(); pg.wait_for_timeout(300)
    pg.mouse.click(3, 3); pg.wait_for_timeout(200)
    pg.keyboard.press("Control+a"); pg.wait_for_timeout(200)
    pg.locator("[data-nova-roll='gamme']").first.click(); pg.wait_for_timeout(300)
    shot(pg, f"v14_{VP}_04b_menu_gamme_aimant")
    pg.locator("[data-nova-roll-menu='scale'] button").filter(has_text="Remettre").first.click(); pg.wait_for_timeout(400)
    n3 = pg.evaluate(notes_js)
    ok("remettre_dans_la_gamme", 46 not in n3 and pg.locator("[data-nova-pianoroll] [data-hors-gamme='1']").count() == 0)
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(500)
    ok("annulable_ctrl_z", 46 in pg.evaluate(notes_js))
    # seulement la gamme
    pg.locator("[data-nova-roll='gamme']").first.click(); pg.wait_for_timeout(300)
    pg.get_by_text("Montrer seulement la gamme", exact=True).first.click(); pg.wait_for_timeout(300)
    pg.mouse.click(3, 3); pg.wait_for_timeout(300)
    rows = pg.locator("[data-nova-pianoroll] [data-pitch]").count()
    ok("seulement_la_gamme", 70 <= rows <= 78, rows)
    key_row(pg, 45)
    shot(pg, f"v14_{VP}_05_seulement_la_gamme")
    pg.locator("[data-nova-roll='gamme']").first.click(); pg.wait_for_timeout(300)
    pg.get_by_text("Montrer seulement la gamme", exact=True).first.click()
    pg.get_by_text("Coller à la gamme", exact=True).first.click(); pg.wait_for_timeout(200)
    pg.mouse.click(3, 3); pg.wait_for_timeout(300)

    # 3. Clavier de l'ordinateur
    probe = """(code) => { const e = new KeyboardEvent('keydown', { code, key: code.replace('Key','').toLowerCase(), bubbles: true, cancelable: true }); document.body.dispatchEvent(e);
      document.body.dispatchEvent(new KeyboardEvent('keyup', { code, key: code.replace('Key','').toLowerCase(), bubbles: true })); return e.defaultPrevented; }"""
    pg.evaluate("() => { window.__spy.length = 0; }")
    off_a = pg.evaluate(probe, "KeyA")
    off_calls = pg.evaluate("() => window.__spy.length")
    ok("clavier_coupe_ne_vole_rien", (not off_a) and off_calls == 0)
    pg.locator("[data-nova-roll='clavier']").first.click(); pg.wait_for_timeout(400)
    on_a = pg.evaluate(probe, "KeyA")
    on_space = pg.evaluate(probe, "KeyB")
    on_q = pg.evaluate(probe, "KeyQ")
    calls = pg.evaluate("() => window.__spy.slice()")
    ok("clavier_actif_capte_ses_touches", on_a)
    ok("clavier_actif_joue_la_piste", len(calls) >= 1 and calls[-1]["p"] == 60, calls[-3:])
    ok("autres_touches_libres", (not on_space) and (not on_q))
    pg.keyboard.down("KeyX"); pg.keyboard.up("KeyX")
    pg.keyboard.down("KeyG"); pg.wait_for_timeout(150)
    shot(pg, f"v14_{VP}_06_clavier_actif")
    pg.keyboard.up("KeyG")
    last = pg.evaluate("() => window.__spy[window.__spy.length - 1]")
    ok("octave_x", last and last["p"] == 79, last)
    pg.keyboard.down("KeyZ"); pg.keyboard.up("KeyZ")
    # prise MIDI
    n_before = len(pg.evaluate(notes_js))
    pg.locator("[data-nova-roll='rec-midi']").first.click(); pg.wait_for_timeout(1200)
    for code in ("KeyA", "KeyD", "KeyG", "KeyJ"):
        pg.keyboard.down(code); pg.wait_for_timeout(260); pg.keyboard.up(code); pg.wait_for_timeout(120)
    pg.wait_for_timeout(200)
    shot(pg, f"v14_{VP}_07_prise_midi_en_cours")
    pg.locator("[data-nova-roll='rec-midi']").first.click(); pg.wait_for_timeout(300)
    pg.keyboard.press("Space"); pg.wait_for_timeout(800)  # arrêt de la lecture → écriture
    n_after = len(pg.evaluate(notes_js))
    ok("prise_midi_ecrite", n_after - n_before == 4, {"avant": n_before, "apres": n_after})
    shot(pg, f"v14_{VP}_08_prise_midi_ecrite")
    pg.locator("[data-nova-roll='clavier']").first.click(); pg.wait_for_timeout(300)
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(600)
    ok("prise_annulee_ctrl_z", len(pg.evaluate(notes_js)) == n_before)
    res["debordements"] = overflow_report(pg)
    res["erreurs_page"] = errs[:5]
    res["secs"] = round(time.time() - t0, 1)
    b.close()

out = os.path.join(os.environ["QA_OUT"], f"v14_piano_roll_{VP}.json")
open(out, "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
print("TOTAL", sum(1 for v in res["etapes"].values() if v["ok"]), "/", len(res["etapes"]), "| erreurs page :", errs[:3])
