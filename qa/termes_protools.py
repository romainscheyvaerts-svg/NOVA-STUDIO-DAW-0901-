"""Termes Pro Tools (READ, SHUF / SLIP / SPOT / GRID, Strip Silence, QP, PDC…) : constat R2.

Règle : en mode avancé, les sigles restent (parité Pro Tools) mais chaque bouton qui
les affiche a une infobulle en français ; en mode simple, aucun sigle : le libellé
français (« Libre / Grille », « Supprimer les silences », « Lecture »…).

Navigateur headless, aucune fenêtre. PC (1600 × 900) et téléphone, modes simple et
avancé : arrangement, console, menu du clip du beat (clic droit), fenêtre « Supprimer
les silences ». Chaque élément visible qui affiche un terme est relevé avec son infobulle.

Usage : NOVA_URL=http://127.0.0.1:3441/ python qa/termes_protools.py [pc] [tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions-3\\termes_*.png / termes_protools.json
"""
import json, os, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-finitions-3")
from qalib import launch, new_page, Log, BASE, OUT, menu_open_for  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

INIT = ("try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0');"
        " localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '{simple}'); } catch (e) {}")

# Termes Pro Tools affichés tels quels (sigles et mots anglais du métier).
TERMS = r"\b(SHUF|SLIP|SPOT|GRID|REL|QP|PDC|PUNCH|PRÉ|POST|READ|TCH|LTCH|WRT|TRIM|Shuffle|Slip|Spot|Grid|Read|Touch|Latch|Write|Trim|Strip Silence|QuickPunch|Nudge|Playlists?|Tab to Transient|Memory Locations|Sync Point)\b"

SCAN_JS = r"""(terms) => {
  const re = new RegExp(terms);
  const vis = el => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const out = [];
  for (const el of document.querySelectorAll('button, [role=button], [role=radio], [role=menuitem], [role=menuitemradio], [role=tab], h2, h3, label, [role=status]')) {
    if (!vis(el)) continue;
    const txt = (el.innerText || '').trim().replace(/\s+/g, ' ');
    const m = txt.match(re);
    if (!m) continue;
    // Infobulle : la sienne, ou celle d'un parent proche (groupe de boutons).
    let tip = el.getAttribute('title') || '', p = el.parentElement, up = 0;
    while (!tip && p && up < 2) { tip = p.getAttribute('title') || ''; p = p.parentElement; up++; }
    const aria = el.getAttribute('aria-label') || '';
    out.push({ terme: m[1], texte: txt.slice(0, 60), infobulle: tip.slice(0, 160), aria: aria.slice(0, 80) });
  }
  return out;
}"""

FR = re.compile(r"\b(le|la|les|un|une|des|du|de|à|au|sur|pour|avec|tant|que|qui|ne|pas|dans|piste|clip|clips|lecture|enregistre)\b", re.I)


def ouvrir(pg):
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=45000)
    pg.get_by_text("NOCTAMBULE", exact=True).first.click()
    pg.wait_for_timeout(1200)
    close_welcome(pg)
    wait_text_gone(pg, "Chargement", 60)
    pg.wait_for_timeout(1500)
    close_welcome(pg)


def bilan(items, simple):
    """Élément fautif : en simple, tout terme affiché ; en avancé, un terme sans infobulle française."""
    bad = []
    for it in items:
        if it["terme"] == "-":
            continue
        if simple:
            bad.append(it)
        elif not (it["infobulle"] and FR.search(it["infobulle"])):
            bad.append(it)
    return bad


def run(vps):
    res = {"ok": True, "ecrans": {}}
    with sync_playwright() as p:
        b = launch(p)
        for vp in vps:
            for simple in (True, False):
                name = f"{vp}_{'simple' if simple else 'avance'}"
                log = Log(name)
                ctx, pg = new_page(b, vp, log)
                pg.add_init_script(INIT.replace("{simple}", "1" if simple else "0"))
                ouvrir(pg)
                ecrans = {}
                pg.screenshot(path=str(OUT / f"termes_{name}_1_pistes.png"))
                ecrans["pistes"] = pg.evaluate(SCAN_JS, TERMS)
                # Menu du clip du beat (clic droit ; appui long au doigt n'est pas rejoué ici).
                if vp == "pc":
                    name_t = pg.evaluate("""() => { const t = (window.__novaEdit?.getState().tracks || []).find(t => (t.clips || []).some(c => !c.notes && c.duration > 3));
                      return t ? t.name : null; }""")
                    if name_t:
                        head = pg.locator(".nova-grille").get_by_text(name_t, exact=True).first
                        hb = head.bounding_box()
                        box = pg.evaluate("""() => { const c = (document.querySelector('.nova-grille canvas[data-tracks-top]') || document.querySelectorAll('.nova-grille canvas')[1]); const r = c.getBoundingClientRect();
                          const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, sl: sc ? sc.scrollLeft : 0 }; }""")
                        def menu_clip():
                            pg.mouse.click(box["x"] + 3 * 40 - box["sl"], hb["y"] + hb["height"] / 2 + 4, button="right"); pg.wait_for_timeout(400)
                        menu_clip()
                        pg.screenshot(path=str(OUT / f"termes_{name}_2_menu_clip.png"))
                        ecrans["menu_clip"] = pg.evaluate(SCAN_JS, TERMS)
                        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
                        for cle, rx, shot in (("fenetre_silences", r"(Strip Silence|Supprimer les silences)", "3_silences"), ("fenetre_spot", r"^Position exacte", "3b_spot")):
                            menu_clip()
                            menu_open_for(pg, re.compile(rx))  # sous-menu « Édition »
                            item = pg.get_by_text(re.compile(rx)).first
                            if item.count() and item.is_visible():
                                item.click(); pg.wait_for_timeout(600)
                                pg.screenshot(path=str(OUT / f"termes_{name}_{shot}.png"))
                                ecrans[cle] = pg.evaluate(SCAN_JS, TERMS)
                            pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
                # Console
                tab = pg.get_by_role("button", name=re.compile(r"^Console$", re.I)).locator("visible=true").first
                if tab.count():
                    tab.click(); pg.wait_for_timeout(800)
                    pg.screenshot(path=str(OUT / f"termes_{name}_4_console.png"))
                    ecrans["console"] = pg.evaluate(SCAN_JS, TERMS)
                fautifs = {k: bilan(v, simple) for k, v in ecrans.items()}
                fautifs = {k: v for k, v in fautifs.items() if v}
                res["ecrans"][name] = {"releves": ecrans, "fautifs": fautifs, "erreurs_console": [e["text"][:200] for e in log.errors()]}
                if fautifs:
                    res["ok"] = False
                print(name, "OK" if not fautifs else json.dumps(fautifs, ensure_ascii=False)[:1500], flush=True)
                ctx.close()
    (OUT / "termes_protools.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")
    return res


if __name__ == "__main__":
    run([v for v in sys.argv[1:] if v in ("pc", "tab", "tel")] or ["pc", "tel"])
