"""∿ Modulateurs (L3, écart 11) : LFO calé sur le tempo sur un réglage (bout en bout, hors production).

Navigateur headless (aucune fenêtre), Supabase simulé (qa_hors_prod), aucun micro réel.

Projet à 120 BPM : piste audio « Son » (sinus 440 Hz de 6 s), voie de volume sans point.
Bureau 1600 × 900 (sombre puis clair) :
  1. clic droit sur la piste → « Modulateurs (LFO)… » ; état vide expliqué ; « Ajouter un LFO » (volume) ;
     période « Noire », amplitude 50 % ;
  2. export (rendu hors ligne) : l'enveloppe du son bat à la noire (crêtes espacées de 0,5 s à ±5 ms) ;
  3. lecture : le gain de la piste suit la même courbe (écart mesuré sur l'AudioParam pendant la lecture) ;
  4. coupé → le son redevient constant ; Ctrl+Z ;
  5. sauvegarde (.zip) → rechargement : le modulateur revient.
Téléphone 390 × 844 : la fenêtre s'affiche sans défilement horizontal.

NOVA_URL=http://127.0.0.1:3521/ python qa/modulateurs.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-pro-2026\\qa-modulateurs) : modulateurs.json + captures.
"""
import io, json, os, re, sys, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3521/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\qa-modulateurs")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, new_page, shot, save_log, launch, menu_pick  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
checks = []
res = {"bureau": {}, "rechargement": {}, "telephone": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def sine_wav(seconds=6.0, f=440.0, amp=0.25, sr=SR) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    x = amp * np.sin(2 * np.pi * f * t)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project(path: Path):
    tone = {"id": "son", "name": "Son", "type": "AUDIO", "color": "#34d399", "isMuted": False, "isSolo": False, "isTrackArmed": False,
            "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "totalLatency": 0,
            "automationLanes": [{"id": "lane-vol", "parameterName": "volume", "points": [], "color": "#34d399", "isExpanded": False, "min": 0, "max": 1.5}],
            "clips": [{"id": "c-son", "start": 0, "duration": 6.0, "offset": 0, "fadeIn": 0, "fadeOut": 0, "name": "Sinus", "color": "#34d399", "type": "AUDIO", "audioRef": "audio/sinus.wav"}]}
    state = {
        "id": "proj-modulateurs", "name": "Modulateurs", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [tone], "trackGroups": [], "markers": [], "selectedTrackId": "son", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/sinus.wav", sine_wav())


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


RENDER_JS = """async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await E.init();
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'son');
  const b = await E.renderProject([t], 6, 0, 48000);
  const y = b.getChannelData(0);
  // Enveloppe : crête par fenêtre de 5 ms (le sinus à 440 Hz y passe 2 fois).
  const w = 240, env = [];
  for (let i = 0; i + w <= y.length; i += w) { let m = 0; for (let j = i; j < i + w; j++) m = Math.max(m, Math.abs(y[j])); env.push(m); }
  return env;
}"""


def envelope_stats(env):
    env = np.array(env)
    frame = 0.005
    # Crêtes locales de l'enveloppe (au-dessus de la moyenne), une par battement.
    mean = env.mean()
    peaks = []
    for i in range(2, len(env) - 2):
        if env[i] >= env[i - 2:i + 3].max() and env[i] > mean and (not peaks or (i - peaks[-1]) * frame > 0.3):
            peaks.append(i)
    times = [p * frame for p in peaks]
    gaps = [round(times[i + 1] - times[i], 4) for i in range(len(times) - 1)]
    return {"crêtes_s": [round(t, 3) for t in times], "écarts_s": gaps, "max": float(env[10:-10].max()), "min": float(env[10:-10].min())}


SAMPLE_JS = """async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const A = await window.__novaAppModule('/utils/automationWrite.ts');
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'son');
  const lane = A.playedLanes(t).find(l => l.parameterName === 'volume');
  const pts = A.sortedPoints(lane.points);
  const ap = E.tracksDSP.get('son').gain.gain;
  const out = [];
  for (let i = 0; i < 70; i++) {
    await new Promise(r => setTimeout(r, 25));
    const song = E.getCurrentTime();
    out.push({ song, v: ap.value, attendu: A.valueAtPoints(pts, song, 1) });
  }
  return out;
}"""


def desktop(b):
    R = res["bureau"]
    log = Log("modulateurs_bureau")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    src = OUT / "projet_modulateurs.zip"
    make_project(src)
    open_project(page, src, "pc_00_ouvert")

    env0 = envelope_stats(page.evaluate(RENDER_JS))
    R["sans_lfo"] = env0
    check("avant : le son est constant (enveloppe plate)", env0["max"] - env0["min"] < 0.01, env0)

    page.locator("[data-track-header='son']").first.click(button="right"); page.wait_for_timeout(400)
    menu_pick(page, "Modulateurs (LFO"); page.wait_for_timeout(600)
    check("menu de la piste : la fenêtre « Modulateurs · Son » s'ouvre, état vide expliqué",
          page.locator('[data-testid="modulators-panel"]').count() == 1 and page.locator('[data-testid="mod-empty"]').count() == 1)
    shot(page, "pc_01_fenetre_vide")
    page.locator('[data-testid="mod-add"]').click(); page.wait_for_timeout(300)
    page.locator('[data-testid="mod-rate"]').select_option("1/4"); page.wait_for_timeout(200)
    page.locator('[data-testid="mod-depth"]').fill("50"); page.wait_for_timeout(400)
    shot(page, "pc_02_lfo_noire")
    st = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(x => x.id === 'son').modulators")
    check("LFO posé sur le volume : noire, sinus, 50 %", st and st[0]["target"] == "volume" and st[0]["rate"] == "1/4" and abs(st[0]["depth"] - 0.5) < 1e-9, st)

    # 2. Export.
    env = envelope_stats(page.evaluate(RENDER_JS))
    R["export"] = env
    gaps_ok = len(env["écarts_s"]) >= 8 and all(abs(g - 0.5) <= 0.005 for g in env["écarts_s"])
    check("export : l'enveloppe bat à la noire (crêtes espacées de 0,5 s à ±5 ms)", gaps_ok and env["max"] / max(env["min"], 1e-6) > 1.5, env)

    # 3. Lecture.
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.seek(0)")
    page.evaluate("() => window.DAW_CONTROL.togglePlay()"); page.wait_for_timeout(300)
    smp = page.evaluate(SAMPLE_JS)
    page.evaluate("() => window.DAW_CONTROL.stop()"); page.wait_for_timeout(300)
    errs = [abs(s["v"] - s["attendu"]) for s in smp if 0.1 < s["song"] < 5.5]
    R["lecture"] = {"n": len(errs), "ecart_max": max(errs) if errs else None, "ecart_moyen": (sum(errs) / len(errs)) if errs else None, "v": [round(s["v"], 3) for s in smp[:20]]}
    span = (max(s["v"] for s in smp) - min(s["v"] for s in smp)) if smp else 0
    check("lecture : le gain de la piste suit la même courbe (écart moyen < 0,08 ; il bouge vraiment)", errs and R["lecture"]["ecart_moyen"] < 0.08 and span > 0.3, R["lecture"])

    # 4. Coupé, puis Ctrl+Z.
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-modulators', { detail: { trackId: 'son' } }))"); page.wait_for_timeout(500)
    page.locator('[data-testid="mod-on"]').uncheck(); page.wait_for_timeout(400)
    envc = envelope_stats(page.evaluate(RENDER_JS))
    check("coupé : le son redevient constant", envc["max"] - envc["min"] < 0.01, envc)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+z"); page.wait_for_timeout(800)
    on = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(x => x.id === 'son').modulators?.[0]?.on")
    check("Ctrl+Z : le LFO est de nouveau actif", on is True, on)
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-modulators', { detail: { trackId: 'son' } }))"); page.wait_for_timeout(500)
    page.evaluate("() => window.DAW_CONTROL.setTheme('light')"); page.wait_for_timeout(600)
    shot(page, "pc_03_theme_clair")
    page.evaluate("() => window.DAW_CONTROL.setTheme('dark')"); page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # 5. Sauvegarde.
    dest = OUT / "seance_modulateurs.zip"
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+Shift+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    with zipfile.ZipFile(dest) as z:
        pj = json.loads(z.read("project.json"))
    mods = [t.get("modulators") for t in pj["tracks"] if t["id"] == "son"][0]
    check("sauvegarde : project.json porte le modulateur", isinstance(mods, list) and mods[0]["rate"] == "1/4", mods)
    R["final_env"] = env
    errs = log.errors()
    check("bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()
    return dest


def reload_desktop(b, f: Path):
    log = Log("modulateurs_rechargement")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_04_rechargement")
    page.wait_for_timeout(800)
    env = envelope_stats(page.evaluate(RENDER_JS))
    res["rechargement"] = env
    check("rechargement : même export (mêmes crêtes)", env["crêtes_s"] == res["bureau"]["final_env"]["crêtes_s"], {"avant": res["bureau"]["final_env"]["crêtes_s"], "apres": env["crêtes_s"]})
    errs = log.errors()
    check("rechargement : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


def phone(b, f: Path):
    log = Log("modulateurs_tel")
    ctx, page = new_page(b, "tel390", log=log, touch=True)
    open_project(page, f, "tel_00_ouvert", touch=True)
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-modulators', { detail: { trackId: 'son' } }))"); page.wait_for_timeout(700)
    ok = page.locator('[data-testid="modulators-panel"]').is_visible()
    shot(page, "tel_01_modulateurs")
    hs = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
    check("téléphone : la fenêtre des modulateurs s'affiche, sans défilement horizontal", ok and hs, {"ok": ok, "hs": hs})
    errs = log.errors()
    check("téléphone : aucune erreur dans la console", not errs, errs[:5])
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
(OUT / "modulateurs.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
