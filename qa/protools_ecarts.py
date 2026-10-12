"""Écarts Pro Tools restants (12/10/2026) : preuves dans un navigateur headless, 100 % hors production.

  playlists : Nouvelle / Dupliquer la playlist (Ctrl+\\ et Ctrl+Alt+\\ dans le préréglage Pro Tools, menu de
              piste, palette), pastille dans l'en-tête, bascule Maj+← (Pro Tools), menu de la pastille ;
              sauvegarde .zip → rechargement : la version rangée garde ses clips ET leur son.
  écrire    : plage + fader réglé → Ctrl+/ (Write to Current) : palier exact sur la plage, courbe intacte
              ailleurs ; bouton « Écrire » de la barre de la plage (tablette).
  solo      : mode X-OR (palette) → un solo annule le précédent, badge « X-OR » ; Verrouiller → ils s'ajoutent.
  molette   : Ctrl+Maj+molette sur un clip → gain +1 dB pour 2 crans (PC).
  inserts   : glisser un insert sur une autre tranche : Alt = copie (réglages, nouvel id), préréglage Pro Tools
              sans Alt = déplacement ; envoi glissé = copié ; tablette : « Copier vers » dans le menu de l'insert.
  lot       : fenêtre « Commit / geler plusieurs pistes » : geler 2 pistes, les dégeler, commit d'une piste.
  entrées   : « Nommer les entrées » → « Micro cabine » affiché par le sélecteur d'entrée.
  palette   : chaque commande se trouve en français.

PC (souris, clavier) et tablette (doigt), thèmes sombre et clair. Le catalogue et Supabase sont simulés
(qa_hors_prod) : aucune requête ne part vers la production (vérifié à la fin).

Usage : serveur `npx vite --port 3493 --strictPort --host 127.0.0.1` dans le worktree, puis
  NOVA_URL=http://127.0.0.1:3493/ PYTHONIOENCODING=utf-8 python qa/protools_ecarts.py [pc-sombre] [pc-clair] [tab-sombre] [tab-clair]
Sorties : D:\\1 WORK\\CONTENU\\nova-protools-ecarts\\ (protools_ecarts.json + captures)
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from nova_pro_lib import app_state, track_point  # noqa: E402  (géométrie seule, aucun réseau)

BASE = os.environ.get("NOVA_URL", "http://127.0.0.1:3493/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-protools-ecarts"))
OUT.mkdir(parents=True, exist_ok=True)
CHROME = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
VIEWPORTS = {"pc": {"width": 1600, "height": 900}, "tab": {"width": 1024, "height": 768}}
SR, DUR = 44100, 12.0

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

res = {"runs": {}}
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


COMP = {"id": "fx-comp", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "latency": 0,
        "params": {"threshold": -18, "ratio": 4, "knee": 12, "attack": 0.003, "release": 0.25, "makeupGain": 1.6, "mix": 1,
                   "scHpFreq": 80, "lookahead": 0, "autoMakeup": False, "mode": "CLEAN", "isEnabled": True}}


def make_project(path):
    n = int(SR * DUR); t = np.arange(n) / SR
    beat = np.zeros(n)
    for k in range(int(DUR * 2)):
        i0 = int(k * 0.5 * SR); m = min(n - i0, int(0.25 * SR)); tt = np.arange(m) / SR
        beat[i0:i0 + m] += 0.6 * np.sin(2 * np.pi * (60 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)
    lead = 0.3 * np.sin(2 * np.pi * 261.6 * t) * ((t > 0.5) & (t < 11.5))
    back = 0.2 * np.sin(2 * np.pi * 311.1 * t) * ((t > 2) & (t < 10))
    audio = {"beat": beat * 0.5, "lead": lead, "back": back}

    def clip(cid, name, color, start=0.0, dur=DUR, ref=None):
        return {"id": cid, "name": name, "type": "AUDIO", "start": start, "duration": dur, "offset": start, "audioRef": f"audio/{ref or cid.split('-')[0]}.wav",
                "color": color, "fadeIn": 0, "fadeOut": 0, "gain": 1, "isMuted": False}

    def track(tid, name, typ="AUDIO", out="master", clips=None, **kw):
        return {"id": tid, "name": name, "type": typ, "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
                "isFrozen": False, "volume": 0.8, "pan": 0, "outputTrackId": out, "sends": [], "clips": clips or [],
                "plugins": [], "automationLanes": [], "totalLatency": 0, **kw}

    tracks = [
        track("beat", "Beat", clips=[clip("beat", "Beat", "#eab308")]),
        track("lead", "Voix lead", out="bus-vox", clips=[clip("lead-1", "Couplet", "#ef4444", 0, 6), clip("lead-2", "Refrain", "#f97316", 6, 6)],
              sends=[{"id": "send-verb", "level": 0.6, "isEnabled": True, "preFader": True}], plugins=[COMP]),
        track("back", "Backs", out="bus-vox", clips=[clip("back", "Backs", "#a855f7")], sends=[{"id": "send-verb", "level": 0, "isEnabled": True}]),
        track("bus-vox", "Bus voix", typ="BUS"),
        track("send-verb", "Reverb", typ="SEND"),
        track("master", "MASTER", typ="BUS", out=""),
    ]
    state = {"id": "qa-pt-ecarts", "name": "Écarts Pro Tools", "bpm": 120, "isPlaying": False, "isRecording": False, "currentTime": 0,
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

    ctx.add_init_script(APP_MODULE_INIT)
    ctx.add_init_script(TOAST_SPY)
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); localStorage.removeItem('nova_solo_mode'); localStorage.removeItem('nova_io_input_names'); }} catch (e) {{}}")
    page = ctx.new_page()
    page.set_default_timeout(20000)
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
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
    page.goto(BASE, wait_until="domcontentloaded", timeout=120000)
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
    t0 = time.time()
    while time.time() - t0 < timeout / 1000:
        txt = page.evaluate("() => [document.body.innerText, ...(window.__toasts || [])].join(String.fromCharCode(10))")
        if re.search(rx, txt):
            page.evaluate("() => { window.__toasts = []; }")
            return True
        page.wait_for_timeout(150)
    return False


def wait_for(page, expr, timeout=8000):
    t0 = time.time()
    while time.time() - t0 < timeout / 1000:
        v = st(page, expr)
        if v: return v
        page.wait_for_timeout(200)
    return st(page, expr)


def press_body(page, key):
    page.evaluate("() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); }")
    page.keyboard.press(key)
    page.wait_for_timeout(400)


def palette(page, query, touch):
    if touch:
        page.locator("[data-testid=open-palette]").locator("visible=true").first.tap()
    else:
        page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
    page.keyboard.type(query, delay=10)
    page.wait_for_timeout(250)
    first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    return first


def tap_or_click(loc, touch):
    (loc.tap() if touch else loc.click())


def select_track(page, tid):
    h = page.locator(f"[data-track-header='{tid}']").first
    h.scroll_into_view_if_needed()
    bb = h.bounding_box()
    page.mouse.click(bb["x"] + 30, bb["y"] + 10)
    page.wait_for_timeout(250)


def set_preset(page, pid):
    mod(page, "/utils/keymapStore.ts", f"m => m.keymapStore.setPreset('{pid}')")
    page.wait_for_timeout(200)


def playlists(page, tid="lead"):
    return st(page, f"""s => {{ const t = s.tracks.find(x => x.id === '{tid}'); if (!t) return null;
      return {{ active: t.activePlaylistId || null, clips: t.clips.map(c => c.id), names: (t.playlists || []).map(p => p.name),
               stored: (t.playlists || []).map(p => p.clips.length) }}; }}""")


def active_name(page, tid="lead"):
    return st(page, f"s => {{ const t = s.tracks.find(x => x.id === '{tid}'); const p = (t.playlists || []).find(p => p.id === t.activePlaylistId); return p ? p.name : t.name; }}")


def goto_mixer(page, touch):
    if touch: palette(page, "console de mixage", True)
    else: press_body(page, "Control+=")
    page.wait_for_timeout(900)


def goto_arrangement(page, touch):
    if touch: palette(page, "arrangement", True)
    else: press_body(page, "Control+=")
    page.wait_for_timeout(900)


# ------------------------------------------------------------------ scénarios
def scen_playlists(page, vp, theme):
    touch = vp == "tab"
    select_track(page, "lead")
    if touch:
        got = palette(page, "dupliquer la playlist", True)
        ok("palette_dupliquer", got == "pt.playlistDuplicate", got)
    else:
        set_preset(page, "protools")
        press_body(page, "Control+Alt+Backslash")
    p = playlists(page)
    ok("dupliquee_active", p and active_name(page) == "Voix lead.01" and len(p["clips"]) == 2 and all(c not in ("lead-1", "lead-2") for c in p["clips"]), p)
    ok("originale_gardee", p and p["names"] == ["Voix lead", "Voix lead.01"] and p["stored"] == [2, 0], p)
    ok("message_dupliquer", body_has(page, r"Playlist « Voix lead\.01 »"))
    chip = page.locator("[data-testid='playlist-chip-lead']").locator("visible=true")
    ok("pastille_visible", chip.count() > 0 and ".01" in chip.first.inner_text() and "Voix lead.01" in (chip.first.get_attribute("aria-label") or ""), chip.first.inner_text() if chip.count() else None)
    # Nouvelle playlist vide.
    if touch:
        got = palette(page, "nouvelle playlist", True)
        ok("palette_nouvelle", got == "pt.playlistNew", got)
    else:
        press_body(page, "Control+Backslash")
    p = playlists(page)
    ok("nouvelle_vide", p and active_name(page) == "Voix lead.02" and p["clips"] == [], p)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_playlist_vide.png"))
    # Revenir à la précédente : Maj+← (Pro Tools) au PC ; pastille au doigt.
    if touch:
        tap_or_click(page.locator("[data-testid='playlist-chip-lead']").locator("visible=true").first, True)
        page.locator("[data-testid='playlist-menu-lead']").wait_for(timeout=4000)
        page.screenshot(path=str(OUT / f"{vp}_{theme}_playlist_menu.png"))
        page.locator("[data-testid='playlist-menu-lead'] [data-playlist-id='pl-main']").first.tap()
        page.wait_for_timeout(500)
        ok("bascule_originale", active_name(page) == "Voix lead" and playlists(page)["clips"] == ["lead-1", "lead-2"], playlists(page))
    else:
        press_body(page, "Shift+ArrowLeft")
        ok("maj_gauche_recent", active_name(page) == "Voix lead.01", active_name(page))
        press_body(page, "Shift+ArrowUp")
        ok("maj_haut_precedente", active_name(page) == "Voix lead" and playlists(page)["clips"] == ["lead-1", "lead-2"], playlists(page))
        chip = page.locator("[data-testid='playlist-chip-lead']").locator("visible=true").first
        chip.click(); page.locator("[data-testid='playlist-menu-lead']").wait_for(timeout=4000)
        page.screenshot(path=str(OUT / f"{vp}_{theme}_playlist_menu.png"))
        ok("menu_trois_versions", page.locator("[data-testid='playlist-menu-lead'] [role=menuitemradio]").count() == 3)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        # Menu de la piste (clic droit sur l'en-tête).
        h = page.locator("[data-track-header='back']").first.bounding_box()
        page.mouse.click(h["x"] + 30, h["y"] + 10, button="right"); page.wait_for_timeout(400)
        ok("menu_piste_playlists", page.get_by_text("Dupliquer la playlist", exact=True).locator("visible=true").count() > 0
           and page.get_by_text("Nouvelle playlist (vide)", exact=True).locator("visible=true").count() > 0)
        page.screenshot(path=str(OUT / f"{vp}_{theme}_menu_piste.png"))
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        set_preset(page, "nova")
    # Ctrl+Z : une étape par geste.
    # Sauvegarde .zip → rechargement : la version rangée garde ses clips ET leur son.
    r = page.evaluate("""async () => {
      const { ProjectIO } = await window.__novaAppModule('/services/ProjectIO.ts');
      const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
      const s = window.__novaEdit.getState();
      const blob = await ProjectIO.saveProject(s, []);
      const back = await ProjectIO.loadProject(blob, { bufferPrefix: 'qa-' });
      const t = back.tracks.find(x => x.id === 'lead');
      const stored = (t.playlists || []).filter(p => p.id !== t.activePlaylistId);
      const clips = stored.flatMap(p => p.clips);
      return { names: (t.playlists || []).map(p => p.name), stored: stored.map(p => p.clips.length),
               sons: clips.map(c => !!(c.bufferId && audioBufferRegistry.get(c.bufferId))),
               dur: clips.map(c => { const b = c.bufferId && audioBufferRegistry.get(c.bufferId); return b ? Math.round(b.duration * 10) / 10 : 0; }) };
    }""")
    ok("sauvegarde_rechargement", r["names"] == ["Voix lead", "Voix lead.01", "Voix lead.02"] and sum(r["stored"]) == 2 and all(r["sons"]), r)


def scen_write(page, vp, theme):
    touch = vp == "tab"
    # Le refrain monté de +2 dB d'abord (courbe existante), puis le fader réglé à −6 dB et écrit sur 2-4 s.
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: { start: 0, end: 8, trackIds: ['lead'] }, clipIds: [] })")
    page.evaluate("() => window.__novaEdit.volumeRange(2)")
    page.wait_for_timeout(300)
    mod(page, "/utils/structureBus.ts", "m => m.applyTracks(ts => ts.map(t => t.id === 'lead' ? { ...t, volume: 0.5 } : t))")
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: { start: 2, end: 4, trackIds: ['lead'] }, clipIds: [] })")
    page.wait_for_timeout(300)
    if touch:
        page.get_by_role("button", name="Écrire", exact=True).locator("visible=true").first.tap()
        page.locator("[data-testid=range-write]").wait_for(timeout=4000)
        page.screenshot(path=str(OUT / f"{vp}_{theme}_ecrire_menu.png"))
        page.locator("[data-testid='range-pt.writeCurrent']").first.tap()
    else:
        press_body(page, "Control+Slash")
    page.wait_for_timeout(400)
    vals = mod(page, "/utils/automationWrite.ts", """m => { const s = window.__novaEdit.getState(); const t = s.tracks.find(x => x.id === 'lead');
      const l = t.automationLanes.find(x => x.parameterName === 'volume'); if (!l) return null;
      const at = (x) => Math.round(m.valueAtPoints(l.points, x, NaN) * 1000) / 1000; return { a1: at(1), a3: at(3), a5: at(5), a9: at(9), open: l.isExpanded }; }""")
    g = round(0.8 * 10 ** (2 / 20), 3)
    ok("ecrit_sur_plage", vals and abs(vals["a3"] - 0.5) < 1e-3 and abs(vals["a1"] - g) < 2e-3 and abs(vals["a5"] - g) < 2e-3 and abs(vals["a9"] - 0.8) < 2e-3 and vals["open"], {**(vals or {}), "attendu_hors_plage": g})
    ok("message_ecrire", body_has(page, r"Volume −6,0 dB écrit"))
    page.screenshot(path=str(OUT / f"{vp}_{theme}_ecrire_plage.png"))
    page.keyboard.press("Control+z"); page.wait_for_timeout(400)
    vals2 = mod(page, "/utils/automationWrite.ts", """m => { const t = window.__novaEdit.getState().tracks.find(x => x.id === 'lead');
      const l = t.automationLanes.find(x => x.parameterName === 'volume'); return l ? Math.round(m.valueAtPoints(l.points, 3, NaN) * 1000) / 1000 : null; }""")
    ok("annulable", vals2 is not None and abs(vals2 - g) < 2e-3, vals2)
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: null, clipIds: [] })")


def scen_solo(page, vp, theme):
    touch = vp == "tab"
    got = palette(page, "solo x-or", touch)
    ok("palette_xor", got == "pt.soloXor", got)
    ok("message_xor", body_has(page, r"Solo X-OR"))
    tap_or_click(page.get_by_role("button", name="Solo : Voix lead", exact=True).locator("visible=true").first, touch); page.wait_for_timeout(350)
    tap_or_click(page.get_by_role("button", name="Solo : Backs", exact=True).locator("visible=true").first, touch); page.wait_for_timeout(350)
    solos = st(page, "s => s.tracks.filter(t => t.isSolo).map(t => t.id)")
    ok("xor_un_seul_solo", solos == ["back"], solos)
    ok("badge_xor", page.locator("[data-testid=solo-xor-badge]").locator("visible=true").count() > 0)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_solo_xor.png"))
    palette(page, "solo verrouiller", touch)
    tap_or_click(page.get_by_role("button", name="Solo : Voix lead", exact=True).locator("visible=true").first, touch); page.wait_for_timeout(350)
    solos = st(page, "s => s.tracks.filter(t => t.isSolo).map(t => t.id).sort()")
    ok("verrouiller_s_ajoutent", solos == ["back", "lead"], solos)
    page.locator("[data-testid=clear-solos]").locator("visible=true").first.click(); page.wait_for_timeout(300)


def scen_wheel(page, vp, theme):
    if vp == "tab": return
    x, y = track_point(page, "lead", 2.0)
    page.mouse.move(x, y)
    page.keyboard.down("Control"); page.keyboard.down("Shift")
    page.mouse.wheel(0, -100); page.wait_for_timeout(40)
    page.mouse.wheel(0, -100)
    page.keyboard.up("Shift"); page.keyboard.up("Control")
    page.wait_for_timeout(500)
    g = st(page, "s => { const c = s.tracks.find(t => t.id === 'lead').clips.find(c => c.id === 'lead-1'); return c.gain; }")
    ok("molette_gain_plus_1dB", g is not None and abs(20 * np.log10(g) - 1.0) < 0.05, g)
    ok("molette_message", body_has(page, r"Gain du clip \+1\.0 dB"))
    z = st(page, "s => s.tracks.length")  # le zoom n'a pas bougé : la page tient
    page.keyboard.press("Control+z"); page.wait_for_timeout(300)


def _drag_js(page, src_sel, dst_sel, alt):
    """Glisser-déposer HTML5 par événements (même DataTransfer, Alt réglable)."""
    return page.evaluate("""([s, d, alt]) => {
      const src = document.querySelector(s), dst = document.querySelector(d);
      if (!src || !dst) return 'introuvable';
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, altKey: alt }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, altKey: alt }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return 'ok';
    }""", [src_sel, dst_sel, alt])


def plugins_of(page, tid):
    return st(page, f"s => s.tracks.find(t => t.id === '{tid}').plugins.map(p => ({{ id: p.id, type: p.type, ratio: p.params && p.params.ratio }}))")


def scen_inserts(page, vp, theme):
    touch = vp == "tab"
    goto_mixer(page, touch)
    if not touch:
        src = "[data-strip-id='lead'] [data-fx-id='fx-comp']"
        page.evaluate("() => { const e = document.querySelector(\"[data-strip-id='lead']\"); e && e.scrollIntoView({ inline: 'center' }); }")
        dst = "[data-strip-id='back'] button[aria-label^='Solo']"  # dans la tranche (le dépôt remonte jusqu'à elle)
        r = _drag_js(page, src, dst, True)
        page.wait_for_timeout(400)
        b, l = plugins_of(page, "back"), plugins_of(page, "lead")
        ok("alt_glisser_copie", r == "ok" and len(b) == 1 and b[0]["type"] == "COMPRESSOR" and b[0]["ratio"] == 4 and b[0]["id"] != "fx-comp" and len(l) == 1, {"r": r, "back": b, "lead": l})
        ok("message_copie", body_has(page, r"Effet copié"))
        page.screenshot(path=str(OUT / f"{vp}_{theme}_insert_copie.png"))
        page.keyboard.press("Control+z"); page.wait_for_timeout(400)
        set_preset(page, "protools")
        _drag_js(page, src, dst, False); page.wait_for_timeout(400)
        b, l = plugins_of(page, "back"), plugins_of(page, "lead")
        ok("pt_glisser_deplace", len(b) == 1 and b[0]["id"] == "fx-comp" and len(l) == 0, {"back": b, "lead": l})
        page.keyboard.press("Control+z"); page.wait_for_timeout(400)
        set_preset(page, "nova")
        # Envoi glissé (grip) : niveau et pré-fader repris.
        r = _drag_js(page, "[data-strip-id='lead'] [data-send-grip='send-verb']", dst, True)
        page.wait_for_timeout(400)
        s = st(page, "s => s.tracks.find(t => t.id === 'back').sends.find(x => x.id === 'send-verb')")
        ok("envoi_copie", r == "ok" and s and abs(s["level"] - 0.6) < 1e-6 and s.get("preFader") is True, {"r": r, "send": s})
        page.keyboard.press("Control+z"); page.wait_for_timeout(400)
    # Menu de l'insert (clic droit / appui long) : « Copier vers ».
    slot = page.locator("[data-strip-id='lead'] [data-fx-id='fx-comp']").first
    slot.scroll_into_view_if_needed()
    slot.click(button="right"); page.wait_for_timeout(400)
    item = page.get_by_text("Copier vers « Backs »", exact=True).locator("visible=true")
    ok("menu_copier_vers", item.count() > 0)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_insert_menu.png"))
    if item.count():
        tap_or_click(item.first, touch); page.wait_for_timeout(400)
        b = plugins_of(page, "back")
        ok("menu_copie_faite", len(b) == 1 and b[0]["type"] == "COMPRESSOR", b)
        page.keyboard.press("Control+z") if not touch else palette(page, "annuler", True)
        page.wait_for_timeout(400)
    goto_arrangement(page, touch)


def scen_batch(page, vp, theme):
    touch = vp == "tab"
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: { start: 0, end: 4, trackIds: ['lead', 'back'] }, clipIds: [] })")
    if touch:
        got = palette(page, "commit geler plusieurs", True)
        ok("palette_lot", got == "pt.batchRender", got)
    else:
        press_body(page, "Alt+Shift+C")
    dlg = page.locator("[data-testid=batch-render-dialog]")
    dlg.wait_for(timeout=6000)
    checked = page.evaluate("() => [...document.querySelectorAll('[data-testid=batch-render-dialog] input[type=checkbox]')].filter(i => i.checked).map(i => i.getAttribute('aria-label'))")
    ok("lot_precoche", sorted(checked) == ["Backs", "Voix lead"], checked)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_lot_fenetre.png"))
    tap_or_click(page.locator("[data-testid=batch-freeze]").first, touch)
    fr = wait_for(page, "s => ['lead', 'back'].every(id => s.tracks.find(t => t.id === id).isFrozen) && s.tracks.filter(t => t.isFrozen).map(t => t.id)", 30000)
    ok("lot_geler", fr and sorted(fr) == ["back", "lead"], fr)
    ok("lot_message", body_has(page, r"2 pistes gelées sur 2", 8000))
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: { start: 0, end: 4, trackIds: ['lead', 'back'] }, clipIds: [] })")
    palette(page, "degeler les pistes", touch)
    un = wait_for(page, "s => !s.tracks.some(t => t.isFrozen) && 'ok'", 15000)
    ok("lot_degeler", un == "ok", un)
    # Commit d'une piste par la fenêtre (une seule cochée).
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: { start: 0, end: 4, trackIds: ['back'] }, clipIds: [] })")
    palette(page, "commit geler plusieurs", touch)
    dlg.wait_for(timeout=6000)
    tap_or_click(page.locator("[data-testid=batch-commit]").first, touch)
    c = wait_for(page, "s => { const o = s.tracks.find(t => t.id === 'back'); const n = s.tracks.find(t => t.commit && t.commit.sourceTrackId === 'back'); return o && o.isInactive && o.isHidden && n ? n.name : null; }", 40000)
    ok("lot_commit", bool(c), c)
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: null, clipIds: [] })")
    page.keyboard.press("Control+z") if not touch else palette(page, "annuler", True)
    page.wait_for_timeout(600)


def scen_io(page, vp, theme):
    touch = vp == "tab"
    got = palette(page, "nommer les entrees", touch)
    ok("palette_entrees", got == "pt.ioSetup", got)
    page.locator("[data-testid=io-names-dialog]").wait_for(timeout=5000)
    f = page.locator("[data-testid=io-name-0]").first
    tap_or_click(f, touch); f.fill("Micro cabine")
    page.screenshot(path=str(OUT / f"{vp}_{theme}_entrees.png"))
    tap_or_click(page.locator("[data-testid=io-names-save]").first, touch)
    page.wait_for_timeout(400)
    names = mod(page, "/utils/ioNames.ts", "m => m.ioNamesStore.get()")
    ok("entree_nommee", names == {"0": "Micro cabine"}, names)
    # Le sélecteur d'entrée de la voix (console) l'affiche.
    mod(page, "/utils/structureBus.ts", "m => m.applyTracks(ts => ts.map(t => t.id === 'lead' ? { ...t, recordInput: { ch: 0 } } : t))")
    goto_mixer(page, touch)
    lab = page.locator("[data-testid='record-input-lead']").locator("visible=true")
    ok("selecteur_affiche_nom", lab.count() > 0 and "Micro cabine" in lab.first.inner_text(), lab.first.inner_text() if lab.count() else None)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_entree_console.png"))
    goto_arrangement(page, touch)


PALETTE = [
    ("nouvelle playlist", "pt.playlistNew"), ("dupliquer la playlist", "pt.playlistDuplicate"), ("playlist precedente", "pt.playlistPrev"),
    ("playlist suivante", "pt.playlistNext"), ("playlist d avant", "pt.playlistRecent"), ("ecrire le volume", "pt.writeCurrent"),
    ("ecrire tous les reglages", "pt.writeAll"), ("ecrire le pan", "pt.writePan"), ("solo x-or", "pt.soloXor"), ("solo verrouiller", "pt.soloLatch"),
    ("geler les pistes", "pt.freezeSelected"), ("degeler", "pt.unfreezeSelected"), ("commit plusieurs", "pt.batchRender"), ("nommer les entrees", "pt.ioSetup"),
]


def scen_palette(page, vp, theme):
    touch = vp == "tab"
    found = {}
    for q, want in PALETTE:
        if touch: page.locator("[data-testid=open-palette]").locator("visible=true").first.tap()
        else: page.keyboard.press("Control+k")
        page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
        page.keyboard.type(q, delay=5); page.wait_for_timeout(200)
        ids = page.locator("[data-testid=command-palette] [role=option]").evaluate_all("els => els.slice(0, 5).map(e => e.getAttribute('data-palette-id'))")
        found[q] = want in ids
        if q == "dupliquer la playlist": page.screenshot(path=str(OUT / f"{vp}_{theme}_palette.png"))
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
    ok("palette_francais", all(found.values()), {k: v for k, v in found.items() if not v} or "toutes trouvées")


def run(browser, vp, theme, zpath):
    CUR["run"] = f"{vp}-{theme}"
    res["runs"].setdefault(CUR["run"], {})
    ctx, page = new_page(browser, vp, theme)
    t0 = time.time()
    try:
        open_project(page, zpath, theme)
        ok("projet_ouvert", st(page, "s => s.tracks.length") == 6)
        for f in (scen_playlists, scen_write, scen_solo, scen_wheel, scen_inserts, scen_batch, scen_io, scen_palette):
            try:
                f(page, vp, theme)
            except Exception as e:
                ok(f"{f.__name__}_exception", False, str(e)[:300])
                page.screenshot(path=str(OUT / f"{vp}_{theme}_{f.__name__}_erreur.png"))
                page.keyboard.press("Escape"); page.wait_for_timeout(300)
        ok("aucune_erreur_page", not page._errs, page._errs[:3])
    finally:
        res["runs"][CUR["run"]]["_duree_s"] = round(time.time() - t0, 1)
        ctx.close()


if __name__ == "__main__":
    want = [a for a in sys.argv[1:] if not a.startswith("-")] or ["pc-sombre", "pc-clair", "tab-sombre", "tab-clair"]
    zpath = OUT / "projet_ecarts.zip"
    make_project(zpath)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        for w in want:
            vp, th = w.split("-")
            run(browser, vp, {"sombre": "dark", "clair": "light"}[th], zpath)
        browser.close()
    fails = [f"{r}:{k}" for r, d in res["runs"].items() for k, v in d.items() if isinstance(v, dict) and not v["ok"]]
    res["echecs"] = fails
    S = qa_hors_prod.STATS
    hors_prod = {"simulees": sum(S["simulees"].values()), "bloquees": len(S["bloquees"]), "reseau_prod": len(S["reseau_prod"]), "filet_dns": len(S["filet_dns"])}
    ok_sb = not S["bloquees"] and not S["reseau_prod"] and not S["filet_dns"]
    CUR["run"] = "global"
    ok("zero_requete_vers_la_production", ok_sb, hors_prod)
    res["hors_prod"] = hors_prod
    (OUT / "protools_ecarts.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(fails)} échec(s)" + (" : " + ", ".join(fails) if fails else ""))
    sys.exit(1 if fails or not ok_sb else 0)
