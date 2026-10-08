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
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, y: r.top, w: r.width, h: r.height, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, tt: +(c.dataset.tracksTop || 40) }; }""")


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
    # Fenêtres de 2 périodes à 220 Hz (= 4 à 440 Hz), pas de 1 ms : le niveau ne dépend pas de la phase.
    win = int(round(SR * 2 / 220))
    def env(t0, t1):
        return [round(rms_db(x[i:i + win]), 2) for i in range(int(t0 * SR) - win // 2, int(t1 * SR) - win // 2, int(0.001 * SR))]
    res["niveau_autour_in_dB"] = env(3.97, 4.03)
    res["niveau_autour_out_dB"] = env(5.97, 6.03)
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
    box = canvas_box(page)
    page.mouse.click(x_of(box, 0) + 1, box["y"] + 12); page.wait_for_timeout(300)   # clic dans la règle à 0 s
    page.mouse.click(450, 650); page.wait_for_timeout(100)
    res["qp_depart_s"] = round(engine_time(page), 3)
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


# ======================================================================= V2
V2_JS = r"""
async () => {
  const { audioEngine: e } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const F = await import('/utils/fades.ts');
  await e.init(); await e.resume();
  const SR = e.ctx.sampleRate;
  const mk = (fn, secs) => { const b = new AudioBuffer({ length: Math.round(secs * SR), numberOfChannels: 1, sampleRate: SR }); const x = b.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = fn(i / SR); return b; };
  const dc = mk(() => 0.5, 2);
  const s220 = mk(t => 0.5 * Math.sin(2 * Math.PI * 220 * t), 6);
  const s550 = mk(t => 0.5 * Math.sin(2 * Math.PI * 550 * t), 6);
  const curves = ['LINEAR', 'EQUAL_POWER', 'EXPONENTIAL', 'S_CURVE'];
  const clips = [];
  curves.forEach((cv, i) => clips.push({ id: 'dc-' + cv, type: TrackType.AUDIO, start: i * 1.5, duration: 1, offset: 0, buffer: dc, gain: 1, name: cv, fadeIn: 0.5, fadeOut: 0.3, fadeInCurve: cv, fadeOutCurve: cv }));
  // Crossfades centrés à 7 s (puissance égale) et 10 s (linéaire), 200 ms : 220 Hz → 550 Hz.
  const xf = (id, J, cv) => [
    { id: id + 'a', type: TrackType.AUDIO, start: J - 1, duration: 1.1, offset: 0, buffer: s220, gain: 1, name: 'A', fadeIn: 0, fadeOut: 0.2, fadeOutCurve: cv },
    { id: id + 'b', type: TrackType.AUDIO, start: J - 0.1, duration: 1.1, offset: 1, buffer: s550, gain: 1, name: 'B', fadeIn: 0.2, fadeInCurve: cv, fadeOut: 0 },
  ];
  clips.push(...xf('xp', 7, 'EQUAL_POWER'), ...xf('xl', 10, 'LINEAR'));
  const tr = [{ id: 'v', name: 'v', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, clips, plugins: [], sends: [], automationLanes: [] }];
  const DUR = 11.5;
  // --- Export
  const rb = await e.renderProject(tr, DUR, 0, SR);
  const exp = Array.from(rb.getChannelData(0));
  // --- Lecture : on écoute l'entrée de la piste (somme des clips après leurs gains) pendant une vraie lecture.
  e.updateTrack(tr[0], tr);
  await new Promise(r => setTimeout(r, 300));
  const dsp = e.tracksDSP.get('v');
  // Enregistreur calé (AudioWorklet de NOVA) : chaque échantillon a son numéro d'image exact.
  const R = await import('/engine/NovaRecorder.ts');
  await R.ensureRecorderModule(e.ctx);
  // Source nulle permanente : l'entrée reste « active » entre les clips (sinon le worklet saute les silences).
  const keep = e.ctx.createConstantSource(); keep.offset.value = 0; keep.connect(dsp.input); keep.start();
  const session = new R.NovaRecorderSession(e.ctx, dsp.input);
  await new Promise(r => setTimeout(r, 200));
  e.startPlayback(0, tr); const t0 = e.playbackStartTime;
  await new Promise(r => setTimeout(r, (DUR + 0.6) * 1000));
  e.stopAll();
  const { samples, firstFrame } = await session.stop(dsp.input);
  keep.stop(); keep.disconnect();
  // Échantillon de la capture qui correspond au temps 0 du projet.
  const shift = Math.round(t0 * SR) - firstFrame;
  // Recalage fin sur le 1er front (démarrage de la lecture à quelques blocs près) : on compare les FORMES.
  const first = (arr, from) => { for (let i = from; i < arr.length; i++) if (Math.abs(arr[i]) > 1e-4) return i; return -1; };
  const f0 = first(samples, Math.max(0, shift - SR)), fe = first(exp, 0);
  const start = f0 >= 0 ? f0 - fe : shift;
  const live = Array.from(samples.subarray(Math.max(0, start), Math.max(0, start) + exp.length));
  const startJitterMs = Math.round((start - shift) / SR * 1e5) / 100;
  return { SR, exp, live, shift_samples: shift, start_jitter_ms: startJitterMs, expected: curves.map(cv => [0.1, 0.25, 0.4].map(u => F.fadeInShape(cv, u / 0.5))) };
}
"""


def v2(page, res):
    page.goto(BASE, wait_until="domcontentloaded"); page.wait_for_timeout(2500)
    r = page.evaluate(V2_JS)
    sr = r["SR"]
    curves = ['LINEAR', 'EQUAL_POWER', 'EXPONENTIAL', 'S_CURVE']
    out = {"decalage_capture_lecture_ech": r["shift_samples"], "ecart_demarrage_lecture_ms": r.get("start_jitter_ms")}
    for name in ("exp", "live"):
        x = np.array(r[name], dtype=np.float64)
        np.save(OUT / f"v2_{name}.npy", x.astype(np.float32))
        m = {}
        for i, cv in enumerate(curves):
            t0 = i * 1.5
            got = [round(float(np.mean(x[int((t0 + u) * sr) - 2:int((t0 + u) * sr) + 3])) / 0.5, 4) for u in (0.1, 0.25, 0.4)]
            exp_ = [round(v, 4) for v in r["expected"][i]]
            fo = [round(float(x[int((t0 + 1 - 0.3 + 0.3 * u) * sr)]) / 0.5, 4) for u in (0.25, 0.5, 0.75)]
            m[cv] = {"fondu_entree_mesure": got, "attendu": exp_, "ecart_max": round(max(abs(a - b) for a, b in zip(got, exp_)), 4),
                     "fondu_sortie_mesure_25_50_75": fo, "saut_max": round(max_step(x[int(t0 * sr):int((t0 + 1.05) * sr)]), 5)}
        win = int(0.02 * sr)
        steady = rms_db(x[int(6.3 * sr):int(6.8 * sr)])
        def xfade(J):
            levels = [rms_db(x[k:k + win]) for k in range(int((J - 0.13) * sr), int((J + 0.11) * sr), int(0.005 * sr))]
            return {"min_dB_vs_regime": round(min(levels) - steady, 2), "max_dB_vs_regime": round(max(levels) - steady, 2), "saut_max": round(max_step(x[int((J - 0.15) * sr):int((J + 0.15) * sr)]), 4)}
        m["crossfade_puissance_egale_7s"] = xfade(7.0)
        m["crossfade_lineaire_10s"] = xfade(10.0)
        m["saut_max_sinus_regime_220_550"] = [round(max_step(x[int(6.3 * sr):int(6.8 * sr)]), 4), round(max_step(x[int(7.3 * sr):int(7.8 * sr)]), 4)]
        out[name] = m
    e, l = np.array(r["exp"]), np.array(r["live"])
    n = min(len(e), len(l))
    out["ecart_max_export_vs_lecture"] = round(float(np.max(np.abs(e[:n] - l[:n]))), 5)
    res.update(out)
    ok = all(out[k][cv]["ecart_max"] < 0.02 for k in ("exp", "live") for cv in curves)
    ok = ok and all(abs(out[k]["crossfade_puissance_egale_7s"]["min_dB_vs_regime"]) < 0.5 for k in ("exp", "live"))
    # Pas de clic : un clic ferait un saut bien plus grand (≥ 0,3) que ceux des sinus en régime.
    ok = ok and all(out[k][cv]["saut_max"] < 0.01 for k in ("exp", "live") for cv in curves)
    ok = ok and all(out[k]["crossfade_puissance_egale_7s"]["saut_max"] < 2 * out[k]["saut_max_sinus_regime_220_550"][1] for k in ("exp", "live"))
    res["ok_v2_mesures"] = bool(ok)

def lane_y(box, track_index=0, frac=0.8, zoomv=120):
    """Ordonnée (écran) d'une piste : frac = 0 haut du clip, 1 bas."""
    return box["y"] + box.get("tt", 40) + track_index * zoomv + 2 + frac * (zoomv - 4)


def v2ui(page, res):
    f = OUT / "v2_projet.zip"
    make_project(f, [track("voix", "Voix", [
        clip("A", "Phrase A", 0, 4, "audio/a.wav"),
        clip("B", "Phrase B", 4, 4, "audio/b.wav", offset=2),
    ])], {"audio/a.wav": sine_wav(220, 10), "audio/b.wav": sine_wav(550, 10)}, "Fondus V2")
    open_project(page, f, "v2ui_01_session")
    box = canvas_box(page)
    y_low = lane_y(box, 0, 0.85)
    # --- Crossfade à la souris : bas de la jonction, glisser de 0,5 s → crossfade de 1 s centré
    page.mouse.move(x_of(box, 4.0), y_low); page.wait_for_timeout(100)
    res["curseur_jonction"] = page.evaluate("() => document.querySelector('.nova-grille .custom-scroll').style.cursor")
    page.mouse.down(); page.mouse.move(x_of(box, 4.25), y_low, steps=4); page.mouse.move(x_of(box, 4.5), y_low, steps=4)
    shot(page, "v2ui_02_crossfade_en_cours")
    page.mouse.up(); page.wait_for_timeout(300)
    res["apres_crossfade"] = clips_of(page, "voix")
    a, b = res["apres_crossfade"][0], res["apres_crossfade"][1]
    res["crossfade_ok"] = abs(a["end"] - 4.5) < 0.03 and abs(b["start"] - 3.5) < 0.03 and abs(a["fadeOut"] - 1) < 0.05 and abs(b["fadeIn"] - 1) < 0.05 and a["fo"] == "EQUAL_POWER"
    shot(page, "v2ui_03_crossfade_pose")
    # --- Courbe du fondu de sortie de A : clic droit → « S » (ligne Sortie)
    page.mouse.click(x_of(box, 1.0), lane_y(box, 0, 0.6), button="right"); page.wait_for_timeout(300)
    shot(page, "v2ui_04_menu_courbes")
    page.locator('button[title^="Courbe en S"]').nth(1).click(); page.wait_for_timeout(300)
    res["courbe_sortie_A"] = clips_of(page, "voix")[0]["fo"]
    shot(page, "v2ui_05_courbe_en_S")
    # --- Nudge 10 ms au clavier sur B
    page.select_option("#nova-nudge", "MS10"); page.wait_for_timeout(200)
    page.mouse.click(x_of(box, 6.0), y_low); page.wait_for_timeout(200)
    before = [c for c in clips_of(page, "voix") if c["id"] == "B"][0]["start"]
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(150)
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(150)
    after = [c for c in clips_of(page, "voix") if c["id"] == "B"][0]["start"]
    page.keyboard.press("Shift+ArrowLeft"); page.wait_for_timeout(200)
    after2 = [c for c in clips_of(page, "voix") if c["id"] == "B"][0]["start"]
    res["nudge"] = {"avant": before, "apres_2_droite": after, "apres_maj_gauche": after2}
    res["nudge_ok"] = abs(after - before - 0.02) < 1e-6 and abs(after2 - after + 0.1) < 1e-6
    # --- Crossfade auto : on annule tout, puis on glisse B de 0,5 s sur A
    res["annulations"] = 0
    for _ in range(8):
        cl = clips_of(page, "voix")
        if [(c["start"], c["end"]) for c in cl] == [(0, 4), (4, 8)] and not cl[0]["fadeOut"]:
            break
        page.keyboard.press("Control+z"); page.wait_for_timeout(350); res["annulations"] += 1
    res["apres_annulations"] = clips_of(page, "voix")
    page.mouse.move(x_of(box, 6.0), y_low); page.mouse.down()
    page.mouse.move(x_of(box, 5.7), y_low, steps=4); page.mouse.move(x_of(box, 5.5), y_low, steps=4); page.mouse.up()
    page.wait_for_timeout(400)
    res["apres_glisser_B"] = clips_of(page, "voix")
    a, b = res["apres_glisser_B"][0], res["apres_glisser_B"][1]
    res["crossfade_auto_ok"] = abs(b["start"] - 3.5) < 0.01 and abs(a["fadeOut"] - 0.5) < 0.01 and abs(b["fadeIn"] - 0.5) < 0.01
    shot(page, "v2ui_06_crossfade_auto")
    page.keyboard.press("Control+z"); page.wait_for_timeout(400)
    res["un_seul_ctrl_z_annule_glisser_et_crossfade"] = clips_of(page, "voix")
    res["ok_v2ui"] = bool(res["crossfade_ok"] and res["courbe_sortie_A"] == "S_CURVE" and res["nudge_ok"] and res["crossfade_auto_ok"])


# ======================================================================= V3
def cursor_at(page, x, y):
    page.mouse.move(x, y); page.wait_for_timeout(80)
    return page.evaluate("() => document.querySelector('.nova-grille .custom-scroll').style.cursor")


def tsel(page):
    return page.evaluate("() => { const s = window.__novaEdit.getTimeSelection(); return s ? { start: +s.start.toFixed(4), end: +s.end.toFixed(4), pistes: s.trackIds } : null; }")


def spans(cl):
    return [(c["start"], c["end"]) for c in cl if not c["muted"]]


def drag(page, x0, y0, x1, y1, steps=6):
    page.mouse.move(x0, y0); page.mouse.down()
    page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, steps=steps); page.mouse.move(x1, y1, steps=steps)
    page.mouse.up(); page.wait_for_timeout(250)


def v3_project():
    f = OUT / "v3_projet.zip"
    make_project(f, [
        track("voix", "Voix", [clip("A", "Phrase A", 0, 4, "audio/a.wav"), clip("B", "Phrase B", 5, 4, "audio/b.wav")]),
        track("back", "Back", [clip("C", "Back C", 0, 8, "audio/c.wav")], color="#f97316"),
    ], {"audio/a.wav": sine_wav(220, 10), "audio/b.wav": sine_wav(550, 10), "audio/c.wav": sine_wav(330, 10)}, "Plage V3")
    return f


def v3(page, res):
    open_project(page, v3_project(), "v3_01_session")
    box = canvas_box(page)
    hi, lo = (lambda i: lane_y(box, i, 0.15)), (lambda i: lane_y(box, i, 0.85))  # 0,15 : au-dessus de la poignée de gain
    res["outil_par_defaut"] = page.evaluate("() => { const b = document.querySelector('button[aria-label=\"Smart Tool\"]'); return b && b.getAttribute('aria-pressed'); }")
    # --- Curseurs du Smart Tool selon la zone (comme Pro Tools)
    res["curseurs"] = {
        "moitie_haute": cursor_at(page, x_of(box, 2.0), lane_y(box, 0, 0.45)),
        "moitie_basse": cursor_at(page, x_of(box, 2.0), lo(0)),
        "bord": cursor_at(page, x_of(box, 3.97), lane_y(box, 0, 0.6)),
        "coin_haut": cursor_at(page, x_of(box, 0.1), lane_y(box, 0, 0.05)),
        "piste_vide_haut": cursor_at(page, x_of(box, 4.5), hi(0)),
    }
    res["curseurs_ok"] = res["curseurs"] == {"moitie_haute": "text", "moitie_basse": "grab", "bord": "ew-resize", "coin_haut": "nwse-resize", "piste_vide_haut": "text"}
    # --- Plage sur deux pistes : moitié haute de A, de 1 s à 3 s, en descendant sur Back
    drag(page, x_of(box, 1.0), hi(0), x_of(box, 3.0), hi(1))
    res["selection"] = tsel(page)
    res["tete_de_lecture_au_debut"] = round(engine_time(page), 3)
    shot(page, "v3_02_selection_2_pistes")
    res["barre_actions_visible"] = page.locator('[data-nova-target="range-actions"]').is_visible()
    # --- Copier, coller à 10 s (clic simple = point d'insertion), annuler
    page.keyboard.press("Control+c"); page.wait_for_timeout(200)
    page.mouse.click(x_of(box, 10.0), hi(0)); page.wait_for_timeout(250)
    res["apres_clic_simple"] = {"selection": tsel(page), "tete": round(engine_time(page), 3)}
    page.keyboard.press("Control+v"); page.wait_for_timeout(400)
    res["colle"] = {"voix": spans(clips_of(page, "voix")), "back": spans(clips_of(page, "back"))}
    shot(page, "v3_03_colle_a_10s")
    res["coller_ok"] = (10.0, 12.0) in res["colle"]["voix"] and (10.0, 12.0) in res["colle"]["back"]
    page.keyboard.press("Control+z"); page.wait_for_timeout(450)
    res["annule"] = {"voix": spans(clips_of(page, "voix")), "back": spans(clips_of(page, "back"))}
    # --- Séparer (Ctrl+E) sur 2 → 6 s de la voix
    drag(page, x_of(box, 2.0), hi(0), x_of(box, 6.0), hi(0))
    res["selection_2"] = tsel(page)
    page.keyboard.press("Control+e"); page.wait_for_timeout(350)
    res["separe"] = spans(clips_of(page, "voix"))
    res["separer_ok"] = res["separe"] == [(0, 2), (2, 4), (5, 6), (6, 9)]
    # --- Consolider (Alt+Maj+3) la même plage : un seul clip 2 → 6 s
    page.keyboard.press("Alt+Shift+Digit3"); page.wait_for_timeout(1200)
    res["consolide"] = spans(clips_of(page, "voix"))
    x = np.array(page.evaluate(RENDER_JS, ["voix", 9.5]), dtype=np.float64)
    res["consolide_audio"] = {"2,5s_Hz": round(analyse_freq(x, SR, 2.3, 3.7)), "4,5s_dB": round(rms_db(x[int(4.2 * SR):int(4.8 * SR)]), 1),
                              "5,5s_Hz": round(analyse_freq(x, SR, 5.1, 5.9)), "saut_max_aux_bords": round(max(max_step(x[int(1.9 * SR):int(2.1 * SR)]), max_step(x[int(5.9 * SR):int(6.1 * SR)])), 4)}
    shot(page, "v3_04_consolide")
    res["consolider_ok"] = (2.0, 6.0) in res["consolide"] and res["consolide_audio"]["2,5s_Hz"] in range(215, 226) and res["consolide_audio"]["5,5s_Hz"] in range(540, 561) and res["consolide_audio"]["4,5s_dB"] < -90
    for _ in range(2):
        page.keyboard.press("Control+z"); page.wait_for_timeout(450)
    res["annule_2_fois"] = spans(clips_of(page, "voix"))
    # --- Dupliquer, boucler, effacer (barre d'actions)
    drag(page, x_of(box, 1.0), hi(1), x_of(box, 2.0), hi(1))
    page.locator('[data-nova-target="range-actions"] button[aria-label="Dupliquer"]').click(); page.wait_for_timeout(350)
    res["duplique_back"] = spans(clips_of(page, "back"))
    res["selection_apres_dupliquer"] = tsel(page)
    page.locator('[data-nova-target="range-actions"] button[aria-label="Boucler"]').click(); page.wait_for_timeout(250)
    res["boucle"] = st(page, "s => ({ actif: s.isLoopActive, debut: s.loopStart, fin: s.loopEnd })")
    page.locator('[data-nova-target="range-actions"] button[aria-label="Punch"]').click(); page.wait_for_timeout(250)
    res["punch_depuis_plage"] = st(page, "s => ({ actif: s.punch.enabled, entree: s.punch.punchIn, sortie: s.punch.punchOut })")
    page.keyboard.press("Delete"); page.wait_for_timeout(350)
    res["efface_back"] = spans(clips_of(page, "back"))
    shot(page, "v3_05_duplique_efface")
    # --- Exporter la plage : la fenêtre d'export s'ouvre sur « Ta sélection »
    drag(page, x_of(box, 0.5), hi(0), x_of(box, 1.5), hi(0))
    page.locator('[data-nova-target="range-actions"] button[aria-label="Exporter"]').click(); page.wait_for_timeout(1500)
    res["export_plage"] = page.evaluate("() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'SELECTION')); return s ? s.value : null; }")
    shot(page, "v3_06_export_selection")
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    close = page.get_by_role("button", name="Fermer", exact=True).locator("visible=true").first
    try:
        if close.is_visible(): close.click(); page.wait_for_timeout(300)
    except Exception:
        pass
    # --- Smart Tool : moitié basse = déplacement, bord = rognage, coin haut = fondu
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    page.evaluate("() => window.__novaEdit.clearSelection()")
    drag(page, x_of(box, 7.0), lo(0), x_of(box, 8.0), lo(0))
    res["deplace_B"] = [c for c in clips_of(page, "voix") if c["id"] == "B"]
    drag(page, x_of(box, 3.97), lane_y(box, 0, 0.6), x_of(box, 3.5), lane_y(box, 0, 0.6))
    res["rogne_A"] = [c for c in clips_of(page, "voix") if c["id"] == "A"]
    drag(page, x_of(box, 0.05), lane_y(box, 0, 0.05), x_of(box, 1.0), lane_y(box, 0, 0.05))
    res["fondu_A"] = [c for c in clips_of(page, "voix") if c["id"] == "A"]
    res["selection_apres_gestes_bas"] = tsel(page)
    shot(page, "v3_07_smart_tool_gestes")
    b = res["deplace_B"][0]; a = res["fondu_A"][0]
    res["smart_tool_ok"] = abs(b["start"] - 6.0) < 0.01 and abs(a["end"] - 3.5) < 0.01 and a["fadeIn"] > 0.5 and res["selection_apres_gestes_bas"] is None
    res["ok_v3"] = bool(res["outil_par_defaut"] == "true" and res["curseurs_ok"] and res["selection"] == {"start": 1.0, "end": 3.0, "pistes": ["voix", "back"]}
                        and res["coller_ok"] and res["separer_ok"] and res["consolider_ok"] and res["export_plage"] == "SELECTION" and res["smart_tool_ok"])


def v3_ecrans(page, res, vp):
    """Tablette et téléphone : rien ne casse (pas de défilement horizontal, Grabber par défaut au doigt)."""
    open_project(page, v3_project(), f"v3_{vp}_01_session")
    res[f"{vp}_outil"] = page.evaluate("() => [...document.querySelectorAll('button[aria-pressed=\"true\"]')].map(b => b.getAttribute('aria-label')).filter(Boolean)")
    res[f"{vp}_debordements"] = qalib.overflow_report(page)[:10]
    page.evaluate("() => window.__novaEdit.selectRange(1, 3, ['voix'])"); page.wait_for_timeout(300)
    shot(page, f"v3_{vp}_02_plage")
    res[f"{vp}_barre_plage_dans_ecran"] = page.evaluate("() => { const b = document.querySelector('[data-nova-target=\"range-actions\"]'); if (!b) return 'absente'; const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }")
    res[f"{vp}_hscroll"] = page.evaluate("() => document.documentElement.scrollWidth > innerWidth + 1")


SCENARIOS = {"v1": v1, "v2": v2, "v2ui": v2ui, "v3": v3, "v3tab": lambda p, r: v3_ecrans(p, r, "tab"), "v3tel": lambda p, r: v3_ecrans(p, r, "tel")}
VIEWPORT = {"v3tab": "tab", "v3tel": "tel"}


def main(names):
    summary = {}
    with sync_playwright() as p:
        b = launch(p)
        for n in names:
            log = Log(f"protools_{n}")
            res = {"name": n, "ok": True}
            vp = VIEWPORT.get(n, "pc")
            ctx, page = new_page(b, vp, log, touch=(vp != "pc"))
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
