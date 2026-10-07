"""Capture de la fenêtre du limiteur NOVA ouverte depuis la console (master), PC et téléphone.
Usage : NOVA_URL=http://localhost:3417/ python qa/v15_limiteur_fenetre.py
"""
import os, re, sys, json
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://localhost:3417/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v14-v15")
from qalib import launch, new_page, shot, overflow_report, BASE  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

res = {}
with sync_playwright() as p:
    b = launch(p)
    ctx, pg = new_page(b, "pc")
    pg.add_init_script("try { localStorage.setItem('nova_simple_mode', '0') } catch (e) {}")
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text("Mélodies", exact=False).first.click(timeout=30000); pg.wait_for_timeout(1500)
    pg.get_by_text("Neon Storm", exact=False).first.click(); pg.wait_for_timeout(1500)
    close_welcome(pg); wait_text_gone(pg, "Chargement", 60); pg.wait_for_timeout(1500); close_welcome(pg)
    dr = pg.locator("[aria-labelledby='drums-title']")
    if dr.count():
        cl = dr.locator("button[aria-label^='Fermer'], button[title^='Fermer']")
        (cl.first.click() if cl.count() else pg.keyboard.press("Escape")); pg.wait_for_timeout(600)
    pg.locator("[data-nova-open-master]").first.click(); pg.wait_for_timeout(600)
    pg.locator("[data-nova-master-run]").first.click()
    pg.locator("[data-nova-master-rapport]").first.wait_for(timeout=240000)
    pg.locator("[data-nova-master-apply]").first.click(); pg.wait_for_timeout(800)
    pg.get_by_role("button", name="Fermer", exact=True).last.click(); pg.wait_for_timeout(600)
    for label in ("Console",):
        t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
        if t.count(): t.first.click(); pg.wait_for_timeout(1200)
    shot(pg, "v15_pc_09_console_master_nova")
    slot = pg.locator(".fx-slot button").filter(has_text=re.compile("Limiteur"))
    res["slots_limiteur"] = slot.count()
    if slot.count():
        pg.keyboard.press("Space"); pg.wait_for_timeout(800)  # lecture lancée avant d'ouvrir la fenêtre
        slot.last.click(); pg.wait_for_timeout(1500)
        pg.locator("[data-nova-plugin='LIMITER']").first.wait_for(timeout=10000)
        pg.wait_for_timeout(2500)
        shot(pg, "v15_pc_10_fenetre_limiteur")
        res["gr_affichee"] = pg.locator("[data-nova-limiter='gr']").first.inner_text()
    res["debordements"] = [d for d in overflow_report(pg) if d.get("kind") != "clipped"]
    b.close()
print(json.dumps(res, ensure_ascii=False, indent=1))
