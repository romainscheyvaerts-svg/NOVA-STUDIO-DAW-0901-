"""Captures (headless, sans fenêtre) des façades « matériel » des effets NOVA :
bureau 1600x900 et téléphone 390x844, + contrôles (débordement horizontal,
taille des boutons rotatifs au doigt, erreurs de page).

Usage :
  NOVA_URL=http://127.0.0.1:3440/ python qa/plugins_hw_captures.py <dossier_sortie> [TYPE ...]
Types par défaut : OPTO_VINTAGE FET76 LEVELER2A VOXSTRIP MASTERTRANSIENT LIMITER DEESSER VOCALSATURATOR
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
from playwright.sync_api import sync_playwright  # noqa: E402

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3440/")
OUT = sys.argv[1] if len(sys.argv) > 1 else r"D:\1 WORK\CONTENU\nova-plugins-design\captures"
KINDS = sys.argv[2:] or ["OPTO_VINTAGE", "FET76", "LEVELER2A", "VOXSTRIP", "MASTERTRANSIENT", "LIMITER", "DEESSER", "VOCALSATURATOR"]
os.makedirs(OUT, exist_ok=True)

MEASURE = """(k) => {
  // Contraste des textes HTML (hors SVG) sur leur fond opaque le plus proche (WCAG).
  const contraste = (root) => {
    const lum = (c) => { const m = c.match(/[\d.]+/g); if (!m) return 0; const [r, g, b] = m.slice(0, 3).map(v => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bgOf = (n) => { while (n) { const c = getComputedStyle(n).backgroundColor; const m = c.match(/[\d.]+/g); if (m && (m.length < 4 || +m[3] > 0.5)) return c; n = n.parentElement; } return 'rgb(12,13,16)'; };
    let worst = 99, txt = '';
    root.querySelectorAll('*').forEach(n => {
      if (n.closest('svg') || n.closest('.hw-sr-only')) return;
      const t = [...n.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent.trim()).join('');
      if (!t || !n.getClientRects().length) return;
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || +cs.opacity === 0) return;
      const L1 = lum(cs.color), L2 = lum(bgOf(n));
      const r = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (r < worst) { worst = r; txt = t.slice(0, 40); }
    });
    return { contraste_min: Math.round(worst * 100) / 100, texte_le_moins_contraste: txt };
  };
  const el = document.querySelector(`[data-qa-hw] [data-nova-plugin='${k}']`) || document.querySelector('[data-qa-hw] [data-nova-plugin]') || document.querySelector('[data-qa-hw]');
  const r = el.getBoundingClientRect();
  const sc = document.querySelector('[data-qa-scroller]');
  const knobs = [...el.querySelectorAll('[role=slider]')].map(n => n.getBoundingClientRect()).filter(b => b.width > 0);
  const petits = knobs.filter(b => Math.min(b.width, b.height) < 44).length;
  return {
    largeur: Math.round(r.width), hauteur: Math.round(r.height),
    deborde_ecran: r.right > window.innerWidth + 1 || r.left < -1,
    defilement_horizontal: !!sc && sc.scrollWidth > sc.clientWidth + 1,
    boutons_rotatifs: knobs.length,
    plus_petit_rotatif_px: knobs.length ? Math.round(Math.min(...knobs.map(b => Math.min(b.width, b.height)))) : null,
    rotatifs_sous_44px: petits,
    curseurs_range: el.querySelectorAll('input[type=range]').length,
    ...contraste(el),
  };
}"""

res = {}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EXE, headless=True)
    for vp, size in (("bureau", {"width": 1600, "height": 900}), ("tel", {"width": 390, "height": 844})):
        ctx = b.new_context(viewport=size, device_scale_factor=1, has_touch=(vp == "tel"))
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        if os.environ.get("NOVA_THEME"):  # thème clair : NOVA_THEME=light
            pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{os.environ['NOVA_THEME']}') }} catch (e) {{}}")
        pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(3000)
        for k in KINDS:
            pg.set_viewport_size(size)
            pg.evaluate("async ([k, m]) => { const h = await import('/qa/harness/hwPlugins.tsx'); return h.mountHwPlugin(k, m); }", [k, vp == "tel"])
            print(vp, k, flush=True)
            pg.locator("[data-qa-hw] [data-nova-plugin], [data-qa-hw] .nova-hosted-plugin > *").first.wait_for(timeout=20000)
            pg.wait_for_timeout(1200)
            pg.screenshot(path=os.path.join(OUT, f"{k.lower()}_{vp}.png"))
            m = pg.evaluate(MEASURE, k)
            # Capture entière : hauteur plafonnée levée (fenêtres .hw-window), écran agrandi à la hauteur du contenu.
            pg.evaluate("() => { const s = document.createElement('style'); s.id = 'qa-hw-entier'; s.textContent = '.hw-window{max-height:none!important}.hw-window-body{overflow:visible!important}'; document.head.appendChild(s); }")
            hh = pg.evaluate("() => { const el = document.querySelector('[data-qa-hw] [data-nova-plugin]') || document.querySelector('[data-qa-hw] .nova-hosted-plugin'); return el ? Math.ceil(el.getBoundingClientRect().height) : 0; }")
            full_h = int(hh) + (140 if vp == "bureau" else 90)
            m["hauteur_contenu"] = hh
            if full_h > size["height"]:
                pg.set_viewport_size({"width": size["width"], "height": full_h})
                pg.wait_for_timeout(500)
                pg.screenshot(path=os.path.join(OUT, f"{k.lower()}_{vp}_entier.png"))
            pg.evaluate("() => document.getElementById('qa-hw-entier')?.remove()")
            res[f"{k}_{vp}"] = m
        pg.evaluate("async () => { const h = await import('/qa/harness/hwPlugins.tsx'); h.unmountHwPlugin(); }")
        res[f"erreurs_{vp}"] = errs[:5]
        ctx.close()
    b.close()
print(json.dumps(res, ensure_ascii=False, indent=1))
with open(os.path.join(OUT, "mesures.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
