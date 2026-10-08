"""Preuves « finitions édition » (navigateur headless, à la souris, aucune fenêtre).

  shuffle : Shuffle (F1), DEUX clips sélectionnés glissés vers la piste du dessous :
            toute la sélection bouge, la piste de départ se recolle, celle d'arrivée
            avance ; une seule annulation (Ctrl+Z) remet les deux pistes.
  grille  : menu de grille avec les valeurs en millisecondes et en images ; Grid absolu
            sur 100 ms : le clip déplacé tombe sur un multiple de 100 ms.

Usage : serveur `npx vite --port 3435 --strictPort`, puis python qa/finitions_edition.py [shuffle] [grille]
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions\\
"""
import json, os, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3435/")
os.environ["QA_OUT"] = r"D:\1 WORK\CONTENU\nova-finitions"
sys.path.insert(0, str(Path(__file__).parent))
from qalib import OUT, Log, new_page, shot, save_log  # noqa
import protools_edition as pe  # noqa
import modes_edition as me  # noqa
from playwright.sync_api import sync_playwright


def scenario_shuffle(page, res):
    pe.open_project(page, me.project(), "edition_00_projet")
    box = pe.canvas_box(page)
    page.keyboard.press("F1"); page.wait_for_timeout(200)
    res["mode"] = me.mode(page)
    me.place(page, "voix", {"A": {"start": 0, "duration": 2, "offset": 0, "syncPoint": None}, "B": {"start": 2}, "C": {"start": 4}})
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    res["depart"] = {"voix": me.spans(page, "voix"), "back": me.spans(page, "back")}
    # Sélection : A puis Maj+clic sur B.
    y0 = pe.lane_y(box, 0, 0.85)
    page.mouse.click(pe.x_of(box, 1.0), y0); page.wait_for_timeout(150)
    page.keyboard.down("Shift"); page.mouse.click(pe.x_of(box, 3.0), y0); page.keyboard.up("Shift"); page.wait_for_timeout(150)
    page.wait_for_timeout(500)
    # Départ relevé APRÈS la sélection : un clic sur un clip collé à un autre pose le crossfade
    # anti-clic automatique (10 ms), qui n'est pas l'objet de la mesure.
    res["depart"] = {"voix": me.spans(page, "voix"), "back": me.spans(page, "back")}
    shot(page, "edition_01_shuffle_selection_A_B")
    # Glisse A (donc A + B) sur la piste du dessous, au début du morceau.
    x0 = pe.x_of(box, 1.0)
    page.mouse.move(x0, y0); page.mouse.down()
    page.mouse.move(x0 + 6, y0, steps=2)
    y1 = pe.lane_y(box, 1, 0.85)
    page.mouse.move(x0, y1, steps=10)
    page.wait_for_timeout(120)
    page.mouse.up(); page.wait_for_timeout(400)
    res["apres"] = {"voix": me.spans(page, "voix"), "back": me.spans(page, "back")}
    shot(page, "edition_02_shuffle_groupe_change_de_piste")
    v, b = me.starts(res["apres"]["voix"]), me.starts(res["apres"]["back"])
    res["groupe_ok"] = v == [("C", 0.0)] and b == [("A", 0.0), ("B", 2.0), ("D", 4.0)]
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    res["apres_annuler"] = {"voix": me.spans(page, "voix"), "back": me.spans(page, "back")}
    res["une_annulation_ok"] = res["apres_annuler"] == res["depart"]
    shot(page, "edition_03_shuffle_annule_en_une_fois")
    res["ok"] = res["groupe_ok"] and res["une_annulation_ok"]


def scenario_grille(page, res):
    pe.open_project(page, me.project(), "edition_00_projet")
    box = pe.canvas_box(page)
    page.keyboard.press("F4"); page.wait_for_timeout(150)
    if "ABSOLUTE" in me.mode(page): page.keyboard.press("F4"); page.wait_for_timeout(150)
    res["mode_relatif"] = me.mode(page)
    # Grid relatif, 1/4 à 120 BPM : la fin de A (2,125 s, 0,125 après le temps) rognée de ~0,9 s
    # → 3,125 s (pas entiers, décalage gardé), comme Pro Tools.
    me.place(page, "voix", {"A": {"start": 0.125, "duration": 2, "offset": 0}})
    y = pe.lane_y(box, 0, 0.45)
    pe.drag(page, pe.x_of(box, 2.11), y, pe.x_of(box, 2.11 + 0.9), y)
    a = me.clip_of(page, "voix", "A")
    res["rognage_relatif_fin"] = a["end"]
    res["rognage_relatif_ok"] = abs(a["end"] - 3.125) < 1e-4
    shot(page, "edition_09_rognage_grille_relative")
    page.keyboard.press("Control+z"); page.wait_for_timeout(300)
    page.keyboard.press("F4"); page.wait_for_timeout(150)
    res["mode"] = me.mode(page)
    page.locator('[data-testid="grid-value"]').click(); page.wait_for_timeout(300)
    res["menu"] = page.evaluate("() => [...document.querySelectorAll('[data-grid-option]')].map(e => e.textContent.trim())")
    shot(page, "edition_10_menu_grille_ms_images")
    page.locator('[data-grid-option="ms:100"]').click(); page.wait_for_timeout(250)
    res["valeur"] = page.locator('[data-testid="grid-value"]').inner_text()
    me.place(page, "voix", {"B": {"start": 6.0}})
    me.drag_clip(page, box, 7.0, 0.737)
    b = me.clip_of(page, "voix", "B")
    res["B_debut"] = b["start"]
    res["sur_100ms"] = abs(b["start"] * 10 - round(b["start"] * 10)) < 1e-6
    # Images (25 i/s) : 1 image = 40 ms.
    page.locator('[data-testid="grid-value"]').click(); page.wait_for_timeout(250)
    page.locator('[data-grid-option="fps:25"]').click(); page.wait_for_timeout(250)
    me.drag_clip(page, box, b["start"] + 1.0, 0.31)
    b2 = me.clip_of(page, "voix", "B")
    res["B_debut_images"] = b2["start"]
    res["sur_image_25"] = abs(b2["start"] * 25 - round(b2["start"] * 25)) < 1e-6
    shot(page, "edition_11_grille_images_25")
    res["ok"] = res["rognage_relatif_ok"] and res["sur_100ms"] and res["sur_image_25"] and any("ms" in m for m in res["menu"])


def main(names):
    table = {"shuffle": scenario_shuffle, "grille": scenario_grille}
    allres = {}
    with sync_playwright() as p:
        b = pe.launch(p)
        for n in names:
            log = Log(f"edition_{n}")
            res = {"name": n}
            ctx, page = new_page(b, "pc", log, touch=False)
            try:
                table[n](page, res)
            except Exception as e:  # noqa
                res["ok"] = False
                res["exception"] = f"{type(e).__name__}: {str(e)[:600]}"
                try: shot(page, f"edition_{n}__ECHEC")
                except Exception: pass
            res["erreurs_page"] = [e["text"][:300] for e in log.errors()][:20]
            save_log(log, {"result": res})
            allres[n] = res
            ctx.close()
        b.close()
    (OUT / f"finitions_edition_{'_'.join(names)}.json").write_text(json.dumps(allres, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(allres, ensure_ascii=False, indent=1)[:6000])


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if a in ("shuffle", "grille")] or ["shuffle", "grille"])
