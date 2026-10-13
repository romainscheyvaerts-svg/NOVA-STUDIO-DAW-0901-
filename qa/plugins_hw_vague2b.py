"""Vague 2B des façades « matériel » (Chorus, Flanger, Doubleur, Stéréo, Gate de bruit (ex-Anti-bruit),
Analyse tempo / tonalité, Harmoniseur, Voix grave / aiguë, Tape stop, Gate rythmique,
Gate, Filtre DJ, Lo-fi) : captures headless, sans fenêtre, hors production.

Deux modes :
  - banc (défaut) : chaque fenêtre montée seule par qa/harness/hwPlugins2b.tsx,
    bureau 1600x900 et téléphone 390x844 (+ capture entière), avec mesures :
    débordement horizontal, cibles tactiles < 44 px, curseurs « formulaire »
    restants (input range, select), contraste du texte HTML ;
  - --reel : dans le VRAI studio (PluginEditor, barre de la fenêtre), ajoute
    chaque effet par « Ajouter un effet », capture, tourne un bouton (la valeur
    doit changer), vérifie le débordement, puis ferme.

Usage :
  NOVA_URL=http://127.0.0.1:3445/ python qa/plugins_hw_vague2b.py <dossier> [TYPE ...]
  NOVA_URL=http://127.0.0.1:3445/ python qa/plugins_hw_vague2b.py --reel <dossier> [TYPE ...]
  NOVA_THEME=light : thème clair de l'application autour de la fenêtre.
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, re, sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
from playwright.sync_api import sync_playwright  # noqa: E402

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3445/")
ARGS = [a for a in sys.argv[1:]]
REEL = "--reel" in ARGS
ARGS = [a for a in ARGS if a != "--reel"]
OUT = ARGS[0] if ARGS else r"D:\1 WORK\CONTENU\nova-plugins-design\vague2b"
TOUS = ["CHORUS", "FLANGER", "DOUBLER", "STEREOSPREADER", "DENOISER", "MASTERSYNC", "HARMONIZER", "VOICESHIFT",
        "TIMEFX", "GATEFX", "GATE", "DJFILTER", "LOFI"]
KINDS = ARGS[1:] or TOUS
os.makedirs(OUT, exist_ok=True)

# Recherche dans le menu « Ajouter un effet » (mode --reel).
RECHERCHE = {
    "CHORUS": "chorus", "FLANGER": "flanger", "DOUBLER": "doubleur", "STEREOSPREADER": "stéréo", "DENOISER": "gate de bruit",
    "MASTERSYNC": "master", "HARMONIZER": "harmoniseur", "VOICESHIFT": "voix grave", "TIMEFX": "tape stop",
    "GATEFX": "gate rythmique", "GATE": "expandeur", "DJFILTER": "filtre dj", "LOFI": "lo-fi",
}

MEASURE = """(k) => {
  const contraste = (root) => {
    const lum = (c) => { const m = c.match(/[\\d.]+/g); if (!m) return 0; const [r, g, b] = m.slice(0, 3).map(v => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bgOf = (n) => { while (n) { const c = getComputedStyle(n).backgroundColor; const m = c.match(/[\\d.]+/g); if (m && (m.length < 4 || +m[3] > 0.5)) return c; n = n.parentElement; } return 'rgb(12,13,16)'; };
    let worst = 99, txt = '';
    root.querySelectorAll('*').forEach(n => {
      if (n.closest('svg') || n.closest('.hw-sr-only') || n.closest('option') || n.tagName === 'OPTION') return;
      const t = [...n.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent.trim()).join('');
      if (!t || !n.getClientRects().length) return;
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || +cs.opacity === 0) return;
      let op = 1; for (let q = n; q && q !== root.parentElement; q = q.parentElement) op *= +getComputedStyle(q).opacity;
      if (op < 0.6) return;  // réglage grisé (désactivé) : exclu, comme WCAG
      const L1 = lum(cs.color), L2 = lum(bgOf(n));
      const r = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (r < worst) { worst = r; txt = t.slice(0, 40); }
    });
    return { contraste_min: Math.round(worst * 100) / 100, texte_le_moins_contraste: txt };
  };
  const el = document.querySelector(`[data-qa-hw] [data-nova-plugin='${k}']`) || document.querySelector('[data-qa-hw] [data-nova-plugin]') || document.querySelector('[data-qa-hw]');
  const r = el.getBoundingClientRect();
  const sc = document.querySelector('[data-qa-scroller]');
  const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? b : null; };
  const cibles = [...el.querySelectorAll('[role=slider], .hw-push, .hw-toggle-lever, .hw-pad, .hw-step, .hw-lcd-select, [role=checkbox], .hw-cta')]
    .map(n => ({ n, b: vis(n) })).filter(x => x.b);
  const petites = cibles.filter(x => Math.min(x.b.width, x.b.height) < 44)
    .map(x => (x.n.getAttribute('aria-label') || x.n.textContent || x.n.className).trim().slice(0, 24) + ` ${Math.round(x.b.width)}x${Math.round(x.b.height)}`);
  const knobs = [...el.querySelectorAll('[role=slider]')].map(vis).filter(Boolean);
  return {
    largeur: Math.round(r.width), hauteur: Math.round(r.height),
    deborde_ecran: r.right > window.innerWidth + 1 || r.left < -1,
    defilement_horizontal: !!sc && sc.scrollWidth > sc.clientWidth + 1,
    boutons_rotatifs: knobs.length,
    plus_petit_rotatif_px: knobs.length ? Math.round(Math.min(...knobs.map(b => Math.min(b.width, b.height)))) : null,
    cibles: cibles.length,
    cibles_sous_44px: petites.length, cibles_petites: petites.slice(0, 8),
    curseurs_range: el.querySelectorAll('input[type=range]').length,
    listes_select: [...el.querySelectorAll('select')].filter(s => !s.closest('.hw-lcd-select')).length,
    titre: (el.querySelector('h2') || {}).textContent || null,
    ...contraste(el),
  };
}"""


def banc():
    res = {}
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=EXE, headless=True)
        for vp, size in (("bureau", {"width": 1600, "height": 900}), ("tel", {"width": 390, "height": 844})):
            ctx = b.new_context(viewport=size, device_scale_factor=1, has_touch=(vp == "tel"))
            pg = ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            if os.environ.get("NOVA_THEME"):
                pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{os.environ['NOVA_THEME']}') }} catch (e) {{}}")
            pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(3000)
            for k in KINDS:
                pg.set_viewport_size(size)
                pg.evaluate("async ([k, m]) => { const h = await import('/qa/harness/hwPlugins2b.tsx'); return h.mountHwPlugin(k, m); }", [k, vp == "tel"])
                print(vp, k, flush=True)
                pg.locator("[data-qa-hw] [data-nova-plugin], [data-qa-hw] .nova-hosted-plugin > *").first.wait_for(timeout=20000)
                pg.wait_for_timeout(1200)
                pg.screenshot(path=os.path.join(OUT, f"{k.lower()}_{vp}.png"))
                m = pg.evaluate(MEASURE, k)
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
            pg.evaluate("async () => { const h = await import('/qa/harness/hwPlugins2b.tsx'); h.unmountHwPlugin(); }")
            res[f"erreurs_{vp}"] = errs[:5]
            ctx.close()
        b.close()
    return res


def reel():
    sys.path.insert(0, os.path.dirname(__file__))
    from qalib import launch, new_page, Log  # noqa: E402
    from scenarios import open_studio, close_welcome  # noqa: E402
    ok = True

    def close_plugin(pg):
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
        if pg.locator("[data-nova-plugin]").count():
            btn = pg.get_by_role("button", name="Fermer", exact=True)
            for i in range(btn.count() - 1, -1, -1):
                try:
                    if btn.nth(i).is_visible():
                        btn.nth(i).click(timeout=3000); pg.wait_for_timeout(500)
                        if not pg.locator("[data-nova-plugin]").count():
                            return
                except Exception:
                    pass

    def open_add_menu(pg, vp):
        if vp.startswith("tel"):
            m = pg.get_by_text("Mixer", exact=True)
            if m.count():
                m.last.click(); pg.wait_for_timeout(900)
            add = pg.get_by_role("button", name=re.compile("Ajouter un effet"))
            if add.count():
                add.first.scroll_into_view_if_needed(); add.first.click(); pg.wait_for_timeout(700); return True
            return False
        for label in ("Console", "Mixage", "Mixer"):
            t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
            if t.count() and t.first.is_visible():
                t.first.click(); pg.wait_for_timeout(1000); break
        add = pg.locator("button[aria-label^='Ajouter un effet sur']")
        if add.count():
            add.first.click(); pg.wait_for_timeout(600); return True
        return False

    def run(vp, effets):
        nonlocal ok
        res = {}
        log = Log(f"plugins_hw_vague2b_{vp}")
        with sync_playwright() as p:
            b = launch(p)
            ctx, pg = new_page(b, vp, log)
            pg.add_init_script("try { localStorage.setItem('nova_simple_mode', '0') } catch (e) {}")
            if os.environ.get("NOVA_THEME"):
                pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{os.environ['NOVA_THEME']}') }} catch (e) {{}}")
            r = {"name": f"hw2b_{vp}"}
            open_studio(pg, r, vp=vp)
            close_welcome(pg)
            pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
            for typ in effets:
                q = RECHERCHE.get(typ, typ.lower())
                e = res.setdefault(typ, {})
                if not open_add_menu(pg, vp):
                    e["erreur"] = "menu « Ajouter un effet » introuvable"; ok = False; continue
                search = pg.locator("input[aria-label='Chercher un effet']")
                if search.count():
                    search.first.fill(q); pg.wait_for_timeout(400)
                item = pg.locator("[data-testid='add-effect-menu'] [role=menuitem], [data-testid='add-effect-menu'] button").filter(has_text=re.compile(re.escape(q.split()[0]), re.I))
                if not item.count():
                    e["erreur"] = f"« {q} » absent du menu"; ok = False; pg.keyboard.press("Escape"); continue
                item.first.click(); pg.wait_for_timeout(1500)
                win = pg.locator(f"[data-nova-plugin='{typ}']")
                if not win.count():
                    chip = pg.locator(".fx-slot button[aria-label^='Ouvrir']").last
                    if chip.count(): chip.click(); pg.wait_for_timeout(1500)
                if not win.count():
                    e["erreur"] = "fenêtre non ouverte"; ok = False; pg.screenshot(path=os.path.join(OUT, f"reel_{typ.lower()}_{vp}_pas_ouverte.png")); continue
                win.first.wait_for(timeout=10000)
                pg.wait_for_timeout(700)
                pg.screenshot(path=os.path.join(OUT, f"reel_{typ.lower()}_{vp}.png"))
                e["titre"] = win.locator("h2").first.inner_text()
                e["boutons_rotatifs"] = win.locator("[role=slider]").count()
                k = win.locator("[role=slider]:not([aria-disabled='true'])").first
                if k.count():
                    before = k.get_attribute("aria-valuenow")
                    k.scroll_into_view_if_needed()
                    bx = k.bounding_box()
                    if bx:
                        x, y = bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2
                        pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x, y - 40, steps=4); pg.mouse.up()
                        pg.wait_for_timeout(200)
                    after = k.get_attribute("aria-valuenow")
                    if bx and before == after:  # déjà en butée haute : on tourne vers le bas
                        pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x, y + 40, steps=4); pg.mouse.up()
                        pg.wait_for_timeout(200)
                        after = k.get_attribute("aria-valuenow")
                    e["bouton_tourne"] = before != after
                    e["valeurs"] = [before, after]
                    e["taille_min_px"] = round(min(bx["width"], bx["height"])) if bx else None
                    if not e["bouton_tourne"]:
                        ok = False
                e["debordement_horizontal"] = pg.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('[data-nova-plugin]')].some(el => { const r = el.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; })")
                e["info"] = pg.locator("[data-nova-infobar]").first.inner_text()[:120] if pg.locator("[data-nova-infobar]").count() else None
                txt = win.first.inner_text()
                e["anglais_suspects"] = [w for w in ("Mix", "Gain", "Bypass", "Enabled", "Dry", "Wet", "Voices", "Phase Inv", "More", "Less") if re.search(rf"\b{w}\b", txt)]
                if e["debordement_horizontal"] or (vp.startswith("tel") and (e.get("taille_min_px") or 99) < 44):
                    ok = False
                close_plugin(pg)
                e["ferme"] = pg.locator(f"[data-nova-plugin='{typ}']").count() == 0
                if not e["ferme"]:
                    ok = False
            res["erreurs_page"] = [x["text"][:200] for x in log.errors()][:5]
            ctx.close(); b.close()
        return res

    out = {}
    # Par lots de 4 (un studio neuf par lot) : au téléphone, la chaîne d'une piste ne montre plus « Ajouter un effet » au-delà de quelques effets.
    for vp in ("pc", "tel390"):
        for i in range(0, len(KINDS), 4):
            out.setdefault(vp, {}).update(run(vp, KINDS[i:i + 4]))
    out["ok"] = ok
    return out


res = reel() if REEL else banc()
print(json.dumps(res, ensure_ascii=False, indent=1))
with open(os.path.join(OUT, "mesures_reel.json" if REEL else "mesures.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
if REEL:
    sys.exit(0 if res.get("ok") else 1)
