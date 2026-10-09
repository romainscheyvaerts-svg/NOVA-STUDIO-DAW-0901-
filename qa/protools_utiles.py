"""Commandes Pro Tools du quotidien (ingé voix / mix) : preuves dans un navigateur headless.

  solo   : S de la lead → indicateur « S1 » ; Ctrl+clic sur le S du clic = solo safe (le moteur le
           garde audible, le beat est coupé) ; Alt+clic sur un S allumé = tous les solos effacés ;
           Maj+S / Maj+M sur la piste sélectionnée ; Alt+clic sur un M = toutes muettes, l'indicateur
           « M » efface d'un appui ; Alt+C = diodes de saturation éteintes. Tablette : palette (Ctrl+K
           au doigt) et indicateurs, sans Alt ni Ctrl.
  verrou : Ctrl+L sur un clip → cadenas ; le glisser ne le déplace pas (message), Suppr ne l'efface
           pas ; Ctrl+L le libère, il se déplace. Alt+Maj+L (position) : se rogne, ne se déplace pas.
  pistes : Ctrl+Alt+A (ou menu de la piste) = tous les clips de la piste sélectionnés.
  palette: chaque commande se trouve en français et se lance (Entrée).

PC (souris, clavier) et tablette (doigt), thèmes sombre et clair. AUCUNE requête vers Supabase :
tout `*.supabase.co` est bloqué (route abort) et compté ; projet .zip LOCAL à l'audio synthétique,
ouvert par « Charger Projet » (pas de beat du catalogue).

Usage : serveur `npx vite --port 3486 --strictPort --host 127.0.0.1` dans le worktree, puis
  NOVA_URL=http://127.0.0.1:3486/ PYTHONIOENCODING=utf-8 python qa/protools_utiles.py [pc-sombre] [pc-clair] [tab-sombre] [tab-clair]
Sorties : D:\\1 WORK\\CONTENU\\nova-protools-utiles\\ (protools_utiles.json + captures)
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from nova_pro_lib import app_state, canvas_box, track_point  # noqa: E402  (géométrie seule, aucun réseau)

BASE = os.environ.get("NOVA_URL", "http://127.0.0.1:3486/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-protools-utiles"))
OUT.mkdir(parents=True, exist_ok=True)
CHROME = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
VIEWPORTS = {"pc": {"width": 1600, "height": 900}, "tab": {"width": 1024, "height": 768}}
SR, DUR = 44100, 12.0

# Bandeaux de Nova (toasts) vus pendant le scénario : un bandeau plus récent (sauvegarde auto…)
# peut remplacer le nôtre avant la lecture ; on garde donc tout ce qui s'est affiché.
TOAST_SPY = r"""
window.__toasts = [];
setInterval(() => { for (const e of document.querySelectorAll('[role=status]')) { const t = e.innerText; if (t && window.__toasts[window.__toasts.length - 1] !== t) window.__toasts.push(t); } }, 80);
"""

APP_MODULE_INIT = r"""
try { performance.setResourceTimingBufferSize(50000); } catch (e) {}
window.__novaAppModule = async (path) => {
  let best = null, bestT = -1;
  for (const e of performance.getEntriesByType('resource')) {
    let u; try { u = new URL(e.name); } catch (_) { continue; }
    if (u.origin !== location.origin || u.pathname !== path) continue;
    const t = +(u.searchParams.get('t') || 0);
    if (t >= bestT) { bestT = t; best = u.pathname + u.search; }
  }
  return import(/* @vite-ignore */ best || path);
};
"""

res = {"runs": {}, "supabase": {"bloquees": 0, "passees": 0, "exemples": []}}
CUR = {}


def ok(k, v, note=None):
    run = res["runs"].setdefault(CUR["run"], {})
    run[k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + f"[{CUR['run']}] {k}", "" if note is None else json.dumps(note, ensure_ascii=False)[:400], flush=True)
    return bool(v)


# ------------------------------------------------------------------ projet local
def wav_bytes(x):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return b.getvalue()


def make_project(path):
    n = int(SR * DUR); t = np.arange(n) / SR
    beat = np.zeros(n)
    for k in range(int(DUR * 2)):
        i0 = int(k * 0.5 * SR); m = min(n - i0, int(0.25 * SR)); tt = np.arange(m) / SR
        beat[i0:i0 + m] += 0.6 * np.sin(2 * np.pi * (60 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)
    lead = 0.3 * np.sin(2 * np.pi * 261.6 * t) * ((t > 1) & (t < 5))
    back = 0.2 * np.sin(2 * np.pi * 311.1 * t) * ((t > 2) & (t < 6))
    clic = np.zeros(n)
    for k in range(int(DUR * 2)):
        i0 = int(k * 0.5 * SR); clic[i0:i0 + 400] = 0.5 * np.sin(2 * np.pi * 2000 * np.arange(400) / SR)
    audio = {"beat": beat * 0.5, "lead": lead, "back": back, "clic": clic}

    def clip(cid, name, color, start=0.0, dur=DUR):
        return {"id": cid, "name": name, "type": "AUDIO", "start": start, "duration": dur, "offset": start, "audioRef": f"audio/{cid.split('-')[0]}.wav",
                "color": color, "fadeIn": 0, "fadeOut": 0, "gain": 1, "isMuted": False}

    def track(tid, name, typ="AUDIO", out="master", clips=None, **kw):
        return {"id": tid, "name": name, "type": typ, "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
                "isFrozen": False, "volume": 0.8, "pan": 0, "outputTrackId": out, "sends": [], "clips": clips or [],
                "plugins": [], "automationLanes": [], "totalLatency": 0, **kw}

    tracks = [
        track("beat", "Beat", clips=[clip("beat", "Beat", "#eab308")]),
        track("lead", "Voix lead", out="bus-vox", clips=[clip("lead-1", "Couplet", "#ef4444", 0, 6), clip("lead-2", "Refrain", "#f97316", 6, 6)],
              sends=[{"id": "send-verb", "level": 0.4, "isEnabled": True}]),
        track("back", "Backs", out="bus-vox", clips=[clip("back", "Backs", "#a855f7")]),
        track("clic", "Clic", clips=[clip("clic", "Clic", "#64748b")]),
        track("bus-vox", "Bus voix", typ="BUS"),
        track("send-verb", "Reverb", typ="SEND"),
        track("master", "MASTER", typ="BUS", out=""),
    ]
    state = {"id": "qa-pt-utiles", "name": "Utiles Pro Tools", "bpm": 120, "isPlaying": False, "isRecording": False, "currentTime": 0,
             "isLoopActive": False, "loopStart": 0, "loopEnd": 4, "tracks": tracks, "selectedTrackId": "lead", "currentView": "ARRANGEMENT",
             "timeSignature": {"numerator": 4, "denominator": 4}, "trackGroups": [], "markers": [],
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 1, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, x in audio.items():
            z.writestr(f"audio/{k}.wav", wav_bytes(x))


# ------------------------------------------------------------------ navigateur
def new_page(browser, vp, theme):
    ctx = browser.new_context(viewport=VIEWPORTS[vp], has_touch=(vp == "tab"), device_scale_factor=1, locale="fr-BE", accept_downloads=True)

    def block(route, req):
        res["supabase"]["bloquees"] += 1
        if len(res["supabase"]["exemples"]) < 5: res["supabase"]["exemples"].append(req.url[:110])
        return route.abort()
    # Production restreinte : aucune requête ne doit l'atteindre.
    ctx.route(re.compile(r"https?://[^/]*supabase\.co/.*"), block)
    ctx.add_init_script(APP_MODULE_INIT)
    ctx.add_init_script(TOAST_SPY)
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
    page = ctx.new_page()
    page.set_default_timeout(20000)
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.on("response", lambda r: res["supabase"].__setitem__("passees", res["supabase"]["passees"] + 1) if "supabase.co" in r.url else None)
    page._errs = errs
    return ctx, page


def close_welcome(page):
    for name in ("C'est parti", "Fermer", "Plus tard"):
        try:
            b = page.get_by_role("button", name=name, exact=True).locator("visible=true")
            if b.count(): b.first.click(timeout=1500); page.wait_for_timeout(300)
        except Exception:
            pass


def open_project(page, zpath, theme):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=40000)
    page.evaluate("""async (t) => { const { themeStore } = await window.__novaAppModule('/utils/themeStore.ts'); themeStore.setPref(t); }""", theme)
    page.get_by_text("Charger Projet").first.click()
    page.wait_for_timeout(600)
    with page.expect_file_chooser() as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(zpath))
    page.locator("[data-track-header='lead']").first.wait_for(timeout=40000)
    page.wait_for_timeout(1500)
    close_welcome(page)
    page.wait_for_timeout(500)
    close_welcome(page)


def st(page, expr):
    return app_state(page, expr)


def mod(page, path, expr):
    return page.evaluate(f"async () => {{ const m = await window.__novaAppModule('{path}'); return ({expr})(m); }}")


def body_has(page, rx, timeout=4000):
    """Message affiché : dans la page, ou dans un bandeau de Nova apparu depuis le dernier appel."""
    t0 = time.time()
    while time.time() - t0 < timeout / 1000:
        txt = page.evaluate("() => [document.body.innerText, ...(window.__toasts || [])].join(String.fromCharCode(10))")
        if re.search(rx, txt):
            page.evaluate("() => { window.__toasts = []; }")
            return True
        page.wait_for_timeout(150)
    return False


def tracks_flag(page, field):
    return st(page, f"s => s.tracks.filter(t => t.{field}).map(t => t.id)")


def silenced(page):
    return mod(page, "/engine/AudioEngine.ts", "m => [...(m.audioEngine.soloSilencedIds || [])].sort()")


def press_body(page, key):
    page.evaluate("() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); }")
    page.keyboard.press(key)
    page.wait_for_timeout(350)


def palette(page, query, touch):
    if touch:
        page.locator("[data-testid=open-palette]").locator("visible=true").first.tap()
    else:
        page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
    page.keyboard.type(query, delay=10)
    page.wait_for_timeout(200)
    first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
    page.keyboard.press("Enter")
    page.wait_for_timeout(450)
    return first


def header_btn(page, label):
    return page.get_by_role("button", name=label, exact=True).locator("visible=true").first


def select_track(page, tid):
    # Clic sur le nom (zone de l'en-tête sans bouton).
    h = page.locator(f"[data-track-header='{tid}']").first
    h.scroll_into_view_if_needed()
    bb = h.bounding_box()
    page.mouse.click(bb["x"] + 30, bb["y"] + 10)
    page.wait_for_timeout(250)


def clip_of(page, cid):
    return st(page, f"s => {{ for (const t of s.tracks) for (const c of t.clips) if (c.id === '{cid}') return {{ start: c.start, duration: c.duration, offset: c.offset, lock: c.lock || null }}; return null; }}")


def drag(page, x0, y0, dx, touch=False):
    page.mouse.move(x0, y0); page.mouse.down()
    for i in range(1, 9):
        page.mouse.move(x0 + dx * i / 8, y0); page.wait_for_timeout(25)
    page.mouse.up(); page.wait_for_timeout(500)


# ------------------------------------------------------------------ scénarios
def scen_solo(page, vp, theme):
    touch = vp == "tab"
    lead = header_btn(page, "Solo : Voix lead")
    (lead.tap() if touch else lead.click()); page.wait_for_timeout(400)
    ok("solo_lead", tracks_flag(page, "isSolo") == ["lead"])
    ok("indicateur_S1", page.locator("[data-testid=clear-solos]").locator("visible=true").count() > 0
       and "1" in page.locator("[data-testid=clear-solos]").first.inner_text())
    ok("moteur_solo_lead", silenced(page) == ["back", "beat", "clic"], silenced(page))
    # Solo safe : Ctrl+clic au PC ; palette au doigt (pas de Ctrl sur une tablette).
    if touch:
        select_track(page, "clic")
        got = palette(page, "solo safe", True)
        ok("palette_solo_safe", got == "pt.soloSafe", got)
    else:
        header_btn(page, "Solo : Clic").click(modifiers=["Control"]); page.wait_for_timeout(400)
    ok("solo_safe_pose", tracks_flag(page, "soloSafe") == ["clic"])
    ok("moteur_solo_safe", silenced(page) == ["back", "beat"], silenced(page))
    ok("bouton_solo_safe_visible", page.locator("[data-solo-safe='1']").locator("visible=true").count() > 0)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_solo_safe.png"))
    # Tout effacer : Alt+clic sur le S allumé (PC) ; l'indicateur au doigt.
    if touch:
        page.locator("[data-testid=clear-solos]").locator("visible=true").first.tap()
    else:
        header_btn(page, "Solo : Voix lead").click(modifiers=["Alt"])
    page.wait_for_timeout(400)
    ok("solos_effaces", tracks_flag(page, "isSolo") == [] and page.locator("[data-testid=clear-solos]").count() == 0)
    ok("message_solos", body_has(page, r"Solos effacés"))
    ok("moteur_tout_audible", silenced(page) == [])
    # Maj+S / Maj+M sur la piste sélectionnée.
    select_track(page, "back")
    press_body(page, "Shift+S")
    ok("maj_s", tracks_flag(page, "isSolo") == ["back"])
    press_body(page, "Shift+S")
    ok("maj_s_retour", tracks_flag(page, "isSolo") == [])
    press_body(page, "Shift+M")
    ok("maj_m", tracks_flag(page, "isMuted") == ["back"])
    # Alt+clic sur un M : toutes muettes ; l'indicateur rend le son d'un appui.
    if touch:
        got = palette(page, "effacer mutes", True)
        ok("palette_effacer_mutes", got == "pt.clearMutes", got)
        ok("mutes_effaces", tracks_flag(page, "isMuted") == [])
    else:
        header_btn(page, "Muet : Beat").click(modifiers=["Alt"]); page.wait_for_timeout(400)
        muted = tracks_flag(page, "isMuted")
        ok("alt_clic_muet_toutes", set(muted) >= {"beat", "lead", "back", "clic"} and "master" not in muted, muted)
        page.screenshot(path=str(OUT / f"{vp}_{theme}_indicateurs.png"))
        page.locator("[data-testid=clear-mutes]").locator("visible=true").first.click(); page.wait_for_timeout(400)
        ok("indicateur_M_efface", tracks_flag(page, "isMuted") == [])
        press_body(page, "Shift+M"); press_body(page, "Alt+Shift+M")
        ok("alt_maj_m", tracks_flag(page, "isMuted") == [])
    # Diodes de saturation (Alt+C).
    press_body(page, "Alt+C")
    ok("alt_c_diodes", body_has(page, r"Diodes de saturation éteintes"))
    # Console : indicateurs aussi (solo en cours).
    header_btn(page, "Solo : Voix lead").click(); page.wait_for_timeout(300)
    page.keyboard.press("Control+=") if not touch else palette(page, "console de mixage", True)
    page.wait_for_timeout(900)
    ok("console_indicateur", page.locator("[data-testid=clear-solos]").locator("visible=true").count() > 0)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_console.png"))
    page.locator("[data-testid=clear-solos]").locator("visible=true").first.click(); page.wait_for_timeout(300)
    ok("console_solos_effaces", tracks_flag(page, "isSolo") == [])
    if touch: palette(page, "arrangement", True)
    else: page.keyboard.press("Control+=")
    page.wait_for_timeout(900)


def scen_lock(page, vp, theme):
    touch = vp == "tab"
    before = clip_of(page, "lead-1")
    x, y = track_point(page, "lead", 3.0)
    page.mouse.click(x, y); page.wait_for_timeout(300)
    if touch:
        got = palette(page, "verrouiller clips", True)
        ok("palette_verrou", got == "pt.clipLock", got)
    else:
        press_body(page, "Control+l")
    ok("verrou_pose", clip_of(page, "lead-1")["lock"] == "edit", clip_of(page, "lead-1"))
    ok("message_verrou", body_has(page, r"verrouillé"))
    page.screenshot(path=str(OUT / f"{vp}_{theme}_clip_verrouille.png"))
    x, y = track_point(page, "lead", 3.0)
    page.mouse.click(x, y); page.wait_for_timeout(250)
    sel = mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.get().clipIds")
    ok("clic_selectionne_clip_verrouille", sel == ["lead-1"], sel)
    drag(page, x, y, 120)
    after = clip_of(page, "lead-1")
    ok("glisser_refuse", abs(after["start"] - before["start"]) < 1e-6, after)
    ok("message_glisser", body_has(page, r"ni rogné, ni retouché"))
    page.mouse.click(x, y); page.wait_for_timeout(200)
    press_body(page, "Delete")
    ok("suppr_refusee", clip_of(page, "lead-1") is not None)
    ok("message_suppr", body_has(page, r"rien n.a bougé"))
    # Déverrouiller : le clip se déplace.
    page.mouse.click(x, y); page.wait_for_timeout(200)
    if touch: palette(page, "verrouiller clips", True)
    else: press_body(page, "Control+l")
    ok("verrou_retire", clip_of(page, "lead-1")["lock"] is None)
    drag(page, x, y, 80)
    moved = clip_of(page, "lead-1")
    ok("glisser_libre", moved["start"] > before["start"] + 0.5, moved)
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    # Verrou de position : rogner oui (le son reste calé), déplacer non.
    x2, y2 = track_point(page, "lead", 9.0)
    page.mouse.click(x2, y2); page.wait_for_timeout(250)
    if touch: palette(page, "verrouiller position", True)
    else: press_body(page, "Alt+Shift+L")
    c2 = clip_of(page, "lead-2")
    ok("verrou_position", c2["lock"] == "time", c2)
    drag(page, x2, y2, 100)
    ok("position_tenue", abs(clip_of(page, "lead-2")["start"] - c2["start"]) < 1e-6)
    b = canvas_box(page)
    end_x = b["x"] + (c2["start"] + c2["duration"]) * 40 - b["sl"] - 2
    drag(page, end_x, y2, -60)
    c3 = clip_of(page, "lead-2")
    ok("rognage_permis", c3["duration"] < c2["duration"] - 0.3 and abs((c3["start"] - c3["offset"]) - (c2["start"] - c2["offset"])) < 1e-6, c3)
    # Menu du clip (clic droit) : les deux entrées de verrou.
    if not touch:
        page.mouse.click(x2 - 40, y2, button="right"); page.wait_for_timeout(400)
        ed = page.get_by_text("Édition", exact=True).locator("visible=true")
        if ed.count(): ed.first.hover(); page.wait_for_timeout(400)
        ok("menu_clip_verrou", page.get_by_text(re.compile("^Libérer la position$|^Verrouiller la position$")).locator("visible=true").count() > 0)
        page.screenshot(path=str(OUT / f"{vp}_{theme}_menu_clip.png"))
        page.keyboard.press("Escape"); page.wait_for_timeout(300)


def scen_track_clips(page, vp, theme):
    touch = vp == "tab"
    select_track(page, "lead")
    if touch:
        got = palette(page, "tous les clips de la piste", True)
        ok("palette_clips_piste", got == "pt.selectTrackClips", got)
    else:
        press_body(page, "Control+Alt+a")
    ids = mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.get().clipIds")
    ok("clips_de_la_piste", sorted(ids or []) == ["lead-1", "lead-2"], ids)
    ok("message_clips", body_has(page, r"2 clips sélectionnés"))
    if not touch:
        # Menu de la piste : entrée et solo safe.
        h = page.locator("[data-track-header='back']").first.bounding_box()
        page.mouse.click(h["x"] + 30, h["y"] + 10, button="right"); page.wait_for_timeout(400)
        ok("menu_piste", page.get_by_text("Sélectionner tous les clips de la piste").locator("visible=true").count() > 0
           and page.get_by_text(re.compile("Solo safe")).locator("visible=true").count() > 0)
        page.screenshot(path=str(OUT / f"{vp}_{theme}_menu_piste.png"))
        page.get_by_text("Sélectionner tous les clips de la piste").locator("visible=true").first.click(); page.wait_for_timeout(300)
        ids = mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.get().clipIds")
        ok("menu_piste_clips", ids == ["back"], ids)


def scen_palette(page, vp, theme):
    touch = vp == "tab"
    if touch:
        page.locator("[data-testid=open-palette]").locator("visible=true").first.tap()
    else:
        page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
    page.keyboard.type("solo", delay=10); page.wait_for_timeout(250)
    opts = page.locator("[data-testid=command-palette] [role=option]").evaluate_all("els => els.map(e => e.getAttribute('data-palette-id'))")
    ok("palette_solo", {"pt.clearSolos", "pt.soloSelected", "pt.soloSafe"} <= set(opts), opts[:8])
    page.screenshot(path=str(OUT / f"{vp}_{theme}_palette_solo.png"))
    page.keyboard.press("Escape"); page.wait_for_timeout(300)


def run(browser, vp, theme, zpath):
    CUR["run"] = f"{vp}-{theme}"
    res["runs"].setdefault(CUR["run"], {})
    ctx, page = new_page(browser, vp, theme)
    t0 = time.time()
    try:
        open_project(page, zpath, theme)
        ok("projet_ouvert", st(page, "s => s.tracks.length") == 7)
        for f in (scen_solo, scen_lock, scen_track_clips, scen_palette):
            try:
                f(page, vp, theme)
            except Exception as e:
                ok(f"{f.__name__}_exception", False, str(e)[:300])
                page.screenshot(path=str(OUT / f"{vp}_{theme}_{f.__name__}_erreur.png"))
        ok("aucune_erreur_page", not page._errs, page._errs[:3])
    finally:
        res["runs"][CUR["run"]]["_duree_s"] = round(time.time() - t0, 1)
        ctx.close()


if __name__ == "__main__":
    want = [a for a in sys.argv[1:] if not a.startswith("-")] or ["pc-sombre", "pc-clair", "tab-sombre", "tab-clair"]
    zpath = OUT / "projet_utiles.zip"
    make_project(zpath)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        for w in want:
            vp, th = w.split("-")
            run(browser, vp, {"sombre": "dark", "clair": "light"}[th], zpath)
        browser.close()
    fails = [f"{r}:{k}" for r, d in res["runs"].items() for k, v in d.items() if isinstance(v, dict) and not v["ok"]]
    res["echecs"] = fails
    ok_sb = res["supabase"]["passees"] == 0
    CUR["run"] = "global"
    ok("zero_requete_supabase_passee", ok_sb, res["supabase"])
    (OUT / "protools_utiles.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(fails)} échec(s)" + (" : " + ", ".join(fails) if fails else ""))
    sys.exit(1 if fails or not ok_sb else 0)
