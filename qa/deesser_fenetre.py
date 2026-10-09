"""Captures (headless, sans fenêtre) de la fenêtre du de-esser NOVA, thème clair
et sombre, PC et téléphone, + contrôle des débordements et du contraste du texte.
Usage : NOVA_URL=http://127.0.0.1:3452/ python qa/deesser_fenetre.py"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3452/")
OUT = r"D:\1 WORK\CONTENU\nova-labo\deesser\captures"
os.makedirs(OUT, exist_ok=True)
VARIANTS = ["defaut", "ecoute", "ancien"]
CONTRAST_JS = r"""() => {
  const root = document.querySelector('[data-nova-plugin="DEESSER"]');
  const lum = (c) => { const m = c.match(/[\d.]+/g); if (!m) return 0; const [r, g, b] = m.slice(0, 3).map(v => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bgOf = (el) => { while (el) { const c = getComputedStyle(el).backgroundColor; const m = c.match(/[\d.]+/g); if (m && (m.length < 4 || +m[3] > 0.5)) return c; el = el.parentElement; } return 'rgb(12,13,16)'; };
  let worst = 99, worstTxt = '', small = 0;
  root.querySelectorAll('*').forEach(el => {
    const t = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    if (!t) return;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.fontSize) < 10) small++;
    const L1 = lum(cs.color), L2 = lum(bgOf(el));
    const r = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (r < worst) { worst = r; worstTxt = t.slice(0, 40); }
  });
  const r = root.getBoundingClientRect();
  return { contraste_min: Math.round(worst * 100) / 100, texte_le_moins_contraste: worstTxt, textes_sous_10px: small,
           largeur: Math.round(r.width), deborde_ecran: r.right > window.innerWidth + 1 || r.left < -1,
           theme: document.documentElement.getAttribute('data-theme') };
}"""
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
            for v in VARIANTS:
                pg.evaluate("document.querySelectorAll('[data-qa-deesser]').forEach(n => n.remove())")
                pg.evaluate("async (v) => { const m = await import('/qa/harness/deesserUi.tsx'); return m.mountDeesserWindow(v); }", v)
                pg.locator("[data-nova-plugin='DEESSER']").first.wait_for(timeout=20000)
                pg.wait_for_timeout(900)
                pg.screenshot(path=os.path.join(OUT, f"deesser_{v}_{theme}_{vp}.png"), full_page=False)
                res[f"{v}_{theme}_{vp}"] = pg.evaluate(CONTRAST_JS)
            res[f"erreurs_{theme}_{vp}"] = errs[:3]
            ctx.close()
    b.close()
print(json.dumps(res, ensure_ascii=False, indent=1))
