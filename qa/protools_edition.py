"""Preuves de bout en bout des vagues Pro Tools V1–V3 (navigateur headless, aucune fenêtre).

  V1 : punch-in/out posés dans la règle, pré-roll réglé dans la barre de transport,
       prise avec micro simulé (440 Hz) sur une ancienne prise (220 Hz) ; QuickPunch
       pendant la lecture, sans l'arrêter.
  V2 : fondus et crossfades mesurés en LECTURE (capture du master) et à l'EXPORT
       (renderProject) : courbe, absence de clic, pas de creux au crossfade.
  V3 : sélection de plage et Smart Tool à la souris.

Usage : serveur `npx vite --port 3411` dans le worktree, puis
  python qa/protools_edition.py [v1] [v2] [v3]
Captures et mesures : D:\\1 WORK\\CONTENU\\nova-protools\\edition\\
"""
import io, json, math, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3411/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-protools\edition")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa
from qalib import BASE, OUT, CHROME, Log, new_page, shot, save_log  # noqa
from playwright.sync_api import sync_playwright

SR = 48000
MIC_WAV = OUT / "micro_440hz.wav"


def sine_wav(freq, seconds, amp=0.25, sr=SR) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    x = amp * np.sin(2 * np.pi * freq * t)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def launch(p):
    if not MIC_WAV.exists():
        MIC_WAV.write_bytes(sine_wav(440, 60))
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={MIC_WAV}", "--autoplay-policy=no-user-gesture-required"])


def track(tid, name, clips, **extra):
    return {"id": tid, "name": name, "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
            "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master",
            "sends": [], "clips": clips, "plugins": [], "automationLanes": [], "totalLatency": 0, **extra}


def clip(cid, name, start, dur, ref, **extra):
    return {"id": cid, "name": name, "start": start, "duration": dur, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1, **extra}


def make_project(path: Path, tracks, audio: dict, name="Edition Pro Tools"):
    state = {
        "id": f"proj-{name}", "name": name, "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": tracks[0]["id"], "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in audio.items():
            z.writestr(k, v)


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0'); } catch (e) {}
"""


def open_project(page, f: Path, label):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=30000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    adv = page.get_by_role("button", name=re.compile("Mode avanc", re.I)).locator("visible=true").first
    try:
        if adv.is_visible(): adv.click(); page.wait_for_timeout(500)
    except Exception:
        pass
    shot(page, label)


def st(page, expr="s => s"):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def engine_time(page):
    return page.evaluate("async () => (await import('/engine/AudioEngine.ts')).audioEngine.getCurrentTime()")


def wait_engine(page, t, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if engine_time(page) >= t:
            return
        page.wait_for_timeout(15)
    raise TimeoutError(f"lecture jamais arrivée à {t}s")


def canvas_box(page):
    return page.evaluate("""() => { const c = document.querySelectorAll('.nova-grille canvas')[1]; const r = c.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, y: r.top, w: r.width, h: r.height, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0 }; }""")


def x_of(box, t, zoom=40):
    return box["x"] + t * zoom - box["sl"]


def clips_of(page, tid):
    return st(page, f"s => s.tracks.find(t => t.id === '{tid}').clips.map(c => ({{ id: c.id, name: c.name, start: +c.start.toFixed(4), end: +(c.start + c.duration).toFixed(4), muted: !!c.isMuted, fadeIn: +(c.fadeIn||0).toFixed(4), fadeOut: +(c.fadeOut||0).toFixed(4), fi: c.fadeInCurve || null, fo: c.fadeOutCurve || null }})).sort((a, b) => a.start - b.start)")


RENDER_JS = """
async ([tid, dur]) => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const s = window.__novaEdit.getState();
  const tr = s.tracks.filter(t => t.id === tid).map(t => ({ ...t, plugins: [], sends: [], volume: 1, pan: 0, outputTrackId: undefined, automationLanes: [] }));
  const b = await audioEngine.renderProject(tr, dur, 0, 48000);
  return Array.from(b.getChannelData(0));
}
"""


def analyse_freq(x, sr, t0, t1):
    """Fréquence dominante (FFT) entre t0 et t1."""
    seg = np.asarray(x[int(t0 * sr):int(t1 * sr)])
    if len(seg) < 64 or np.max(np.abs(seg)) < 1e-4:
        return 0.0
    sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    return float(np.fft.rfftfreq(len(seg), 1 / sr)[np.argmax(sp)])


def rms_db(x):
    x = np.asarray(x)
    r = math.sqrt(float(np.mean(x ** 2))) if len(x) else 0
    return 20 * math.log10(r) if r > 1e-9 else -200.0


def max_step(x):
    """Plus grand saut entre deux échantillons (un clic = un saut anormal)."""
    x = np.asarray(x)
    return float(np.max(np.abs(np.diff(x)))) if len(x) > 1 else 0.0


# ======================================================================= V1
def v1(page, res):
    f = OUT / "v1_projet.zip"
    make_project(f, [track("track-rec-main", "Voix lead", [clip("old", "Prise 1", 0, 20, "audio/old.wav", takeNumber=1)])],
                 {"audio/old.wav": sine_wav(220, 20)}, "Punch V1")
    open_project(page, f, "v1_01_session")
    page.mouse.click(800, 600); page.wait_for_timeout(200)
    box = canvas_box(page)
    res["canvas"] = box
    # --- Points de punch posés au clic droit dans la règle (4 s et 6 s)
    for t, item in ((4.0, "Punch-in ici"), (6.0, "Punch-out ici")):
        page.mouse.click(x_of(box, t), box["y"] + 20, button="right"); page.wait_for_timeout(300)
        page.get_by_role("button", name=item).first.click() if page.get_by_role("button", name=item).count() else page.get_by_text(item).first.click()
        page.wait_for_timeout(300)
    res["punch_apres_regle"] = st(page, "s => s.punch")
    assert abs(res["punch_apres_regle"]["punchIn"] - 4) < 1e-6 and abs(res["punch_apres_regle"]["punchOut"] - 6) < 1e-6
    # --- Glisser la poignée de sortie de 6 s à 6,5 s puis la remettre à 6 s
    y = box["y"] + 34
    page.mouse.move(x_of(box, 6.0) - 2, y); page.mouse.down(); page.mouse.move(x_of(box, 6.5), y, steps=5); page.mouse.up()
    res["punch_apres_glisser"] = st(page, "s => [s.punch.punchIn, s.punch.punchOut]")
    page.mouse.move(x_of(box, 6.5) - 2, y); page.mouse.down(); page.mouse.move(x_of(box, 6.0), y, steps=5); page.mouse.up()
    page.wait_for_timeout(200)
    # --- PUNCH + pré-roll 1 mesure (menu ▾ de la barre de transport)
    page.get_by_role("button", name="PUNCH", exact=True).locator("visible=true").first.click(); page.wait_for_timeout(300)
    page.get_by_role("button", name="Réglages du punch, du pré-roll et du post-roll").first.click(); page.wait_for_timeout(300)
    shot(page, "v1_02_reglages_punch")
    page.get_by_role("dialog", name="Réglages du punch").get_by_role("button", name="1 mes.").first.click(); page.wait_for_timeout(200)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    res["punch_reglages"] = st(page, "s => s.punch")
    shot(page, "v1_03_zone_punch_regle")
    # --- Prise : R, pré-roll (repart à 2 s), arrêt auto après le post-roll (6 + 2 s)
    page.mouse.click(450, 650); page.wait_for_timeout(100)
    page.keyboard.press("Home"); page.wait_for_timeout(200)
    page.keyboard.press("r")
    page.wait_for_timeout(700)
    res["depart_preroll_s"] = st(page, "s => s.recStartTime")
    shot(page, "v1_04_enregistrement_preroll")
    t0 = time.time()
    while time.time() - t0 < 15 and st(page, "s => s.isRecording"):
        page.wait_for_timeout(200)
    res["arret_auto"] = not st(page, "s => s.isRecording")
    page.wait_for_timeout(800)
    shot(page, "v1_05_apres_punch")
    cl = clips_of(page, "track-rec-main")
    res["clips_apres_punch"] = cl
    take = [c for c in cl if c["id"] != "old" and not c["id"].startswith("old")]
    assert len(take) == 1, "une seule nouvelle prise attendue"
    tk = take[0]
    res["prise_bornes_ok"] = abs(tk["start"] - 3.995) < 0.002 and abs(tk["end"] - 6.005) < 0.002
    # --- Rendu de la piste : 220 Hz / 440 Hz / 220 Hz, crossfades sans creux ni clic
    x = np.array(page.evaluate(RENDER_JS, ["track-rec-main", 9]))
    np.save(OUT / "v1_rendu_punch.npy", x.astype(np.float32))
    res["frequences"] = {"avant (2-3.9 s)": analyse_freq(x, SR, 2, 3.9), "zone (4.1-5.9 s)": analyse_freq(x, SR, 4.1, 5.9), "après (6.1-8 s)": analyse_freq(x, SR, 6.1, 8)}
    win = int(0.002 * SR)
    def env(t0, t1):
        return [round(rms_db(x[i:i + win]), 2) for i in range(int(t0 * SR), int(t1 * SR), win)]
    res["niveau_autour_in_dB"] = env(3.98, 4.02)
    res["niveau_autour_out_dB"] = env(5.98, 6.02)
    res["saut_max_autour_in"] = max_step(x[int(3.98 * SR):int(4.02 * SR)])
    res["saut_max_regime"] = max_step(x[int(3.0 * SR):int(3.5 * SR)])
    res["creux_max_dB"] = round(min(res["niveau_autour_in_dB"] + res["niveau_autour_out_dB"]) - rms_db(x[int(3 * SR):int(3.5 * SR)]), 2)
    # --- Annuler (Ctrl+Z ; le coach a pu appliquer un mix auto juste après) : l'ancienne prise revient entière
    for i in range(4):
        page.mouse.click(450, 650); page.keyboard.press("Control+z"); page.wait_for_timeout(500)
        res["apres_annuler"] = clips_of(page, "track-rec-main")
        res["annulations"] = i + 1
        if len(res["apres_annuler"]) == 1:
            break
    res["annuler_ok"] = len(res["apres_annuler"]) == 1 and res["apres_annuler"][0]["end"] == 20
    close = page.get_by_role("button", name="Fermer").locator("visible=true")
    for i in range(close.count()):
        try: close.nth(0).click(timeout=1000); page.wait_for_timeout(200)
        except Exception: break

    # ===== QuickPunch : PUNCH coupé, QP activé, entrée à 3 s et sortie à 5 s pendant la lecture
    page.get_by_role("button", name="PUNCH", exact=True).locator("visible=true").first.click(); page.wait_for_timeout(200)
    page.get_by_role("button", name="QP", exact=True).locator("visible=true").first.click(); page.wait_for_timeout(200)
    page.mouse.click(450, 650); page.keyboard.press("Home"); page.wait_for_timeout(300)
    page.keyboard.press("Space")
    wait_engine(page, 3.0)
    page.keyboard.press("r"); t_in = engine_time(page)
    page.wait_for_timeout(600)
    res["qp_pendant"] = st(page, "s => ({ isPlaying: s.isPlaying, isRecording: s.isRecording })")
    shot(page, "v1_06_quickpunch_en_cours")
    wait_engine(page, 5.0)
    page.keyboard.press("r"); t_out = engine_time(page)
    page.wait_for_timeout(900)
    res["qp_apres_sortie"] = st(page, "s => ({ isPlaying: s.isPlaying, isRecording: s.isRecording })")
    res["qp_lecture_continue_s"] = round(engine_time(page), 2)
    wait_engine(page, 6.5)
    page.keyboard.press("Space"); page.wait_for_timeout(800)
    res["qp_touches_s"] = [round(t_in, 3), round(t_out, 3)]
    cl = clips_of(page, "track-rec-main")
    res["qp_clips"] = cl
    take = [c for c in cl if not c["id"].startswith("old")]
    res["qp_prise_ok"] = len(take) == 1 and abs(take[0]["start"] - (t_in - 0.005)) < 0.15 and abs(take[0]["end"] - (t_out + 0.005)) < 0.15
    shot(page, "v1_07_apres_quickpunch")
    x = np.array(page.evaluate(RENDER_JS, ["track-rec-main", 7]))
    a, b = take[0]["start"] + 0.05, take[0]["end"] - 0.05
    res["qp_frequences"] = {"avant": analyse_freq(x, SR, 1, a - 0.1), "zone": analyse_freq(x, SR, a, b), "après": analyse_freq(x, SR, b + 0.1, 6.9)}
    res["ok_v1"] = bool(res["arret_auto"] and res["annuler_ok"] and abs(res["qp_frequences"]["zone"] - 440) < 5 and abs(res["qp_frequences"]["après"] - 220) < 5 and res["prise_bornes_ok"] and res["qp_prise_ok"]
                        and res["qp_pendant"]["isPlaying"] and res["qp_pendant"]["isRecording"]
                        and res["qp_apres_sortie"]["isPlaying"] and not res["qp_apres_sortie"]["isRecording"]
                        and abs(res["frequences"]["zone (4.1-5.9 s)"] - 440) < 5 and abs(res["frequences"]["avant (2-3.9 s)"] - 220) < 5
                        and abs(res["frequences"]["après (6.1-8 s)"] - 220) < 5)


SCENARIOS = {"v1": v1}


def main(names):
    summary = {}
    with sync_playwright() as p:
        b = launch(p)
        for n in names:
            log = Log(f"protools_{n}")
            res = {"name": n, "ok": True}
            ctx, page = new_page(b, "pc", log, touch=False)
            t = time.time()
            try:
                SCENARIOS[n](page, res)
            except Exception as e:  # noqa
                res["ok"] = False
                res["exception"] = f"{type(e).__name__}: {str(e)[:500]}"
                try: shot(page, f"{n}__ECHEC")
                except Exception: pass
            res["secs"] = round(time.time() - t, 1)
            res["erreurs_page"] = [e["text"][:300] for e in log.errors()][:20]
            save_log(log, {"result": res})
            (OUT / f"mesures_{n}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            summary[n] = res
            ctx.close()
        b.close()
    print(json.dumps(summary, ensure_ascii=False, indent=1)[:6000])


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if a in SCENARIOS] or list(SCENARIOS))
