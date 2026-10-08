"""Captures avant / après de la refonte visuelle (07/10/2026), sombre ET clair.

  NOVA_URL=http://localhost:3427/ python qa/visuel_captures.py avant
  NOVA_URL=http://localhost:3427/ python qa/visuel_captures.py apres pc tel

Écrit `<phase>/<vp>_<thème>_<NN>_<écran>.png` dans D:\\1 WORK\\CONTENU\\nova-visuel
et un résumé `<phase>/resume.json` (débordements, erreurs console, thème réellement
appliqué). Navigateur headless : aucune fenêtre.
"""
import json, os, re, sys, time
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-visuel")
from qalib import launch, Log, overflow_report, BASE  # noqa: E402
from scenarios import open_studio, visible, body, btn, close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PHASE = sys.argv[1] if len(sys.argv) > 1 else "apres"
ONLY = [a.lower() for a in sys.argv[2:]]
OUT = Path(os.environ["QA_OUT"]) / PHASE
OUT.mkdir(parents=True, exist_ok=True)

VPS = {
    "pc": {"width": 1600, "height": 900},
    "tab": {"width": 1024, "height": 768},
    "tel": {"width": 390, "height": 844},
}


def ctx_page(b, vp, theme, log):
    ctx = b.new_context(viewport=VPS[vp], permissions=["microphone"], has_touch=vp != "pc",
                        is_mobile=vp == "tel", device_scale_factor=1, locale="fr-BE")

    def guard(route, request):
        ext = not request.url.startswith(BASE.rstrip("/")) and not request.url.startswith(("data:", "blob:"))
        if request.method in ("POST", "PATCH", "PUT", "DELETE") and ext:
            return route.abort()
        return route.continue_()
    ctx.route("**/*", guard)
    pg = ctx.new_page()
    pg.set_default_timeout(15000)
    pg.on("console", lambda m: log.add(f"console.{m.type}", m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: log.add("pageerror", e))
    pg.add_init_script(
        "try { localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_headphones', '1');"
        f" localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
    return ctx, pg


def current_theme(pg):
    return pg.evaluate("() => document.documentElement.getAttribute('data-theme')")


def open_menu(pg):
    m = pg.get_by_role("button", name=re.compile("Ouvrir le menu")).locator("visible=true")
    if m.count():
        m.first.click(); pg.wait_for_timeout(500)
        return True
    return False


def close_menu(pg):
    m = pg.get_by_role("button", name=re.compile("Fermer le menu")).locator("visible=true")
    if m.count():
        m.first.click(); pg.wait_for_timeout(300)


def force_theme(pg, theme):
    """Avant la refonte, le thème n'était pas mémorisé : on passe par le menu ☰."""
    if current_theme(pg) == theme:
        return True
    if open_menu(pg):
        for rx in ("Changer le thème", "Thème clair", "Clair"):
            b = pg.get_by_role("button", name=re.compile(rx)).locator("visible=true")
            if b.count():
                b.first.click(); pg.wait_for_timeout(600); break
        close_menu(pg)
    return current_theme(pg) == theme


def esc(pg, n=2):
    for _ in range(n):
        pg.keyboard.press("Escape"); pg.wait_for_timeout(250)


def run(b, vp, theme, R):
    log = Log(f"{vp}_{theme}")
    ctx, pg = ctx_page(b, vp, theme, log)
    r = R.setdefault(f"{vp}_{theme}", {"name": f"{vp}_{theme}", "ecrans": {}})
    n = [0]

    def S(label):
        n[0] += 1
        p = OUT / f"{vp}_{theme}_{n[0]:02d}_{label}.png"
        try:
            pg.screenshot(path=str(p))
            r["ecrans"][label] = {"theme": current_theme(pg), "debordements": overflow_report(pg)[:8]}
        except Exception as e:  # noqa
            r["ecrans"][label] = {"erreur": str(e)[:200]}

    def tryit(label, fn):
        try:
            fn()
        except Exception as e:  # noqa
            r.setdefault("echecs", []).append(f"{label}: {type(e).__name__}: {str(e)[:200]}")
        esc(pg)

    # Accueil du DAW
    pg.goto(BASE, wait_until="domcontentloaded")
    try:
        pg.get_by_text("Nouveau Projet").first.wait_for(timeout=20000)
    except Exception:
        pass
    pg.wait_for_timeout(1500)
    S("accueil")
    open_studio(pg, r, vp=vp)
    r["theme_force"] = force_theme(pg, theme)
    pg.mouse.move(5, 5); pg.wait_for_timeout(400)
    S("studio")

    def menu():
        if open_menu(pg):
            S("menu")
            pg.mouse.move(180, 500); pg.mouse.wheel(0, 1400); pg.wait_for_timeout(400)
            S("menu_bas")
            close_menu(pg)
    tryit("menu", menu)

    if vp == "tel":
        nav = pg.locator("nav, [role=navigation], div.fixed.bottom-0").filter(has_text="Morceau").last
        for tab in ("Sons", "Nova", "Mixer", "Pistes", "Morceau"):
            def t(tab=tab):
                nav.get_by_text(tab, exact=True).first.click(); pg.wait_for_timeout(900)
                S(f"onglet_{tab}")
            tryit(tab, t)
    else:
        def console():
            b2 = pg.get_by_role("button", name=re.compile("^Console$")).locator("visible=true")
            if not b2.count():
                open_menu(pg)
                b2 = pg.get_by_role("button", name=re.compile("Console")).locator("visible=true")
            b2.first.click(); pg.wait_for_timeout(1000)
            S("console")
            b3 = pg.get_by_role("button", name=re.compile("^Pistes$")).locator("visible=true")
            if not b3.count():
                # Tablette, mode simple : bouton « Pistes » du bandeau du bas (le menu ☰ n'a pas « Vues »,
                # et l'ouvrir recouvrait ce bouton : clic bloqué 15 s).
                b3 = pg.get_by_role("button", name=re.compile(r"\bPistes\b")).locator("visible=true")
            if not b3.count():
                open_menu(pg)
                b3 = pg.get_by_role("button", name=re.compile("Pistes")).locator("visible=true")
            b3.first.click(); pg.wait_for_timeout(700)
        tryit("console", console)

    def via_menu(rx, label, wait=1000):
        def f():
            b2 = btn(pg, re.compile(rx))
            if not visible(b2):
                open_menu(pg)
                b2 = btn(pg, re.compile(rx))
            b2.click(); pg.wait_for_timeout(wait)
            S(label)
        return f

    def effet():
        # Un style de Mix auto pose des effets sur les voix, puis on ouvre le premier.
        pg.locator("button[title='Choisir un style de mix pour ta voix']").locator("visible=true").first.click(); pg.wait_for_timeout(800)
        pg.get_by_role("dialog", name=re.compile("Mix auto")).get_by_role("button", name="Trap autotune").first.click()
        pg.wait_for_timeout(1500); esc(pg, 1); pg.mouse.click(5, 5); pg.wait_for_timeout(400)
        if vp == "tel":
            pg.locator("nav, [role=navigation], div.fixed.bottom-0").filter(has_text="Morceau").last.get_by_text("FX", exact=True).first.click(); pg.wait_for_timeout(800)
            S("onglet_FX")
            pg.get_by_text(re.compile("^(DENOISER|AUTOTUNE|Anti-bruit)$")).locator("visible=true").first.click(timeout=4000)
        else:
            pg.locator(".fx-slot button[aria-label^='Ouvrir']").locator("visible=true").first.click(timeout=4000)
        pg.wait_for_timeout(1200)
        S("effet")
    tryit("effet", effet)
    tryit("export", via_menu(r"^\W*Exporter( le mix)?\s*$", "export"))
    tryit("master", via_menu(r"^\W*Master( Nova)?\s*$", "master_nova", 1400))
    tryit("collab", via_menu(r"Collabor", "collaboration"))
    tryit("signaler", via_menu(r"Signaler", "signalement"))
    r["erreurs"] = [e["text"][:200] for e in log.errors()][:10]
    ctx.close()


R = {}
with sync_playwright() as p:
    b = launch(p)
    for vp in VPS:
        if ONLY and vp not in ONLY:
            continue
        for theme in ("dark", "light"):
            t0 = time.time()
            try:
                run(b, vp, theme, R)
            except Exception as e:  # noqa
                R.setdefault(f"{vp}_{theme}", {})["exception"] = f"{type(e).__name__}: {str(e)[:300]}"
            R[f"{vp}_{theme}"]["secs"] = round(time.time() - t0, 1)
            print(vp, theme, R[f"{vp}_{theme}"].get("secs"), R[f"{vp}_{theme}"].get("echecs"), flush=True)
    b.close()
(OUT / "resume.json").write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
print("ok", OUT)
