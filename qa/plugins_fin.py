"""Fin des façades « matériel » (1.5.1) : Compresseur, Stéréo, Master (analyse tempo / tonalité).

Headless (aucune fenêtre), hors production (qa_hors_prod via qalib). Chaque fenêtre est montée
seule par le banc qa/harness/hwPlugins2b.tsx (même cadre que PluginEditor), dans l'appli :
  - bureau 1366 × 768 et téléphone 390 × 844 (au doigt), thème sombre puis clair ;
  - captures (fenêtre visible + fenêtre entière) ;
  - mesures : plus de curseur « formulaire » (input range), plus de liste déroulante, plus de
    phrase d'aide sur la façade, débordement horizontal, cibles tactiles < 44 px au téléphone,
    contraste du texte HTML, boutons recouverts (qalib.balayage_chevauchement) ;
  - gestes (bureau, souris) : glisser vertical, double-clic = valeur d'origine, molette,
    clavier (Début / Fin = bornes d'avant), poussoirs, préréglages ; (téléphone) glisser au
    doigt et double tape ; ligne d'info ;
  - réglages envoyés au projet (window.__qaHwParams) : bornes et valeurs d'avant.
  La preuve « mêmes paramètres envoyés au moteur » geste par geste est dans
  tests/pluginsFin.test.ts (rejoue les gestes capturés sur les ANCIENNES fenêtres).

Usage :
  NOVA_URL=http://127.0.0.1:3421/ python qa/plugins_fin.py            (contrôles + captures « après »)
  NOVA_URL=http://127.0.0.1:3421/ python qa/plugins_fin.py --avant    (captures seules, ancien look)
  Types en argument pour un sous-ensemble : python qa/plugins_fin.py COMPRESSOR
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-151\\plugins-fin\\apres ou \\avant) : PNG + plugins_fin.json.
"""
import json, os, sys
from pathlib import Path

ARGS = sys.argv[1:]
AVANT = "--avant" in ARGS
ARGS = [a for a in ARGS if not a.startswith("--")]
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3421/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-151\plugins-fin" + ("\\avant" if AVANT else "\\apres"))
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, launch, new_page, balayage_chevauchement  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

KINDS = ARGS or ["COMPRESSOR", "STEREOSPREADER", "MASTERSYNC"]
checks = []
res = {}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


MEASURE = r"""(k) => {
  const lum = (c) => { const m = c.match(/[\d.]+/g); if (!m) return 0; const [r, g, b] = m.slice(0, 3).map(v => { v = +v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bgOf = (n) => { while (n) { const c = getComputedStyle(n).backgroundColor; const m = c.match(/[\d.]+/g); if (m && (m.length < 4 || +m[3] > 0.5)) return c; n = n.parentElement; } return 'rgb(12,13,16)'; };
  const root = document.querySelector('[data-qa-hw]');
  const el = root.querySelector(`[data-nova-plugin='${k}']`) || root.querySelector('.nova-hosted-plugin > *') || root;
  let worst = 99, txt = '';
  el.querySelectorAll('*').forEach(n => {
    if (n.closest('svg') || n.closest('.hw-sr-only') || n.tagName === 'OPTION' || n.closest('canvas')) return;
    const t = [...n.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent.trim()).join('');
    if (!t || !n.getClientRects().length) return;
    const cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) return;
    let op = 1; for (let q = n; q && q !== el.parentElement; q = q.parentElement) op *= +getComputedStyle(q).opacity;
    if (op < 0.6) return;  // réglage grisé (désactivé) : exclu, comme WCAG
    const r = (Math.max(lum(cs.color), lum(bgOf(n))) + 0.05) / (Math.min(lum(cs.color), lum(bgOf(n))) + 0.05);
    if (r < worst) { worst = r; txt = t.slice(0, 40); }
  });
  const r = el.getBoundingClientRect();
  const sc = document.querySelector('[data-qa-scroller]');
  const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? b : null; };
  const cibles = [...el.querySelectorAll('[role=slider], .hw-push, .hw-toggle-lever, .hw-pad, .hw-lcd-select, [role=checkbox], .hw-cta, .hw-chip, button')]
    .filter(n => !n.closest('.hw-toggle-lever') || n.classList.contains('hw-toggle-lever'))
    .map(n => ({ n, b: vis(n) })).filter(x => x.b);
  const petites = cibles.filter(x => Math.min(x.b.width, x.b.height) < 44)
    .map(x => (x.n.getAttribute('aria-label') || x.n.textContent || x.n.className).trim().slice(0, 24) + ` ${Math.round(x.b.width)}x${Math.round(x.b.height)}`);
  const face = el.querySelector('.hw-face') || el;
  const phrases = [...face.querySelectorAll('p, span, div')].filter(n => {
    if (n.closest('[role=status]') || n.closest('[aria-live]') || n.closest('.hw-screen') || n.closest('.hw-lcd') || n.closest('.hw-face-head')) return false;
    const t = [...n.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent.trim()).join(' ');
    return t.split(/\s+/).length >= 8 && n.getClientRects().length;
  }).map(n => n.textContent.trim().slice(0, 60));
  const knobs = [...el.querySelectorAll('[role=slider]')].map(vis).filter(Boolean);
  return {
    plugin: el.getAttribute('data-nova-plugin'),
    largeur: Math.round(r.width), hauteur: Math.round(r.height),
    deborde_ecran: r.right > innerWidth + 1 || r.left < -1,
    defilement_horizontal: (!!sc && sc.scrollWidth > sc.clientWidth + 1) || document.documentElement.scrollWidth > innerWidth + 1,
    boutons_rotatifs: knobs.length,
    plus_petit_rotatif_px: knobs.length ? Math.round(Math.min(...knobs.map(b => Math.min(b.width, b.height)))) : null,
    cibles: cibles.length, cibles_sous_44px: petites.length, cibles_petites: petites.slice(0, 8),
    curseurs_range: [...el.querySelectorAll('input[type=range]')].filter(i => !i.classList.contains('hw-sr-only')).length,
    listes_select: [...el.querySelectorAll('select')].filter(s => !s.closest('.hw-lcd-select')).length,
    phrases_aide_facade: phrases,
    infobar: !!el.querySelector('[data-nova-infobar]'),
    titre: (el.querySelector('h2') || {}).textContent || null,
    mots_anglais: ['MONO SAFE', 'GOOD', 'WIDE', 'PHASE ISSUE', 'More', 'Less', 'Multi-Band', 'Mono Bass', 'Haas', 'Active', 'Bypass', 'MINOR', 'MAJOR', 'NOT DETECTED', 'Appliquer Tout', 'Full-Range', 'Low Width']
      .filter(w => (el.innerText || '').includes(w)),
    contraste_min: Math.round(worst * 100) / 100, texte_le_moins_contraste: txt,
  };
}"""


def mount(pg, kind, mobile):
    pg.evaluate("async ([k, m]) => { const h = await import('/qa/harness/hwPlugins2b.tsx'); return h.mountHwPlugin(k, m); }", [kind, mobile])
    pg.locator("[data-qa-hw] [data-nova-plugin], [data-qa-hw] .nova-hosted-plugin > *").first.wait_for(timeout=20000)
    pg.wait_for_timeout(900)


def params(pg):
    return pg.evaluate("() => ({ ...(window.__qaHwParams || {}) })")


def knob(pg, pid):
    return pg.locator(f"[data-qa-hw] [data-nova-param='{pid}'] [role=slider]").first


def captures(pg, kind, vp, theme, size):
    tag = f"{kind.lower()}_{vp}_{theme}"
    pg.screenshot(path=str(OUT / f"{tag}.png"))
    m = pg.evaluate(MEASURE, kind)
    m["chevauchement"] = balayage_chevauchement(pg, "[data-qa-hw]")
    pg.evaluate("() => { const s = document.createElement('style'); s.id = 'qa-hw-entier'; s.textContent = '.hw-window{max-height:none!important}.hw-window-body{overflow:visible!important}'; document.head.appendChild(s); }")
    hh = pg.evaluate("() => { const el = document.querySelector('[data-qa-hw] [data-nova-plugin]') || document.querySelector('[data-qa-hw] .nova-hosted-plugin'); return el ? Math.ceil(el.getBoundingClientRect().height) : 0; }")
    full_h = int(hh) + (140 if vp == "bureau" else 90)
    m["hauteur_contenu"] = hh
    if full_h > size["height"]:
        pg.set_viewport_size({"width": size["width"], "height": full_h})
        pg.wait_for_timeout(400)
        pg.screenshot(path=str(OUT / f"{tag}_entier.png"))
        pg.set_viewport_size(size)
    pg.evaluate("() => document.getElementById('qa-hw-entier')?.remove()")
    return m


def checks_facade(kind, vp, theme, m):
    t = f"{kind} {vp} {theme}"
    check(f"{t} : façade matériel (data-nova-plugin, titre, ligne d'info)", m["plugin"] == kind and m["titre"] and m["infobar"], m)
    check(f"{t} : aucun curseur « formulaire » ni liste déroulante", m["curseurs_range"] == 0 and m["listes_select"] == 0, m)
    check(f"{t} : aucune phrase d'aide sur la façade (aide = infobulle + ligne d'info)", not m["phrases_aide_facade"], m["phrases_aide_facade"])
    check(f"{t} : aucun mot anglais de l'ancienne fenêtre", not m["mots_anglais"], m["mots_anglais"])
    check(f"{t} : pas de débordement horizontal", not m["deborde_ecran"] and not m["defilement_horizontal"], m)
    check(f"{t} : aucun bouton recouvert", not m["chevauchement"].get("recouverts"), m["chevauchement"])
    check(f"{t} : contraste du texte ≥ 4,5:1", m["contraste_min"] >= 4.5, [m["contraste_min"], m["texte_le_moins_contraste"]])
    if vp == "tel":
        check(f"{t} : cibles ≥ 44 px au doigt", m["cibles_sous_44px"] == 0, m["cibles_petites"])


def drag(pg, k, dy):
    k.scroll_into_view_if_needed()
    bx = k.bounding_box()
    x, y = bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2
    pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x, y - dy, steps=5); pg.mouse.up()
    pg.wait_for_timeout(150)
    return x, y


def gestes_souris(pg, kind):
    """Gestes communs à tous les boutons : glisser, double-clic, molette, clavier."""
    first = {"COMPRESSOR": ("threshold", -18, -60, 0), "STEREOSPREADER": ("width", 1, 0, 2)}.get(kind)
    if not first:
        return
    pid, dflt, lo, hi = first
    k = knob(pg, pid)
    v0 = params(pg).get(pid, None)
    before = float(k.get_attribute("aria-valuenow"))
    x, y = drag(pg, k, 40)
    v1 = params(pg).get(pid)
    check(f"{kind} : glisser vers le haut augmente « {pid} » (projet mis à jour)", v1 is not None and v1 > before, [v0, before, v1])
    k.dblclick(); pg.wait_for_timeout(150)
    check(f"{kind} : double-clic = valeur d'origine ({dflt})", params(pg).get(pid) == dflt, params(pg).get(pid))
    pg.mouse.move(x, y); pg.mouse.wheel(0, -100); pg.wait_for_timeout(150)
    check(f"{kind} : molette vers le haut augmente", (params(pg).get(pid) or -1e9) > dflt, params(pg).get(pid))
    k.focus(); pg.keyboard.press("End"); pg.wait_for_timeout(80)
    hi_v = params(pg).get(pid)
    pg.keyboard.press("Home"); pg.wait_for_timeout(80)
    lo_v = params(pg).get(pid)
    check(f"{kind} : bornes d'avant au clavier (Début / Fin = {lo} / {hi})", hi_v == hi and lo_v == lo, [lo_v, hi_v])
    # Ligne d'info : nom + valeur du réglage survolé.
    pg.mouse.move(x, y); pg.wait_for_timeout(150)
    info = pg.locator("[data-qa-hw] [data-nova-infobar]").first.inner_text()
    check(f"{kind} : la ligne d'info décrit le réglage survolé", len(info) > 10 and any(w in info for w in ("Seuil", "Largeur")), info)
    k.dblclick(); pg.wait_for_timeout(100)


def gestes_specifiques(pg, kind):
    if kind == "COMPRESSOR":
        pg.locator("[data-qa-hw] [data-nova-preset='Vocal Smooth']").click(); pg.wait_for_timeout(150)
        p = params(pg)
        check("COMPRESSOR : préréglage « Voix douce » (mêmes valeurs qu'avant)", p.get("threshold") == -20 and p.get("ratio") == 3 and p.get("knee") == 20 and p.get("mode") == "OPTO" and p.get("scHpFreq") == 100, p)
        pg.locator("[data-qa-hw] [data-nova-param='mode'] [role=radio]", has_text="FET").click(); pg.wait_for_timeout(100)
        check("COMPRESSOR : caractère FET (poussoir)", params(pg).get("mode") == "FET", params(pg).get("mode"))
        auto = pg.locator("[data-qa-hw] [data-nova-param='autoMakeup'] [role=checkbox]").first
        auto.click(); pg.wait_for_timeout(100)
        mk = knob(pg, "makeupGain")
        check("COMPRESSOR : « Gain auto » enfoncé → bouton Sortie grisé", params(pg).get("autoMakeup") is True and mk.get_attribute("aria-disabled") == "true", [params(pg).get("autoMakeup"), mk.get_attribute("aria-disabled")])
        auto.click(); pg.wait_for_timeout(100)
        k = knob(pg, "ratio"); k.focus(); pg.keyboard.press("End")
        check("COMPRESSOR : ratio jusqu'à 20:1 (borne d'avant)", params(pg).get("ratio") == 20, params(pg).get("ratio"))
        t1 = pg.locator("[data-qa-hw] [data-nova-gr-vu] svg g[transform]").last.get_attribute("transform")
        pg.wait_for_timeout(500)
        t2 = pg.locator("[data-qa-hw] [data-nova-gr-vu] svg g[transform]").last.get_attribute("transform")
        check("COMPRESSOR : l'aiguille du VU de réduction bouge", t1 != t2, [t1, t2])
    elif kind == "STEREOSPREADER":
        low = knob(pg, "lowWidth")
        check("STEREOSPREADER : largeurs par bande grisées hors « 3 bandes »", low.get_attribute("aria-disabled") == "true", low.get_attribute("aria-disabled"))
        pg.locator("[data-qa-hw] [data-nova-param='multiBand'] [role=checkbox]").first.click(); pg.wait_for_timeout(120)
        check("STEREOSPREADER : « 3 bandes » enfoncé → largeurs par bande actives", params(pg).get("multiBand") is True and low.get_attribute("aria-disabled") is None, [params(pg).get("multiBand"), low.get_attribute("aria-disabled")])
        low.focus(); pg.keyboard.press("End")
        check("STEREOSPREADER : largeur des graves jusqu'à 200 % (borne d'avant)", params(pg).get("lowWidth") == 2, params(pg).get("lowWidth"))
        mono = pg.locator("[data-qa-hw] [data-nova-param='safeMonoBass'] [role=checkbox]").first
        check("STEREOSPREADER : « Graves en mono » allumé comme le moteur (par défaut)", mono.get_attribute("aria-checked") == "true", mono.get_attribute("aria-checked"))
        mono.click(); pg.wait_for_timeout(100)
        check("STEREOSPREADER : un clic coupe « Graves en mono » (projet mis à jour)", params(pg).get("safeMonoBass") is False, params(pg).get("safeMonoBass"))
        k = knob(pg, "balance"); k.focus(); pg.keyboard.press("Home")
        check("STEREOSPREADER : balance tout à gauche = −1 (borne d'avant)", params(pg).get("balance") == -1, params(pg).get("balance"))
        r1 = pg.locator("[data-qa-hw] [data-nova-corr]").first.inner_text()
        pg.wait_for_timeout(600)
        r2 = pg.locator("[data-qa-hw] [data-nova-corr]").first.inner_text()
        check("STEREOSPREADER : compatibilité mono affichée en direct (LCD)", bool(r1.strip()) and r1 != r2 or "," in r1, [r1, r2])
    elif kind == "MASTERSYNC":
        lcd = pg.locator("[data-qa-hw] [data-nova-sync='bpm']").first
        check("MASTERSYNC : tempo détecté sur l'afficheur", "142" in lcd.inner_text(), lcd.inner_text())
        key = pg.locator("[data-qa-hw] [data-nova-sync='key']").first.inner_text()
        check("MASTERSYNC : tonalité en français (« mineur »)", "mineur" in key.lower(), key)
        pg.get_by_role("button", name="Réinitialiser l'analyse").click(); pg.wait_for_timeout(400)
        go = pg.locator("[data-qa-hw] [data-nova-sync='analyse']").first
        check("MASTERSYNC : après réinitialisation, gros bouton « Analyser l'instru »", go.is_visible() and go.is_enabled(), go.inner_text() if go.count() else None)
        appl = pg.locator("[data-qa-hw] [data-nova-sync='appliquer']").first
        check("MASTERSYNC : « Tout appliquer » grisé tant qu'il n'y a pas d'analyse", appl.is_disabled(), appl.is_disabled())


def gestes_doigt(pg, ctx, kind):
    pid = {"COMPRESSOR": "threshold", "STEREOSPREADER": "width"}.get(kind)
    if not pid:
        return
    k = knob(pg, pid)
    k.scroll_into_view_if_needed()
    pg.wait_for_timeout(200)
    bx = k.bounding_box()
    x, y = bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2
    before = float(k.get_attribute("aria-valuenow"))
    cdp = ctx.new_cdp_session(pg)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, 7):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - i * 10}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    pg.wait_for_timeout(200)
    v = params(pg).get(pid)
    check(f"{kind} téléphone : glisser au doigt règle « {pid} »", v is not None and v > before, [before, v])
    for _ in range(2):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        pg.wait_for_timeout(60)
    pg.wait_for_timeout(150)
    dflt = {"threshold": -18, "width": 1}[pid]
    check(f"{kind} téléphone : double tape = valeur d'origine", params(pg).get(pid) == dflt, params(pg).get(pid))
    check(f"{kind} téléphone : bouton rotatif ≥ 44 px", min(bx["width"], bx["height"]) >= 44, [bx["width"], bx["height"]])


with sync_playwright() as p:
    b = launch(p)
    for theme in ("dark", "light"):
        for vp, qvp in (("bureau", "pc1366"), ("tel", "tel390")):
            log = Log(f"plugins_fin_{vp}_{theme}")
            ctx, pg = new_page(b, qvp, log)
            pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
            size = qalib.VIEWPORTS[qvp]
            pg.goto(BASE, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(3000)
            for kind in KINDS:
                mount(pg, kind, vp == "tel")
                print(theme, vp, kind, flush=True)
                m = captures(pg, kind, vp, theme, size)
                res[f"{kind}_{vp}_{theme}"] = m
                if AVANT:
                    continue
                checks_facade(kind, vp, theme, m)
                if theme == "dark" and vp == "bureau":
                    gestes_souris(pg, kind)
                    gestes_specifiques(pg, kind)
                    pg.screenshot(path=str(OUT / f"{kind.lower()}_bureau_dark_apres_gestes.png"))
                if theme == "light" and vp == "tel":
                    gestes_doigt(pg, ctx, kind)
            pg.evaluate("async () => { const h = await import('/qa/harness/hwPlugins2b.tsx'); h.unmountHwPlugin(); }")
            errs = [e["text"][:200] for e in log.errors() if "Failed to load resource" not in e["text"]]
            res[f"erreurs_{vp}_{theme}"] = errs[:8]
            if not AVANT:
                check(f"{vp} {theme} : aucune erreur de page", not errs, errs[:5])
            ctx.close()
    b.close()

res["checks"] = checks
ok = all(c["ok"] for c in checks)
res["ok"] = ok
(OUT / "plugins_fin.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{sum(c['ok'] for c in checks)}/{len(checks)} contrôles OK" if checks else "captures seules (--avant)")
sys.exit(0 if ok else 1)
