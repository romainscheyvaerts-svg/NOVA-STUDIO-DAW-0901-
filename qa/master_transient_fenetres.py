"""Captures (headless, sans fenêtre) de la fenêtre « Mastering Transient », en thème
clair et en thème sombre, PC et téléphone, + contrôle des débordements.
Usage : NOVA_URL=http://127.0.0.1:3451/ python qa/master_transient_fenetres.py"""
import json, os, sys
from playwright.sync_api import sync_playwright  # noqa: E402

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3451/")
OUT = r"D:\1 WORK\CONTENU\nova-labo\elevate\captures"
os.makedirs(OUT, exist_ok=True)
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE, headless=True)
    for theme in ("dark", "light"):
        for vp, size in (("pc", {"width": 1440, "height": 1100}), ("tel", {"width": 390, "height": 844})):
            ctx = b.new_context(viewport=size, device_scale_factor=1)
            pg = ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}') }} catch (e) {{}}")
            pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(3000)
            pg.evaluate("async () => { const m = await import('/qa/harness/masterTransientUi.tsx'); return m.mountMasterTransientWindow(); }")
            pg.locator("[data-nova-plugin='MASTERTRANSIENT']").first.wait_for(timeout=20000)
            pg.wait_for_timeout(900)
            fn = os.path.join(OUT, f"mastering_transient_{theme}_{vp}.png")
            pg.screenshot(path=fn, full_page=False)
            info = pg.evaluate("""() => { const el = document.querySelector("[data-nova-plugin='MASTERTRANSIENT']"); const r = el.getBoundingClientRect();
              const over = [...el.querySelectorAll('*')].filter(n => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === 'visible' && n.clientWidth > 0).length;
              return { largeur: Math.round(r.width), deborde_ecran: r.right > window.innerWidth + 1 || r.left < -1, elements_debordants: over,
                       preset_romain_actif: !!document.querySelector("[data-nova-preset='romain'][aria-pressed='true']"),
                       theme: document.documentElement.getAttribute('data-theme') }; }""")
            res[f"{theme}_{vp}"] = info
            res[f"erreurs_{theme}_{vp}"] = errs[:3]
            ctx.close()
    b.close()
print(json.dumps(res, ensure_ascii=False, indent=1))
