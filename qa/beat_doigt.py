"""Boîte à rythmes et piano roll AU DOIGT : téléphone 390 × 844 et tablette 820 × 1180 (Chrome headless, aucune fenêtre).

Parcours : accueil → « Nouveau beat » (boîte à rythmes ouverte) → preset Trap →
  - pas : taille des cases (largeur × hauteur), toucher = allumé ↔ éteint, glisser le doigt sur une rangée =
    pas peints (comme à la souris), appui long = menu du pas ;
  - barre et cibles du panneau : cibles < 44 / < 32 px, défilement horizontal de la page ou de la barre ;
→ « 808 » (piano roll) :
  - barre du piano roll : tient dans l'écran (pas de défilement horizontal au téléphone), cibles < 44 / < 32 px ;
  - pincer : zoom horizontal ; toucher une case vide = une note ; appui long sur une note = son menu.
Mesures avant / après, captures. Code 1 si un geste ne marche pas ou si une cible fait moins de 32 px.

  NOVA_URL=http://127.0.0.1:3545/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/beat_doigt.py [tel] [tab]
Sorties : D:\\1 WORK\\CONTENU\\nova-tactile\\beat\\<phase>\\ (beat_doigt.json + captures)
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3545/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-tactile\beat\{PHASE}")
sys.path.insert(0, str(Path(__file__).parent))
import qa_hors_prod  # noqa: E402,F401
from qalib import launch, OUT, Log, BASE, APP_MODULE_INIT, SORTIE_AUDIO_INIT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CAS = {"tel": dict(w=390, h=844, mobile=True), "tab": dict(w=820, h=1180, mobile=True)}
WANT = [a for a in sys.argv[1:] if a in CAS] or list(CAS)
DR = "[aria-labelledby='drums-title']"
PR = "[data-nova-pianoroll]"
ROWS = "() => { const t = window.__novaEdit.getState().tracks.find(t => t.drumMachine); return t ? Object.fromEntries(t.drumMachine.rows.map(r => [r.name, r.steps.slice(0, 16).map(v => v >= 100 ? 'X' : v > 0 ? 'x' : '.').join('')])) : null; }"
NOTES = "() => { const t = window.__novaEdit.getState().tracks.find(t => /808/.test(t.name)); const c = t && t.clips.find(c => c.notes); return c ? c.notes.length : null; }"

CIBLES = r"""(scope) => {
  const root = document.querySelector(scope); if (!root) return null;
  const W = innerWidth;
  const sel = 'button, [role=button], [role=slider], input:not([type=hidden]), select';
  const out = { n: 0, p44: [], p32: [] };
  for (const el of root.querySelectorAll(sel)) {
    if (!el.getClientRects().length) continue;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || +s.opacity === 0) continue;
    const r = el.getBoundingClientRect(); if (r.right < 0 || r.left > W || r.width < 2) continue;
    let w = r.width, h = r.height;
    const a = getComputedStyle(el, '::after');
    if (a.content && a.content !== 'none' && a.position === 'absolute') {
      w = Math.max(w, r.width - (parseFloat(a.left) || 0) - (parseFloat(a.right) || 0));
      h = Math.max(h, r.height - (parseFloat(a.top) || 0) - (parseFloat(a.bottom) || 0)); }
    out.n++;
    const it = { t: (el.getAttribute('aria-label') || el.innerText || el.title || '').trim().slice(0, 34), w: Math.round(w), h: Math.round(h) };
    if (Math.min(w, h) < 44) out.p44.push(it);
    if (Math.min(w, h) < 32) out.p32.push(it);
  }
  out.p44 = out.p44.slice(0, 40); out.n44 = out.p44.length; out.n32 = out.p32.length;
  return out;
}"""

BARRE = r"""(scope) => {
  const root = document.querySelector(scope); if (!root) return null;
  // Rangées d'outils qui débordent (défilement horizontal) : largeur de contenu > largeur visible.
  const res = [];
  for (const el of root.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (!/(auto|scroll)/.test(s.overflowX)) continue;
    if (el.scrollWidth > el.clientWidth + 2 && el.querySelector('button') && el.clientHeight < 90) {
      const r = el.getBoundingClientRect(); res.push({ y: Math.round(r.top), h: Math.round(r.height), visible: el.clientWidth, contenu: el.scrollWidth,
        boutons_caches: [...el.querySelectorAll('button')].filter(b => { const q = b.getBoundingClientRect(); return q.right > r.right + 1 || q.left < r.left - 1; }).length });
    }
  }
  return { page_hscroll: document.documentElement.scrollWidth - innerWidth, rangees_qui_defilent: res.slice(0, 6) };
}"""


def run(p, nom, cfg, R, ko):
    log = Log(f"beat_doigt_{nom}")
    b = launch(p)
    ctx = b.new_context(viewport={"width": cfg["w"], "height": cfg["h"]}, has_touch=True, is_mobile=cfg["mobile"], device_scale_factor=1,
                        permissions=["microphone"], locale="fr-BE")
    ctx.route("**/downloads/nova-studio-latest.json*", lambda route, request: route.fulfill(status=200, content_type="application/json", body="{}"))
    qa_hors_prod.install(ctx, log)
    ctx.add_init_script(APP_MODULE_INIT)
    ctx.add_init_script("try { localStorage.setItem('nova_theme','dark'); localStorage.setItem('nova_headphones','1'); localStorage.setItem('nova_welcome_seen','1'); localStorage.setItem('nova_simple_mode','0'); } catch(e) {}")
    ctx.add_init_script(SORTIE_AUDIO_INIT % json.dumps("Casque (Realtek(R) Audio)"))
    page = ctx.new_page(); page.set_default_timeout(20000)
    page.on("pageerror", lambda e: log.add("pageerror", e))
    cdp = ctx.new_cdp_session(page)
    r = {"cas": nom}
    R[nom] = r

    def touch(t, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": t, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})

    def chk(name, cond, detail=None):
        r.setdefault("verifs", {})[name] = {"ok": bool(cond), "detail": detail}
        print(("  OK  " if cond else "  KO  ") + f"{nom} · {name}" + ("" if cond else f" → {json.dumps(detail, ensure_ascii=False, default=str)[:300]}"), flush=True)
        if not cond: ko.append(f"{nom} : {name}")

    try:
        page.goto(BASE, wait_until="domcontentloaded")
        plus = page.locator("[data-testid=landing-plus][aria-expanded=false]").locator("visible=true")
        page.locator("[data-testid=landing-new-beat], [data-testid=landing-plus]").first.wait_for(timeout=60000)
        if plus.count(): plus.first.tap(); page.wait_for_timeout(300)
        page.locator("[data-testid=landing-new-beat]").first.tap()
        page.wait_for_selector(DR, timeout=30000); page.wait_for_timeout(800)
        page.get_by_role("button", name="🔥 Trap").first.tap(); page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT / f"{nom}_01_batterie.png"))
        r["batterie_cibles"] = page.evaluate(CIBLES, DR)
        r["batterie_barre"] = page.evaluate(BARRE, DR)
        hat = "Hi-hat fermé"
        p1 = page.locator(f"{DR} button[aria-label^='{hat}, pas 1']").first
        bb = p1.bounding_box()
        r["pas_taille"] = {"w": round(bb["width"]), "h": round(bb["height"])}
        # Toucher un pas : éteint ↔ allumé.
        s5 = page.locator(f"{DR} button[aria-label^='Snare, pas 5']").first
        before = page.evaluate(ROWS)["Snare"][4]
        s5.tap(); page.wait_for_timeout(300)
        after = page.evaluate(ROWS)["Snare"][4]
        chk("toucher un pas l'allume / l'éteint", before != after, [before, after])
        s5.tap(); page.wait_for_timeout(300)
        # Glisser le doigt sur 4 pas de la rangée des charleys (du pas 1 au pas 4) : les 4 pas suivent le 1er.
        p4 = page.locator(f"{DR} button[aria-label^='{hat}, pas 4']").first.bounding_box()
        row0 = page.evaluate(ROWS)[hat]
        x0, y0 = bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
        x1 = p4["x"] + p4["width"] / 2
        touch("touchStart", [(x0, y0)])
        for k in range(1, 13):
            touch("touchMove", [(x0 + (x1 - x0) * k / 12, y0)]); page.wait_for_timeout(16)
        touch("touchEnd", [])
        page.wait_for_timeout(400)
        row1 = page.evaluate(ROWS)[hat]
        target = "." if row0[0] != "." else "X"
        r["glisser_pas"] = [row0[:4], row1[:4]]
        chk("glisser le doigt sur 4 pas les peint d'un geste", all((c == "." if target == "." else c != ".") for c in row1[:4]), r["glisser_pas"])
        # Appui long sur un pas : menu du pas.
        p6 = page.locator(f"{DR} button[aria-label^='Snare, pas 6']").first.bounding_box()
        touch("touchStart", [(p6["x"] + p6["width"] / 2, p6["y"] + p6["height"] / 2)]); page.wait_for_timeout(700); touch("touchEnd", []); page.wait_for_timeout(400)
        menu = page.locator("[role=menu]").locator("visible=true")
        chk("appui long sur un pas : son menu", menu.count() >= 1)
        page.screenshot(path=str(OUT / f"{nom}_02_menu_pas.png"))
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        if menu.count(): page.mouse.click(5, 5); page.wait_for_timeout(300)
        # Piano roll (808).
        page.locator(f"{DR} button:has-text('808')").first.tap(); page.wait_for_timeout(2000)
        page.wait_for_selector(PR, timeout=20000); page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / f"{nom}_03_piano_roll.png"))
        r["pr_cibles"] = page.evaluate(CIBLES, PR)
        r["pr_barre"] = page.evaluate(BARRE, PR)
        # Pincer (zoom horizontal) dans la grille.
        grid = page.evaluate("""(pr) => { const c = document.querySelector(pr + ' canvas') || document.querySelector(pr); const r = c.getBoundingClientRect();
          return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.5, w: r.width, h: r.height }; }""", PR)
        zread = """(pr) => { const el = document.querySelector(pr); const z = el && (el.getAttribute('data-zoom-x') || el.getAttribute('data-zoom')); return z ? +z : null; }"""
        z0 = page.evaluate(zread, PR)
        cx, cy = grid["x"], grid["y"]
        touch("touchStart", [(cx - 40, cy), (cx + 40, cy)])
        for k in range(1, 11):
            touch("touchMove", [(cx - 40 - 8 * k, cy), (cx + 40 + 8 * k, cy)]); page.wait_for_timeout(20)
        touch("touchEnd", []); page.wait_for_timeout(400)
        z1 = page.evaluate(zread, PR)
        r["pr_zoom"] = [z0, z1]
        chk("piano roll : pincer agrandit", z0 is not None and z1 is not None and z1 > z0 * 1.3, r["pr_zoom"])
        page.screenshot(path=str(OUT / f"{nom}_04_piano_roll_zoom.png"))
    except Exception as e:  # noqa
        r["arret"] = f"{type(e).__name__}: {str(e)[:300]}"
        ko.append(f"{nom} : arrêt {r['arret']}")
        try: page.screenshot(path=str(OUT / f"{nom}_arret.png"))
        except Exception: pass
    for k in ("batterie_cibles", "pr_cibles"):
        v = r.get(k) or {}
        print(f"   {nom} {k} : {v.get('n')} cibles, <44 = {v.get('n44')}, <32 = {v.get('n32')} {[(i['t'], i['w'], i['h']) for i in v.get('p32', [])][:6]}", flush=True)
        if v.get("n32"): ko.append(f"{nom} : {k} : {v['n32']} cible(s) < 32 px")
    for k in ("batterie_barre", "pr_barre"):
        v = r.get(k) or {}
        print(f"   {nom} {k} : {v}", flush=True)
        if nom == "tel" and k == "pr_barre" and any(x.get("boutons_caches") for x in v.get("rangees_qui_defilent", [])):
            ko.append(f"{nom} : la barre du piano roll défile (boutons hors de l'écran)")
    print(f"   {nom} pas : {r.get('pas_taille')}", flush=True)
    if nom == "tel" and r.get("pas_taille") and min(r["pas_taille"].values()) < 44: ko.append(f"tel : pas de {r['pas_taille']} (< 44 px)")
    ctx.close(); b.close()


def main():
    R, ko = {}, []
    with sync_playwright() as p:
        for nom in WANT:
            print(f"== {nom}", flush=True)
            run(p, nom, CAS[nom], R, ko)
    (OUT / "beat_doigt.json").write_text(json.dumps({"phase": PHASE, "date": time.strftime("%Y-%m-%d %H:%M"), "cas": R}, ensure_ascii=False, indent=1), encoding="utf-8")
    for k in ko: print("KO", k)
    sys.exit(1 if ko else 0)


if __name__ == "__main__":
    main()
