"""Récupération après plantage, en tuant VRAIMENT le navigateur au milieu d'une prise.

Deux scénarios (profil de navigateur persistant, comme un vrai poste) :
  A. « onglet tué » : le processus de rendu de l'onglet est tué net (TerminateProcess)
     pendant l'enregistrement ;
  B. « coupure de courant » : TOUS les processus du navigateur sont tués net
     (SIGKILL / TerminateProcess), sans aucune fermeture propre.
Pour chacun : projet ouvert (2 pistes avec du son), première sauvegarde automatique,
prise au micro simulé pendant ~12 s, mise à mort, relance du navigateur sur le même
profil, « Récupérer la session » : on mesure la durée de prise récupérée par rapport
à la durée réellement enregistrée avant la mise à mort, et on vérifie que le reste du
projet est revenu (pistes, clips, sons).

Usage : NOVA_URL=http://127.0.0.1:3442/ PYTHONIOENCODING=utf-8 python qa/recuperation_plantage.py
Résultats : D:\\1 WORK\\CONTENU\\nova-stabilite\\recuperation_plantage.json (+ captures)
"""
import io, json, os, shutil, sys, tempfile, time, wave, zipfile
from pathlib import Path

import numpy as np
import psutil

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-stabilite")
from qalib import BASE, OUT, CHROME, FAKE_WAV, APP_MODULE_INIT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
REC_SECONDS = float(os.environ.get("QA_REC_SECONDS", "12"))


def tone_wav(freq, dur):
    t = np.arange(int(dur * SR)) / SR
    x = 0.2 * np.sin(2 * np.pi * freq * t)
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())
    return b.getvalue()


def make_project(path: Path):
    def tr(tid, name, clips, **kw):
        t = {"id": tid, "name": name, "type": "AUDIO", "color": "#3b82f6", "isMuted": False, "isSolo": False, "isTrackArmed": False,
             "isFrozen": False, "volume": 0.8, "pan": 0, "outputTrackId": "master", "sends": [], "clips": clips, "plugins": [],
             "automationLanes": [], "totalLatency": 0}
        t.update(kw)
        return t
    master = tr("master", "MASTER BUS", [], type="BUS", outputTrackId="")
    guitare = tr("guitare", "Guitare", [{"id": "g1", "name": "Riff", "start": 0, "duration": 20, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                                          "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/riff.wav", "gain": 1}],
                 plugins=[{"id": "g-comp", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "params": {}}])
    rec = tr("rec", "VOIX", [], color="#ff0000")
    state = {"id": "proj-recup", "name": "Test récupération", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
             "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
             "tracks": [master, guitare, rec], "trackGroups": [], "markers": [{"id": "m1", "time": 4, "label": "Couplet"}],
             "selectedTrackId": "rec", "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "isLowLatencyMode": False,
             "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/riff.wav", tone_wav(220, 20))


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}
"""


def launch(p, profile: Path):
    ctx = p.chromium.launch_persistent_context(
        str(profile), headless=True, executable_path=CHROME, viewport={"width": 1600, "height": 900}, locale="fr-BE",
        permissions=["microphone"],
        args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
              "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])
    ctx.add_init_script(INIT)
    ctx.add_init_script(APP_MODULE_INIT)
    # Aucune écriture vers l'extérieur (Supabase…), aucun pont local.
    def guard(route, request):
        url = request.url
        if request.method in ("POST", "PATCH", "PUT", "DELETE") and not url.startswith(BASE.rstrip("/")):
            return route.abort()
        return route.continue_()
    ctx.route("**/*", guard)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.route_web_socket(__import__("re").compile(r"^ws://(127\.0\.0\.1|localhost):876[56]"), lambda ws: ws.close())
    page.set_default_timeout(20000)
    return ctx, page


def browser_tree(profile: Path):
    """Processus du navigateur lancé sur ce profil : (principal, enfants)."""
    key = str(profile).lower()
    for pr in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cmd = [x for x in (pr.info["cmdline"] or [])]
            if "chrome" in (pr.info["name"] or "").lower() and key in " ".join(cmd).lower() and not any(x.startswith("--type=") for x in cmd):
                return pr, pr.children(recursive=True)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return None, []


def kill_all(procs):
    for pr in procs:
        try: pr.kill()
        except Exception: pass


def open_project(page, f):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=40000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    for _ in range(40):
        page.wait_for_timeout(500)
        if page.evaluate("() => !!(window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.some(t => t.id === 'rec'))"):
            break


STATE_JS = """() => { const s = window.DAW_CONTROL.getState(); return { recording: s.isRecording, tracks: s.tracks.map(t => ({ id: t.id, name: t.name,
  clips: t.clips.map(c => ({ id: c.id, name: c.name, start: Math.round(c.start * 1000) / 1000, duration: Math.round(c.duration * 1000) / 1000, hasAudio: !!(c.bufferId && window.DAW_CONTROL.diag && true) })) })),
  markers: (s.markers || []).length, buffers: window.DAW_CONTROL.diag().buffers }; }"""


def scenario(p, name, kill):
    res = {"scenario": name, "ok": False}
    profile = Path(tempfile.mkdtemp(prefix=f"nova-recup-{name}-", dir=os.environ.get("QA_TMP") or None))
    proj = OUT / "recuperation_projet.novaproj.zip"
    make_project(proj)
    try:
        ctx, page = launch(p, profile)
        open_project(page, proj)
        page.wait_for_timeout(1500)
        # Première version automatique (toutes les 15 s si le projet a du contenu).
        t0 = time.time()
        while time.time() - t0 < 25:
            n = page.evaluate("async () => { try { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); return (await m.recoveryStore().listVersions()).length; } catch (e) { return -1; } }")
            if n and n > 0: break
            page.wait_for_timeout(1000)
        res["versions_avant_prise"] = n
        page.evaluate("() => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'rec'); window.DAW_CONTROL.updateTrack({ ...t, isTrackArmed: true }); }")
        page.wait_for_timeout(1500)
        page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
        # Début réel de la prise : quand l'état passe « en enregistrement ».
        for _ in range(100):
            if page.evaluate("() => window.DAW_CONTROL.getState().isRecording"): break
            page.wait_for_timeout(50)
        rec_start = time.time()
        page.screenshot(path=str(OUT / f"recup_{name}_1_pendant_prise.png"))
        while time.time() - rec_start < REC_SECONDS:
            page.wait_for_timeout(100)
        recorded = time.time() - rec_start
        res["prise_enregistree_s"] = round(recorded, 2)
        res["mise_a_mort"] = kill
        main, kids = browser_tree(profile)
        kill_ms = time.time() * 1000
        if kill == "onglet":
            # Onglet tué : le processus de rendu meurt net (comme un plantage de l'onglet).
            renderers = [k for k in kids if any(a.startswith("--type=renderer") for a in (k.cmdline() or []))]
            res["processus_tues"] = len(renderers)
            kill_all(renderers)
            time.sleep(2)
            # On rouvre Nova dans le même navigateur (nouvel onglet).
            page = ctx.new_page()
            page.route_web_socket(__import__("re").compile(r"^ws://(127\.0\.0\.1|localhost):876[56]"), lambda ws: ws.close())
            page.set_default_timeout(20000)
        else:
            # Coupure de courant : tous les processus du navigateur tués net.
            procs = ([main] if main else []) + kids
            res["processus_tues"] = len(procs)
            kill_all(procs)
            time.sleep(2)
            try: ctx.close()
            except Exception: pass
            ctx, page = launch(p, profile)

        page.goto(BASE, wait_until="domcontentloaded")
        dlg = page.get_by_test_id("crash-recovery")
        dlg.wait_for(timeout=30000)
        page.wait_for_timeout(500)
        res["proposition"] = dlg.inner_text()[:600]
        # Début réel de la capture (horodatage du journal de prise) -> durée captée jusqu'à la mise à mort.
        takes = page.evaluate("async () => { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); return (await m.recoveryStore().pendingTakes()).map(t => ({ startedAt: t.startedAt, samples: t.samples, sr: t.sampleRate })); }")
        if takes:
            res["capte_jusqu_a_la_mise_a_mort_s"] = round((kill_ms - takes[-1]["startedAt"]) / 1000, 2)
        page.screenshot(path=str(OUT / f"recup_{name}_2_proposition.png"))
        page.get_by_role("button", name="Récupérer la session").click()
        for _ in range(60):
            page.wait_for_timeout(500)
            ok = page.evaluate("() => !!(window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.some(t => t.clips.some(c => /récupérée/.test(c.name || ''))))")
            if ok: break
        page.wait_for_timeout(2500)
        st = page.evaluate(STATE_JS)
        page.screenshot(path=str(OUT / f"recup_{name}_3_recuperee.png"))
        voix = next((t for t in st["tracks"] if t["id"] == "rec"), None)
        recup = [c for t in st["tracks"] for c in t["clips"] if "récupérée" in (c["name"] or "")]
        res["etat_apres"] = st
        res["prise_recuperee_s"] = recup[0]["duration"] if recup else 0
        ref = res.get("capte_jusqu_a_la_mise_a_mort_s", res["prise_enregistree_s"])
        res["perte_s"] = round(ref - res["prise_recuperee_s"], 2)
        guitare = next((t for t in st["tracks"] if t["id"] == "guitare"), None)
        res["projet_revenu"] = bool(guitare and guitare["clips"] and st["markers"] >= 1)
        res["notification"] = page.evaluate("() => Array.from(document.querySelectorAll('[role=status], [role=alert]')).map(e => e.innerText).filter(t => /récup|🛟/i.test(t)).slice(0, 3)")
        res["ok"] = bool(recup) and res["perte_s"] < 1.0 and res["projet_revenu"] and voix is not None
        try: ctx.close()
        except Exception: pass
    except Exception as e:  # noqa
        res["erreur"] = f"{type(e).__name__}: {str(e)[:400]}"
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    return res


if __name__ == "__main__":
    out = {"date": time.strftime("%Y-%m-%d %H:%M"), "url": BASE, "duree_prise_visee_s": REC_SECONDS, "scenarios": []}
    with sync_playwright() as p:
        for name, kill in (("onglet_tue", "onglet"), ("coupure_courant", "processus")):
            r = scenario(p, name, kill)
            print(json.dumps({k: v for k, v in r.items() if k != "etat_apres"}, ensure_ascii=False))
            out["scenarios"].append(r)
    out["ok"] = all(s.get("ok") for s in out["scenarios"])
    (OUT / "recuperation_plantage.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("OK" if out["ok"] else "ÉCHEC", "→", OUT / "recuperation_plantage.json")
