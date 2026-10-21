"""🎹 Effets MIDI en temps réel (L3, écart 9) : arpège, accord, gamme forcée (bout en bout, hors production).

Navigateur headless (aucune fenêtre), Supabase simulé (qa_hors_prod), aucun micro réel, aucun clavier MIDI réel
(les touches passent par le même chemin que le clavier de l'ordinateur : services/MidiInput).

Projet à 140 BPM : piste MIDI « Synth », accord Do-Mi-Sol tenu une mesure (mesure 2), tonalité La mineur.
Bureau 1600 × 900 (sombre puis clair) :
  1. clic droit sur la piste → « Effets MIDI… » ; fenêtre vide expliquée ; « + Arpège », vitesse « Double » ;
  2. notes entendues (moteur) : 16 doubles-croches à ±1 ms de la grille du morceau ;
  3. lecture : les attaques envoyées à l'instrument suivent la double-croche, puis la croche quand on change la
     vitesse PENDANT la lecture ;
  4. export (rendu hors ligne) = rendu des notes figées (« Figer en notes »), écart mesuré ≤ 1e-6 ;
  5. « Gamme forcée » (projet : La mineur) : 100 % des notes jouées dans la gamme ;
  6. clavier en direct : accord tenu → arpège ; touches lâchées → aucun minuteur ne tourne ;
  7. « Figer en notes » : les notes du clip = celles entendues, effets coupés ; Ctrl+Z ;
  8. sauvegarde (.zip) → rechargement : les effets reviennent.
Téléphone 390 × 844 : la fenêtre s'affiche sans défilement horizontal.

NOVA_URL=http://127.0.0.1:3521/ python qa/effets_midi.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-pro-2026\\qa-effets-midi) : effets_midi.json + captures.
"""
import json, os, re, sys, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3521/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\qa-effets-midi")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, new_page, shot, save_log, launch, menu_pick  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BPM = 140
BAR = 4 * 60 / BPM
checks = []
res = {"bureau": {}, "rechargement": {}, "telephone": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def make_project(path: Path):
    notes = [{"id": f"n{p}", "pitch": p, "start": 0, "duration": BAR, "velocity": 0.8} for p in (60, 64, 67)]
    synth = {"id": "synth", "name": "Synth", "type": "MIDI", "color": "#a78bfa", "isMuted": False, "isSolo": False, "isTrackArmed": False,
             "isFrozen": False, "volume": 0.9, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
             "clips": [{"id": "accord", "start": BAR, "duration": BAR, "offset": 0, "fadeIn": 0, "fadeOut": 0, "name": "Accord", "color": "#a78bfa", "type": "MIDI", "notes": notes}]}
    state = {
        "id": "proj-effets-midi", "name": "Effets MIDI", "bpm": BPM, "timeSignature": {"numerator": 4, "denominator": 4},
        "projectKey": 9, "projectScale": "MINOR",
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [synth], "trackGroups": [], "markers": [], "selectedTrackId": "synth", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}
"""


def open_project(page, f: Path, label, touch=False):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=90000)
    b = page.get_by_text("Charger Projet").first
    b.tap() if touch else b.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        c = page.get_by_text("Charger depuis l'ordinateur").first
        c.tap() if touch else c.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.DAW_CONTROL", timeout=30000)
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/simpleMode.ts'); m.simpleModeStore.setPref(false); }")
    page.wait_for_timeout(600)
    shot(page, label)


HEARD_JS = """async () => {
  const F = await window.__novaAppModule('/engine/midiFx/index.ts');
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'synth');
  const c = F.clipsWithMidiFx(t, t.clips)[0];
  return { fx: t.midiFx || [], clipNotes: t.clips[0].notes.map(n => n.pitch), heard: c.notes.map(n => ({ p: n.pitch, s: +(c.start + n.start).toFixed(6), d: +n.duration.toFixed(6) })) };
}"""


def heard(page):
    return page.evaluate(HEARD_JS)


SPY_JS = """async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  if (!E.__spy) { const orig = E.triggerTrackAttack.bind(E); E.__spyLog = []; E.triggerTrackAttack = (id, p, v, t, ex) => { E.__spyLog.push({ id, p, t }); return orig(id, p, v, t, ex); }; E.__spy = true; }
  E.__spyLog.length = 0; return true;
}"""
SPY_READ = "async () => { const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts'); return E.__spyLog.filter(x => x.id === 'synth').map(x => ({ p: x.p, t: x.t })); }"

RENDER_JS = """async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await E.init();
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'synth');
  const b = await E.renderProject([t], 3 * %f, 0, 48000);
  return Array.from(b.getChannelData(0));
}""" % BAR


def desktop(b):
    R = res["bureau"]
    log = Log("effets_midi_bureau")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    src = OUT / "projet_effets_midi.zip"
    make_project(src)
    open_project(page, src, "pc_00_ouvert")

    # 1. Menu de la piste → Effets MIDI.
    hdr = page.locator("[data-track-header='synth']").first
    hdr.click(button="right"); page.wait_for_timeout(400)
    shot(page, "pc_01_menu_piste")
    menu_pick(page, "Effets MIDI"); page.wait_for_timeout(600)
    panel = page.locator('[data-testid="midi-fx-panel"]')
    check("menu de la piste : la fenêtre « Effets MIDI · Synth » s'ouvre, état vide expliqué", panel.count() == 1 and page.locator('[data-testid="mfx-empty"]').count() == 1)
    shot(page, "pc_02_fenetre_vide")
    page.locator('[data-testid="mfx-add-arp"]').click(); page.wait_for_timeout(300)
    page.locator('[data-testid="mfx-rate-1-16"]').click(); page.wait_for_timeout(400)
    shot(page, "pc_03_arpege_double")

    # 2. Notes entendues.
    h = heard(page)
    R["arpege"] = h
    step = 60 / BPM / 4
    pire = max(abs(x["s"] - (BAR + i * step)) for i, x in enumerate(h["heard"])) * 1000 if h["heard"] else 99
    check("arpège en doubles-croches à 140 BPM : 16 notes à ±1 ms de la grille du morceau", len(h["heard"]) == 16 and pire < 1, {"n": len(h["heard"]), "pire_ms": pire})
    check("les notes du clip ne changent pas (Do-Mi-Sol)", h["clipNotes"] == [60, 64, 67], h["clipNotes"])

    # 3. Lecture : réglage changé pendant la lecture.
    page.evaluate(SPY_JS)
    page.evaluate("() => window.DAW_CONTROL.seek(%f)" % (BAR - 0.05))
    page.evaluate("() => window.DAW_CONTROL.togglePlay()"); page.wait_for_timeout(int(BAR * 1000 / 2) + 150)
    page.locator('[data-testid="mfx-rate-1-8"]').click(); page.wait_for_timeout(int(BAR * 1000 / 2) + 300)
    page.evaluate("() => window.DAW_CONTROL.stop()"); page.wait_for_timeout(300)
    ev = page.evaluate(SPY_READ)
    R["lecture_attaques"] = ev
    gaps = [round(ev[i + 1]["t"] - ev[i]["t"], 4) for i in range(len(ev) - 1)]
    has16 = any(abs(g - step) < 0.002 for g in gaps)
    has8 = any(abs(g - 2 * step) < 0.002 for g in gaps[len(gaps) // 2:])
    check("lecture : l'arpège joue en doubles-croches, puis en croches après le réglage changé pendant la lecture", len(ev) >= 8 and has16 and has8, {"gaps": gaps})

    # 5. Gamme forcée (projet La mineur) avec des notes hors gamme.
    page.evaluate("""() => { const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'synth');
      window.DAW_CONTROL.editClip('synth', 'accord', 'UPDATE_PROPS', { notes: [61, 63, 66, 68, 70].map((p, i) => ({ id: 'h' + p, pitch: p, start: i * 0.1, duration: 0.1, velocity: 0.8 })) }); }""")
    page.wait_for_timeout(300)
    page.locator('[data-testid="mfx-on-arp"]').uncheck(); page.wait_for_timeout(200)
    page.locator('[data-testid="mfx-add-scale"]').click(); page.wait_for_timeout(400)
    shot(page, "pc_04_gamme_forcee")
    g = heard(page)
    inscale = page.evaluate("async (ps) => { const S = await window.__novaAppModule('/utils/scales.ts'); return ps.every(p => S.isInScale(p, 9, 'MINOR')); }", [x["p"] for x in g["heard"]])
    R["gamme"] = g
    check("gamme forcée (La mineur du projet) : 100 % des notes jouées dans la gamme", inscale and len(g["heard"]) == 5, [x["p"] for x in g["heard"]])
    # Retour à l'accord tenu + arpège pour la suite.
    page.evaluate("""() => window.DAW_CONTROL.editClip('synth', 'accord', 'UPDATE_PROPS', { notes: [60, 64, 67].map(p => ({ id: 'n' + p, pitch: p, start: 0, duration: %f, velocity: 0.8 })) })""" % BAR)
    page.locator('[data-testid="mfx-on-arp"]').check(); page.wait_for_timeout(300)

    # 6. Clavier en direct.
    live = page.evaluate("""async () => {
      const { midiInput } = await window.__novaAppModule('/services/MidiInput.ts');
      const L = await window.__novaAppModule('/engine/midiFx/live.ts');
      const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
      await E.init(); await E.resume?.();
      E.__spyLog.length = 0;
      [57, 60, 64].forEach(p => midiInput.noteOn(p, 100, { source: 'kb', trackId: 'synth' }));
      const during = L.liveMidiFx.activeTimers();
      await new Promise(r => setTimeout(r, 700));
      [57, 60, 64].forEach(p => midiInput.noteOff(p, { source: 'kb', trackId: 'synth' }));
      await new Promise(r => setTimeout(r, 200));
      const ev = E.__spyLog.filter(x => x.id === 'synth');
      return { during, after: L.liveMidiFx.activeTimers(), pitches: ev.map(x => x.p), gaps: ev.slice(1).map((x, i) => +(x.t - ev[i].t).toFixed(4)) };
    }""")
    R["clavier"] = live
    check("clavier : accord tenu → arpège (notes l'une après l'autre, au pas réglé)", live["during"] == 1 and len(live["pitches"]) >= 4 and live["pitches"][:3] in ([57, 60, 64], [57, 60, 64]) and all(abs(gp - 2 * step) < 0.003 for gp in live["gaps"][:3]), live)
    check("clavier : touches lâchées → aucun minuteur ne tourne (rien au repos)", live["after"] == 0, live["after"])

    # 4. Export = notes figées ; 7. Figer en notes.
    before = heard(page)
    a = page.evaluate(RENDER_JS)
    a2 = page.evaluate(RENDER_JS)
    base = max(abs(x - y) for x, y in zip(a, a2)) if a and a2 else 99
    page.locator('[data-testid="mfx-freeze"]').click(); page.wait_for_timeout(600)
    shot(page, "pc_05_fige")
    after = heard(page)
    R["fige"] = after
    same_notes = [(x["p"], x["s"]) for x in after["heard"]] == [(x["p"], x["s"]) for x in before["heard"]]
    check("« Figer en notes » : les notes du clip = celles entendues, effets coupés", same_notes and all(not s["on"] for s in after["fx"]) and len(after["clipNotes"]) == 8,
          {"clip": after["clipNotes"], "fx": after["fx"]})
    bb = page.evaluate(RENDER_JS)
    diff = max(abs(x - y) for x, y in zip(a, bb)) if a and bb else 99
    rms = (sum(x * x for x in a) / max(1, len(a))) ** 0.5
    R["export"] = {"diff": diff, "rms": rms, "ecart_entre_deux_rendus_identiques": base}
    check("export avec effets = export des notes figées (écart ≤ 1e-6, comme entre deux rendus du même projet ; son présent)", diff <= 1e-6 and rms > 1e-4, R["export"])
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+z"); page.wait_for_timeout(800)
    u = heard(page)
    check("Ctrl+Z : les notes d'origine et l'arpège reviennent", u["clipNotes"] == [60, 64, 67] and any(s["type"] == "arp" and s["on"] for s in u["fx"]), u["clipNotes"])

    # Thème clair.
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-midi-fx', { detail: { trackId: 'synth' } }))"); page.wait_for_timeout(500)
    page.evaluate("() => window.DAW_CONTROL.setTheme('light')"); page.wait_for_timeout(600)
    shot(page, "pc_06_theme_clair")
    page.evaluate("() => window.DAW_CONTROL.setTheme('dark')"); page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # 8. Sauvegarde.
    dest = OUT / "seance_effets_midi.zip"
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    with zipfile.ZipFile(dest) as z:
        pj = json.loads(z.read("project.json"))
    fx = [t.get("midiFx") for t in pj["tracks"] if t["id"] == "synth"][0]
    check("sauvegarde : project.json porte les effets MIDI de la piste", isinstance(fx, list) and any(s["type"] == "arp" and s["arp"]["rate"] == "1/8" for s in fx), fx)
    R["final"] = heard(page)
    errs = log.errors()
    check("bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()
    return dest


def reload_desktop(b, f: Path):
    log = Log("effets_midi_rechargement")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_07_rechargement")
    page.wait_for_timeout(800)
    h = heard(page)
    res["rechargement"] = h
    before = res["bureau"]["final"]
    check("rechargement : mêmes effets, mêmes notes entendues", h["heard"] == before["heard"] and [s["type"] for s in h["fx"]] == [s["type"] for s in before["fx"]], {"avant": len(before["heard"]), "apres": len(h["heard"])})
    errs = log.errors()
    check("rechargement : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


def phone(b, f: Path):
    for theme in ("dark", "light"):
        log = Log(f"effets_midi_tel_{theme}")
        ctx, page = new_page(b, "tel390", log=log, touch=True)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, f, f"tel_{theme}_00_ouvert", touch=True)
        page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-midi-fx', { detail: { trackId: 'synth' } }))"); page.wait_for_timeout(700)
        ok = page.locator('[data-testid="midi-fx-panel"]').is_visible()
        shot(page, f"tel_{theme}_01_effets_midi")
        hs = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
        check(f"téléphone ({theme}) : la fenêtre des effets MIDI s'affiche, sans défilement horizontal", ok and hs, {"ok": ok, "hs": hs})
        errs = log.errors()
        check(f"téléphone ({theme}) : aucune erreur dans la console", not errs, errs[:5])
        save_log(log)
        ctx.close()


with sync_playwright() as p:
    b = launch(p)
    try:
        saved = desktop(b)
        reload_desktop(b, saved)
        phone(b, saved)
    finally:
        b.close()

res["verifications"] = checks
res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
(OUT / "effets_midi.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
