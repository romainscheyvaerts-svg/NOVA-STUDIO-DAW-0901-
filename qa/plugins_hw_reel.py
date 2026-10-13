"""Façades « matériel » dans le VRAI studio (PluginEditor, barre de la fenêtre,
barre « Clé » des compresseurs), bureau 1600x900 et téléphone 390x844 (tel390) :
ajoute chaque effet par « Ajouter un effet », capture la fenêtre, tourne un
bouton (la valeur doit changer), vérifie l'absence de débordement horizontal,
puis ferme (Échap / Fermer). Headless, sans fenêtre, hors production.

Usage : NOVA_URL=http://127.0.0.1:3440/ python qa/plugins_hw_reel.py [dossier_captures]
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, re, sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.dirname(__file__))
from qalib import launch, new_page, Log  # noqa: E402
from scenarios import open_studio, close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-plugins-design\reel")
os.makedirs(OUT, exist_ok=True)
EFFETS = [("OPTO_VINTAGE", "opto vintage"), ("FET76", "fet 76"), ("LEVELER2A", "leveler"), ("VOXSTRIP", "vox strip"),
          ("MASTERTRANSIENT", "mastering transient"), ("LIMITER", "nova limiter"), ("DEESSER", "de-esser"), ("VOCALSATURATOR", "saturation")]
ok_all = True


def close_plugin(pg):
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    if pg.locator("[data-nova-plugin]").count():
        for btn in (pg.get_by_role("button", name="Fermer", exact=True),):
            for i in range(btn.count() - 1, -1, -1):
                try:
                    if btn.nth(i).is_visible():
                        btn.nth(i).click(timeout=3000); pg.wait_for_timeout(500)
                        if not pg.locator("[data-nova-plugin]").count():
                            return
                except Exception:
                    pass


def open_add_menu(pg, vp):
    if vp.startswith("tel"):
        m = pg.get_by_text("Mixer", exact=True)
        if m.count():
            m.last.click(); pg.wait_for_timeout(900)
        add = pg.get_by_role("button", name=re.compile("Ajouter un effet"))
        if add.count():
            add.first.scroll_into_view_if_needed(); add.first.click(); pg.wait_for_timeout(700); return True
        return False
    for label in ("Console", "Mixage", "Mixer"):
        t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
        if t.count() and t.first.is_visible():
            t.first.click(); pg.wait_for_timeout(1000); break
    add = pg.locator("button[aria-label^='Ajouter un effet sur']")
    if add.count():
        add.first.click(); pg.wait_for_timeout(600); return True
    return False


def run(vp, effets):
    global ok_all
    res = {}
    log = Log(f"plugins_hw_reel_{vp}")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, vp, log)
        pg.add_init_script("try { localStorage.setItem('nova_simple_mode', '0') } catch (e) {}")
        r = {"name": f"hw_{vp}"}
        open_studio(pg, r, vp=vp)
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        for typ, q in effets:
            e = res.setdefault(typ, {})
            if not open_add_menu(pg, vp):
                e["erreur"] = "menu « Ajouter un effet » introuvable"; ok_all = False; continue
            search = pg.locator("input[aria-label='Chercher un effet']")
            if search.count():
                search.first.fill(q); pg.wait_for_timeout(400)
            item = pg.locator("[data-testid='add-effect-menu'] [role=menuitem], [data-testid='add-effect-menu'] button").filter(has_text=re.compile(q.split()[0], re.I))
            if not item.count():
                e["erreur"] = f"« {q} » absent du menu"; ok_all = False; pg.keyboard.press("Escape"); continue
            item.first.click(); pg.wait_for_timeout(1500)
            win = pg.locator(f"[data-nova-plugin='{typ}']")
            if not win.count():
                chip = pg.locator(".fx-slot button[aria-label^='Ouvrir']").last
                if chip.count(): chip.click(); pg.wait_for_timeout(1500)
            if not win.count():
                e["erreur"] = "fenêtre non ouverte"; ok_all = False; pg.screenshot(path=os.path.join(OUT, f"{typ.lower()}_{vp}_pas_ouverte.png")); continue
            win.first.wait_for(timeout=10000)
            pg.wait_for_timeout(700)
            pg.screenshot(path=os.path.join(OUT, f"{typ.lower()}_{vp}.png"))
            e["titre"] = win.locator("h2").first.inner_text()
            k = win.locator("[role=slider]").first
            e["boutons_rotatifs"] = win.locator("[role=slider]").count()
            before = k.get_attribute("aria-valuenow")
            k.scroll_into_view_if_needed()
            bx = k.bounding_box()
            if bx:
                x, y = bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2
                pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x, y - 40, steps=4); pg.mouse.up()
                pg.wait_for_timeout(200)
            after = k.get_attribute("aria-valuenow")
            e["bouton_tourne"] = before != after
            e["valeurs"] = [before, after]
            e["taille_min_px"] = round(min(bx["width"], bx["height"])) if bx else None
            e["debordement_horizontal"] = pg.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('[data-nova-plugin]')].some(el => { const r = el.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; })")
            e["info"] = pg.locator("[data-nova-infobar]").first.inner_text()[:120] if pg.locator("[data-nova-infobar]").count() else None
            if not e["bouton_tourne"] or e["debordement_horizontal"] or (vp.startswith("tel") and (e["taille_min_px"] or 0) < 44):
                ok_all = False
            close_plugin(pg)
            e["ferme"] = pg.locator(f"[data-nova-plugin='{typ}']").count() == 0
            if not e["ferme"]:
                ok_all = False
        res["erreurs_page"] = [x["text"][:200] for x in log.errors()][:5]
        ctx.close(); b.close()
    return res


# Par lots de 4 (un studio neuf par lot) : au téléphone, la chaîne d'une piste ne montre plus « Ajouter un effet » au-delà de quelques effets.
out = {}
for vp in ("pc", "tel390"):
    for i in range(0, len(EFFETS), 4):
        out.setdefault(vp, {}).update(run(vp, EFFETS[i:i + 4]))
out["ok"] = ok_all
print(json.dumps(out, ensure_ascii=False, indent=1))
sys.exit(0 if ok_all else 1)
