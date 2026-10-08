"""Gestes au doigt : non-régression de TOUS les gestes tactiles de l'arrangement
(navigateur headless, aucune fenêtre). Échoue (code de sortie 1) au moindre défaut.

  tab (tablette 1024×768, mode avancé) :
    - appui long sur un clip → le menu du clip, en Slip / Grid / Shuffle ; il reste ouvert
      après le lever du doigt et le clip n'a pas bougé (le clic du lever tombait sur
      « Normaliser » : le clip était normalisé et le menu refermé) ; en Spot → « Position
      exacte », sans le menu ;
    - appui long sur un effet (barre d'inserts de la piste) → son menu, effet inchangé ;
    - appui long sur une piste vide → le menu de la grille (clic droit de l'endroit) ;
    - un seul arbitre : aucun clic droit simulé par le gestionnaire global sur la zone des
      pistes, ni sur le canvas des marqueurs de warp ;
    - glisser un clip au doigt ; glisser puis garder le doigt immobile : pas de menu ;
    - défilement au doigt de la timeline, puis doigt immobile : pas d'appui long ;
    - deux doigts posés (même sur un clip) et gardés : aucun appui long, le clip ne suit pas ;
    - crayon de gain au doigt (points posés, pas de menu, la page ne défile pas) ;
    - section de la piste Arrangement glissée au doigt (mode « Copier ») ;
    - marqueur de warp : appui long → retiré (une seule fois).
  tel (téléphone 432×768) :
    - appui long sur un clip → clip sélectionné, barre du clip, aucun menu, clip intact ;
    - glisser le clip sélectionné ; défilement au doigt sans rien sélectionner ni déplacer.

Usage : serveur `npx vite --port 3458 --strictPort` dans le worktree, puis
  NOVA_URL=http://localhost:3458/ python qa/gestes_tactiles.py [tab] [tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-gestes\\ (captures, mesures.json, journal).
"""
import io, json, math, os, re, sys, traceback, wave
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://localhost:3458/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-gestes")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa
from qalib import OUT, Log, new_page, shot, save_log  # noqa
import protools_edition as pe  # noqa
from playwright.sync_api import sync_playwright

SR = 44100
ZOOM = 40       # px par seconde (120 BPM)
ZOOMV = 120     # hauteur d'une piste
RES = {"checks": [], "echecs": []}


def ok(name, cond, detail=None):
    RES["checks"].append({"ok": bool(cond), "test": name, "detail": detail})
    if not cond:
        RES["echecs"].append(name)
    print(("  OK   " if cond else "  ÉCHEC ") + name + ("" if cond else f"  → {json.dumps(detail, ensure_ascii=False, default=str)[:400]}"), flush=True)


# ------------------------------------------------------------------ projet
def wav_bytes(x, sr=SR):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    return buf.getvalue()


def voice(seconds):
    """Voix simple (crête 0,3 : « Normaliser » la changerait), notes séparées → attaques."""
    t = np.arange(int(seconds * SR)) / SR
    f = 220 * 2 ** (np.floor(t * 2) % 5 / 12)
    env = np.clip(np.sin(np.pi * ((t * 2) % 1)), 0, 1) ** 0.5
    return 0.3 * env * np.sin(2 * np.pi * np.cumsum(f) / SR)


def project():
    f = OUT / "gestes_projet.zip"
    comp = {"id": "fx-comp", "type": "COMPRESSOR", "name": "Compresseur", "isEnabled": True, "params": {}, "latency": 0}
    pe.make_project(f, [
        pe.track("voix", "Voix", [pe.clip("c-voix", "Voix", 1.0, 5.0, "audio/voix.wav")], plugins=[comp]),
        pe.track("beat", "Beat", [pe.clip("c-beat", "Beat", 1.0, 2.0, "audio/beat.wav")], color="#f97316"),
        pe.track("pistevide", "Vide", [], color="#64748b"),
    ], {"audio/voix.wav": wav_bytes(voice(5.0)), "audio/beat.wav": wav_bytes(voice(2.0))}, "Gestes tactiles")
    import zipfile
    z = zipfile.ZipFile(f); st = json.loads(z.read("project.json")); files = {k: z.read(k) for k in z.namelist() if k != "project.json"}; z.close()
    st["markers"] = [
        {"id": "m-intro", "name": "Intro", "time": 0, "type": "MARKER", "color": "#64748b", "number": 1},
        {"id": "m-couplet", "name": "Couplet", "time": 2, "type": "MARKER", "color": "#22d3ee", "number": 2},
        {"id": "m-refrain", "name": "Refrain", "time": 4, "type": "MARKER", "color": "#f59e0b", "number": 3},
        {"id": "m-outro", "name": "Outro", "time": 6, "type": "MARKER", "color": "#a855f7", "number": 4},
    ]
    with zipfile.ZipFile(f, "w") as z:
        z.writestr("project.json", json.dumps(st))
        for k, v in files.items():
            z.writestr(k, v)
    return f


INIT_TAB = """try { localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_arrange_lane', '1');
  localStorage.removeItem('nova_clip_gain_view'); } catch (e) {}"""

# Espion : clics droits simulés (non « isTrusted ») reçus par la zone des pistes et le canvas
# du warp ; menus du clip / de la grille / de l'effet présents à l'écran.
SPY = """() => {
  if (window.__gestes) return;
  window.__gestes = { synth: [], menuClicks: [] };
  // Clic (vrai) arrivé sur une entrée de menu : après un appui long, celui du lever ne doit jamais y arriver.
  document.addEventListener('click', e => {
    const b = e.isTrusted && e.target && e.target.closest && e.target.closest('button');
    if (b && b.closest('.fixed, [role=menu]')) window.__gestes.menuClicks.push((b.innerText || '').trim().slice(0, 30));
  }, true);
  for (const t of ['mousedown', 'contextmenu']) document.addEventListener(t, e => {
    if (!e.isTrusted && e.button === 2) window.__gestes.synth.push([t, (e.target && e.target.dataset && e.target.dataset.testid) || e.target.tagName]);
  }, true);
}"""


def open_tab(page, label):
    page.add_init_script(INIT_TAB)
    pe.open_project(page, project(), label)
    for _ in range(2):
        page.keyboard.press("Escape"); page.wait_for_timeout(120)
    page.evaluate(SPY)


# ------------------------------------------------------------------ outils
def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def clips(page):
    return st(page, """s => Object.fromEntries(s.tracks.filter(t => t.type !== 'BUS').map(t => [t.id, t.clips.map(c => ({ id: c.id,
      start: +c.start.toFixed(4), dur: +c.duration.toFixed(4), off: +(c.offset || 0).toFixed(4), gain: +(c.gain ?? 1).toFixed(4),
      buf: c.bufferId || null, muted: !!c.isMuted, pts: (c.gainPoints || []).length, norm: !!c.normalized })).sort((a, b) => a.start - b.start)]))""")


def plugin_state(page):
    return st(page, "s => s.tracks.find(t => t.id === 'voix').plugins.map(p => [p.id, !!p.isEnabled, !!p.isInactive])")


def box(page):
    return pe.canvas_box(page)


def x_of(b, t):
    return b["x"] + t * ZOOM - b["sl"]


def y_mid(b, idx):
    return b["y"] + b["tt"] + idx * ZOOMV + ZOOMV * 0.7 - b["st"]


class Finger:
    def __init__(self, page):
        self.page = page
        self.cdp = page.context.new_cdp_session(page)

    def send(self, kind, pts):
        self.cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})

    def down(self, *pts): self.send("touchStart", pts)
    def move(self, *pts): self.send("touchMove", pts)
    def up(self): self.send("touchEnd", [])

    def long_press(self, x, y, ms=900, after=700):
        self.down((x, y)); self.page.wait_for_timeout(ms); self.up(); self.page.wait_for_timeout(after)

    def drag(self, x0, y0, x1, y1, steps=12, hold=0, after=500):
        self.down((x0, y0)); self.page.wait_for_timeout(60)
        for k in range(1, steps + 1):
            self.move((x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps)); self.page.wait_for_timeout(25)
        if hold: self.page.wait_for_timeout(hold)
        self.up(); self.page.wait_for_timeout(after)


def visible_text(page, text):
    return page.get_by_text(text, exact=True).locator("visible=true").count()


def clip_menu_open(page):
    return visible_text(page, "Normaliser") > 0 and visible_text(page, "Dupliquer") > 0


def any_menu_open(page):
    return page.evaluate("""() => !![...document.querySelectorAll('[role=menu], .fixed')].find(el => el.getClientRects().length
      && /Normaliser|Ajouter un marqueur|Créer un pattern|Bypass|Coller/.test(el.innerText || ''))""")


def open_menus(page):
    return page.evaluate("""() => [...document.querySelectorAll('.fixed, [role=menu]')].filter(el => el.getClientRects().length && (el.innerText || '').trim().length > 3).map(el => (el.innerText || '').trim().slice(0, 60))""")


def close_menus(page):
    page.evaluate("() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
    page.keyboard.press("Escape"); page.wait_for_timeout(250)


def menu_clicks(page):
    return page.evaluate("() => window.__gestes.menuClicks.length")


def synth_count(page):
    return page.evaluate("() => window.__gestes.synth.length")


def set_mode(page, m):
    page.locator(f'[data-edit-mode="{m}"]').locator("visible=true").first.tap(); page.wait_for_timeout(250)
    return page.evaluate("() => window.__novaEditMode.get().mode")


# ------------------------------------------------------------------ tablette
def scenario_tab_menus(browser, log):
    ctx, page = new_page(browser, "tab", log)
    open_tab(page, "tab_00_projet")
    f = Finger(page)
    b = box(page)
    RES["tab_canvas"] = b
    x, y = x_of(b, 2.0), y_mid(b, 0)
    ref = clips(page)

    # 1. Appui long sur un clip, dans chaque mode d'édition.
    for m in ("SLIP", "GRID", "SHUFFLE"):
        got = set_mode(page, m)
        ok(f"tab · mode {m} sélectionné au doigt", got == m, got)
        s0 = synth_count(page)
        m0 = menu_clicks(page)
        f.down((x, y)); page.wait_for_timeout(900)
        shot(page, f"tab_01_{m}_appui_long_doigt_pose")
        f.up(); page.wait_for_timeout(800)
        shot(page, f"tab_02_{m}_menu_apres_lever")
        ok(f"tab · {m} : appui long sur un clip → menu du clip, encore ouvert après le lever", clip_menu_open(page))
        ok(f"tab · {m} : le clic du lever n'a rien activé (aucune entrée du menu, clip intact)", clips(page) == ref and menu_clicks(page) == m0,
           {"avant": ref["voix"], "apres": clips(page)["voix"], "entrees_cliquees": page.evaluate("() => window.__gestes.menuClicks")})
        ok(f"tab · {m} : un seul arbitre (aucun clic droit simulé sur la zone des pistes)", synth_count(page) == s0, page.evaluate("() => window.__gestes.synth"))
        ok(f"tab · {m} : un seul menu", page.get_by_text("Normaliser", exact=True).locator("visible=true").count() == 1)
        close_menus(page)
        ok(f"tab · {m} : menu refermé par un toucher ailleurs", not clip_menu_open(page))
    # Le menu reste utilisable au doigt : « Dupliquer » ajoute bien un clip.
    set_mode(page, "SLIP")
    f.long_press(x, y)
    page.get_by_text("Dupliquer", exact=True).locator("visible=true").first.tap(); page.wait_for_timeout(600)
    n = len(clips(page)["voix"])
    ok("tab · une entrée du menu touchée au doigt agit (Dupliquer → 2 clips)", n == 2, clips(page)["voix"])
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    ok("tab · annulé (Ctrl+Z)", clips(page) == ref, clips(page)["voix"])

    # 2. Spot : appui long → Position exacte, sans le menu du clip.
    ok("tab · mode SPOT sélectionné au doigt", set_mode(page, "SPOT") == "SPOT")
    f.long_press(x, y, after=900)
    shot(page, "tab_03_SPOT_position_exacte")
    ok("tab · SPOT : appui long → « Position exacte » ouverte après le lever", page.locator('[data-testid="spot-dialog"]').is_visible())
    ok("tab · SPOT : pas le menu du clip", not clip_menu_open(page))
    ok("tab · SPOT : clip intact", clips(page) == ref)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    if page.locator('[data-testid="spot-dialog"]').is_visible():
        page.locator('[data-testid="spot-dialog"]').get_by_role("button", name=re.compile("Annuler|Fermer", re.I)).first.click(); page.wait_for_timeout(300)
    set_mode(page, "SLIP")

    # 3. Piste vide : appui long → menu de la grille (clic droit de l'endroit), une seule fois.
    s0 = synth_count(page)
    f.long_press(x_of(b, 4.0), y_mid(b, 2))
    shot(page, "tab_04_piste_vide_menu")
    menus = open_menus(page)
    ok("tab · piste vide : appui long → un menu (clic droit de l'endroit)", len(menus) >= 1, menus)
    ok("tab · piste vide : clips intacts", clips(page) == ref)
    close_menus(page)

    # 4. Appui long sur un effet (inserts de la piste) → son menu.
    chip = page.locator('.fx-slot button').locator("visible=true").first
    if chip.count():
        bb = chip.bounding_box()
        p0 = plugin_state(page)
        m0 = menu_clicks(page)
        f.long_press(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
        shot(page, "tab_05_effet_menu")
        txt = page.locator('[data-testid="structure-menu"]').locator("visible=true").all_inner_texts()
        ok("tab · appui long sur un effet → son menu (actif / bypass / inactif)", len(txt) == 1 and "Bypass" in txt[0] and "Inactif" in txt[0], txt)
        ok("tab · effet : le lever n'a rien changé (état, aucune entrée du menu cliquée)", plugin_state(page) == p0 and menu_clicks(page) == m0, plugin_state(page))
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        ok("tab · menu de l'effet refermé (Échap)", page.locator('[data-testid="structure-menu"]').locator("visible=true").count() == 0)
        # Un toucher simple sur l'effet l'ouvre toujours (le clic du lever n'est avalé qu'après un appui long).
        chip.tap(); page.wait_for_timeout(900)
        editor = page.get_by_text("Rend le volume de la voix", exact=False).locator("visible=true")
        # Fenêtre d'effet chargée à la demande : sur une machine très chargée, son code peut
        # mettre plus de 0,9 s à arriver (« Chargement… »). On attend la fenêtre (15 s au plus)
        # avant de juger, et avant de continuer : ouverte en retard, elle recouvrait les pistes
        # et faisait échouer le glisser suivant.
        waited = 0
        while not editor.count() and waited < 15000:
            page.wait_for_timeout(250); waited += 250
        RES["tab_effet_ouvert_apres_ms"] = 900 + waited
        shot(page, "tab_06_effet_tap_ouvre")
        ok("tab · un toucher simple sur l'effet l'ouvre (fenêtre du Compresseur)", editor.count() >= 1, {"ouverte_apres_ms": 900 + waited})
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        for _ in range(3):
            if not editor.count(): break
            page.get_by_role("button", name="Fermer", exact=True).locator("visible=true").first.click(); page.wait_for_timeout(300)
        ok("tab · fenêtre de l'effet refermée", editor.count() == 0)
    else:
        ok("tab · effet visible dans les inserts de la piste", False, "aucun .fx-slot visible")

    # 5. Glisser un clip au doigt (Slip) : il suit, sans menu ; puis glisser + doigt immobile : pas de menu.
    b = box(page)
    f.drag(x_of(b, 2.0), y_mid(b, 0), x_of(b, 3.0), y_mid(b, 0))
    c = clips(page)["voix"][0]
    ok("tab · clip glissé au doigt (+1 s)", abs(c["start"] - 2.0) < 0.06, c)
    ok("tab · glisser : pas de menu", not any_menu_open(page))
    f.drag(x_of(b, 3.0), y_mid(b, 0), x_of(b, 2.0), y_mid(b, 0), hold=1000)
    c = clips(page)["voix"][0]
    ok("tab · glissé puis doigt gardé immobile 1 s : pas d'appui long", not any_menu_open(page) and abs(c["start"] - 1.0) < 0.06, c)
    page.evaluate("() => window.__novaEdit.patchClips('voix', [{ id: 'c-voix', start: 1.0 }])"); page.wait_for_timeout(300)
    ref = clips(page)
    # Après un glissement, l'appui long marche encore ailleurs (piste vide → menu).
    f.long_press(x_of(b, 4.0), y_mid(b, 2))
    menus = open_menus(page)
    ok("tab · après un glissement, appui long sur une piste vide → menu", len(menus) >= 1, menus)
    close_menus(page)

    # 6. Défilement au doigt de la timeline (zone vide), puis doigt immobile : pas d'appui long.
    sc0 = page.evaluate("() => { const s = document.querySelector('.nova-grille .custom-scroll'); return [s.scrollLeft, s.scrollTop, s.scrollWidth - s.clientWidth]; }")
    s0 = synth_count(page)
    yv = y_mid(b, 2)
    f.drag(x_of(b, 7.5), yv, x_of(b, 3.0), yv, steps=16, hold=1000)
    sc1 = page.evaluate("() => { const s = document.querySelector('.nova-grille .custom-scroll'); return [s.scrollLeft, s.scrollTop]; }")
    shot(page, "tab_07_defilement_doigt")
    RES["tab_defilement"] = {"avant": sc0, "apres": sc1}
    ok("tab · défilement au doigt : la timeline défile", sc0[2] > 0 and sc1[0] > sc0[0], {"avant": sc0, "apres": sc1})
    ok("tab · défilement puis doigt immobile : aucun menu, clips intacts", not any_menu_open(page) and clips(page) == ref and synth_count(page) == s0)
    page.evaluate("() => { const s = document.querySelector('.nova-grille .custom-scroll'); s.scrollLeft = 0; s.scrollTop = 0; }"); page.wait_for_timeout(300)

    # 7. Deux doigts posés (l'un sur le clip) et gardés, puis glissés : ni appui long, ni clip déplacé.
    b = box(page)
    s0 = synth_count(page)
    p1, p2 = (x_of(b, 2.0), y_mid(b, 0)), (x_of(b, 2.0), y_mid(b, 1) + 30)
    f.down(p1); page.wait_for_timeout(40); f.down(p1, p2); page.wait_for_timeout(1000)
    for k in range(1, 9):
        f.move((p1[0] - 12 * k, p1[1]), (p2[0] - 12 * k, p2[1])); page.wait_for_timeout(30)
    page.wait_for_timeout(700)
    f.up(); page.wait_for_timeout(700)
    shot(page, "tab_08_deux_doigts")
    ok("tab · deux doigts gardés puis glissés : aucun menu, aucune fenêtre", not any_menu_open(page) and not page.locator('[data-testid="spot-dialog"]').is_visible())
    ok("tab · deux doigts : le clip n'a pas suivi", clips(page) == ref, clips(page)["voix"])
    ok("tab · deux doigts : aucun clic droit simulé", synth_count(page) == s0, page.evaluate("() => window.__gestes.synth"))
    save_log(log, {"errors": log.errors()})
    ctx.close()


def scenario_tab_crayon(browser, log):
    ctx, page = new_page(browser, "tab", log)
    open_tab(page, "tab_10_crayon_projet")
    f = Finger(page)
    b = box(page)
    page.get_by_test_id("toggle-gain-line").tap(); page.wait_for_timeout(200)
    page.get_by_test_id("tool-pencil").tap(); page.wait_for_timeout(200)
    page.get_by_test_id("pencil-shape").tap(); page.wait_for_timeout(200)
    page.get_by_test_id("pencil-shape-line").tap(); page.wait_for_timeout(200)
    # Ligne de gain à 0 dB : 18 + (H - 22) * 0,2 sous le haut du clip (cf. clip_gain_preuve).
    y0 = b["y"] + b["tt"] - b["st"] + 2 + 18 + max(4, ZOOMV - 4 - 22) * 0.2
    s0 = synth_count(page)
    # Doigt posé 0,8 s AVANT de tracer : le crayon ne doit pas céder à l'appui long.
    f.down((x_of(b, 2.0), y0)); page.wait_for_timeout(800)
    for k in range(1, 13):
        f.move((x_of(b, 2.0) + ZOOM * 3 * k / 12, y0 + 20 * k / 12)); page.wait_for_timeout(25)
    f.up(); page.wait_for_timeout(600)
    shot(page, "tab_11_crayon_de_gain")
    c = clips(page)["voix"][0]
    ok("tab · crayon de gain au doigt : points posés", c["pts"] >= 2, c)
    ok("tab · crayon (doigt posé avant de tracer) : pas de menu", not any_menu_open(page) and synth_count(page) == s0)
    ok("tab · crayon : la page n'a pas défilé", box(page)["sl"] == b["sl"] and box(page)["st"] == b["st"])
    save_log(log, {"errors": log.errors()})
    ctx.close()


def scenario_tab_sections(browser, log):
    ctx, page = new_page(browser, "tab", log)
    open_tab(page, "tab_20_sections_projet")
    f = Finger(page)
    page.get_by_test_id("arrange-copy-mode").tap(); page.wait_for_timeout(200)
    sec = page.get_by_test_id("arrange-section-m-refrain")
    bb = sec.bounding_box()
    y = bb["y"] + bb["height"] / 2
    x0 = bb["x"] + min(20, bb["width"] / 3)
    s0 = synth_count(page)
    f.drag(x0, y, x0 + 2 * ZOOM, y, steps=11, after=900)
    shot(page, "tab_21_section_glissee")
    mk = st(page, "s => s.markers.map(m => [m.name, +m.time.toFixed(3)]).sort((a, b) => a[1] - b[1])")
    ok("tab · section Refrain glissée au doigt (Copier) : dupliquée", mk == [["Intro", 0], ["Couplet", 2], ["Refrain", 4], ["Refrain", 6], ["Outro", 8]], mk)
    ok("tab · section : pas de menu", not any_menu_open(page) and synth_count(page) == s0)
    # Appui long sur une section (sans bouger) : rien d'inattendu (pas de menu du clip ni de la grille).
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    bb = page.get_by_test_id("arrange-section-m-couplet").bounding_box()
    mk0 = st(page, "s => s.markers.length")
    f.long_press(bb["x"] + 15, bb["y"] + bb["height"] / 2)
    ok("tab · appui long sur une section : ni menu du clip, ni section modifiée", not clip_menu_open(page) and st(page, "s => s.markers.length") == mk0)
    close_menus(page)
    save_log(log, {"errors": log.errors()})
    ctx.close()


def scenario_tab_warp(browser, log):
    ctx, page = new_page(browser, "tab", log)
    open_tab(page, "tab_30_warp_projet")
    f = Finger(page)
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-window', { detail: { name: 'warp', targets: [{ trackId: 'voix', clipId: 'c-voix' }] } }))")
    page.wait_for_selector("[data-testid=warp-dialog]"); page.wait_for_timeout(1200)
    cv = page.locator("[data-testid=warp-canvas]")
    bb = cv.bounding_box()
    count = lambda: int(re.search(r"marqueurs\s*:\s*(\d+)", page.get_by_test_id("warp-status").inner_text()).group(1))
    # Marqueur posé à la souris (double-clic), entre deux attaques.
    mx, my = bb["x"] + bb["width"] * 0.45, bb["y"] + bb["height"] / 2
    page.mouse.dblclick(mx, my); page.wait_for_timeout(400)
    n1 = count()
    ok("tab · warp : marqueur posé", n1 == 1, n1)
    s0 = synth_count(page)
    page.evaluate("() => { window.__warpCtx = 0; document.querySelector('[data-testid=warp-canvas]').addEventListener('contextmenu', () => window.__warpCtx++, true); }")
    shot(page, "tab_31_warp_marqueur")
    # Le marqueur est sous le point du double-clic (calé sur l'attaque la plus proche s'il y en a une).
    f.long_press(mx, my, ms=1000)
    shot(page, "tab_32_warp_appui_long")
    n2 = count()
    ok("tab · warp : appui long sur le marqueur → retiré", n2 == 0, n2)
    ok("tab · warp : un seul arbitre (aucun clic droit simulé sur le canvas)", page.evaluate("() => window.__warpCtx") == 0 and synth_count(page) == s0,
       {"ctx": page.evaluate("() => window.__warpCtx"), "synth": page.evaluate("() => window.__gestes.synth")})
    ok("tab · warp : la fenêtre reste ouverte", page.locator("[data-testid=warp-dialog]").is_visible())
    save_log(log, {"errors": log.errors()})
    ctx.close()


# ------------------------------------------------------------------ téléphone
def scenario_tel(browser, log):
    ctx, page = new_page(browser, "tel", log)
    pe.open_project(page, project(), "tel_00_projet")
    page.evaluate(SPY)
    f = Finger(page)
    page.wait_for_timeout(800)
    clip = page.locator("[data-clip-id='c-voix']").locator("visible=true").first
    ok("tel · clip visible", clip.count() == 1)
    ref = clips(page)
    bb = clip.bounding_box()
    x, y = bb["x"] + min(60, bb["width"] / 2), bb["y"] + bb["height"] / 2
    f.long_press(x, y)
    shot(page, "tel_01_appui_long_clip")
    sel = page.evaluate("() => { const e = document.querySelector('[data-clip-id=\"c-voix\"]'); return !!e && /ring|border-white|selected/.test(e.className); }")
    bar = page.get_by_test_id("mobile-clip-gain").locator("visible=true").count() + page.get_by_test_id("mobile-clip-pitch").locator("visible=true").count()
    ok("tel · appui long sur un clip → clip sélectionné, barre du clip", bar >= 1, {"selection_classe": sel})
    ok("tel · appui long : aucun menu, clip intact", not any_menu_open(page) and clips(page) == ref, clips(page)["voix"])
    # Clip sélectionné : le doigt le déplace.
    bb = clip.bounding_box()
    x, y = bb["x"] + 60, bb["y"] + bb["height"] / 2   # le clip déborde de l'écran : on le prend par son début
    f.drag(x, y, x + 160, y, steps=16)
    c = clips(page)["voix"][0]
    ok("tel · clip sélectionné glissé au doigt (+1 s, calé sur la grille)", abs(c["start"] - 2.0) < 0.06, c)
    ok("tel · glisser : pas de menu", not any_menu_open(page))
    page.evaluate("() => window.__novaEdit.patchClips('voix', [{ id: 'c-voix', start: 1.0 }])"); page.wait_for_timeout(300)
    ref = clips(page)
    # Défilement au doigt sur la piste vide, puis doigt immobile : rien n'est sélectionné ni déplacé.
    lane = page.locator("[data-clip-id='c-beat']").locator("visible=true").first.bounding_box()
    yv = lane["y"] + lane["height"] + 40
    f.drag(380, yv, 120, yv, steps=14, hold=900)
    shot(page, "tel_02_defilement")
    ok("tel · défilement au doigt : aucun menu, clips intacts", not any_menu_open(page) and clips(page) == ref, clips(page))
    save_log(log, {"errors": log.errors()})
    ctx.close()


SCENARIOS = {
    "tab": [scenario_tab_menus, scenario_tab_crayon, scenario_tab_sections, scenario_tab_warp],
    "tel": [scenario_tel],
}


def main(names):
    names = names or list(SCENARIOS)
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = qalib.launch(p)
        for n in names:
            for fn in SCENARIOS[n]:
                print(f"== {fn.__name__}", flush=True)
                log = Log(fn.__name__)
                try:
                    fn(browser, log)
                except Exception:
                    ok(f"{fn.__name__} : déroulé sans exception", False, traceback.format_exc()[-1500:])
        browser.close()
    total = len(RES["checks"])
    RES["bilan"] = f"{total - len(RES['echecs'])}/{total} vérifications au vert"
    (OUT / "mesures.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(RES["bilan"])
    if RES["echecs"]:
        print("ÉCHECS :", *RES["echecs"], sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
