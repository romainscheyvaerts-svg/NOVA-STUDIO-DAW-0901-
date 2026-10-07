"""Captures des fenêtres des effets V21 (PC, tablette, téléphone) ouvertes depuis l'interface.

NOVA_URL=http://localhost:3426/ python qa/v21_fenetres.py [pc] [tab] [tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-v21\\
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://localhost:3426/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v21")
from qalib import launch, new_page, shot, overflow_report, Log  # noqa: E402
from scenarios import open_studio, close_welcome, body  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

EFFETS = [("HARMONIZER", "Harmoniseur", "tierce-quinte"), ("VOICESHIFT", "Voix grave / aiguë", "demon"),
          ("TIMEFX", "Tape stop & half-time", "stop-1"), ("DJFILTER", "Filtre DJ", "intro"), ("LOFI", "Lo-fi / téléphone", "telephone")]


def close_plugin(pg):
    for btn in (pg.get_by_role("button", name="Fermer", exact=True), pg.get_by_role("button", name=re.compile("^Fermer"))):
        for i in range(btn.count() - 1, -1, -1):
            try:
                if btn.nth(i).is_visible():
                    btn.nth(i).click(timeout=3000); pg.wait_for_timeout(500)
                    if not pg.locator("[data-nova-plugin]").count():
                        return
            except Exception:
                pass
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)


def open_add_menu(pg, vp):
    """Ouvre la liste « Ajouter un effet » de la première piste voix."""
    if vp == "tel":
        # Onglet « Mixer » du bas, puis « Ajouter un effet » de la piste affichée.
        m = pg.get_by_text("Mixer", exact=True)
        if m.count():
            m.last.click(); pg.wait_for_timeout(900)
        add = pg.get_by_role("button", name=re.compile("Ajouter un effet"))
        if add.count():
            add.first.scroll_into_view_if_needed(); add.first.click(); pg.wait_for_timeout(700); return True
        return False
    if vp == "tab":
        fx = pg.locator("button[aria-label^='Effets de']")
        if fx.count():
            fx.nth(1 if fx.count() > 1 else 0).click(); pg.wait_for_timeout(600)
            add = pg.get_by_role("button", name=re.compile("Ajouter un effet"))
            if add.count():
                add.first.click(); pg.wait_for_timeout(600); return True
        return False
    for label in ("Console", "Mixage", "Mixer"):
        t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
        if t.count() and t.first.is_visible():
            t.first.click(); pg.wait_for_timeout(1000); break
    add = pg.locator("button[aria-label^='Ajouter un effet sur']")
    if add.count():
        add.first.click(); pg.wait_for_timeout(600); return True
    return False


def run(vp):
    res = {"vp": vp, "effets": {}}
    log = Log(f"v21_{vp}")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, vp, log)
        pg.add_init_script("try { localStorage.setItem('nova_simple_mode', '0') } catch (e) {}")
        r = {"name": f"v21_{vp}"}
        open_studio(pg, r, vp=vp)
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        for i, (typ, nom, preset) in enumerate(EFFETS):
            e = res["effets"].setdefault(typ, {})
            if not open_add_menu(pg, vp):
                e["erreur"] = "bouton « Ajouter un effet » introuvable"; shot(pg, f"v21_{vp}_{i}_sans_menu"); continue
            if i == 0:
                shot(pg, f"v21_{vp}_menu_ajout")
            item = pg.get_by_text(nom, exact=True)
            if not item.count():
                e["erreur"] = f"« {nom} » absent de la liste"; shot(pg, f"v21_{vp}_{typ}_absent"); pg.keyboard.press("Escape"); continue
            item.first.click(); pg.wait_for_timeout(1500)
            win = pg.locator(f"[data-nova-plugin='{typ}']")
            if not win.count():
                # Téléphone : l'effet est ajouté, on l'ouvre depuis sa pastille.
                chip = pg.locator(".fx-slot button", has_text=re.compile(re.escape(nom.split(' /')[0][:10])))
                if chip.count(): chip.last.click(); pg.wait_for_timeout(1500)
            if not win.count():
                e["erreur"] = "fenêtre non ouverte"; shot(pg, f"v21_{vp}_{typ}_pas_ouverte"); continue
            pr = pg.locator(f"[data-nova-preset='{preset}']")
            if pr.count():
                pr.first.click(); pg.wait_for_timeout(500)
            if typ == "TIMEFX":
                pg.locator("[data-nova-trigger='stop']").first.click(); pg.wait_for_timeout(300)
            pg.wait_for_timeout(600)
            shot(pg, f"v21_{vp}_{i + 1}_{typ.lower()}")
            e["preset_actif"] = pg.locator("[data-nova-preset][aria-pressed='true']").all_inner_texts()
            e["titre"] = win.locator("h2").first.inner_text()
            e["boutons_marche_internes"] = win.get_by_role("button", name=re.compile(r"^(Marche|Arrêt|Bypass|On|Off|Activer|Désactiver)", re.I)).count()
            txt = win.inner_text()
            e["anglais_suspects"] = [w for w in ("Mix", "Gain", "Bypass", "Enabled", "Dry", "Wet") if re.search(rf"\b{w}\b", txt)]
            e["debordements"] = [d for d in overflow_report(pg) if d.get("kind") != "clipped"][:5]
            close_plugin(pg)
        res["erreurs_console"] = [x["text"][:200] for x in log.errors()][:8]
        b.close()
    return res


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    out = {vp: run(vp) for vp in (sys.argv[1:] or ["pc", "tab", "tel"])}
    print(json.dumps(out, ensure_ascii=False, indent=1))
