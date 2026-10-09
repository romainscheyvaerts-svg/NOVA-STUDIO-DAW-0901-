"""Console du téléphone et de la tablette : solo / muet comme Pro Tools, au doigt.

Chrome headless (aucune fenêtre), 100 % hors production (qa_hors_prod via qalib) :
projet de 8 pistes (projet_mix), mode avancé, puis pour le téléphone (390 × 844, onglet
« Mixer » : components/MobileMixerPage) et la tablette (1024 × 768, console PC :
components/MixerView), en thème sombre et clair :
  - état vide : la ligne d'aide dit le geste caché (téléphone) ;
  - toucher S : 1 piste en solo, compteur « 1 en solo » ;
  - appui long S : menu « Toutes les pistes en solo / Effacer tous les solos / Solo safe » ;
  - compteur « tout réentendre » : 0 solo en 1 toucher ;
  - appui long M : « Couper toutes les pistes », compteur « N muettes » → « rendre le son » ;
  - clavier de tablette : Alt+clic sur M (toutes muettes / toutes rendues), Ctrl+clic sur S (solo safe) ;
  - zones de toucher ≥ 44 px (téléphone) ; gestes avant / après.

  NOVA_URL=http://127.0.0.1:3487/ PYTHONIOENCODING=utf-8 python qa/console_telephone.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro3\\console_telephone\\ (console_telephone.json + captures)
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3487/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro3\console_telephone")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402  (qa_hors_prod : Supabase simulé, prod bloquée)
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from projet_mix import make_mix_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

N = 8
checks = []
res = {"cas": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("  OK  " if cond else "  KO  ") + name + (f" — {detail}" if detail is not None else ""), flush=True)


def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit && window.__novaEdit.getState(); return s ? ({expr})(s) : null; }}")


def counts(page):
    return st(page, "s => { const l = s.tracks.filter(t => t.id !== 'master'); return { solo: l.filter(t => t.isSolo).length, mute: l.filter(t => t.isMuted).length, safe: l.filter(t => t.soloSafe).map(t => t.name), n: l.length }; }")


def hold(page, loc, ms=800):
    """Appui long au doigt (vrais événements tactiles de Chrome)."""
    loc.scroll_into_view_if_needed()
    b = loc.bounding_box()
    x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 1, "radiusX": 4, "radiusY": 4, "force": 1}]})
    page.wait_for_timeout(ms)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()
    page.wait_for_timeout(350)


def menu_labels(page):
    return page.evaluate("() => Array.from(document.querySelectorAll('[data-testid=structure-menu] [role=menuitem]')).map(b => b.innerText.trim())")


def pick(page, rx):
    page.locator("[data-testid=structure-menu] [role=menuitem]", has_text=re.compile(rx)).first.tap()
    page.wait_for_timeout(400)


def open_studio(page, vp, theme, zpath):
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.wait_for(timeout=90000)
    page.wait_for_function("() => !document.getElementById('loading-screen')", timeout=15000)
    page.wait_for_timeout(300)
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.tap()
    page.wait_for_timeout(800); close_welcome(page)
    page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
    # Ouvrir le projet de mix (menu ☰ › Ouvrir un projet › Fichier sur l'ordinateur).
    page.get_by_role("button", name=re.compile("^Ouvrir le menu$")).first.tap(); page.wait_for_timeout(300)
    page.locator("[role=dialog] button", has_text=re.compile("Ouvrir un projet")).first.tap(); page.wait_for_timeout(400)
    page.get_by_text(re.compile("Fichier sur l.ordinateur")).first.tap()
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(zpath))
    page.wait_for_function(f"() => window.__novaEdit.getState().tracks.filter(t => t.type === 'AUDIO').length >= {N}", timeout=60000)
    page.wait_for_timeout(1200)
    for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(150)


def run_tel(page, theme, out):
    open_studio(page, "tel", theme, out["zip"])
    page.locator("[role=navigation] button", has_text=re.compile(r"^\s*Mixer\s*$")).first.tap()
    page.locator("[data-testid^=tel-solo-]").first.wait_for(timeout=15000)
    page.wait_for_timeout(500)
    tag = f"tel_{theme}"
    page.screenshot(path=str(OUT / f"{tag}_01_vide.png"))
    ids = st(page, "s => s.tracks.filter(t => t.type === 'AUDIO').map(t => t.id)")
    a, b = ids[0], ids[1]
    check(f"{tag} · état vide : aide « appui long » affichée", page.locator("[data-testid=tel-solo-mute-vide]").is_visible())
    # Zones de toucher ≥ 44 px
    sizes = page.evaluate("""() => ['button[data-testid^=tel-solo-]', 'button[data-testid^=tel-mute-]'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })""")
    check(f"{tag} · S et M : zones ≥ 44 px de haut", all(h >= 44 for _, h in sizes), sizes)
    # Toucher S
    page.locator(f"[data-testid=tel-solo-{a}]").tap(); page.wait_for_timeout(300)
    c = counts(page)
    check(f"{tag} · toucher S : 1 piste en solo, compteur « 1 en solo »", c["solo"] == 1 and "1 en solo" in page.locator("[data-testid=tel-clear-solos]").inner_text(), c)
    # Appui long S → menu
    hold(page, page.locator(f"[data-testid=tel-solo-{b}]"))
    labels = menu_labels(page)
    page.screenshot(path=str(OUT / f"{tag}_02_appui_long_solo.png"))
    check(f"{tag} · appui long S : menu tous les solos / effacer / solo safe", any("Toutes les pistes en solo" in l for l in labels) and any("Effacer tous les solos" in l for l in labels) and any("Solo safe" in l for l in labels), labels)
    check(f"{tag} · appui long S : la tranche n'a PAS basculé (le lever du doigt est avalé)", counts(page)["solo"] == 1)
    pick(page, "Toutes les pistes en solo")
    c = counts(page)
    check(f"{tag} · « Toutes les pistes en solo » : {c['n']} pistes en solo en 2 gestes", c["solo"] == c["n"], c)
    page.screenshot(path=str(OUT / f"{tag}_03_tout_en_solo.png"))
    t0 = time.time()
    page.locator("[data-testid=tel-clear-solos]").tap(); page.wait_for_timeout(300)
    check(f"{tag} · compteur « tout réentendre » : 0 solo en 1 toucher", counts(page)["solo"] == 0, round((time.time() - t0) * 1000))
    # Appui long M → couper tout → compteur → rendre le son
    hold(page, page.locator(f"[data-testid=tel-mute-{a}]"))
    labels = menu_labels(page)
    check(f"{tag} · appui long M : « Couper toutes les pistes »", any("Couper toutes les pistes" in l for l in labels), labels)
    pick(page, "Couper toutes les pistes")
    c = counts(page)
    txt = page.locator("[data-testid=tel-clear-mutes]").inner_text() if page.locator("[data-testid=tel-clear-mutes]").count() else ""
    check(f"{tag} · toutes muettes, compteur « {c['mute']} muettes »", c["mute"] == c["n"] and f"{c['n']} muettes" in txt, txt.replace("\n", " "))
    page.screenshot(path=str(OUT / f"{tag}_04_toutes_muettes.png"))
    page.locator("[data-testid=tel-clear-mutes]").tap(); page.wait_for_timeout(300)
    check(f"{tag} · « rendre le son » : 0 muette, l'aide revient", counts(page)["mute"] == 0 and page.locator("[data-testid=tel-solo-mute-vide]").is_visible())
    # Solo safe par l'appui long
    hold(page, page.locator(f"[data-testid=tel-solo-{b}]"))
    pick(page, "Solo safe")
    check(f"{tag} · appui long › Solo safe : bouclier sur la tranche", page.locator(f"[data-testid=tel-solo-{b}]").get_attribute("data-solo-safe") == "1", counts(page)["safe"])
    page.screenshot(path=str(OUT / f"{tag}_05_solo_safe.png"))
    hold(page, page.locator(f"[data-testid=tel-solo-{b}]")); pick(page, "Retirer le solo safe")
    # Clavier (tablette avec clavier, ou téléphone avec clavier Bluetooth) : Alt+clic / Ctrl+clic
    page.locator(f"[data-testid=tel-mute-{a}]").click(modifiers=["Alt"]); page.wait_for_timeout(300)
    c1 = counts(page)
    page.locator(f"[data-testid=tel-mute-{a}]").click(modifiers=["Alt"]); page.wait_for_timeout(300)
    c2 = counts(page)
    check(f"{tag} · Alt+clic sur M : toutes muettes, puis toutes rendues", c1["mute"] == c1["n"] and c2["mute"] == 0, [c1["mute"], c2["mute"]])
    page.locator(f"[data-testid=tel-solo-{a}]").click(modifiers=["Control"]); page.wait_for_timeout(300)
    c3 = counts(page)
    check(f"{tag} · Ctrl+clic sur S : solo safe (pas de solo)", len(c3["safe"]) == 1 and c3["solo"] == 0, c3)
    page.locator(f"[data-testid=tel-solo-{a}]").click(modifiers=["Control"]); page.wait_for_timeout(200)
    # Gestes : écouter toutes les pistes en solo puis tout réentendre
    res["cas"][tag] = {"pistes": c["n"], "gestes_tout_en_solo": {"avant": f"{c['n']} touchers (un S par tranche, console à faire défiler)", "apres": "2 (appui long + menu)"},
                       "gestes_effacer_solos": {"avant": "1 toucher par piste en solo", "apres": 1},
                       "gestes_tout_couper": {"avant": c["n"], "apres": 2}, "gestes_rendre_le_son": {"avant": "1 par piste muette", "apres": 1}}


def run_tab(page, theme, out):
    open_studio(page, "tab", theme, out["zip"])
    page.get_by_role("button", name=re.compile("^Ouvrir le menu$")).first.tap(); page.wait_for_timeout(300)
    page.locator("[role=dialog] button", has_text=re.compile("^Console$")).first.tap()
    page.wait_for_function("() => document.querySelectorAll('[data-strip-id]').length > 3", timeout=15000)
    page.wait_for_timeout(500)
    tag = f"tab_{theme}"
    ids = st(page, "s => s.tracks.filter(t => t.type === 'AUDIO').map(t => [t.id, t.name])")
    (a, an), (b, bn) = ids[0], ids[1]
    solo_b = page.get_by_role("button", name=re.compile(f"^Solo : {re.escape(bn)}")).first
    mute_a = page.get_by_role("button", name=re.compile(f"^Muet : {re.escape(an)}$")).first
    solo_a = page.get_by_role("button", name=re.compile(f"^Solo : {re.escape(an)}")).first
    solo_a.tap(); page.wait_for_timeout(300)
    hold(page, solo_b)
    labels = menu_labels(page)
    page.screenshot(path=str(OUT / f"{tag}_01_appui_long_solo.png"))
    check(f"{tag} · console au doigt : appui long sur Solo = menu", any("Toutes les pistes en solo" in l for l in labels) and any("Effacer tous les solos" in l for l in labels), labels)
    pick(page, "Toutes les pistes en solo")
    c = counts(page)
    check(f"{tag} · toutes en solo", c["solo"] == c["n"], c)
    clr = page.locator("[data-testid=clear-solos]").locator("visible=true").first
    clr.tap(); page.wait_for_timeout(300)
    check(f"{tag} · indicateur S : tout réentendre en 1 toucher", counts(page)["solo"] == 0)
    hold(page, mute_a)
    pick(page, "Couper toutes les pistes")
    check(f"{tag} · appui long sur Muet › couper toutes", counts(page)["mute"] == counts(page)["n"])
    page.screenshot(path=str(OUT / f"{tag}_02_toutes_muettes.png"))
    mute_a.click(modifiers=["Alt"]); page.wait_for_timeout(300)
    check(f"{tag} · clavier : Alt+clic sur Muet (allumé) rend le son partout", counts(page)["mute"] == 0)
    solo_a.click(modifiers=["Control"]); page.wait_for_timeout(300)
    check(f"{tag} · clavier : Ctrl+clic sur Solo = solo safe", len(counts(page)["safe"]) == 1)
    solo_a.click(modifiers=["Control"]); page.wait_for_timeout(200)


def main():
    zpath = OUT / "mix8.zip"; make_mix_project(zpath, N, name="Console téléphone")
    t0 = time.time()
    with sync_playwright() as p:
        b = launch(p)
        for vp in ("tel", "tab"):
            for theme in ("sombre", "clair"):
                log = Log(f"console_{vp}_{theme}")
                ctx, page = new_page(b, vp, log=log, touch=True)
                if vp == "tel": page.set_viewport_size({"width": 390, "height": 844})
                page.set_default_timeout(20000)
                page.add_init_script(f"try {{ localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_theme', '{'light' if theme == 'clair' else 'dark'}'); }} catch (e) {{}}")
                install_mocks(page, "romain", SUPERADMIN, {})
                try:
                    (run_tel if vp == "tel" else run_tab)(page, theme, {"zip": zpath})
                except Exception as e:
                    check(f"{vp}_{theme} · déroulé complet", False, f"{type(e).__name__}: {str(e)[:300]}")
                    try: page.screenshot(path=str(OUT / f"{vp}_{theme}_ECHEC.png"))
                    except Exception: pass
                errs = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])]
                check(f"{vp}_{theme} · aucune erreur de console", not errs, errs[:3])
                ctx.close()
        b.close()
    ok = sum(c["ok"] for c in checks)
    res.update({"verifs": checks, "total": f"{ok}/{len(checks)}", "secs": round(time.time() - t0, 1)})
    (OUT / "console_telephone.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{ok}/{len(checks)} vérifications")
    sys.exit(0 if ok == len(checks) else 1)


if __name__ == "__main__":
    main()
