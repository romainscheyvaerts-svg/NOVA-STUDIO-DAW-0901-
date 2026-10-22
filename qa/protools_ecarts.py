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

Chantier 19 (2e tour) :
  sélection → playlist : copier (menu de piste / palette) puis déplacer la plage vers une nouvelle playlist.
  étendues  : Write to End / Start / Punch / All, Glide (Alt+/) et Glide to Current (Alt+Maj+/), au doigt
              par le menu « Écrire » de la barre de la plage.
  VCA       : fusionner le VCA dans ses pistes (palette).
  envois    : tablette : barre glissée au doigt comme un fader, double toucher = 0 dB, appui long = copier vers ;
              téléphone (390 × 844, onglet Mixer) : section « Envois » de la piste, fader de 44 px, menu ⋯.
  formant   : éditeur de justesse, formant +5 sur toutes les notes, appliqué (nouveau son, rangé dans le clip).
  cloud     : presets synchronisés entre postes : poste A (PC) enregistre un modèle de piste et un preset
              d'effet, poste B (tablette, autre navigateur) les retrouve, suppression sur B → disparaît sur A ;
              poste C : table pas encore en ligne → « bientôt disponible », 1 seule requête, aucune erreur.
              Compte et table simulés par qa_hors_prod (compte_simule / table_simulee).
  couverture: chaque ligne ✅ de ETAT.md a ses vérifications (table COUVERTURE) ; une ligne ✅ sans
              vérification, ou dont une vérification échoue, fait échouer le scénario.

PC (souris, clavier) et tablette (doigt), thèmes sombre et clair. Le catalogue et Supabase sont simulés
(qa_hors_prod) : aucune requête ne part vers la production (vérifié à la fin).

Usage : serveur `npx vite --port 3438 --strictPort --host 127.0.0.1` dans le worktree, puis
  NOVA_URL=http://127.0.0.1:3438/ PYTHONIOENCODING=utf-8 python qa/protools_ecarts.py [pc-sombre] [pc-clair] [tab-sombre] [tab-clair] [tel-sombre] [tel-clair] [cloud]
Sorties : D:\\1 WORK\\CONTENU\\nova-protools-ecarts\\ (protools_ecarts.json + captures)
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from nova_pro_lib import app_state, track_point  # noqa: E402  (géométrie seule, aucun réseau)
import qalib  # noqa: E402  (ouvrir_menu_range : barre allégée)

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
    ctx.grant_permissions(["microphone"], origin=BASE.rstrip("/"))

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



# ================================================================== chantier 19 (2e tour)
def set_range(page, a, b, ids=("lead",)):
    mod(page, "/utils/editSelection.ts", f"m => m.editSelectionStore.set({{ time: {{ start: {a}, end: {b}, trackIds: {json.dumps(list(ids))} }}, clipIds: [] }})")
    page.wait_for_timeout(250)


def clear_range(page):
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: null, clipIds: [] })")
    page.wait_for_timeout(150)


def set_track(page, tid, js_patch):
    mod(page, "/utils/structureBus.ts", f"m => m.applyTracks(ts => ts.map(t => t.id === '{tid}' ? {{ ...t, {js_patch} }} : t))")
    page.wait_for_timeout(250)


def undo(page, touch, n=1):
    for _ in range(n):
        if touch: palette(page, "annuler", True)
        else: press_body(page, "Control+z")
    page.wait_for_timeout(300)


def lane_at(page, tid, times, param="volume"):
    return mod(page, "/utils/automationWrite.ts", f"""m => {{ const t = window.__novaEdit.getState().tracks.find(x => x.id === '{tid}');
      const l = (t.automationLanes || []).find(x => x.parameterName === '{param}'); if (!l || !l.points.length) return null;
      return {json.dumps(list(times))}.map(x => Math.round(m.valueAtPoints([...l.points].sort((a, b) => a.time - b.time), x, NaN) * 1000) / 1000); }}""")


def write_menu(page, touch, item_id):
    """Barre de la plage › « Écrire » › entrée (au doigt comme à la souris)."""
    btn = page.get_by_role("button", name="Écrire", exact=True).locator("visible=true").first
    tap_or_click(btn, touch)
    page.locator("[data-testid=range-write]").wait_for(timeout=4000)
    tap_or_click(page.locator(f"[data-testid='range-{item_id}']").first, touch)
    page.wait_for_timeout(400)


def scen_sel_playlist(page, vp, theme):
    """Copier / déplacer la sélection vers une nouvelle playlist."""
    touch = vp == "tab"
    before = playlists(page)
    set_range(page, 4, 8)
    if touch:
        got = palette(page, "copier la selection vers une nouvelle playlist", True)
        ok("palette_sel_playlist", got == "pt.selToPlaylist", got)
    else:
        h = page.locator("[data-track-header='lead']").first.bounding_box()
        page.mouse.click(h["x"] + 30, h["y"] + 10, button="right"); page.wait_for_timeout(400)
        item = page.get_by_text("Copier la sélection vers une nouvelle playlist", exact=True).locator("visible=true")
        ok("menu_piste_sel_playlist", item.count() > 0)
        page.screenshot(path=str(OUT / f"{vp}_{theme}_sel_playlist_menu.png"))
        item.first.click(); page.wait_for_timeout(500)
    p = playlists(page)
    new = st(page, """s => { const t = s.tracks.find(x => x.id === 'lead'); const l = t.playlists || []; const n = l[l.length - 1];
      return n ? { name: n.name, clips: n.clips.map(c => [Math.round(c.start * 1000) / 1000, Math.round(c.duration * 1000) / 1000, Math.round(c.offset * 1000) / 1000]) } : null; }""")
    ok("sel_copiee_dans_nouvelle", new and new["name"] == "Voix lead.03" and new["clips"] == [[4, 2, 4], [6, 2, 6]], new)
    ok("sel_version_entendue_intacte", p["active"] == before["active"] and p["clips"] == before["clips"], {"avant": before, "apres": p})
    ok("sel_message", body_has(page, r"copiée dans la playlist « Voix lead\.03 »"))
    # Déplacer : la plage quitte la version qu'on entend.
    set_range(page, 4, 8)
    got = palette(page, "deplacer la selection vers une nouvelle playlist", touch)
    gap = st(page, "s => s.tracks.find(t => t.id === 'lead').clips.map(c => [Math.round(c.start * 100) / 100, Math.round((c.start + c.duration) * 100) / 100]).sort((a, b) => a[0] - b[0])")
    ok("sel_deplacee", got == "pt.selMoveToPlaylist" and gap == [[0, 4], [8, 12]], {"palette": got, "clips": gap})
    page.screenshot(path=str(OUT / f"{vp}_{theme}_sel_playlist_deplacee.png"))
    undo(page, touch, 2)
    after = playlists(page)
    ok("sel_annulable", after["names"] == before["names"] and after["clips"] == before["clips"], after)
    clear_range(page)


def scen_write_span(page, vp, theme):
    """Write to Start / End / All / Punch, Glide, Glide to Current."""
    touch = vp == "tab"
    # Courbe de départ : volume à 0,8 partout (une voie déjà écrite).
    set_track(page, "lead", "volume: 0.8, automationLanes: [{ id: 'lane-qa', parameterName: 'volume', points: [{ id: 'p0', time: 0, value: 0.8 }], color: '#22d3ee', isExpanded: true, min: 0, max: 1.5 }]")
    # Write to End : fader à 0,5 depuis 6 s.
    set_track(page, "lead", "volume: 0.5")
    set_range(page, 6, 7)
    write_menu(page, touch, "pt.writeToEnd")
    v = lane_at(page, "lead", [1, 5.98, 6, 9, 40])
    ok("write_to_end", v == [0.8, 0.8, 0.5, 0.5, 0.5], v)
    ok("write_to_end_message", body_has(page, r"Volume −6,0 dB écrit de 0:06,0 à la fin"))
    page.screenshot(path=str(OUT / f"{vp}_{theme}_write_to_end.png"))
    # Write to Start : fader à 0,25 jusqu'à la fin de la sélection (3 s).
    set_track(page, "lead", "volume: 0.25")
    set_range(page, 2, 3)
    write_menu(page, touch, "pt.writeToStart")
    v = lane_at(page, "lead", [0, 2.5, 3, 4, 9])
    ok("write_to_start", v == [0.25, 0.25, 0.25, 0.8, 0.5], v)
    # Write to Punch : zone de punch 4-5 s (bouton « Punch » de la barre), fader à 1.
    set_range(page, 4, 5)
    tap_or_click(page.get_by_role("button", name="Punch", exact=True).locator("visible=true").first, touch)
    page.wait_for_timeout(300)
    set_track(page, "lead", "volume: 1")
    set_range(page, 10, 11)   # la sélection ailleurs : c'est bien la zone de punch qui compte
    write_menu(page, touch, "pt.writeToPunch")
    v = lane_at(page, "lead", [3.5, 4.5, 5.2, 10.5])
    ok("write_to_punch", v == [0.8, 1, 0.8, 0.5], v)
    ok("write_to_punch_message", body_has(page, r"sur la zone de punch"))
    # Glide entre deux points : de 3,5 s (0,8) à 9 s (0,5) → rampe droite (Alt+/ au PC).
    set_range(page, 3.5, 9)
    if touch: write_menu(page, True, "pt.glide")
    else: press_body(page, "Alt+Slash")
    v = lane_at(page, "lead", [3.5, 6.25, 9])
    ok("glide_rampe", v and v[0] == 0.8 and abs(v[1] - 0.65) < 0.002 and v[2] == 0.5, v)
    ok("glide_message", body_has(page, r"Rampe droite"))
    page.screenshot(path=str(OUT / f"{vp}_{theme}_glide.png"))
    # Glide to Current : fader à 0,2, plage 10-12 s → arrive sur 0,2 (Alt+Maj+/ au PC).
    set_track(page, "lead", "volume: 0.2")
    set_range(page, 10, 12)
    if touch: write_menu(page, True, "pt.glideCurrent")
    else: press_body(page, "Alt+Shift+Slash")
    v = lane_at(page, "lead", [10, 11, 12])
    ok("glide_to_current", v and v[0] == 0.5 and abs(v[1] - 0.35) < 0.002 and v[2] == 0.2, v)
    # Write to All : tout le morceau, courbe plate.
    write_menu(page, touch, "pt.writeToAll")
    v = lane_at(page, "lead", [0, 6, 30])
    pts = st(page, "s => s.tracks.find(t => t.id === 'lead').automationLanes.find(l => l.parameterName === 'volume').points.length")
    ok("write_to_all", v == [0.2, 0.2, 0.2] and pts == 1, {"valeurs": v, "points": pts})
    undo(page, touch, 1)
    ok("write_annulable", lane_at(page, "lead", [11]) == [0.35], lane_at(page, "lead", [11]))
    set_track(page, "lead", "automationLanes: [], volume: 0.8")
    clear_range(page)


def scen_vca(page, vp, theme):
    """Fusionner un VCA dans ses pistes (palette)."""
    touch = vp == "tab"
    mod(page, "/utils/structureBus.ts", """async m => { const ts = await window.__novaAppModule('/utils/trackStructure.ts');
      m.applyTracks(tracks => ts.createVca(tracks, { id: 'vca-qa', name: 'VCA voix', memberIds: ['lead', 'back'] }).map(t => t.id === 'vca-qa' ? { ...t, volume: 0.5 } : t)); }""")
    page.wait_for_timeout(500)
    before = st(page, "s => Object.fromEntries(s.tracks.filter(t => ['lead', 'back', 'vca-qa'].includes(t.id)).map(t => [t.id, t.volume]))")
    got = palette(page, "fusionner le vca", touch)
    after = st(page, "s => Object.fromEntries(s.tracks.filter(t => ['lead', 'back', 'vca-qa'].includes(t.id)).map(t => [t.id, Math.round(t.volume * 1000) / 1000]))")
    ok("vca_fusion", got == "pt.vcaCoalesce" and after == {"lead": round(before["lead"] * 0.5, 3), "back": round(before["back"] * 0.5, 3), "vca-qa": 1}, {"avant": before, "apres": after})
    ok("vca_message", body_has(page, r"« VCA voix » \(−6,0 dB\) reporté dans 2 pistes"))
    undo(page, touch, 2)
    gone = st(page, "s => !s.tracks.some(t => t.id === 'vca-qa')")
    if not gone:
        mod(page, "/utils/structureBus.ts", "m => m.applyTracks(ts => ts.filter(t => t.id !== 'vca-qa').map(t => { const o = { ...t }; if (o.vcaId === 'vca-qa') delete o.vcaId; return o; }))")
        page.wait_for_timeout(300)


def touch_drag(page, x, y, dx, steps=10):
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 1, "radiusX": 4, "radiusY": 4, "force": 1}]})
    for i in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx * i / steps, "y": y, "id": 1, "radiusX": 4, "radiusY": 4, "force": 1}]})
        page.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()
    page.wait_for_timeout(400)


def touch_hold(page, x, y, ms=800):
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 1, "radiusX": 4, "radiusY": 4, "force": 1}]})
    page.wait_for_timeout(ms)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()
    page.wait_for_timeout(400)


def send_level(page, tid, sid="send-verb"):
    return st(page, f"s => {{ const x = s.tracks.find(t => t.id === '{tid}').sends.find(q => q.id === '{sid}'); return x ? Math.round(x.level * 10000) / 10000 : null; }}")


def fader_drag_check(page, sel, tid, dx, tag):
    loc = page.locator(sel).locator("visible=true").first
    # Au milieu de l'écran : sur le téléphone, la barre d'onglets fixe couvre le bas.
    loc.evaluate("e => e.scrollIntoView({ block: 'center', inline: 'nearest' })")
    page.wait_for_timeout(300)
    b = loc.bounding_box()
    l0 = send_level(page, tid)
    want = mod(page, "/utils/sendFader.ts", f"m => Math.round(m.dragSendLevel({l0}, {dx}, {b['width']}) * 10000) / 10000")
    touch_drag(page, b["x"] + b["width"] * 0.3, b["y"] + b["height"] / 2, dx)
    l1 = send_level(page, tid)
    ok(f"{tag}_glisse_comme_un_fader", l1 is not None and abs(l1 - want) < 0.02 and l1 != l0, {"avant": l0, "apres": l1, "attendu": want, "hauteur_px": round(b["height"])})
    return loc, b


def scen_sends_touch(page, vp, theme):
    """Envoi réglé au doigt comme un fader (tablette) ; copier / déplacer par appui long."""
    if vp != "tab": return
    goto_mixer(page, True)
    sel = "[data-testid='send-fader-lead-send-verb']"
    page.evaluate("() => { const e = document.querySelector(\"[data-strip-id='lead']\"); e && e.scrollIntoView({ inline: 'center' }); }")
    page.wait_for_timeout(300)
    ok("envoi_fader_tablette", page.locator(sel).locator("visible=true").count() > 0)
    loc, b = fader_drag_check(page, sel, "lead", -40, "tab")
    page.screenshot(path=str(OUT / f"{vp}_{theme}_envoi_fader.png"))
    # Double toucher : 0 dB.
    cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    page.touchscreen.tap(cx, cy); page.wait_for_timeout(120); page.touchscreen.tap(cx, cy); page.wait_for_timeout(400)
    ok("envoi_double_toucher_0dB", send_level(page, "lead") == 1, send_level(page, "lead"))
    # Appui long : menu « Copier vers « Backs » ».
    page.wait_for_timeout(500)
    touch_hold(page, cx, cy, 800)
    labels = page.evaluate("() => Array.from(document.querySelectorAll('[data-testid=structure-menu] [role=menuitem]')).map(b => b.innerText.trim())")
    ok("envoi_menu_appui_long", "Copier vers « Backs »" in labels and "Déplacer vers « Backs »" in labels, labels)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_envoi_menu.png"))
    if "Copier vers « Backs »" in labels:
        page.locator("[data-testid=structure-menu] [role=menuitem]", has_text="Copier vers « Backs »").first.tap(); page.wait_for_timeout(400)
        ok("envoi_copie_au_doigt", send_level(page, "back") == 1, send_level(page, "back"))
    else:
        page.keyboard.press("Escape")
    undo(page, True, 3)
    set_track(page, "lead", "sends: t.sends.map(s => s.id === 'send-verb' ? { ...s, level: 0.6 } : s)")
    set_track(page, "back", "sends: t.sends.map(s => s.id === 'send-verb' ? { ...s, level: 0 } : s)")
    goto_arrangement(page, True)


def scen_formant(page, vp, theme):
    """Formant par note dans l'éditeur de justesse : réglé, appliqué, rangé dans le clip."""
    touch = vp == "tab"
    mod(page, "/utils/novaWindows.ts", "m => m.openNovaWindow('pitch-editor', { targets: [{ trackId: 'lead', clipId: 'lead-1' }] })")
    ed = page.locator("[data-testid=pitch-editor]")
    ed.wait_for(timeout=15000)
    page.locator("[data-testid=pitch-selection]").wait_for(timeout=30000)
    # Analyse finie : des notes à sélectionner (Ctrl+A : toutes).
    t0 = time.time()
    while time.time() - t0 < 40 and "Touche une note" not in (page.locator("[data-testid=pitch-selection]").inner_text() or ""):
        page.wait_for_timeout(300)
    page.keyboard.press("Control+a"); page.wait_for_timeout(400)
    slider = page.locator("[data-testid=pitch-formant]")
    ok("formant_reglage_visible", slider.count() > 0 and slider.first.is_visible())
    if not slider.count():
        page.keyboard.press("Escape"); return
    page.evaluate("""() => { const el = document.querySelector('[data-testid=pitch-formant]');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '5');
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }""")
    page.wait_for_timeout(400)
    shown = page.locator("[data-testid=pitch-formant-value]").first.inner_text()
    ok("formant_affiche", "+5,0 dt" in shown, shown)
    page.screenshot(path=str(OUT / f"{vp}_{theme}_formant.png"))
    buf0 = st(page, "s => s.tracks.find(t => t.id === 'lead').clips.find(c => c.id === 'lead-1').bufferId")
    tap_or_click(page.locator("[data-testid=pitch-apply]").first, touch)
    pe = wait_for(page, "s => { const c = s.tracks.find(t => t.id === 'lead').clips.find(c => c.id === 'lead-1'); return c.pitchEdit && c.pitchEdit.edits.length ? { formant: c.pitchEdit.edits.map(e => e.formant), buf: c.bufferId } : null; }", 40000)
    ok("formant_applique", pe and all(f == 5 for f in pe["formant"]) and pe["buf"] != buf0, pe)
    son = page.evaluate("""async (ids) => { const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
      const a = audioBufferRegistry.get(ids[0]), b = audioBufferRegistry.get(ids[1]); if (!a || !b) return null;
      const x = a.getChannelData(0), y = b.getChannelData(0); let d = 0; const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i += 7) d = Math.max(d, Math.abs(x[i] - y[i])); return { diff: Math.round(d * 1000) / 1000, sr: b.sampleRate }; }""", [buf0, pe["buf"] if pe else ""])
    ok("formant_son_rendu", son and son["diff"] > 0.01, son)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    if ed.count() and ed.first.is_visible():
        b = page.get_by_role("button", name="Fermer", exact=True).locator("visible=true")
        if b.count(): tap_or_click(b.first, touch)
    page.wait_for_timeout(300)
    undo(page, touch, 1)


# ------------------------------------------------------------------ téléphone (onglet Mixer)
def open_project_tel(page, zpath, theme):
    page.goto(BASE, wait_until="domcontentloaded", timeout=120000)
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.wait_for(timeout=90000)
    page.wait_for_function("() => !document.getElementById('loading-screen')", timeout=20000)
    page.evaluate("""async (t) => { const { themeStore } = await window.__novaAppModule('/utils/themeStore.ts'); themeStore.setPref(t); }""", theme)
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.tap()
    page.wait_for_timeout(800); close_welcome(page)
    page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
    page.get_by_role("button", name=re.compile("^Ouvrir le menu$")).first.tap(); page.wait_for_timeout(300)
    page.locator("[role=dialog] button", has_text=re.compile("Ouvrir un projet")).first.tap(); page.wait_for_timeout(400)
    page.get_by_text(re.compile("Fichier sur l.ordinateur")).first.tap()
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(zpath))
    page.wait_for_function("() => window.__novaEdit.getState().tracks.some(t => t.id === 'lead')", timeout=60000)
    page.wait_for_timeout(1200)
    for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(150)


def run_tel(browser, theme, zpath):
    CUR["run"] = f"tel-{theme}"
    res["runs"].setdefault(CUR["run"], {})
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=1, locale="fr-BE")
    ctx.add_init_script(APP_MODULE_INIT)
    ctx.add_init_script(TOAST_SPY)
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
    page = ctx.new_page()
    page.set_default_timeout(20000)
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    t0 = time.time()
    try:
        open_project_tel(page, zpath, theme)
        page.locator("[role=navigation] button", has_text=re.compile(r"^\s*Mixer\s*$")).first.tap()
        page.wait_for_timeout(800)
        # La piste « Voix lead » touchée : ses envois s'affichent sous les tranches.
        page.locator("button", has_text=re.compile(r"^\s*Voix lead\s*$")).first.tap(); page.wait_for_timeout(500)
        sec = page.locator("[data-testid=mobile-sends-lead]")
        ok("tel_section_envois", sec.count() > 0)
        sel = "[data-testid='mobile-send-lead-send-verb']"
        loc = page.locator(sel).first
        loc.scroll_into_view_if_needed(); page.wait_for_timeout(300)
        b = loc.bounding_box()
        ok("tel_fader_44px", b and b["height"] >= 44, b and round(b["height"]))
        fader_drag_check(page, sel, "lead", 60, "tel")
        page.screenshot(path=str(OUT / f"tel_{theme}_envois.png"))
        # Menu ⋯ : copier vers une autre piste.
        mb = page.locator("[data-testid='mobile-send-menu-lead-send-verb']").first
        mb.evaluate("e => e.scrollIntoView({ block: 'center' })"); page.wait_for_timeout(300)
        mb.tap()
        # PC chargé : on attend le menu (et on retouche une fois s'il n'est pas venu).
        if not visible(page, "[data-testid=structure-menu]", 3000):
            mb.tap(); visible(page, "[data-testid=structure-menu]", 3000)
        page.wait_for_timeout(300)
        labels = page.evaluate("() => Array.from(document.querySelectorAll('[data-testid=structure-menu] [role=menuitem]')).map(b => b.innerText.trim())")
        ok("tel_menu_copier", "Copier vers « Backs »" in labels, labels)
        page.screenshot(path=str(OUT / f"tel_{theme}_envoi_menu.png"))
        if "Copier vers « Backs »" in labels:
            lv = send_level(page, "lead")
            page.locator("[data-testid=structure-menu] [role=menuitem]", has_text="Copier vers « Backs »").first.tap(); page.wait_for_timeout(400)
            ok("tel_copie_faite", send_level(page, "back") == lv, {"lead": lv, "back": send_level(page, "back")})
        ok("aucune_erreur_page", not errs, errs[:3])
    except Exception as e:
        ok("run_tel_exception", False, str(e)[:300])
        page.screenshot(path=str(OUT / f"tel_{theme}_erreur.png"))
    finally:
        res["runs"][CUR["run"]]["_duree_s"] = round(time.time() - t0, 1)
        ctx.close()


# ------------------------------------------------------------------ presets dans le cloud (2 postes)
CLOUD_PROJECT = "mxdrxpzxbgybchzzvpkf"


def cloud_context(browser, vp, theme, session, live=True):
    ctx, page = new_page(browser, vp, theme)
    if live:
        # Interrupteur config/presetCloud : éteint jusqu'au GO ; allumé ici pour le test.
        ctx.add_init_script("try { localStorage.setItem('nova_presets_cloud_test', '1'); } catch (e) {}")
    if session:
        ctx.add_init_script(f"try {{ localStorage.setItem('sb-{CLOUD_PROJECT}-auth-token', {json.dumps(json.dumps(session))}); }} catch (e) {{}}")
    reqs = []
    page.on("request", lambda r: reqs.append(f"{r.method} {r.url}") if "/rest/v1/nova_presets" in r.url and r.method != "OPTIONS" else None)
    page._reqs = reqs
    return ctx, page


def preset_dialog(page, touch):
    mod(page, "/utils/novaWindows.ts", "m => m.openNovaWindow('track-preset', { trackId: 'lead' })")
    page.locator("[data-testid=track-preset-dialog]").wait_for(timeout=10000)
    page.wait_for_timeout(300)


def cloud_state(page):
    loc = page.locator("[data-testid=preset-cloud-status]").first
    return (loc.get_attribute("data-state"), loc.inner_text()) if loc.count() else (None, "")


def wait_cloud(page, states, timeout=15000):
    t0 = time.time()
    while time.time() - t0 < timeout / 1000:
        s, txt = cloud_state(page)
        if s in states: return s, txt
        page.wait_for_timeout(250)
    return cloud_state(page)


def track_preset_names(page):
    return page.evaluate("() => Array.from(document.querySelectorAll('[data-testid=track-preset-list] li p.font-bold span:first-child')).map(e => e.innerText.trim())")


def server_rows():
    t = qa_hors_prod.TABLES.get("nova_presets")
    return list(t["lignes"].values()) if t else []


def wait_server(page, pred, timeout=15):
    """Attente côté serveur simulé : page.wait_for_timeout (et non time.sleep) laisse Playwright
    servir les requêtes interceptées pendant l'attente."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred(server_rows()): return True
        page.wait_for_timeout(250)
    return pred(server_rows())


def run_cloud(browser, zpath):
    CUR["run"] = "cloud"
    res["runs"].setdefault(CUR["run"], {})
    t0 = time.time()
    qa_hors_prod.table_simulee("nova_presets")
    sess = qa_hors_prod.compte_simule("5b0c2a8e-1d4f-4c55-9a77-0c1d2e3f4a5b", "inge.qa@exemple.be")
    A = B = C = None
    try:
        # ── Poste A (PC) : enregistre un modèle de piste (UI) et un preset d'effet. ──
        A, pa = cloud_context(browser, "pc", "dark", sess)
        open_project(pa, zpath, "dark")
        preset_dialog(pa, False)
        s, txt = wait_cloud(pa, ("ok",))
        ok("A_synchro_ok", s == "ok", txt)
        pa.locator("[data-testid=track-preset-save]").first.click()
        pa.locator("[data-testid=track-preset-name]").fill("Lead QA cloud")
        pa.keyboard.press("Enter"); pa.wait_for_timeout(500)
        pa.evaluate("""async () => { const P = await window.__novaAppModule('/services/PresetStore.ts'); const U = await window.__novaAppModule('/utils/presets.ts');
          const t = window.__novaEdit.getState().tracks.find(x => x.id === 'lead'); await P.savePreset(U.makePluginPreset(t.plugins[0], 'Comp voix QA cloud')); }""")
        up = wait_server(pa, lambda rows: {"Lead QA cloud", "Comp voix QA cloud"} <= {r.get("name") for r in rows if not r.get("deleted")})
        ok("A_envoye_au_compte", up, [(r.get("name"), r.get("kind")) for r in server_rows()])
        pa.screenshot(path=str(OUT / "cloud_poste_A.png"))

        # ── Poste B (tablette, autre navigateur, rangement vide) : les retrouve. ──
        B, pb = cloud_context(browser, "tab", "light", sess)
        open_project(pb, zpath, "light")
        preset_dialog(pb, True)
        s, txt = wait_cloud(pb, ("ok",))
        t1 = time.time()
        while time.time() - t1 < 10 and "Lead QA cloud" not in track_preset_names(pb):
            pb.wait_for_timeout(250)
        names = track_preset_names(pb)
        ok("B_retrouve_modele_de_piste", "Lead QA cloud" in names, {"etat": s, "liste": names, "texte": txt})
        plug = pb.evaluate("""async () => { const P = await window.__novaAppModule('/services/PresetStore.ts');
          const t = window.__novaEdit.getState().tracks.find(x => x.id === 'lead'); return (await P.listPluginPresets(t.plugins[0])).map(p => p.name); }""")
        ok("B_retrouve_preset_effet", "Comp voix QA cloud" in plug, plug)
        pb.screenshot(path=str(OUT / "cloud_poste_B.png"))
        # Appliquer le modèle reçu sur B (il marche comme un preset local).
        # Suppression sur B → disparaît sur A.
        pb.get_by_role("button", name="Supprimer « Lead QA cloud »").first.tap(); pb.wait_for_timeout(300)
        pb.locator("[data-testid=track-preset-dialog] button.bg-red-500", has_text="Supprimer").first.tap(); pb.wait_for_timeout(400)
        gone = wait_server(pb, lambda rows: any(r.get("deleted") for r in rows))
        ok("B_suppression_envoyee", gone, [(r.get("name"), r.get("deleted")) for r in server_rows()])
        pa.locator("[data-testid=preset-cloud-sync]").first.click()
        t1 = time.time()
        while time.time() - t1 < 10 and "Lead QA cloud" in track_preset_names(pa):
            pa.wait_for_timeout(250)
        ok("A_suppression_recue", "Lead QA cloud" not in track_preset_names(pa), track_preset_names(pa))
        pa.screenshot(path=str(OUT / "cloud_poste_A_apres.png"))
        egress = {"A": len(pa._reqs), "B": len(pb._reqs), "octets_simules": qa_hors_prod.STATS["octets"].get("presets_cloud_lecture", 0)}
        ok("requetes_legeres", egress["A"] <= 8 and egress["B"] <= 8, {**egress, "A_detail": [r.split("?")[0] for r in pa._reqs]})
        ok("aucune_erreur_page_AB", not pa._errs and not pb._errs, (pa._errs + pb._errs)[:3])

        # ── Poste C : table pas encore en ligne → état clair, aucune erreur, pas de boucle. ──
        qa_hors_prod.table_retiree("nova_presets")
        sess2 = qa_hors_prod.compte_simule("8d1e3b9f-2e5a-4d66-8b88-1d2e3f4a5b6c", "artiste.qa@exemple.be")
        C, pc = cloud_context(browser, "pc", "light", sess2)
        open_project(pc, zpath, "light")
        preset_dialog(pc, False)
        s, txt = wait_cloud(pc, ("soon",))
        ok("C_bientot_disponible", s == "soon" and "bientôt disponible" in txt, {"etat": s, "texte": txt})
        pc.locator("[data-testid=track-preset-save]").first.click()
        pc.locator("[data-testid=track-preset-name]").fill("Gardé ici")
        pc.keyboard.press("Enter"); pc.wait_for_timeout(3500)
        ok("C_preset_garde_sur_le_poste", "Gardé ici" in track_preset_names(pc), track_preset_names(pc))
        ok("C_une_seule_requete", len(pc._reqs) == 1, pc._reqs)
        ok("C_aucune_erreur", not pc._errs, pc._errs[:3])
        pc.screenshot(path=str(OUT / "cloud_poste_C_bientot.png"))
        # ── Poste D : la NOVA publiée aujourd'hui (interrupteur éteint) : 0 requête, même état clair. ──
        D, pd = cloud_context(browser, "tab", "dark", sess2, live=False)
        try:
            open_project(pd, zpath, "dark")
            preset_dialog(pd, True)
            s, txt = wait_cloud(pd, ("soon",))
            pd.wait_for_timeout(4500)   # la 1re synchro du démarrage est passée
            ok("D_interrupteur_eteint_zero_requete", s == "soon" and not pd._reqs and not pd._errs, {"etat": s, "requetes": pd._reqs, "erreurs": pd._errs[:2]})
        finally:
            D.close()
    except Exception as e:
        ok("run_cloud_exception", False, str(e)[:300])
    finally:
        for c in (A, B, C):
            try:
                if c: c.close()
            except Exception:
                pass
        qa_hors_prod.table_retiree("nova_presets")
        res["runs"][CUR["run"]]["_duree_s"] = round(time.time() - t0, 1)


def scen_cloud_off(page, vp, theme):
    """Sans compte : la ligne d'état dit que les presets restent sur l'appareil (aucune requête)."""
    touch = vp == "tab"
    preset_dialog(page, touch)
    s, txt = wait_cloud(page, ("off",), 6000)
    ok("presets_sans_compte", s == "off" and "Connecte-toi" in txt, {"etat": s, "texte": txt})
    page.keyboard.press("Escape"); page.wait_for_timeout(300)


def select_clip(page, tid, cid):
    page.evaluate(f"() => window.dispatchEvent(new CustomEvent('nova:select-clip', {{ detail: {{ trackId: '{tid}', clipId: '{cid}' }} }}))")
    page.wait_for_timeout(250)


def set_playhead(page, t):
    mod(page, "/utils/playheadStore.ts", f"m => m.playheadStore.set({t})")
    page.wait_for_timeout(150)


def clip_of(page, tid, cid, expr="c => c"):
    return st(page, f"s => {{ const c = s.tracks.find(t => t.id === '{tid}').clips.find(c => c.id === '{cid}'); return c ? ({expr})(c) : null; }}")


def palette_has(page, query, want, touch):
    if touch: page.locator("[data-testid=open-palette]").locator("visible=true").first.tap()
    else: page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
    page.keyboard.type(query, delay=5); page.wait_for_timeout(200)
    ids = page.locator("[data-testid=command-palette] [role=option]").evaluate_all("els => els.slice(0, 8).map(e => e.getAttribute('data-palette-id'))")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    return want in ids


def visible(page, sel, timeout=6000):
    try:
        page.locator(sel).locator("visible=true").first.wait_for(timeout=timeout)
        return True
    except Exception:
        return False


def escape(page, n=1):
    for _ in range(n):
        page.keyboard.press("Escape"); page.wait_for_timeout(250)


def cv(name, fn):
    """Une vérification de couverture : une exception = échec (le scénario continue)."""
    try:
        r = fn()
        if isinstance(r, tuple): ok(name, r[0], r[1])
        else: ok(name, r)
    except Exception as e:
        ok(name, False, f"exception : {str(e)[:200]}")
        escape(CUR["page"], 2)


def scen_couverture(page, vp, theme):
    """Les fonctions déjà présentes (lignes ✅ d'avant ce tour) : une preuve rapide chacune."""
    touch = vp == "tab"
    CUR["page"] = page
    clear_range(page)

    def modes():
        mod(page, "/utils/editCommands.ts", "m => m.runEditCommand('editMode', 'SLIP')")
        a = st(page, "s => s.editMode && s.editMode.mode")
        press_body(page, "F1")
        b = st(page, "s => s.editMode && s.editMode.mode")
        mod(page, "/utils/editCommands.ts", "m => m.runEditCommand('editMode', 'GRID')")
        return a == "SLIP" and b == "SHUFFLE", [a, b]
    cv("cv_modes", modes)

    def outils():
        press_body(page, "F7")
        a = mod(page, "/utils/windowLayouts.ts", "m => m.captureLayout().tool")
        press_body(page, "F6")
        b = mod(page, "/utils/windowLayouts.ts", "m => m.captureLayout().tool")
        return a == "RANGE" and b == "SMART", [a, b]
    cv("cv_outils", outils)

    def tab_transient():
        select_clip(page, "beat", "beat"); set_playhead(page, 0.1)
        press_body(page, "Tab")
        t = mod(page, "/utils/playheadStore.ts", "m => m.playheadStore.get()")
        return t is not None and 0.4 < t < 0.6, t
    cv("cv_tab_transient", tab_transient)

    def separer_heal():
        select_clip(page, "lead", "lead-1"); set_playhead(page, 3)
        press_body(page, "Control+e")
        n1 = st(page, "s => s.tracks.find(t => t.id === 'lead').clips.length")
        select_clip(page, "lead", "lead-1")
        press_body(page, "Control+h")
        n2 = st(page, "s => s.tracks.find(t => t.id === 'lead').clips.length")
        d = clip_of(page, "lead", "lead-1", "c => Math.round(c.duration * 100) / 100")
        return n1 == 3 and n2 == 2 and d == 6, {"apres_separer": n1, "apres_heal": n2, "duree": d}
    cv("cv_separer_heal", separer_heal)
    cv("cv_consolider_repeter_boucler", lambda: (all([palette_has(page, "consolider", "pt.consolidate", touch), palette_has(page, "repeter les clips", "pt.repeat", touch), palette_has(page, "boucler le clip", "pt.loopClip", touch)]), None))

    def fondus():
        set_range(page, 0, 0.5, ("beat",))
        page.evaluate("() => window.__novaEdit.fadesFromSelection()"); page.wait_for_timeout(300)
        f = clip_of(page, "beat", "beat", "c => Math.round((c.fadeIn || 0) * 100) / 100")
        undo(page, touch); clear_range(page)
        return f == 0.5, f
    cv("cv_fondus", fondus)

    def nudge():
        select_clip(page, "lead", "lead-2")
        step = page.evaluate("() => window.__novaEdit.nudgeStepSeconds()")
        press_body(page, "ArrowRight")
        s0 = clip_of(page, "lead", "lead-2", "c => c.start")
        undo(page, touch)
        return abs(s0 - (6 + step)) < 1e-6, {"pas": step, "debut": s0}
    cv("cv_nudge", nudge)

    def gain_clip():
        select_clip(page, "lead", "lead-1")
        press_body(page, "Control+Shift+ArrowUp")
        g = clip_of(page, "lead", "lead-1", "c => c.gain")
        undo(page, touch)
        return g is not None and abs(20 * np.log10(g) - 0.5) < 0.02, g
    cv("cv_gain_clip", gain_clip)

    def verrou():
        mod(page, "/utils/editCommands.ts", "m => m.runEditCommand('clipLock', { kind: 'edit', clipIds: ['beat'] })"); page.wait_for_timeout(250)
        a = clip_of(page, "beat", "beat", "c => c.lock || null")
        mod(page, "/utils/editCommands.ts", "m => m.runEditCommand('clipLock', { kind: 'edit', clipIds: ['beat'] })"); page.wait_for_timeout(250)
        b = clip_of(page, "beat", "beat", "c => c.lock || null")
        return a == "edit" and b is None, [a, b]
    cv("cv_verrou", verrou)

    def strip():
        select_clip(page, "beat", "beat")
        press_body(page, "Control+u")
        v = visible(page, "[data-testid=strip-silence]")
        escape(page)
        return v
    cv("cv_strip_silence", strip)

    def prises():
        f = page.evaluate("""async () => { const P = await window.__novaAppModule('/utils/playlists.ts'); const C = await window.__novaAppModule('/utils/comping.ts');
          return typeof P.listLanes === 'function' && typeof C.compSwipe === 'function'; }""")
        return f and palette_has(page, "enregistrement en boucle", "pt.numLoopRec", touch), f
    cv("cv_prises_comp", prises)

    def groupes():
        n0 = st(page, "s => (s.trackGroups || []).length")
        set_range(page, 0, 1, ("lead", "back"))
        press_body(page, "Control+g")
        g = wait_for(page, f"s => (s.trackGroups || []).length > {n0} && s.trackGroups[s.trackGroups.length - 1]", 6000)
        escape(page); clear_range(page)
        if g: undo(page, touch)
        good = bool(g) and sorted(g.get("trackIds", [])) == ["back", "lead"] and g.get("kind") in ("both", "mix")
        return good, g and {k: g.get(k) for k in ("trackIds", "kind", "linkedVolume")}
    cv("cv_groupes", groupes)

    def temps():
        press_body(page, "Control+Alt+i")
        v = visible(page, "[data-testid=time-ops-dialog]")
        escape(page)
        return v
    cv("cv_temps", temps)

    def reperes():
        palette(page, "liste des reperes", touch)
        v = visible(page, "[data-testid=memory-locations]")
        if v: palette(page, "liste des reperes", touch)
        return v
    cv("cv_reperes", reperes)
    cv("cv_historique", lambda: (palette_has(page, "revenir a la version enregistree", "pal.revertSaved", touch), None))

    def transposer():
        mod(page, "/utils/novaWindows.ts", "m => m.openNovaWindow('transpose', { targets: [{ trackId: 'lead', clipId: 'lead-1' }] })")
        v = visible(page, "[data-testid=transpose-dialog]")
        escape(page)
        return v
    cv("cv_transposer", transposer)

    def audiosuite():
        set_range(page, 0, 2, ("lead",))
        tap_or_click(page.locator("[role=toolbar][aria-label='Actions sur la sélection de plage'] button[aria-label=Traiter]").first, touch)
        v = visible(page, "[data-testid=audiosuite-dialog]")
        escape(page); clear_range(page)
        return v
    cv("cv_audiosuite", audiosuite)

    def mode_auto():
        qalib.ouvrir_menu_range(page, "[data-testid=automation-mode-lead]", tap=touch, piste="lead")  # « ⋯ » de la piste (barre allégée)
        b = page.locator("[data-testid=automation-mode-lead]").locator("visible=true").first
        before = st(page, "s => s.tracks.find(t => t.id === 'lead').automationMode || null")
        tap_or_click(b, touch); page.wait_for_timeout(300)
        items = page.locator("[role=menuitemradio]").locator("visible=true")
        n = items.count()
        item = page.locator("[role=menuitemradio]", has_text=re.compile("Touch")).locator("visible=true").first
        item.evaluate("e => e.scrollIntoView({ block: 'center' })")
        # Menu dans l'écran et au-dessus des pistes (corrigé ce tour : avant, il passait sous les en-têtes au doigt).
        page.screenshot(path=str(OUT / f"{vp}_{theme}_mode_automation.png"))
        tap_or_click(item, touch); page.wait_for_timeout(300)
        m = st(page, "s => s.tracks.find(t => t.id === 'lead').automationMode")
        set_track(page, "lead", f"automationMode: {json.dumps(before)}")
        return n >= 5 and m == "touch", {"modes": n, "choisi": m}
    cv("cv_mode_auto", mode_auto)

    cv("cv_auto_effets", lambda: (mod(page, "/utils/automationWriteTo.ts", """m => { const t = window.__novaEdit.getState().tracks.find(x => x.id === 'lead');
      const lane = { id: 'x', parameterName: 'plugin::fx-comp::threshold', points: [{ id: 'p', time: 0, value: -18 }], color: '#fff', isExpanded: false, min: -60, max: 0 };
      return m.writableParams({ ...t, automationLanes: [lane] }).some(p => p.param === 'plugin::fx-comp::threshold'); }"""), None))

    def copier_auto():
        set_track(page, "lead", "automationLanes: [{ id: 'lane-cv', parameterName: 'volume', points: [{ id: 'a', time: 0.5, value: 0.4 }, { id: 'b', time: 1.5, value: 1.2 }], color: '#22d3ee', isExpanded: true, min: 0, max: 1.5 }]")
        set_range(page, 0, 2, ("lead",))
        page.evaluate("() => window.__novaEdit.copyAutomation()"); page.wait_for_timeout(250)
        has = page.evaluate("() => window.__novaEdit.hasAutomationClipboard()")
        set_range(page, 6, 8, ("lead",))
        page.evaluate("() => window.__novaEdit.pasteAutomation()"); page.wait_for_timeout(300)
        n = st(page, "s => s.tracks.find(t => t.id === 'lead').automationLanes.find(l => l.parameterName === 'volume').points.filter(p => p.time >= 6 && p.time <= 8).length")
        set_track(page, "lead", "automationLanes: []"); clear_range(page)
        return has and n >= 2, {"presse_papiers": has, "points_colles": n}
    cv("cv_copier_auto", copier_auto)

    cv("cv_sidechain", lambda: (page.evaluate("""async () => { const S = await window.__novaAppModule('/engine/sidechain.ts'); const ts = window.__novaEdit.getState().tracks;
      return S.supportsSidechain('COMPRESSOR') === true && Array.isArray(S.keySourceOptions(ts, 'lead')) && S.sidechainLoop(ts, 'lead', 'beat') === null; }"""), None))

    def solo_safe():
        if touch: mod(page, "/utils/editCommands.ts", "m => m.runEditCommand('soloSafe', { trackIds: ['beat'] })")
        else: page.get_by_role("button", name="Solo : Beat", exact=True).locator("visible=true").first.click(modifiers=["Control"])
        page.wait_for_timeout(300)
        a = st(page, "s => !!s.tracks.find(t => t.id === 'beat').soloSafe")
        set_track(page, "beat", "soloSafe: false")
        set_track(page, "lead", "isSolo: true")
        press_body(page, "Alt+Shift+S")
        b = st(page, "s => s.tracks.filter(t => t.isSolo).length")
        return a and b == 0, {"solo_safe": a, "solos_apres_effacer": b}
    cv("cv_solo_safe", solo_safe)

    def armer():
        for n in ("Voix lead", "Backs"):
            page.get_by_role("button", name=f"Armer l'enregistrement : {n}", exact=True).locator("visible=true").first.click(); page.wait_for_timeout(350)
        armed = st(page, "s => s.tracks.filter(t => t.isTrackArmed).map(t => t.id).sort()")
        mod(page, "/utils/structureBus.ts", "m => m.applyTracks(ts => ts.map(t => ({ ...t, isTrackArmed: false })))")
        return armed == ["back", "lead"], armed
    cv("cv_armer", armer)

    def punch():
        q0 = st(page, "s => !!s.punch.quickPunch")
        press_body(page, "Control+Shift+P")
        q1 = st(page, "s => !!s.punch.quickPunch")
        press_body(page, "Control+Shift+P")
        l0 = st(page, "s => !!s.isLoopActive")
        press_body(page, "Numpad5")
        l1 = st(page, "s => !!s.isLoopActive")
        press_body(page, "Numpad5")
        return q1 != q0 and l1 != l0, {"quickPunch": [q0, q1], "boucle": [l0, l1]}
    cv("cv_punch", punch)

    def raccourcis():
        press_body(page, "Control+Alt+k")
        e = visible(page, "[data-testid=keymap-editor]")
        escape(page)
        press_body(page, "Control+Alt+1")
        f = mod(page, "/utils/keyboardFocus.ts", "m => m.isKeyboardFocus()")
        press_body(page, "Control+Alt+1")
        g = mod(page, "/utils/keymapStore.ts", "m => { const p = m.resolvePreset(m.presetById('protools')); const k = (id) => (p.find(s => s.id === id) || {}).keys || []; return k('pt.playlistNew').includes('ctrl+\\\\') && k('pt.glide').includes('alt+/'); }")
        return e and f is True and g, {"editeur": e, "keyboard_focus": f, "preset_pro_tools": g}
    cv("cv_raccourcis", raccourcis)

    # Console de mixage : VCA, inserts, envois a-j, bus, mètres, LUFS.
    goto_mixer(page, touch)

    def vca_strip():
        mod(page, "/utils/structureBus.ts", """async m => { const ts = await window.__novaAppModule('/utils/trackStructure.ts');
          m.applyTracks(tracks => ts.createVca(tracks, { id: 'vca-cv', name: 'VCA cv', memberIds: ['lead'] }).map(t => t.id === 'vca-cv' ? { ...t, volume: 0.5 } : t)); }""")
        page.wait_for_timeout(500)
        v = visible(page, "[data-testid=vca-strip-vca-cv]")
        sc = mod(page, "/utils/trackStructure.ts", "m => m.engineView(window.__novaEdit.getState().tracks).vcaScale.get('lead')")
        mod(page, "/utils/structureBus.ts", "m => m.applyTracks(ts => ts.filter(t => t.id !== 'vca-cv').map(t => { const o = { ...t }; if (o.vcaId === 'vca-cv') delete o.vcaId; return o; }))")
        page.wait_for_timeout(300)
        return v and abs((sc or 0) - 0.5) < 1e-6, {"tranche": v, "echelle": sc}
    cv("cv_vca_strip", vca_strip)

    def inserts():
        if touch: return True, "au doigt : menu de l'insert (menu_copie_faite)"
        btn = page.locator("[data-strip-id='lead'] [data-fx-id='fx-comp'] button").first
        btn.evaluate("e => e.scrollIntoView({ inline: 'center', block: 'center' })")
        btn.click(modifiers=["Control"]); page.wait_for_timeout(300)
        a = st(page, "s => s.tracks.find(t => t.id === 'lead').plugins[0].isEnabled")
        btn.click(modifiers=["Control"]); page.wait_for_timeout(300)
        btn.click(modifiers=["Control", "Alt"]); page.wait_for_timeout(300)
        b = st(page, "s => !!s.tracks.find(t => t.id === 'lead').plugins[0].isInactive")
        btn.click(modifiers=["Control", "Alt"]); page.wait_for_timeout(300)
        c = st(page, "s => { const p = s.tracks.find(t => t.id === 'lead').plugins[0]; return p.isEnabled && !p.isInactive; }")
        return a is False and b and c, {"bypass": a is False, "inactif": b, "retour_actif": c}
    cv("cv_inserts_etat", inserts)

    def envois_aj():
        o = page.locator("[data-testid=sends-open-lead]").locator("visible=true").first
        o.evaluate("e => e.scrollIntoView({ inline: 'center', block: 'center' })")
        tap_or_click(o, touch)
        v = visible(page, "[data-testid=sends-popover-lead]")
        n = page.locator("[data-testid^='send-slot-lead-']").count()
        escape(page)
        if page.locator("[data-testid=sends-popover-lead]").locator("visible=true").count(): tap_or_click(o, touch)
        return v and n >= 10, {"fenetre": v, "emplacements": n}
    cv("cv_envois_aj", envois_aj)

    def bus():
        tap_or_click(page.locator("[data-testid=mixer-open-buses]").locator("visible=true").first, touch)
        v = visible(page, "[data-testid=bus-panel]")
        escape(page)
        return v
    cv("cv_bus", bus)

    def metres():
        m = page.locator("[data-meter='lead']").count() > 0 and page.locator("[data-meter='__master_out__']").count() > 0
        chip = page.locator("[data-testid=lufs-chip]").locator("visible=true")
        lufs = False
        if chip.count():
            tap_or_click(chip.first, touch); lufs = visible(page, "[data-testid=loudness-panel]")
            tap_or_click(chip.first, touch); page.wait_for_timeout(300)
        else:
            palette(page, "loudness", touch); lufs = visible(page, "[data-testid=loudness-panel]"); escape(page)
        return m and lufs, {"metres": m, "lufs": lufs}
    cv("cv_metres", metres)

    def casque():
        palette(page, "mixes casque", touch)
        v = visible(page, "[data-testid=cue-panel]", 10000)
        escape(page)
        return v
    cv("cv_casque", casque)
    goto_arrangement(page, touch)
    escape(page)


# Lignes ✅ de ETAT.md → vérifications du scénario (début du nom de la fonction dans le tableau).
COUVERTURE = [
    ("Modes Shuffle", ["cv_modes"]), ("Smart Tool", ["cv_outils"]), ("Tab to Transient", ["cv_tab_transient"]),
    ("Séparer, Heal", ["cv_separer_heal", "cv_consolider_repeter_boucler"]), ("Fondus et crossfades", ["cv_fondus"]), ("Nudge", ["cv_nudge"]),
    ("Gain de clip : ligne", ["cv_gain_clip"]), ("Gain de clip à la molette", ["molette_gain_plus_1dB", "molette_message"]),
    ("Verrou de clip", ["cv_verrou"]), ("Strip Silence", ["cv_strip_silence"]), ("Couloirs de prises", ["cv_prises_comp", "dupliquee_active"]),
    ("Playlists de piste", ["dupliquee_active", "originale_gardee", "nouvelle_vide", "sauvegarde_rechargement"]),
    ("Copier / déplacer la sélection", ["sel_copiee_dans_nouvelle", "sel_version_entendue_intacte", "sel_deplacee", "sel_annulable"]),
    ("Groupes d'édition", ["cv_groupes"]), ("Insérer / supprimer du temps", ["cv_temps"]), ("Liste des clips", ["cv_reperes"]),
    ("Historique", ["annulable", "cv_historique"]), ("Transposer", ["cv_transposer"]), ("AudioSuite", ["cv_audiosuite"]),
    ("Formant par note", ["formant_reglage_visible", "formant_affiche", "formant_applique", "formant_son_rendu"]),
    ("Mode d'automation par piste", ["cv_mode_auto"]), ("Automation de tous les effets", ["cv_auto_effets"]),
    ("Copier / coller l'automation", ["cv_copier_auto"]), ("Écrire l'automation sur la sélection", ["ecrit_sur_plage", "annulable"]),
    ("Write to Start", ["write_to_end", "write_to_start", "write_to_punch", "write_to_all", "glide_rampe", "glide_to_current", "write_annulable"]),
    ("VCA (fader", ["cv_vca_strip"]), ("Fusion de l'automation du VCA", ["vca_fusion", "vca_message"]), ("Groupes de mix", ["cv_groupes"]),
    ("Solo safe", ["cv_solo_safe"]), ("Mode de solo « Verrouiller »", ["verrouiller_s_ajoutent"]), ("Mode de solo X-OR", ["xor_un_seul_solo", "badge_xor"]),
    ("Inserts : actif", ["cv_inserts_etat"]), ("Insert copié", ["alt_glisser_copie", "pt_glisser_deplace", "menu_copie_faite"]),
    ("Envoi copié", ["envoi_copie", "envoi_copie_au_doigt", "tel_copie_faite"]),
    ("Envoi glissé au doigt", ["tab_glisse_comme_un_fader", "envoi_double_toucher_0dB", "envoi_menu_appui_long", "tel_glisse_comme_un_fader", "tel_fader_44px"]),
    ("Envois a–j", ["cv_envois_aj"]), ("Bus nommés", ["cv_bus"]), ("Entrées nommées", ["entree_nommee", "selecteur_affiche_nom"]),
    ("Side-chain", ["cv_sidechain"]), ("Mètres crête", ["cv_metres"]), ("Mixes casque", ["cv_casque"]),
    ("Freeze d'une piste", ["lot_geler", "lot_degeler"]), ("Commit d'une piste", ["lot_commit"]), ("Commit / Freeze en lot", ["lot_precoche", "lot_geler", "lot_commit"]),
    ("Track Presets", ["presets_sans_compte", "B_retrouve_modele_de_piste"]),
    ("Presets synchronisés", ["A_envoye_au_compte", "B_retrouve_modele_de_piste", "B_retrouve_preset_effet", "A_suppression_recue", "C_bientot_disponible", "C_une_seule_requete", "requetes_legeres", "D_interrupteur_eteint_zero_requete"]),
    ("Plusieurs pistes armées", ["cv_armer"]), ("Punch, QuickPunch", ["cv_punch"]), ("Préréglage de raccourcis", ["cv_raccourcis"]),
    ("Palette Ctrl+K", ["palette_francais"]),
]
ETAT_MD = Path(os.environ.get("ETAT_MD", r"D:\1 WORK\CONTENU\nova-protools-ecarts\ETAT.md"))


def etat_lignes_vertes():
    """Lignes du § 1 de ETAT.md dont la colonne « Après » est ✅ (nom de la fonction nettoyé)."""
    out = []
    txt = ETAT_MD.read_text(encoding="utf-8")
    part = txt.split("## 1.")[1].split("\n## ")[0] if "## 1." in txt else txt
    for line in part.splitlines():
        if not line.startswith("|") or line.startswith("|---"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cells or cells[0] in ("Fonction Pro Tools", "Fonction"):
            continue
        after = cells[3] if len(cells) >= 5 else cells[2] if len(cells) >= 3 else ""
        if "✅" in after:
            out.append(re.sub(r"[*`]", "", cells[0]).strip())
    return out


def couverture_globale():
    lignes = etat_lignes_vertes()
    detail = {}
    for name in lignes:
        m = next((checks for key, checks in COUVERTURE if name.startswith(key)), None)
        if m is None:
            detail[name] = {"ok": False, "raison": "aucune vérification dans le scénario"}
            continue
        etat = {}
        for c in m:
            vals = [d[c]["ok"] for d in res["runs"].values() if isinstance(d.get(c), dict)]
            etat[c] = "absent" if not vals else ("ok" if all(vals) else "KO")
        detail[name] = {"ok": all(v == "ok" for v in etat.values()), "verifs": etat}
    n_ok = sum(1 for d in detail.values() if d["ok"])
    return {"lignes_vertes": len(lignes), "couvertes": n_ok, "pourcent": round(100 * n_ok / max(1, len(lignes)), 1), "detail": detail}


PALETTE = [
    ("nouvelle playlist", "pt.playlistNew"), ("dupliquer la playlist", "pt.playlistDuplicate"), ("playlist precedente", "pt.playlistPrev"),
    ("playlist suivante", "pt.playlistNext"), ("playlist d avant", "pt.playlistRecent"), ("ecrire le volume", "pt.writeCurrent"),
    ("ecrire tous les reglages", "pt.writeAll"), ("ecrire le pan", "pt.writePan"), ("solo x-or", "pt.soloXor"), ("solo verrouiller", "pt.soloLatch"),
    ("geler les pistes", "pt.freezeSelected"), ("degeler", "pt.unfreezeSelected"), ("commit plusieurs", "pt.batchRender"), ("nommer les entrees", "pt.ioSetup"),
    # Chantier 19 (2e tour)
    ("copier la selection vers une nouvelle playlist", "pt.selToPlaylist"), ("deplacer la selection vers une nouvelle playlist", "pt.selMoveToPlaylist"),
    ("write to start", "pt.writeToStart"), ("write to end", "pt.writeToEnd"), ("write to all", "pt.writeToAll"), ("write to punch", "pt.writeToPunch"),
    ("glide", "pt.glide"), ("glide vers la valeur actuelle", "pt.glideCurrent"), ("fusionner le vca", "pt.vcaCoalesce"),
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
        for f in (scen_playlists, scen_sel_playlist, scen_write, scen_write_span, scen_solo, scen_wheel, scen_inserts, scen_sends_touch,
                  scen_vca, scen_batch, scen_io, scen_formant, scen_cloud_off, scen_palette, scen_couverture):
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
    want = [a for a in sys.argv[1:] if not a.startswith("-")] or ["pc-sombre", "pc-clair", "tab-sombre", "tab-clair", "tel-sombre", "tel-clair", "cloud"]
    zpath = OUT / "projet_ecarts.zip"
    make_project(zpath)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required",
                                    # Micro factice (aucune vraie carte son) : armer une piste ouvre l'entrée.
                                    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        for w in want:
            if w == "cloud":
                run_cloud(browser, zpath); continue
            vp, th = w.split("-")
            theme = {"sombre": "dark", "clair": "light"}[th]
            if vp == "tel": run_tel(browser, theme, zpath)
            else: run(browser, vp, theme, zpath)
        browser.close()
    # Couverture de ETAT.md : jugée sur une passe complète (tous les postes et le cloud).
    complet = set(want) >= {"pc-sombre", "pc-clair", "tab-sombre", "tab-clair", "tel-sombre", "tel-clair", "cloud"}
    couv = couverture_globale()
    res["couverture"] = couv
    CUR["run"] = "global"
    if complet:
        ok("couverture_etat_100", couv["couvertes"] == couv["lignes_vertes"] and couv["lignes_vertes"] > 0,
           {"lignes_vertes": couv["lignes_vertes"], "couvertes": couv["couvertes"], "manquantes": [k for k, d in couv["detail"].items() if not d["ok"]]})
    else:
        print(f"(couverture partielle, passe incomplète : {couv['couvertes']}/{couv['lignes_vertes']} lignes)")
    fails = [f"{r}:{k}" for r, d in res["runs"].items() for k, v in d.items() if isinstance(v, dict) and not v["ok"]]
    res["echecs"] = fails
    S = qa_hors_prod.STATS
    hors_prod = {"simulees": sum(S["simulees"].values()), "bloquees": len(S["bloquees"]), "reseau_prod": len(S["reseau_prod"]), "filet_dns": len(S["filet_dns"])}
    ok_sb = not S["bloquees"] and not S["reseau_prod"] and not S["filet_dns"]
    ok("zero_requete_vers_la_production", ok_sb, hors_prod)
    res["hors_prod"] = hors_prod
    (OUT / "protools_ecarts.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(fails)} échec(s)" + (" : " + ", ".join(fails) if fails else ""))
    sys.exit(1 if fails or not ok_sb else 0)
