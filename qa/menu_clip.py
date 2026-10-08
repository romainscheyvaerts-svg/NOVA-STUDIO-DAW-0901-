"""Menu contextuel du clip regroupé en sous-menus : taille, ordre, souris / clavier / doigt.

Mesure, sur un vrai projet (voix + beat, r1_export) :
- PC 1600 × 900 (souris) : hauteur du menu, nombre d'entrées au 1er niveau, sous-menus
  (Édition, Gain et fondus, Hauteur et temps, Voix, Traitement, MIDI), ouverture au survol ;
- clavier : ↓ jusqu'à « Voix », → ouvre, ↓ Entrée lance « Respirations… », ← et Échap ;
- tablette 1024 × 768 (doigt) : appui long sur le clip, toucher « Traitement », toucher une entrée ;
- téléphone 390 × 844 (doigt) : le sous-menu s'ouvre à la place du menu (‹ Retour) ;
- même ordre des sous-menus pour un clip audio et un clip MIDI.
Chrome headless (aucune fenêtre), compte simulé, aucune écriture externe.

NOVA_URL=http://127.0.0.1:3492/ PYTHONIOENCODING=utf-8 python qa/menu_clip.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro2\\point2\\ (menu_clip.json + captures)
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3492/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro2\point2")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, menu_open_for, menu_pick  # noqa: E402
from nova_pro_lib import track_point  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split("\nwith sync_playwright() as p:")[0]
exec(compile(_r1, "r1_export.py", "exec"))  # make_project, open_with_project…
from playwright.sync_api import sync_playwright  # noqa: E402

GROUPS = ["Édition", "Gain et fondus", "Hauteur et temps", "Voix", "Traitement", "MIDI"]
res = {"cas": {}}
checks = []


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("  OK  " if cond else "  KO  ") + name + (f" — {detail}" if detail is not None else ""))


MENU_INFO = """() => { const ms = [...document.querySelectorAll('[role=menu]')].filter(m => m.getClientRects().length);
  return ms.map(m => { const r = m.getBoundingClientRect();
    const items = [...m.querySelectorAll(':scope > div > button[role=menuitem], :scope > button[role=menuitem]')];
    return { label: m.getAttribute('aria-label'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      scroll: m.scrollHeight > m.clientHeight + 1, entries: items.map(b => ({ t: (b.innerText || '').trim().split('\\n')[0], sub: b.hasAttribute('data-submenu'), dis: b.disabled, sub_n: (b.dataset.submenu || '').split('\\n').filter(Boolean).length })) }; }); }"""


def menus(page):
    return page.evaluate(MENU_INFO)


def open_clip_menu(page, track="voix", t=3.0, touch=False):
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    x, y = track_point(page, track, t)
    if touch:
        page.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y); const o = { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', pointerId: 7, isPrimary: true };
          el.dispatchEvent(new PointerEvent('pointerdown', o)); }""", [x, y])
        page.wait_for_timeout(800)
        page.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', pointerId: 7 })); }""", [x, y])
    else:
        page.mouse.click(x, y, button="right")
    page.wait_for_timeout(450)
    return menus(page)


def run_pc(b):
    log = Log("menu_pc")
    ctx, page = new_page(b, "pc", log=log)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    z = OUT / "menu.zip"; make_project(z)
    open_with_project(page, z)
    page.mouse.click(5, 300); page.keyboard.press("Escape")
    m = open_clip_menu(page)
    root = m[0] if m else {}
    page.screenshot(path=str(OUT / "pc_01_menu_clip.png"))
    labels = [e["t"] for e in root.get("entries", [])]
    subs = [e["t"] for e in root.get("entries", []) if e["sub"] or e["t"] in GROUPS]
    total = len(labels) - len(subs) + sum(e["sub_n"] for e in root.get("entries", []))
    res["cas"]["pc"] = {"hauteur_px": root.get("h"), "entrees_1er_niveau": len(labels), "sous_menus": subs, "entrees_en_tout": total, "defile": root.get("scroll"), "premier_niveau": labels}
    check("PC : menu du clip sous 500 px de haut (avant 892 px)", (root.get("h") or 9999) < 500, f"{root.get('h')} px")
    check("PC : sous-menus dans l'ordre Édition, Gain et fondus, Hauteur et temps, Voix, Traitement, MIDI", subs == GROUPS, subs)
    check("PC : gestes de tous les jours en haut (Couper … Muter)", labels[:6] == ["Couper", "Copier", "Coller", "Dupliquer", "Diviser", "Muter"], labels[:6])
    check("PC : Justesse et Respirations au 1er niveau (clip audio)", "Justesse note par note…" in labels and "Respirations…" in labels)
    # Survol : chaque sous-menu s'ouvre à côté, dans l'écran.
    res["cas"]["pc"]["sous_menus_detail"] = {}
    for i, g in enumerate(GROUPS):
        trig = page.locator("[role=menu] [data-submenu]", has_text=g).first
        if not trig.count():
            check(f"PC : sous-menu « {g} » présent", False); continue
        trig.hover(); page.wait_for_timeout(350)
        mm = menus(page)
        sub = next((x for x in mm if x["label"] == g), None)
        inside = bool(sub) and sub["x"] >= 0 and sub["y"] >= 0 and sub["x"] + sub["w"] <= 1600 and sub["y"] + sub["h"] <= 900
        res["cas"]["pc"]["sous_menus_detail"][g] = sub and {"h": sub["h"], "entrees": [e["t"] for e in sub["entries"]]}
        check(f"PC : survol de « {g} » ouvre le sous-menu dans l'écran", inside, sub and f"{len(sub['entries'])} entrées, {sub['h']} px")
        if i == 1: page.screenshot(path=str(OUT / "pc_02_sous_menu_gain_fondus.png"))
        if i == 3: page.screenshot(path=str(OUT / "pc_03_sous_menu_voix.png"))
    # Souris : une entrée de sous-menu marche (Transposer / étirer… ouvre sa fenêtre).
    page.keyboard.press("Escape"); page.keyboard.press("Escape")
    open_clip_menu(page)
    menu_pick(page, "Transposer / étirer…", exact=True)
    ok = False
    try: page.wait_for_selector("[data-testid=transpose-dialog]", timeout=8000); ok = True
    except Exception: pass
    check("Souris : Hauteur et temps › Transposer / étirer… ouvre la fenêtre", ok)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    # Clavier : ↓ jusqu'à « Voix », → ouvre, ↓ jusqu'à Respirations, Entrée.
    open_clip_menu(page)
    page.keyboard.press("ArrowDown")
    target_ok = False
    for _ in range(25):
        cur = page.evaluate("() => (document.activeElement && document.activeElement.innerText || '').trim()")
        if cur.startswith("Voix"): target_ok = True; break
        page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(300)
    first = page.evaluate("() => (document.activeElement && document.activeElement.innerText || '').trim()")
    check("Clavier : ↓ atteint « Voix », → ouvre le sous-menu et place le focus sur sa 1re entrée", target_ok and first.startswith("Justesse"), first)
    page.keyboard.press("ArrowLeft"); page.wait_for_timeout(200)
    back = page.evaluate("() => (document.activeElement && document.activeElement.innerText || '').trim()")
    still = len(menus(page)) == 1
    check("Clavier : ← referme le sous-menu, le focus revient sur « Voix »", back.startswith("Voix") and still, back)
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(250)
    for _ in range(6):
        cur = page.evaluate("() => (document.activeElement && document.activeElement.innerText || '').trim()")
        if cur.startswith("Respirations"): break
        page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    ok = False
    try: page.wait_for_function("() => /Respirations/.test(document.querySelector('[role=dialog]')?.innerText || '')", timeout=6000); ok = True
    except Exception: pass
    check("Clavier : Voix › Respirations… + Entrée ouvre la fenêtre", ok)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    # Échap : 1er appui ferme le sous-menu, 2e le menu.
    open_clip_menu(page)
    page.locator("[role=menu] [data-submenu]", has_text="Édition").first.click(); page.wait_for_timeout(250)
    n1 = len(menus(page)); page.keyboard.press("Escape"); page.wait_for_timeout(150)
    n2 = len(menus(page)); page.keyboard.press("Escape"); page.wait_for_timeout(150)
    n3 = len(menus(page))
    check("Échap : ferme d'abord le sous-menu, puis le menu", (n1, n2, n3) == (2, 1, 0), (n1, n2, n3))
    # Clip MIDI : mêmes sous-menus, même ordre (Voix grisé avec la raison).
    midi = page.evaluate("""() => { const s = window.__novaEdit && window.__novaEdit.getState(); return s ? s.tracks.find(t => t.type === 'MIDI' && t.clips.length) : null; }""")
    if midi:
        x, y = track_point(page, midi["id"], midi["clips"][0]["start"] + 0.3)
        page.mouse.click(x, y, button="right"); page.wait_for_timeout(400)
        mm = menus(page)
        subs_m = [e["t"] for e in (mm[0]["entries"] if mm else []) if e["sub"] or e["t"] in GROUPS]
        check("Clip MIDI : mêmes sous-menus dans le même ordre", subs_m == GROUPS, subs_m)
        page.keyboard.press("Escape")
    else:
        res["cas"]["pc"]["midi"] = "pas de clip MIDI dans le projet de test"
    errs = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])]
    check("PC : aucune erreur de console", not errs, errs[:2])
    ctx.close()


def run_touch(b, vp, tag):
    log = Log(f"menu_{tag}")
    ctx, page = new_page(b, vp, log=log)
    if vp == "tel":
        page.set_viewport_size({"width": 390, "height": 844})
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    z = OUT / f"menu_{tag}.zip"; make_project(z)
    open_with_project(page, z)
    page.keyboard.press("Escape")
    has_grid = page.evaluate("() => !!document.querySelector('.nova-grille canvas')")
    if not has_grid:
        res["cas"][tag] = {"note": "pas d'arrangement de bureau à cette taille (pages téléphone)"}
        ctx.close(); return
    m = open_clip_menu(page, touch=True)
    root = m[0] if m else {}
    page.screenshot(path=str(OUT / f"{tag}_01_menu_clip.png"))
    res["cas"][tag] = {"hauteur_px": root.get("h"), "entrees_1er_niveau": len(root.get("entries", []))}
    vh = page.evaluate("() => innerHeight")
    check(f"{tag} : appui long ouvre le menu du clip, entièrement dans l'écran", bool(root) and root["y"] + root["h"] <= vh and not root.get("scroll"), root and f"{root.get('h')} px / écran {vh} px")
    trig = page.locator("[role=menu] [data-submenu]", has_text="Traitement").first
    trig.tap(); page.wait_for_timeout(400)
    mm = menus(page)
    page.screenshot(path=str(OUT / f"{tag}_02_sous_menu_traitement.png"))
    if tag == "tel":
        drilled = len(mm) == 1 and mm[0]["label"] == "Traitement"
        check("téléphone : le sous-menu s'ouvre à la place du menu (‹ Retour)", drilled, [x["label"] for x in mm])
        page.locator("[role=menu] button", has_text="Traitement").first.tap(); page.wait_for_timeout(300)
        back = menus(page)
        check("téléphone : ‹ Retour revient au menu", len(back) == 1 and back[0]["label"] == "Menu contextuel")
        trig = page.locator("[role=menu] [data-submenu]", has_text="Traitement").first
        trig.tap(); page.wait_for_timeout(300)
    else:
        sub = next((x for x in mm if x["label"] == "Traitement"), None)
        check(f"{tag} : toucher « Traitement » ouvre le sous-menu à côté", bool(sub) and sub["x"] + sub["w"] <= 1024, sub and f"x={sub['x']} w={sub['w']}")
    small = page.evaluate("""() => [...document.querySelectorAll('[role=menu] button[role=menuitem]')].filter(b => b.getClientRects().length && b.getBoundingClientRect().height < 36).map(b => b.innerText.trim().slice(0, 30))""")
    check(f"{tag} : entrées d'au moins 36 px au doigt", not small, small[:3])
    it = page.locator("[role=menu] button", has_text="AudioSuite").locator("visible=true").first
    it.tap(); page.wait_for_timeout(800)
    opened = page.evaluate("() => !!document.querySelector('[role=dialog]')")
    check(f"{tag} : toucher Traitement › AudioSuite ouvre la fenêtre", opened)
    page.keyboard.press("Escape")
    ctx.close()


with sync_playwright() as p:
    b = launch(p)
    t0 = time.time()
    run_pc(b)
    run_touch(b, "tab", "tablette")
    run_touch(b, "tel", "tel")
    b.close()
res["verifications"] = checks
res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks), "duree_s": round(time.time() - t0, 1)}
(OUT / "menu_clip.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
