"""Les effets d'une piste sont visibles et ouvrables (mode simple et avancé, console).

NOVA_URL=http://localhost:3411/ python qa/inserts_visibles.py
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-inserts")
from qalib import launch, new_page, shot  # noqa: E402
from scenarios import open_studio, visible, body  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

res = {"name": "inserts"}
with sync_playwright() as p:
    b = launch(p)
    for mode in ("simple", "avance"):
        ctx, pg = new_page(b, "pc")
        pg.add_init_script(f"try {{ localStorage.setItem('nova_simple_mode', '{'1' if mode == 'simple' else '0'}') }} catch (e) {{}}")
        r = res.setdefault(mode, {})
        r["name"] = f"inserts_{mode}"
        open_studio(pg, r)
        pg.locator("button[title='Choisir un style de mix pour ta voix']").first.click(); pg.wait_for_timeout(800)
        pg.get_by_role("dialog", name=re.compile("Mix auto")).get_by_role("button", name="Trap autotune").first.click()
        pg.wait_for_timeout(1500)
        pg.keyboard.press("Escape"); pg.mouse.click(5, 5); pg.wait_for_timeout(500)
        shot(pg, f"inserts_{mode}_pistes")
        chips = pg.locator(".fx-slot button[aria-label^='Ouvrir']")
        r["pastilles"] = [chips.nth(i).inner_text().strip() for i in range(min(chips.count(), 12))]
        badge = pg.get_by_test_id("autotune-badge")
        r["badge_autotune"] = badge.first.inner_text().strip() if badge.count() else None
        plus = pg.locator("[data-testid^='inserts-plus-']")
        r["bouton_plus"] = plus.first.inner_text().strip() if plus.count() else None
        if plus.count():
            plus.first.click(); pg.wait_for_timeout(500)
            shot(pg, f"inserts_{mode}_liste_complete")
            r["liste_complete"] = pg.locator("div.fixed.z-\[600\] button").all_inner_texts()[:12]
            pg.keyboard.press("Escape"); pg.mouse.click(5, 5); pg.wait_for_timeout(300)
        if chips.count():
            chips.first.click(); pg.wait_for_timeout(900)
            shot(pg, f"inserts_{mode}_effet_ouvert")
            r["clic_ouvre"] = bool(re.search(r"Autotune|Compresseur|Égaliseur|De-esser|Saturation", body(pg)))
            pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        if mode == "avance":
            for label in ("Console", "Mixage", "Mixer", "Mix"):
                t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
                if t.count() and visible(t.first):
                    t.first.click(); pg.wait_for_timeout(900); break
            shot(pg, "inserts_avance_console")
            slots = pg.locator(".fx-slot")
            r["console_noms"] = sorted({s.strip() for s in slots.all_inner_texts() if s.strip()})[:15]
        ctx.close()
    b.close()
print(json.dumps(res, ensure_ascii=False, indent=1))
