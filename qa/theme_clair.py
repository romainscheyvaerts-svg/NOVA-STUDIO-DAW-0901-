"""Thème clair : anciennes fenêtres passées aux jetons du thème (bg-nv-*), avant / après.

Pour quelques écrans (accueil, studio, modèles, réglages audio, console, menu du clip, piano
roll) en thème clair puis sombre : capture, et nombre de grands panneaux restés sombres en
thème clair (fond calculé de luminance < 60 sur plus de 20 000 px², hors fenêtres d'effets
volontairement sombres .nova-sombre). Chrome headless, compte simulé, aucune écriture externe.

NOVA_URL=http://127.0.0.1:3492/ QA_TAG=apres PYTHONIOENCODING=utf-8 python qa/theme_clair.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro2\\point5\\<tag>\\
"""
import json, os, re, sys
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3492/")
TAG = os.environ.get("QA_TAG", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro2\point5\{TAG}")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from nova_pro_lib import track_point  # noqa: E402
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split("\nwith sync_playwright() as p:")[0]
exec(compile(_r1, "r1_export.py", "exec"))  # make_project, open_with_project…
from playwright.sync_api import sync_playwright  # noqa: E402

DARK = r"""() => { const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.nova-sombre') || el.tagName === 'CANVAS' || el.tagName === 'IMG') continue;
    const r = el.getBoundingClientRect(); if (r.width * r.height < 20000 || !el.getClientRects().length) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?/); if (!m) continue;
    if (m[4] !== undefined && +m[4] < 0.6) continue;
    const lum = 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3];
    if (lum < 60) out.push((el.className && el.className.baseVal === undefined ? String(el.className) : el.tagName).slice(0, 70));
  }
  return out; }"""

res = {"tag": TAG, "ecrans": {}}


def screens(page, theme):
    def snap(name):
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / f"{theme}_{name}.png"))
        if theme == "clair": res["ecrans"][name] = page.evaluate(DARK)
    z = OUT / "theme.zip"; make_project(z)
    open_with_project(page, z)
    page.mouse.click(5, 300); page.keyboard.press("Escape")
    snap("01_studio")
    x, y = track_point(page, "voix", 3.0); page.mouse.click(x, y, button="right"); page.wait_for_timeout(300)
    snap("02_menu_clip"); page.keyboard.press("Escape")
    page.keyboard.press("Control+Equal"); page.wait_for_timeout(800); snap("03_console"); page.keyboard.press("Control+Equal")
    page.wait_for_timeout(500)
    b = page.locator("button[aria-label='Ouvrir le menu']").locator("visible=true")
    if b.count():
        b.first.click(); page.wait_for_timeout(300)
        it = page.locator("[role=dialog][aria-label=Menu] button", has_text=re.compile("Réglages audio|Audio")).locator("visible=true")
        if it.count(): it.first.click(); snap("04_reglages_audio")
        page.keyboard.press("Escape"); page.keyboard.press("Escape")


with sync_playwright() as p:
    b = launch(p)
    for theme in ("clair", "sombre"):
        log = Log(f"theme_{theme}")
        ctx, page = new_page(b, "pc", log=log)
        page.add_init_script(f"try {{ localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_theme', '{'light' if theme == 'clair' else 'dark'}'); }} catch (e) {{}}")
        install_mocks(page, "romain", SUPERADMIN, {})
        # Accueil et « Depuis un modèle »
        page.goto(BASE, wait_until="domcontentloaded")
        page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.wait_for(timeout=90000)
        page.wait_for_timeout(600); page.screenshot(path=str(OUT / f"{theme}_00_accueil.png"))
        if theme == "clair": res["ecrans"]["00_accueil"] = page.evaluate(DARK)
        tpl = page.locator("[data-testid=landing-templates]:visible")
        if tpl.count():
            tpl.first.click(); page.wait_for_timeout(1500); page.screenshot(path=str(OUT / f"{theme}_00b_modeles.png"))
            if theme == "clair": res["ecrans"]["00b_modeles"] = page.evaluate(DARK)
            page.keyboard.press("Escape")
        screens(page, theme)
        res[f"erreurs_{theme}"] = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:5]
        ctx.close()
    b.close()
res["panneaux_sombres_en_clair"] = {k: len(v) for k, v in res["ecrans"].items()}
res["total"] = sum(res["panneaux_sombres_en_clair"].values())
(OUT / "theme_clair.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps({"total": res["total"], **res["panneaux_sombres_en_clair"]}, ensure_ascii=False), res.get("erreurs_clair"))
