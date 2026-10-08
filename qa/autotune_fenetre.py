"""Fenêtre « Utiliser ton autotune à la place de celui de NOVA ? » avec le VRAI pont (8 autotunes
sur le PC du studio) : sur un écran de 900 px puis 768 px de haut, le titre et « Plus tard »
restent visibles (la liste défile jusqu'à « Autotune de NOVA »), « Plus tard » ferme la fenêtre.

Usage (serveur NOVA lancé) : NOVA_URL=http://127.0.0.1:3484/ NOVA_TEST_PORT=8786 python qa/autotune_fenetre.py
"""
import json, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-verif\autotune")
from qalib import *  # noqa
from qalib import BASE  # noqa
import qalib
from stems_separation import start_bridge, stop_bridge, prepare, make_project  # noqa

PORT = int(os.environ.get("NOVA_TEST_PORT", "8786"))
PROJECT = OUT / "projet_autotune.zip"


def scenario(page, log, res, vp):
    prepare(page, port=PORT)
    # Utilisateur qui n'a pas encore répondu : on retire le choix posé par prepare().
    page.add_init_script("try { localStorage.removeItem('nova.autotuneVst.v1'); localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    # La fenêtre arrive dans le studio quand le pont a livré la liste des plugins : projet ouvert
    # à la main (open_project_file fermerait la fenêtre par « Plus tard »).
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.click(timeout=25000); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(PROJECT))
    dlg = page.get_by_test_id("autotune-choice")
    dlg.wait_for(timeout=60000)
    page.wait_for_timeout(800)
    shot(page, f"{vp}_1_fenetre_autotune")
    h = page.viewport_size["height"]
    box = lambda loc: loc.bounding_box()  # noqa
    title = box(page.locator("#autotune-choice-title"))
    later = page.get_by_role("button", name="Plus tard", exact=True)
    lb = box(later)
    lst = page.get_by_test_id("autotune-choice-list")
    res["hauteur_ecran"] = h
    res["titre_y"] = round(title["y"])
    res["plus_tard_bas"] = round(lb["y"] + lb["height"])
    res["autotunes"] = page.locator("[data-testid=autotune-choice] input[type=radio]").count()
    res["liste_defile"] = lst.evaluate("e => e.scrollHeight > e.clientHeight + 1")
    res["titre_visible"] = title["y"] >= 0
    res["plus_tard_visible"] = lb["y"] + lb["height"] <= h
    # La dernière option (« Autotune de NOVA ») est atteignable en faisant défiler la liste.
    lst.evaluate("e => { e.scrollTop = e.scrollHeight; }")
    page.wait_for_timeout(300)
    nova = page.locator("[data-testid=autotune-choice] label", has_text="Autotune de NOVA")
    nb = box(nova)
    res["option_nova_visible"] = nb is not None and nb["y"] + nb["height"] <= h
    shot(page, f"{vp}_2_liste_defilee")
    later.click()
    dlg.wait_for(state="detached", timeout=5000)
    res["ferme"] = True
    shot(page, f"{vp}_3_ferme")
    assert res["titre_visible"] and res["plus_tard_visible"] and res["option_nova_visible"], res


if __name__ == "__main__":
    make_project(PROJECT)
    qalib.VIEWPORTS["pc768"] = {"width": 1366, "height": 768}
    report = {}
    br = start_bridge(PORT)
    try:
        report["ecran_900"] = run_one(scenario, "pc", "ecran_900")
        report["ecran_768"] = run_one(scenario, "pc768", "ecran_768")
    finally:
        stop_bridge(br)
    for r in report.values():
        r["errors"] = [e for e in r["errors"] if "JWT" not in e and "401" not in e and "suitable key" not in e][:5]
    (OUT / "autotune_fenetre.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1))
