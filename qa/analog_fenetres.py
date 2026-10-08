"""Captures (headless, sans fenêtre) des fenêtres des compresseurs analogiques NOVA,
en thème clair et en thème sombre, PC et téléphone, + contrôle des débordements.
Usage : NOVA_URL=http://127.0.0.1:3440/ python qa/analog_fenetres.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright  # noqa: E402

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3440/")
OUT = r"D:\1 WORK\CONTENU\nova-labo\captures"
os.makedirs(OUT, exist_ok=True)
KINDS = ["OPTO_VINTAGE", "FET76", "LEVELER2A", "VOXSTRIP"]
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE, headless=True)
    for theme in ("dark", "light"):
        for vp, size in (("pc", {"width": 1440, "height": 1000}), ("tel", {"width": 390, "height": 844})):
            ctx = b.new_context(viewport=size, device_scale_factor=1)
            pg = ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}') }} catch (e) {{}}")
            pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(3000)
            for k in KINDS:
                pg.evaluate("document.querySelectorAll('[data-qa-analog]').forEach(n => n.remove())")
                pg.evaluate("async (k) => { const m = await import('/qa/harness/analogUi.tsx'); return m.mountAnalogWindow(k); }", k)
                pg.locator(f"[data-nova-plugin='{k}']").first.wait_for(timeout=20000)
                pg.wait_for_timeout(900)
                fn = os.path.join(OUT, f"{k.lower()}_{theme}_{vp}.png")
                pg.screenshot(path=fn, full_page=False)
                over = pg.evaluate("""(k) => { const r = document.querySelector(`[data-nova-plugin='${k}']`).getBoundingClientRect();
                  return { largeur: Math.round(r.width), deborde_ecran: r.right > window.innerWidth + 1 || r.left < -1,
                           theme: document.documentElement.getAttribute('data-theme') }; }""", k)
                res[f"{k}_{theme}_{vp}"] = over
            res[f"erreurs_{theme}_{vp}"] = errs[:3]
            ctx.close()
    b.close()
print(json.dumps(res, ensure_ascii=False, indent=1))
