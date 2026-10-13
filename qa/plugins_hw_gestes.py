"""Gestes sur les façades « matériel » (kit plugins/hw), headless, sans fenêtre :
glisser un bouton rotatif (souris puis doigt), Maj = fin, double-clic = valeur
d'origine, molette, clavier, bulle de valeur, ligne d'info, interrupteur à
levier, boutons-poussoirs du FET 76, préréglage, « Caler sur ma voix » présent.

Usage : NOVA_URL=http://127.0.0.1:3440/ python qa/plugins_hw_gestes.py
Sortie : JSON des contrôles + "ok": true si tout passe (code 1 sinon).
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
from playwright.sync_api import sync_playwright  # noqa: E402

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3440/")

res, ok = {}, True


def check(name, cond, detail=None):
    global ok
    res[name] = {"ok": bool(cond), **({"detail": detail} if detail is not None else {})}
    ok = ok and bool(cond)


def params(pg):
    return pg.evaluate("() => ({ ...(window.__qaHwParams || {}) })")


def mount(pg, kind, mobile=False):
    pg.evaluate("async ([k, m]) => { const h = await import('/qa/harness/hwPlugins.tsx'); return h.mountHwPlugin(k, m); }", [kind, mobile])
    pg.locator(f"[data-qa-hw] [data-nova-plugin='{kind}']").first.wait_for(timeout=20000)
    pg.wait_for_timeout(400)


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE, headless=True)
    ctx = b.new_context(viewport={"width": 1600, "height": 900})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "Cannot update a component" in m.text else None)
    pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
    pg.wait_for_timeout(2500)

    # ── Opto Vintage : bouton « Seuil » ──
    mount(pg, "OPTO_VINTAGE")
    knob = pg.locator("[data-nova-param='threshold'] [role=slider]").first
    check("aria_slider", knob.get_attribute("aria-valuemin") == "-60" and knob.get_attribute("aria-valuemax") == "20" and knob.get_attribute("aria-valuenow") == "-30",
          {k: knob.get_attribute(k) for k in ("aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext", "aria-label")})
    bx = knob.bounding_box()
    cx, cy = bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2
    pg.mouse.move(cx, cy)
    pg.wait_for_timeout(100)
    info = pg.locator("[data-nova-infobar]").first.inner_text()
    check("ligne_info_survol", "Seuil" in info and "dBFS" in info, info)
    pg.mouse.down()
    pg.mouse.move(cx, cy - 50, steps=5)
    bubble = pg.locator("[data-nova-param='threshold'] .hw-bubble")
    check("bulle_pendant_glisser", bubble.count() == 1 and "dBFS" in bubble.first.inner_text(), bubble.first.inner_text() if bubble.count() else None)
    pg.mouse.up()
    v1 = params(pg).get("threshold")
    check("glisser_haut_augmente", v1 is not None and v1 > -30 and abs(v1 - (-30 + 0.25 * 80)) < 2.5, v1)
    # Maj = réglage fin (10x moins)
    pg.keyboard.down("Shift")
    pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx, cy - 50, steps=5); pg.mouse.up()
    pg.keyboard.up("Shift")
    v2 = params(pg).get("threshold")
    check("maj_reglage_fin", v2 is not None and 0.5 < v2 - v1 < 3.5, [v1, v2])
    # Double-clic = valeur d'origine
    knob.dblclick()
    pg.wait_for_timeout(100)
    check("double_clic_defaut", params(pg).get("threshold") == -30, params(pg).get("threshold"))
    # Molette
    pg.mouse.move(cx, cy)
    pg.mouse.wheel(0, -100)
    pg.wait_for_timeout(100)
    vw = params(pg).get("threshold")
    check("molette", vw is not None and vw > -30, vw)
    # Clavier
    knob.focus()
    before = params(pg).get("threshold")
    pg.keyboard.press("ArrowDown"); pg.keyboard.press("ArrowDown")
    after = params(pg).get("threshold")
    check("clavier_fleches", after < before, [before, after])
    pg.keyboard.press("End")
    check("clavier_fin", params(pg).get("threshold") == 20, params(pg).get("threshold"))

    # Interrupteur à levier (Temps : 3 positions)
    pg.locator("[data-nova-param='mode'] [role=radio]", has_text="Manuel").last.click()
    check("levier_position", params(pg).get("mode") == 2, params(pg).get("mode"))
    pg.locator("[data-nova-param='mode'] .hw-toggle-lever").click()
    check("levier_cycle", params(pg).get("mode") == 0, params(pg).get("mode"))

    # Préréglage
    pg.locator("[data-nova-preset='parallele']").click()
    pr = params(pg)
    check("preréglage", pr.get("ratio") == 8 and pr.get("mix") == 50 and pg.locator("[data-nova-preset='parallele'][aria-pressed='true']").count() == 1, pr)
    check("calage_present", pg.locator("[data-nova-calibrate]").count() == 1 and "Caler sur ma voix" in pg.locator("[data-nova-calibrate]").inner_text())
    check("vu_present", pg.locator("[data-nova-gr-vu]").count() == 1)
    # VU : l'aiguille bouge (le nœud factice varie)
    t1 = pg.locator("[data-nova-gr-vu] svg g[transform]").last.get_attribute("transform")
    pg.wait_for_timeout(500)
    t2 = pg.locator("[data-nova-gr-vu] svg g[transform]").last.get_attribute("transform")
    check("vu_aiguille_bouge", t1 != t2, [t1, t2])

    # ── FET 76 : boutons-poussoirs de taux ──
    mount(pg, "FET76")
    pg.get_by_role("radio", name="Taux 8:1").click()
    check("fet_taux", params(pg).get("ratio") == 8 and pg.get_by_role("radio", name="Taux 8:1").get_attribute("aria-checked") == "true", params(pg).get("ratio"))
    pg.locator("[data-nova-param='slo'] button").click()
    check("fet_slo", params(pg).get("slo") == 1, params(pg).get("slo"))

    # ── Vox Strip : sélecteur à crans (fréquence) ──
    mount(pg, "VOXSTRIP")
    f = pg.locator("[data-nova-param='hiFreq'] [role=slider]").first
    f.focus(); pg.keyboard.press("ArrowUp")
    check("vox_cran_clavier", params(pg).get("hiFreq") == 9, params(pg).get("hiFreq"))
    pg.locator("[data-nova-param='eqOn'] button").click()
    check("vox_bouton_en_service", params(pg).get("eqOn") == 0, params(pg).get("eqOn"))
    ctx.close()

    # ── Téléphone : glisser au doigt (pointer events tactiles) ──
    ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
    pg.wait_for_timeout(2500)
    mount(pg, "LEVELER2A", True)
    k = pg.locator("[data-nova-param='peakReduction'] [role=slider]").first
    k.scroll_into_view_if_needed()
    bx = k.bounding_box()
    x, y = bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2
    cdp = ctx.new_cdp_session(pg)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, 7):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - i * 12}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    pg.wait_for_timeout(200)
    vt = params(pg).get("peakReduction")
    check("doigt_glisser", vt is not None and vt > 20, vt)
    check("taille_doigt_px", min(bx["width"], bx["height"]) >= 44, [bx["width"], bx["height"]])
    ctx.close()
    b.close()

check("aucune_erreur_page", not errs, errs[:5])
res["ok"] = ok
print(json.dumps(res, ensure_ascii=False, indent=1))
sys.exit(0 if ok else 1)
