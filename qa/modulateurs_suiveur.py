"""∿ Suiveur d'enveloppe (modulateur, 22/10/2026) : le niveau d'une piste source pilote un réglage d'une
autre piste (bout en bout, hors production).

Navigateur headless (aucune fenêtre), Supabase simulé (qa_hors_prod), aucun micro réel.

Projet à 120 BPM : « Kick » (grosse caisse 60 Hz amortie de 150 ms, un coup toutes les 0,5 s pendant 6 s) et « Basse »
(sinus 110 Hz constant, voie de volume sans point). Bureau 1600 × 900 :
  1. clic droit sur Basse → Modulateurs → « Ajouter un suiveur d'enveloppe » : source Kick, « le niveau creuse
     le réglage », plage 60 %, attaque 5 ms, relâchement 80 ms ;
  2. export de la Basse SEULE (comme un stem) : elle se creuse à chaque coup (creux espacés de 0,5 s à ±5 ms,
     ≥ 6 dB sous le niveau entre les coups), et reste au niveau d'origine entre les coups ;
  3. lecture : le gain de la piste suit la même courbe que l'export (écart mesuré sur l'AudioParam) ;
  4. coupé → la basse redevient constante ; Ctrl+Z ;
  5. sauvegarde (.zip) → rechargement : même export.
Téléphone 390 × 844 : la fenêtre s'affiche sans défilement horizontal.

NOVA_URL=http://127.0.0.1:3526/ python qa/modulateurs_suiveur.py
"""
import io, json, os, re, sys, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3521/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-qa-hors-prod\modulateurs_suiveur")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, new_page, shot, save_log, launch, menu_pick  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
DUR = 6.0
checks = []
res = {"bureau": {}, "rechargement": {}, "telephone": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def wav(x, sr=SR) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def kick_wav():
    x = np.zeros(int(DUR * SR))
    t = np.arange(int(0.15 * SR)) / SR
    k = 0.9 * np.sin(2 * np.pi * 60 * t) * np.exp(-t / 0.03)
    for s in np.arange(0, DUR, 0.5):
        i = int(round(s * SR)); n = min(len(k), len(x) - i); x[i:i + n] += k[:n]
    return wav(x)


def bass_wav():
    t = np.arange(int(DUR * SR)) / SR
    return wav(0.25 * np.sin(2 * np.pi * 110 * t))


def track(tid, name, color, ref, lanes):
    return {"id": tid, "name": name, "type": "AUDIO", "color": color, "isMuted": False, "isSolo": False, "isTrackArmed": False,
            "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "totalLatency": 0,
            "automationLanes": lanes,
            "clips": [{"id": f"c-{tid}", "start": 0, "duration": DUR, "offset": 0, "fadeIn": 0, "fadeOut": 0, "name": name, "color": color, "type": "AUDIO", "audioRef": ref}]}


def make_project(path: Path):
    kick = track("kick", "Kick", "#f87171", "audio/kick.wav", [])
    bass = track("basse", "Basse", "#34d399", "audio/basse.wav",
                 [{"id": "lane-vol", "parameterName": "volume", "points": [], "color": "#34d399", "isExpanded": False, "min": 0, "max": 1.5}])
    state = {
        "id": "proj-suiveur", "name": "Suiveur", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [kick, bass], "trackGroups": [], "markers": [], "selectedTrackId": "basse", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/kick.wav", kick_wav())
        z.writestr("audio/basse.wav", bass_wav())


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


# Export de la Basse SEULE (stem) : la source du suiveur est cherchée dans le projet, pas dans le rendu.
RENDER_JS = """async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await E.init();
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'basse');
  const b = await E.renderProject([t], 6, 0, 48000);
  const y = b.getChannelData(0);
  // Enveloppe : crête par fenêtre de 5 ms (le sinus à 110 Hz a une crête toutes les 4,5 ms).
  const w = 240, env = [];
  for (let i = 0; i + w <= y.length; i += w) { let m = 0; for (let j = i; j < i + w; j++) m = Math.max(m, Math.abs(y[j])); env.push(m); }
  return env;
}"""


def dips(env):
    """Creux de l'enveloppe (sous la moyenne), un par coup, et profondeur en dB par rapport au niveau entre les coups."""
    env = np.array(env)
    frame = 0.005
    mean = env.mean()
    found = []
    for i in range(2, len(env) - 2):
        if env[i] <= env[i - 2:i + 3].min() and env[i] < mean and (not found or (i - found[-1]) * frame > 0.3):
            found.append(i)
    times = [p * frame for p in found]
    gaps = [round(times[i + 1] - times[i], 4) for i in range(len(times) - 1)]
    # Niveau « entre les coups » : 0,42 à 0,49 s après chaque coup (le relâchement est fini).
    between = [env[int((k * 0.5 + 0.42) / frame):int((k * 0.5 + 0.49) / frame)].max() for k in range(11)]
    lows = [env[p] for p in found]
    return {"creux_s": [round(t, 3) for t in times], "écarts_s": gaps, "niveau_entre_coups": float(np.median(between)),
            "niveau_creux": float(np.median(lows)) if lows else None,
            "profondeur_db": float(20 * np.log10(np.median(between) / max(np.median(lows), 1e-9))) if lows else 0.0,
            "max": float(env[10:-10].max()), "min": float(env[10:-10].min())}


SAMPLE_JS = """async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const A = await window.__novaAppModule('/utils/automationWrite.ts');
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'basse');
  const lane = A.playedLanes(t).find(l => l.parameterName === 'volume');
  const pts = A.sortedPoints(lane.points);
  const ap = E.tracksDSP.get('basse').gain.gain;
  const out = [];
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 15));
    const song = E.getCurrentTime();
    out.push({ song, v: ap.value, attendu: A.valueAtPoints(pts, song, 1) });
  }
  return out;
}"""


def desktop(b):
    R = res["bureau"]
    log = Log("suiveur_bureau")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    src = OUT / "projet_suiveur.zip"
    make_project(src)
    open_project(page, src, "pc_00_ouvert")

    env0 = dips(page.evaluate(RENDER_JS))
    R["sans_suiveur"] = env0
    check("avant : la basse est constante (enveloppe plate)", env0["max"] - env0["min"] < 0.01, env0)

    page.locator("[data-track-header='basse']").first.click(button="right"); page.wait_for_timeout(400)
    menu_pick(page, "Modulateurs (LFO"); page.wait_for_timeout(600)
    check("menu de la piste : la fenêtre « Modulateurs · Basse » s'ouvre, le suiveur est proposé",
          page.locator('[data-testid="modulators-panel"]').count() == 1 and page.locator('[data-testid="mod-add-env"]').is_enabled())
    page.locator('[data-testid="mod-add-env"]').click(); page.wait_for_timeout(300)
    slot = page.locator('[data-testid="mod-slot"][data-mod-kind="env"]')
    src_opts = slot.locator('[data-testid="mod-source"] option').all_inner_texts()
    page.locator('[data-testid="mod-source"]').select_option("kick"); page.wait_for_timeout(150)
    page.locator('[data-testid="mod-env-polarity"]').select_option("down"); page.wait_for_timeout(150)
    page.locator('[data-testid="mod-depth"]').fill("60"); page.wait_for_timeout(150)
    page.locator('[data-testid="mod-attack"]').fill("5"); page.wait_for_timeout(150)
    page.locator('[data-testid="mod-release"]').fill("80"); page.wait_for_timeout(400)
    shot(page, "pc_01_suiveur")
    st = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(x => x.id === 'basse').modulators")
    R["modulateur"] = st
    check("suiveur posé sur le volume : source Kick, creuse, plage 60 %, attaque 5 ms, relâchement 80 ms",
          st and st[0].get("kind") == "env" and st[0]["source"] == "kick" and st[0]["polarity"] == "down" and abs(st[0]["depth"] - 0.6) < 1e-9
          and st[0]["attack"] == 5 and st[0]["release"] == 80 and st[0]["target"] == "volume", {"modulateur": st, "sources_proposees": src_opts})
    check("sources proposées : les pistes qui ont du son", any("Kick" in o for o in src_opts) and any("Basse" in o for o in src_opts), src_opts)

    # 2. Export de la basse seule.
    env = dips(page.evaluate(RENDER_JS))
    R["export"] = env
    gaps_ok = len(env["écarts_s"]) >= 9 and all(abs(g - 0.5) <= 0.005 for g in env["écarts_s"])
    check("export (basse seule) : elle se creuse à chaque coup de grosse caisse (creux espacés de 0,5 s à ±5 ms)", gaps_ok and env["creux_s"] and env["creux_s"][0] < 0.05, env)
    check("export : creux ≥ 6 dB sous le niveau entre les coups ; entre les coups = niveau d'origine (±0,2 dB)",
          env["profondeur_db"] >= 6 and abs(20 * np.log10(env["niveau_entre_coups"] / env0["max"])) <= 0.2, env)

    # 3. Lecture.
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.seek(0)")
    page.evaluate("() => window.DAW_CONTROL.togglePlay()"); page.wait_for_timeout(300)
    smp = page.evaluate(SAMPLE_JS)
    page.evaluate("() => window.DAW_CONTROL.stop()"); page.wait_for_timeout(300)
    errs = [abs(s["v"] - s["attendu"]) for s in smp if 0.1 < s["song"] < 5.5]
    R["lecture"] = {"n": len(errs), "ecart_max": max(errs) if errs else None, "ecart_moyen": (sum(errs) / len(errs)) if errs else None,
                    "v": [round(s["v"], 3) for s in smp[:40]]}
    span = (max(s["v"] for s in smp) - min(s["v"] for s in smp)) if smp else 0
    check("lecture : le gain de la basse suit la même courbe que l'export (écart moyen < 0,08 ; il bouge vraiment)",
          errs and R["lecture"]["ecart_moyen"] < 0.08 and span > 0.3, R["lecture"])

    # 4. Coupé, puis Ctrl+Z.
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-modulators', { detail: { trackId: 'basse' } }))"); page.wait_for_timeout(500)
    page.locator('[data-testid="mod-on"]').uncheck(); page.wait_for_timeout(400)
    envc = dips(page.evaluate(RENDER_JS))
    check("coupé : la basse redevient constante", envc["max"] - envc["min"] < 0.01, envc)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+z"); page.wait_for_timeout(800)
    on = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(x => x.id === 'basse').modulators?.[0]?.on")
    check("Ctrl+Z : le suiveur est de nouveau actif", on is True, on)
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-modulators', { detail: { trackId: 'basse' } }))"); page.wait_for_timeout(500)
    page.evaluate("() => window.DAW_CONTROL.setTheme('light')"); page.wait_for_timeout(600)
    shot(page, "pc_02_theme_clair")
    page.evaluate("() => window.DAW_CONTROL.setTheme('dark')"); page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # 5. Sauvegarde.
    dest = OUT / "seance_suiveur.zip"
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    with zipfile.ZipFile(dest) as z:
        pj = json.loads(z.read("project.json"))
    mods = [t.get("modulators") for t in pj["tracks"] if t["id"] == "basse"][0]
    check("sauvegarde : project.json porte le suiveur (source, attaque, relâchement)",
          isinstance(mods, list) and mods[0].get("kind") == "env" and mods[0].get("source") == "kick" and mods[0].get("attack") == 5 and mods[0].get("release") == 80, mods)
    R["final_env"] = env
    errs = log.errors()
    check("bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()
    return dest


def reload_desktop(b, f: Path):
    log = Log("suiveur_rechargement")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_03_rechargement")
    page.wait_for_timeout(800)
    env = dips(page.evaluate(RENDER_JS))
    res["rechargement"] = env
    check("rechargement : même export (mêmes creux, même profondeur ±0,1 dB)",
          env["creux_s"] == res["bureau"]["final_env"]["creux_s"] and abs(env["profondeur_db"] - res["bureau"]["final_env"]["profondeur_db"]) <= 0.1,
          {"avant": res["bureau"]["final_env"], "apres": env})
    errs = log.errors()
    check("rechargement : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


def phone(b, f: Path):
    log = Log("suiveur_tel")
    ctx, page = new_page(b, "tel390", log=log, touch=True)
    open_project(page, f, "tel_00_ouvert", touch=True)
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-modulators', { detail: { trackId: 'basse' } }))"); page.wait_for_timeout(700)
    ok = page.locator('[data-testid="modulators-panel"]').is_visible() and page.locator('[data-testid="mod-source"]').is_visible()
    shot(page, "tel_01_suiveur")
    hs = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
    check("téléphone : la fenêtre du suiveur s'affiche (source visible), sans défilement horizontal", ok and hs, {"ok": ok, "hs": hs})
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
(OUT / "modulateurs_suiveur.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
