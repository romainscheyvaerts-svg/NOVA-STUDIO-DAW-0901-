"""Tour « beatmaking » (22/10/2026) : les gestes d'un beatmaker qui fait 5 beats par jour.

Headless (aucune fenêtre), 100 % hors production (qalib importe qa_hors_prod), PC 1600 × 900, mode avancé.
Chaque point a été trouvé en faisant de vrais beats et comparé aux gestes standard des autres logiciels :

  1. Entrée « beat » : accueil → « Nouveau beat » (1 clic, 2 en mode simple via « Plus d'options »),
     menu ☰ → « Faire un beat » : projet en mode beat, boîte à rythmes ouverte, et dans la barre du bas
     Batterie / Kits / 808 / Synthé / Sampler (avant : rien de visible dans un projet vierge, Ctrl+K « batterie »).
  2. Boîte à rythmes : glisser sur les pas les peint (allumés ou éteints comme le 1er touché), clic = allumé ↔
     éteint, Maj + clic = accent léger, Ctrl+Z annule.
  3. Pads au clavier de l'ordinateur : délai touche → déclenchement du moteur (avant ~29 ms, objectif < 5 ms),
     comparé au clavier du synthé.
  4. Piano roll (808) : Maj + → / ← (longueur), Maj + ↑ / ↓ (octave), Ctrl+L (legato), Ctrl + glisser (copie),
     Q sur des notes calées (aucune étape d'annulation vide).
  5. Métronome : touche O.

NOVA_URL=http://127.0.0.1:3536/ PYTHONIOENCODING=utf-8 python qa/beat_gestes.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-auditbeat) : beat_gestes.json + captures
"""
import json, os, re, statistics, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3536/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-auditbeat")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, Log, BASE, OUT  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DR = "[aria-labelledby='drums-title']"
PR = "[data-nova-pianoroll]"
KO, RES = [], {}
INIT = ("try { localStorage.setItem('nova_headphones','1'); localStorage.setItem('nova_welcome_seen','1'); localStorage.setItem('nova_count_in','0');"
        " localStorage.setItem('nova_simple_mode','%s'); } catch(e) {}"
        # Heure de la touche AVANT tous les écouteurs de l'appli (mesure de latence).
        " window.__kd = 0; window.addEventListener('keydown', () => { window.__kd = performance.now(); }, true);")
HOOK = """async () => { const m = await window.__novaAppModule('/engine/AudioEngine.ts'); const e = m.audioEngine; window.__lat = [];
  const o = e.triggerTrackAttack.bind(e); e.triggerTrackAttack = (...a) => { if (window.__kd) { window.__lat.push(performance.now() - window.__kd); window.__kd = 0; } return o(...a); }; return true; }"""
ROWS = "() => { const t = window.__novaEdit.getState().tracks.find(t => t.id === 'track-drums'); return t ? Object.fromEntries(t.drumMachine.rows.map(r => [r.name, r.steps.slice(0, 16).map(v => v >= 100 ? 'X' : v > 0 ? 'x' : '.').join('')])) : null; }"
N808 = "() => { const t = window.__novaEdit.getState().tracks.find(t => /808/.test(t.name)); const c = t && t.clips.find(c => c.notes); return c ? c.notes.map(n => [n.pitch, +n.start.toFixed(3), +n.duration.toFixed(3)]).sort((a, b) => a[1] - b[1] || a[0] - b[0]) : null; }"


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False)[:400]}"), flush=True)
    if not cond: KO.append(name)
    return cond


def page_for(p, simple="0"):
    b = launch(p); log = Log("beat_gestes")
    ctx, page = new_page(b, "pc", log)
    page.add_init_script(INIT % simple)
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.wait_for(timeout=60000)
    return b, page, log


def entree_beat(p):
    for simple in ("0", "1"):
        b, page, log = page_for(p, simple)
        t0 = time.time(); clics = 0
        if simple == "1": page.locator("[data-testid=landing-plus]").click(); clics += 1
        page.locator("[data-testid=landing-new-beat]").click(); clics += 1
        page.wait_for_selector(DR, timeout=20000)
        dt = round(time.time() - t0, 2)
        mode = page.evaluate("() => window.__novaEdit.getState().projectMode")
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        dock = page.evaluate("() => ['Batterie', 'Kits de batterie', 'Basse 808', 'Synthé NOVA : nouvelle piste', 'Nouvelle piste Sampler'].filter(l => [...document.querySelectorAll(`button[aria-label='${l}']`)].some(b => b.getClientRects().length))")
        RES[f"accueil_nouveau_beat_{'simple' if simple == '1' else 'avance'}"] = {"clics": clics, "s": dt, "mode": mode, "barre": dock}
        ok(f"accueil → Nouveau beat ({'simple' if simple == '1' else 'avancé'}) : {clics} clic(s), {dt} s, boîte à rythmes ouverte, mode beat, 5 boutons de beat",
           mode == "BEATMAKING" and len(dock) == 5 and clics <= (2 if simple == "1" else 1), {"mode": mode, "barre": dock})
        b.close()
    b, page, log = page_for(p, "0")
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.click()
    page.wait_for_function("() => !!window.__novaEdit", timeout=30000); page.wait_for_timeout(800); close_welcome(page)
    t0 = time.time()
    page.locator("button[aria-label='Ouvrir le menu']").first.click()
    page.locator("[data-testid=menu-start-beat]").click()
    page.wait_for_selector(DR, timeout=20000)
    RES["menu_faire_un_beat"] = {"clics": 2, "s": round(time.time() - t0, 2)}
    ok("projet vierge → ☰ → « Faire un beat » : 2 clics jusqu'à la boîte à rythmes", True)
    # Métronome : touche O (arrangement).
    page.keyboard.press("Escape"); page.wait_for_timeout(300); page.mouse.click(900, 600); page.wait_for_timeout(200)
    m = "() => window.__novaEdit.getState().metronome.enabled"
    a = page.evaluate(m); page.keyboard.press("o"); page.wait_for_timeout(300); b1 = page.evaluate(m); page.keyboard.press("o"); page.wait_for_timeout(300); c1 = page.evaluate(m)
    ok("touche O : métronome allumé puis éteint", a is False and b1 is True and c1 is False, [a, b1, c1])
    b.close()


def batterie_et_808(p):
    b, page, log = page_for(p, "0")
    page.locator("[data-testid=landing-new-beat]").click()
    page.wait_for_selector(DR, timeout=20000); page.wait_for_timeout(500)
    page.get_by_role("button", name="🔥 Trap").first.click(); page.wait_for_timeout(1500)
    hat = "Hi-hat fermé"
    first = page.locator(f"button[aria-label^='{hat}, pas 1']").first.bounding_box()
    last = page.locator(f"button[aria-label^='{hat}, pas 16']").first.bounding_box()
    # Rangée effacée d'un geste (1er pas allumé → le coup éteint), puis peinte d'un geste.
    for _ in range(2):
        page.mouse.move(first["x"] + 5, first["y"] + 10); page.mouse.down()
        page.mouse.move(last["x"] + 5, last["y"] + 10, steps=30); page.mouse.up(); page.wait_for_timeout(350)
        RES.setdefault("pinceau_charleys", []).append(page.evaluate(ROWS)[hat])
    ok("glisser sur la rangée des charleys : effacée puis 16 pas peints en 1 geste chacun", RES["pinceau_charleys"] == ["." * 16, "X" * 16], RES["pinceau_charleys"])
    s5 = page.locator("button[aria-label^='Snare, pas 5']").first
    seq = []
    s5.click(); page.wait_for_timeout(250); seq.append(page.evaluate(ROWS)["Snare"][4])
    s5.click(); page.wait_for_timeout(250); seq.append(page.evaluate(ROWS)["Snare"][4])
    s5.click(modifiers=["Shift"]); page.wait_for_timeout(250); seq.append(page.evaluate(ROWS)["Snare"][4])
    page.keyboard.press("Control+z"); page.wait_for_timeout(300); seq.append(page.evaluate(ROWS)["Snare"][4])
    RES["clic_pas"] = seq
    ok("clic : allumé puis éteint ; Maj + clic : accent léger ; Ctrl+Z annule", seq == ["X", ".", "x", "."], seq)
    # Pads au clavier de l'ordinateur : délai touche → moteur.
    kb = page.locator(f"{DR} button:has(i.fa-keyboard)")
    if kb.count() and kb.first.get_attribute("aria-pressed") != "true": kb.first.click(); page.wait_for_timeout(300)
    page.evaluate(HOOK)
    for i in range(12):
        page.keyboard.press("KeyA" if i % 2 else "KeyS"); page.wait_for_timeout(110)
    lat = page.evaluate("() => window.__lat")
    med = round(statistics.median(lat[2:]), 2) if len(lat) > 4 else None
    RES["latence_pads_ms"] = {"mesures": [round(x, 2) for x in lat], "mediane": med}
    ok(f"pads au clavier : 12 frappes, médiane {med} ms (avant ~29 ms)", len(lat) >= 10 and med is not None and med < 5, lat)
    # 808 au piano roll.
    page.locator(f"{DR} button:has-text('808')").first.click(); page.wait_for_timeout(1500)
    start = page.evaluate(N808)
    page.keyboard.down("Control"); page.mouse.move(540, 398); page.mouse.down(); page.mouse.move(700, 390, steps=5); page.mouse.move(860, 382, steps=5); page.mouse.up(); page.keyboard.up("Control"); page.wait_for_timeout(300)
    after = page.evaluate(N808)
    ok("Ctrl + glisser une note : une copie de plus, l'original reste", len(after) == len(start) + 1 and all(n in after for n in start), {"avant": start, "apres": after})
    page.keyboard.press("Control+z"); page.wait_for_timeout(250)
    page.keyboard.press("Control+a"); page.wait_for_timeout(150)
    steps = {}
    for k in ("Shift+ArrowRight", "Shift+ArrowLeft", "Shift+ArrowLeft", "Shift+ArrowUp", "Shift+ArrowDown"):
        page.keyboard.press(k); page.wait_for_timeout(220); steps[k + ("" if k not in steps else " (2)")] = page.evaluate(N808)[0]
    RES["piano_roll_maj_fleches"] = steps
    d0 = start[0][2]
    vals = list(steps.values())
    ok("Maj + → / ← : longueur ± 1 case ; Maj + ↑ / ↓ : octave", abs(vals[0][2] - (d0 + 0.125)) < 1e-3 and abs(vals[1][2] - d0) < 1e-3 and abs(vals[2][2] - (d0 - 0.125)) < 1e-3 and vals[3][0] == start[0][0] + 12 and vals[4][0] == start[0][0], steps)
    page.keyboard.press("q"); page.wait_for_timeout(250)
    msg = page.evaluate("() => [...document.querySelectorAll('[data-nova-pianoroll] [role=status]')].map(e => e.innerText).join(' | ')")
    page.keyboard.press("Control+z"); page.wait_for_timeout(250)
    undone = page.evaluate(N808)
    ok("Q sur des notes calées : message « déjà sur la grille » et Ctrl+Z annule bien le dernier geste (Maj+↓)", "déjà sur la grille" in msg and undone[0][0] == start[0][0] + 12, {"msg": msg, "apres_ctrl_z": undone[:1]})
    page.keyboard.press("Control+y"); page.wait_for_timeout(200)
    pre = page.evaluate(N808)
    page.keyboard.press("Control+l"); page.wait_for_timeout(250)
    leg = page.evaluate(N808)
    ok("Ctrl+L : legato (chaque note jusqu'à la suivante)", all(abs(leg[i][1] + leg[i][2] - leg[i + 1][1]) < 1e-3 for i in range(len(leg) - 1)), {"avant": pre, "apres": leg})
    page.screenshot(path=str(OUT / "beat_gestes_808.png"))
    errs = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED|status of 400", e["text"])]
    ok("aucune erreur de page", not errs, errs)
    b.close()


if __name__ == "__main__":
    with sync_playwright() as p:
        entree_beat(p)
        batterie_et_808(p)
    (OUT / "beat_gestes.json").write_text(json.dumps({"resultats": RES, "ko": KO}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(KO)} KO" + (f" : {KO}" if KO else ""))
    sys.exit(1 if KO else 0)
