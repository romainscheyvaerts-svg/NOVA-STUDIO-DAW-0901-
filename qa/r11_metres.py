"""R11 · Mètres et tranche : preuves dans un navigateur headless (aucune fenêtre).

  A. Moteur (lecture réelle, AudioContext temps réel du navigateur) :
     - gauche et droite indépendants (sinus à gauche seulement) ;
     - Ø : une piste et sa copie polarité inversée s'annulent au master ;
       mono (somme) et largeur 0 mesurés ; corrélation +1 / −1 ;
     - point de mesure pré / post-fader ;
     - réduction de gain affichée = réduction mesurée (limiteur, compresseur) ;
  B. LUFS NOVA en direct comparé à ffmpeg ebur128 sur l'export du même projet
     (±0,1 LU), et le mètre AudioWorklet rejoué hors ligne sur ce même fichier ;
  C. Coût processeur avec 40 pistes (rendu hors ligne avec / sans mètres =
     coût côté fil audio ; métriques du fil principal pendant la lecture) ;
  D. Interface : captures PC, tablette, téléphone, en sombre et en clair
     (console, en-têtes de piste, fenêtre Loudness).

NOVA_URL=http://127.0.0.1:3448/ PYTHONIOENCODING=utf-8 python qa/r11_metres.py [A] [B] [C] [D]
Sorties : D:\\1 WORK\\CONTENU\\nova-r11\\ (r11_metres.json, captures, export WAV)
"""
import base64, io, json, os, re, subprocess, sys, time, wave, zipfile
from pathlib import Path
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3448/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r11")
from qalib import launch, new_page, shot, overflow_report, Log, OUT, BASE  # noqa: E402
from gel_pre_effet import prepare, open_project_file, export_wav  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
PROJECT = OUT / "r11_projet.novaproj.zip"
RESULT = OUT / "r11_metres.json"
FFMPEG = "ffmpeg"

ENGINE_PRELUDE = r"""
  const E = await window.__novaAppModule('/engine/AudioEngine.ts');
  const e = E.audioEngine;
  const { meterBank, MASTER_OUT } = await window.__novaAppModule('/engine/meters/meterBank.ts');
  const { TrackType } = await window.__novaAppModule('/types.ts');
  await e.init(); await e.resume();
  const SR = e.ctx.sampleRate;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Attend une durée de CONTEXTE audio (le navigateur headless peut être plus lent que l'horloge murale).
  const waitAudio = async (sec) => { const c0 = e.ctx.currentTime, w0 = performance.now(); while (e.ctx.currentTime - c0 < sec && performance.now() - w0 < sec * 4000 + 5000) await sleep(40); };
  const buf = (sec, fl, fr) => { const b = new AudioBuffer({ length: Math.round(SR * sec), numberOfChannels: 2, sampleRate: SR });
    const L = b.getChannelData(0), R = b.getChannelData(1); for (let i = 0; i < L.length; i++) { L[i] = fl(i / SR); R[i] = fr(i / SR); } return b; };
  const sine = (a, f = 1000) => t => a * Math.sin(2 * Math.PI * f * t);
  const zero = () => 0;
  const track = (id, b, extra) => ({ id, name: id, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    clips: [{ id: 'c-' + id, type: TrackType.AUDIO, start: 0, duration: b.duration, offset: 0, buffer: b, gain: 1, name: 'c-' + id }],
    plugins: [], sends: [], automationLanes: [], outputTrackId: '', totalLatency: 0, color: '#22d3ee', ...extra });
  const db = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : (x > 0 ? 999 : -999);
  const view = id => { const v = meterBank.view(id); return v ? { peak: v.peak.map(db), rms: v.rms.map(db), tp: db(v.maxTp), corr: Math.round(v.corr * 1000) / 1000 } : null; };
  let current = [];
  const play = async (tracks, sec) => {
    current.forEach(t => { if (!tracks.find(x => x.id === t.id)) e.disposeTrack(t.id); });
    current = tracks;
    tracks.forEach(t => e.updateTrack(t, tracks));
    await sleep(400);
    meterBank.resetClip();
    e.startPlayback(0, tracks);
    await waitAudio(sec);
  };
"""

JS_A = "async () => {" + ENGINE_PRELUDE + r"""
  const out = {};
  // 1. Gauche / droite, mono, corrélation
  const L6 = buf(3, sine(0.5), zero);                       // gauche seule, −6,02 dBFS
  const same = buf(3, sine(0.25), sine(0.25));              // G = D
  const anti = buf(3, sine(0.25), t => -sine(0.25)(t));     // D = −G
  await play([track('gauche', L6), track('mono', L6, { monoSum: true }), track('identique', same), track('opposition', anti),
              track('largeur0', anti, { stereoWidth: 0 })], 1.6);
  out.gauche_seule = view('gauche'); out.mono_somme = view('mono'); out.identique = view('identique'); out.opposition = view('opposition');
  out.opposition_largeur_0 = view('largeur0');
  e.stopAll(); await sleep(300);
  // 2. Ø : piste + copie inversée = silence au master
  await play([track('ref', same), track('inv', same, { phaseInvert: true })], 1.6);
  out.phase_piste_inversee = view('inv'); out.phase_master_somme = view(MASTER_OUT);
  e.stopAll(); await sleep(300);
  await play([track('ref', same), track('inv', same, { phaseInvert: false })], 1.2);
  out.phase_master_sans_inversion = view(MASTER_OUT);
  e.stopAll(); await sleep(300);
  // 3. Pré / post-fader : piste à −6 dB de fader
  meterBank.setTapMode('post');
  await play([track('fader', L6, { volume: 0.5 })], 1.2);
  out.post_fader = view('fader');
  meterBank.setTapMode('pre'); await sleep(200); meterBank.resetClip('fader'); await waitAudio(0.8);
  out.pre_fader = view('fader');
  meterBank.setTapMode('post');
  e.stopAll(); await sleep(300);
  // 4. Trim d'entrée +6 dB
  await play([track('trim', buf(3, sine(0.25), sine(0.25)), { inputTrimDb: 6 })], 1.2);
  out.trim_plus_6 = view('trim');
  e.stopAll(); await sleep(300);
  // 5. Réduction de gain : affichée (moteur) contre mesurée (entrée − sortie)
  const lim = { id: 'fx-lim', type: 'LIMITER', name: 'Limiteur', isEnabled: true, params: { ceiling: -12, inputGain: 0, release: 100, lookahead: 3, oversample: 4, isEnabled: true } };
  meterBank.setTapMode('pre');
  await play([track('lim', buf(4, sine(0.5), sine(0.5)), { plugins: [lim] })], 2.0);
  const grL = e.getTrackGainReduction('lim'); const vL = view('lim');
  out.limiteur = { entree_dBTP: -6.02, sortie_dBTP: vL.tp, reduction_mesuree_dB: db(-6.02 - vL.tp), reduction_affichee_dB: db(grL ? grL.db : NaN) };
  e.stopAll(); await sleep(300);
  const comp = (id) => ({ id, type: 'COMPRESSOR', name: 'Compresseur', isEnabled: true, params: { threshold: -30, ratio: 4, knee: 0, attack: 0.003, release: 0.1, makeupGain: 1, mix: 1, scHpFreq: 20, lookahead: 0, autoMakeup: false, mode: 'CLEAN', isEnabled: true } });
  const level = async (amp) => {
    await play([track('cmp', buf(4, sine(amp, 440), sine(amp, 440)), { plugins: [comp('fx-cmp')] })], 2.2);
    const v = view('cmp'); const gr = e.getTrackGainReduction('cmp');
    e.stopAll(); await sleep(300);
    return { in_rms: db(20 * Math.log10(amp / Math.SQRT2)), out_rms: v.rms[0], gr: gr ? gr.db : NaN };
  };
  const quiet = await level(0.003), loud = await level(0.5);
  const gainQ = quiet.out_rms - quiet.in_rms, gainL = loud.out_rms - loud.in_rms;
  out.compresseur = { faible: quiet, fort: loud, gain_sous_le_seuil_dB: db(gainQ), reduction_mesuree_dB: db(gainQ - gainL), reduction_affichee_dB: db(loud.gr) };
  meterBank.setTapMode('post');
  out.banc = meterBank.info();
  return out;
}"""


def run_A(b):
    log = Log("r11_A")
    ctx, pg = new_page(b, "pc", log)
    prepare(pg)
    pg.goto(BASE, wait_until="domcontentloaded"); pg.wait_for_timeout(2500)
    res = pg.evaluate(JS_A)
    ctx.close()
    ok = {}
    g = res["gauche_seule"]; ok["gauche_droite_independants"] = abs(g["tp"] + 6.02) < 0.15 and g["peak"][1] <= -150
    m = res["mono_somme"]; ok["mono_somme"] = abs(m["rms"][0] - m["rms"][1]) < 0.05 and abs(m["tp"] + 12.04) < 0.2
    ok["correlation_plus_1"] = res["identique"]["corr"] > 0.99
    ok["correlation_moins_1"] = res["opposition"]["corr"] < -0.99
    ok["largeur_0_annule_l_opposition"] = res["opposition_largeur_0"]["tp"] <= -90
    ok["phase_inversee_annule_au_master"] = res["phase_master_somme"]["tp"] <= -90 and res["phase_master_sans_inversion"]["tp"] > -7
    ok["pre_post_fader"] = abs(res["post_fader"]["tp"] - res["pre_fader"]["tp"] + 6.02) < 0.2
    ok["trim_plus_6"] = abs(res["trim_plus_6"]["tp"] - (-12.04 + 6)) < 0.2
    li = res["limiteur"]; ok["gr_limiteur"] = abs(li["reduction_affichee_dB"] - li["reduction_mesuree_dB"]) < 0.5
    co = res["compresseur"]; ok["gr_compresseur"] = abs(co["reduction_affichee_dB"] - co["reduction_mesuree_dB"]) < 1.0
    res["verdicts"] = ok
    res["erreurs_page"] = [x["text"] for x in log.errors()][:5]
    return res


# ---------------------------------------------------------------- B. LUFS contre ffmpeg

def tone(t, f, a):
    return a * np.sin(2 * np.pi * f * t)


def make_audio(seconds=20.0):
    """Beat (kick + charley, stéréo), voix (harmoniques, phrases), basse : niveaux réalistes, crêtes < −3 dBFS."""
    n = int(seconds * SR); t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    beat = np.zeros((2, n))
    for k in np.arange(0, seconds, 0.5):
        i = int(k * SR); m = min(n - i, int(0.25 * SR)); tt = np.arange(m) / SR
        beat[:, i:i + m] += 0.45 * np.sin(2 * np.pi * (50 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)
    for k in np.arange(0.25, seconds, 0.25):
        i = int(k * SR); m = min(n - i, int(0.05 * SR))
        hat = rng.standard_normal(m) * np.exp(-np.arange(m) / SR * 80) * 0.08
        beat[0, i:i + m] += hat; beat[1, i:i + m] += 0.6 * hat
    voice = np.zeros(n)
    for a, b_ in [(1, 4), (5, 8.5), (10, 13), (14, 18.5)]:
        msk = (t >= a) & (t < b_)
        env = np.minimum(1, np.minimum((t[msk] - a) / 0.05, (b_ - t[msk]) / 0.08))
        f0 = 220 * (1 + 0.01 * np.sin(2 * np.pi * 5 * t[msk]))
        ph = 2 * np.pi * np.cumsum(f0) / SR
        voice[msk] = 0.3 * env * (np.sin(ph) + 0.5 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph)) / 1.75
    bass = 0.25 * np.sin(2 * np.pi * 55 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.25 * t) ** 2)
    return {"beat": beat, "voix": np.vstack([voice, voice]), "basse": np.vstack([bass, bass])}


def wav_bytes(x):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x.T, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project():
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0, "sends": [], "plugins": []}
    au = make_audio()
    clip = lambda id_, ref: [{"id": id_, "name": id_, "start": 0, "duration": 20.0, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1, "takeNumber": 1}]
    comp = {"id": "fx-comp", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "latency": 0,
            "params": {"threshold": -26, "ratio": 4, "knee": 6, "attack": 0.003, "release": 0.15, "makeupGain": 1.4, "mix": 1, "scHpFreq": 80, "lookahead": 0, "autoMakeup": False, "mode": "CLEAN", "isEnabled": True}}
    lim = {"id": "fx-lim", "name": "Limiteur", "type": "LIMITER", "isEnabled": True, "latency": 0,
           "params": {"ceiling": -1, "inputGain": 3, "release": 100, "lookahead": 3, "oversample": 4, "isEnabled": True}}
    tracks = [
        {**base, "id": "beat", "name": "Beat", "type": "AUDIO", "color": "#f59e0b", "volume": 0.8, "outputTrackId": "master", "clips": clip("c-beat", "audio/beat.wav")},
        {**base, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 0.9, "outputTrackId": "master", "clips": clip("c-voix", "audio/voix.wav"), "plugins": [comp]},
        {**base, "id": "basse", "name": "Basse", "type": "AUDIO", "color": "#a78bfa", "volume": 0.7, "outputTrackId": "master", "clips": clip("c-basse", "audio/basse.wav"), "inputTrimDb": -3, "monoSum": True},
        {**base, "id": "gauche", "name": "Guitare gauche", "type": "AUDIO", "color": "#10b981", "volume": 0.5, "outputTrackId": "master", "clips": clip("c-gauche", "audio/gauche.wav"), "phaseInvert": True, "stereoWidth": 1.4},
        {**base, "id": "master", "name": "MASTER BUS", "type": "BUS", "color": "#00f2ff", "volume": 1.0, "outputTrackId": "", "clips": [], "plugins": [lim]},
    ]
    state = {
        "id": "proj-r11", "name": "R11 metres", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    gauche = np.vstack([au["voix"][0] * 0.8, np.zeros(au["voix"].shape[1])])
    with zipfile.ZipFile(PROJECT, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/beat.wav", wav_bytes(au["beat"]))
        z.writestr("audio/voix.wav", wav_bytes(au["voix"]))
        z.writestr("audio/basse.wav", wav_bytes(au["basse"]))
        z.writestr("audio/gauche.wav", wav_bytes(gauche))


def ffmpeg_ebur128(path):
    p = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    txt = p.stderr
    summ = txt[txt.rfind("Summary:"):]
    get = lambda pat: float(re.search(pat, summ, re.S).group(1))
    return {"I": get(r"I:\s+(-?[\d.]+) LUFS"), "LRA": get(r"LRA:\s+(-?[\d.]+) LU"), "TP": get(r"Peak:\s+(-?[\d.]+) dBFS")}


JS_B_LIVE = "async () => {" + r"""
  const { meterBank, MASTER_OUT } = await window.__novaAppModule('/engine/meters/meterBank.ts');
  const E = await window.__novaAppModule('/engine/AudioEngine.ts'); const e = E.audioEngine;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  meterBank.resetLoudness();
  return { ready: meterBank.isReady(), t0: e.ctx.currentTime };
}"""

JS_B_READ = "async () => {" + r"""
  const { meterBank, MASTER_OUT } = await window.__novaAppModule('/engine/meters/meterBank.ts');
  const s = meterBank.loudness.snapshot(); const v = meterBank.view(MASTER_OUT);
  return { I: s.integrated, LRA: s.lra, M_max: s.momentaryMax, S_max: s.shortTermMax, secondes: s.seconds, TP: v ? v.maxTp : null, corr: v ? v.corr : null };
}"""

# Le mètre AudioWorklet (même code que la lecture) rejoué hors ligne sur l'export.
JS_B_OFFLINE = r"""
async (b64) => {
  const { meterBank } = await window.__novaAppModule('/engine/meters/meterBank.ts');
  const { createMeterCore } = await window.__novaAppModule('/engine/meters/meterCore.ts');
  const { LoudnessMeter } = await window.__novaAppModule('/engine/meters/loudness.ts');
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ac = new OfflineAudioContext(2, 44100, 44100);
  const buf = await ac.decodeAudioData(bin.buffer);
  const core = createMeterCore(buf.sampleRate, { loudness: true, tpTaps: 16 });
  const lm = new LoudnessMeter(); let tp = 0;
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let s = 0; s < L.length; s += 128) { const k = Math.min(128, L.length - s); core.process(L.subarray(s, s + k), R.subarray(s, s + k), k);
    if ((s / 128) % 12 === 11) { const t = core.take(); lm.pushMany(t.k); tp = Math.max(tp, t.tpL, t.tpR); } }
  const t = core.take(); lm.pushMany(t.k); tp = Math.max(tp, t.tpL, t.tpR);
  return { I: lm.integrated(), LRA: lm.lra(), TP: 20 * Math.log10(tp), secondes: buf.duration };
}"""


def run_B(b):
    make_project()
    log = Log("r11_B")
    ctx, pg = new_page(b, "pc", log)
    prepare(pg)
    pg.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")
    res = {}
    open_project_file(pg, PROJECT, res, "B_projet")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(1500)
    # Lecture complète du projet (20 s), LUFS remis à zéro juste avant.
    res["avant"] = pg.evaluate(JS_B_LIVE)
    pg.keyboard.press("Home"); pg.wait_for_timeout(300)
    pg.evaluate("async () => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts'); window.__r11c0 = e.ctx.currentTime; }")
    pg.keyboard.press("Space")
    t0 = time.time()
    while time.time() - t0 < 90:
        pg.wait_for_timeout(1000)
        el = pg.evaluate("async () => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts'); return e.ctx.currentTime - window.__r11c0; }")
        if el > 21.5:
            break
    pg.keyboard.press("Space"); pg.wait_for_timeout(600)
    res["nova_direct"] = pg.evaluate(JS_B_READ)
    shot(pg, "B_apres_lecture")
    dest = OUT / "r11_export.wav"
    export_wav(pg, dest, "B")
    res["export"] = {"fichier": str(dest), "octets": dest.stat().st_size}
    res["ffmpeg"] = ffmpeg_ebur128(dest)
    res["nova_hors_ligne_sur_export"] = pg.evaluate(JS_B_OFFLINE, base64.b64encode(dest.read_bytes()).decode())
    ctx.close()
    d1 = res["nova_direct"]["I"] - res["ffmpeg"]["I"]
    d2 = res["nova_hors_ligne_sur_export"]["I"] - res["ffmpeg"]["I"]
    res["ecarts_LU"] = {"direct_vs_ffmpeg": round(d1, 3), "hors_ligne_vs_ffmpeg": round(d2, 3),
                        "lra_hors_ligne_vs_ffmpeg": round(res["nova_hors_ligne_sur_export"]["LRA"] - res["ffmpeg"]["LRA"], 2),
                        "tp_hors_ligne_vs_ffmpeg": round(res["nova_hors_ligne_sur_export"]["TP"] - res["ffmpeg"]["TP"], 2)}
    res["verdicts"] = {"lufs_direct_a_0_1_LU": abs(d1) <= 0.1, "lufs_hors_ligne_a_0_1_LU": abs(d2) <= 0.1}
    res["erreurs_page"] = [x["text"] for x in log.errors()][:5]
    return res


# ---------------------------------------------------------------- C. Coût processeur (40 pistes)

JS_C_OFFLINE = r"""
async () => {
  const { createMeterCore } = await window.__novaAppModule('/engine/meters/meterCore.ts');
  const { loadWorkletModule } = await window.__novaAppModule('/plugins/vocalDspUtils.ts');
  // Le code du worklet des mètres, tel que chargé en lecture.
  const mb = await window.__novaAppModule('/engine/meters/meterBank.ts');
  const SR = 44100, SEC = 10, N = 40;
  const render = async (withMeters) => {
    const c = new OfflineAudioContext(2, SR * SEC, SR);
    if (withMeters) await loadWorkletModule(c, 'nova-meter-bank', mb.__workletCodeForTests());
    const nodes = [];
    if (withMeters) for (let k = 0; k < Math.ceil(N / 16); k++) nodes.push(new AudioWorkletNode(c, 'nova-meter-bank-v1', { numberOfInputs: 16, numberOfOutputs: 0, processorOptions: { core: { tpTaps: 8, tpGate: true } } }));
    const master = c.createGain(); master.gain.value = 1 / N; master.connect(c.destination);
    for (let i = 0; i < N; i++) {
      const o = c.createOscillator(); o.frequency.value = 80 + i * 37; const n = c.createStereoPanner(); n.pan.value = (i % 5 - 2) / 2;
      const g = c.createGain(); o.connect(n); n.connect(g); g.connect(master); o.start();
      if (withMeters) g.connect(nodes[Math.floor(i / 16)], 0, i % 16);
    }
    if (withMeters) { const m = new AudioWorkletNode(c, 'nova-meter-bank-v1', { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { core: { loudness: true, gonio: true, tpTaps: 16 }, always: true } }); master.connect(m); }
    const t0 = performance.now(); await c.startRendering(); return performance.now() - t0;
  };
  const runs = { sans: [], avec: [] };
  for (let r = 0; r < 3; r++) { runs.sans.push(await render(false)); runs.avec.push(await render(true)); }
  const med = a => a.slice().sort((x, y) => x - y)[1];
  const sans = med(runs.sans), avec = med(runs.avec);
  return { pistes: N, secondes_audio: SEC, rendu_sans_metres_ms: Math.round(sans), rendu_avec_metres_ms: Math.round(avec),
           cout_metres_ms_par_seconde_audio: Math.round((avec - sans) / SEC * 10) / 10,
           cout_metres_pourcent_d_un_coeur: Math.round((avec - sans) / (SEC * 1000) * 1000) / 10, essais: runs };
}"""


def run_C(b):
    log = Log("r11_C")
    ctx, pg = new_page(b, "pc", log)
    prepare(pg)
    pg.goto(BASE, wait_until="domcontentloaded"); pg.wait_for_timeout(2500)
    res = {"fil_audio_hors_ligne": pg.evaluate(JS_C_OFFLINE)}
    # Fil principal : 40 pistes en lecture réelle, vumètres affichés (console), métriques CDP.
    js = "async () => {" + ENGINE_PRELUDE + r"""
      const tracks = [];
      for (let i = 0; i < 40; i++) tracks.push(track('p' + i, buf(14, sine(0.02, 80 + i * 37), sine(0.015, 81 + i * 37))));
      tracks.forEach(t => e.updateTrack(t, tracks)); await sleep(800);
      // 40 vumètres de console dessinés par la boucle partagée (canvas de 30 × 300 px).
      const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;display:flex;gap:2px;z-index:99999;background:#000';
      document.body.appendChild(host);
      const { drawStereoMeter } = await window.__novaAppModule('/components/meters/TrackMeter.tsx');
      const { meterPrefs } = await window.__novaAppModule('/engine/meters/meterPrefs.ts');
      const { meterClock } = await window.__novaAppModule('/engine/meters/meterBank.ts');
      const cvs = tracks.map(() => { const c = document.createElement('canvas'); c.width = 30; c.height = 300; host.appendChild(c); return c; });
      const unsub = meterClock.subscribe(now => tracks.forEach((t, i) => drawStereoMeter(cvs[i].getContext('2d'), 30, 300, meterBank.view(t.id, now), meterPrefs.scale(), { vertical: true, marks: true, gr: 0, light: false })));
      const s0 = { ...meterBank.stats }, f0 = { ...meterClock.stats };
      e.startPlayback(0, tracks);
      const w0 = performance.now(); await waitAudio(10); const wall = performance.now() - w0;
      e.stopAll(); unsub(); host.remove();
      const sec = wall / 1000;
      return { secondes: Math.round(sec * 10) / 10, messages_par_s: Math.round((meterBank.stats.messages - s0.messages) / sec),
               traitement_messages_ms_par_s: Math.round((meterBank.stats.handleMs - s0.handleMs) / sec * 100) / 100,
               images_par_s: Math.round((meterClock.stats.frames - f0.frames) / sec * 10) / 10,
               dessin_40_metres_ms_par_s: Math.round((meterClock.stats.drawMs - f0.drawMs) / sec * 100) / 100,
               banc: meterBank.info() };
    }"""
    cdp = ctx.new_cdp_session(pg)
    cdp.send("Performance.enable")
    m0 = {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
    live = pg.evaluate(js)
    m1 = {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
    sec = live["secondes"] or 1
    live["fil_principal_script_ms_par_s"] = round((m1["ScriptDuration"] - m0["ScriptDuration"]) * 1000 / sec, 1)
    live["fil_principal_taches_ms_par_s"] = round((m1["TaskDuration"] - m0["TaskDuration"]) * 1000 / sec, 1)
    res["lecture_40_pistes"] = live
    ctx.close()
    res["erreurs_page"] = [x["text"] for x in log.errors()][:5]
    return res


# ---------------------------------------------------------------- D. Interface et captures

def run_D(b, vp, theme):
    tag = f"{vp}_{theme}"
    log = Log(f"r11_D_{tag}")
    ctx, pg = new_page(b, vp, log)
    prepare(pg)
    pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
    res = {}
    open_project_file(pg, PROJECT, res, f"D_{tag}_01_projet")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(800)
    # Lecture pour que les mètres bougent
    pg.evaluate("async () => { const { meterBank } = await window.__novaAppModule('/engine/meters/meterBank.ts'); meterBank.resetLoudness(); }")
    if vp == "tel":
        pg.get_by_role("button", name=re.compile("Lecture")).locator("visible=true").first.click()
    else:
        pg.keyboard.press("Space")
    pg.wait_for_timeout(5500)
    shot(pg, f"D_{tag}_02_pistes_en_lecture")
    res["metres_entete"] = pg.locator("[data-testid^='header-meter-']").count()
    # Console
    if vp == "tel":
        m = pg.get_by_text("Mixer", exact=True)
        if m.count(): m.last.click(); pg.wait_for_timeout(1200)
    else:
        done = False
        for label in ("Console", "Mixage", "Mixer"):
            t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
            if t.count() and t.first.is_visible():
                t.first.click(); pg.wait_for_timeout(1200); done = True; break
        if not done:
            # Tablette : la console est dans le menu (☰ > Vues > Console).
            pg.get_by_role("button", name="Ouvrir le menu").first.click(); pg.wait_for_timeout(600)
            pg.locator("button", has_text=re.compile(r"^\s*Console\s*$")).locator("visible=true").first.click(); pg.wait_for_timeout(1200)
    pg.wait_for_timeout(1500)
    shot(pg, f"D_{tag}_03_console_metres")
    res["metres_console"] = pg.locator("[data-meter]").locator("visible=true").count()
    res["tetes_de_tranche"] = pg.locator("[data-testid^='strip-head-']").locator("visible=true").count()
    res["boutons_phase_actifs"] = pg.locator("[data-testid^='strip-phase-'][aria-pressed=true]").count()
    res["boutons_mono_actifs"] = pg.locator("[data-testid^='strip-mono-'][aria-pressed=true]").count()
    # Fenêtre Loudness
    opened = False
    for sel in ("[data-testid=mixer-loudness]", "[data-testid=lufs-chip]"):
        loc = pg.locator(sel).locator("visible=true")
        if loc.count():
            loc.first.click(); opened = True; break
    if not opened:
        b2 = pg.get_by_role("button", name="Ouvrir la fenêtre Loudness").locator("visible=true")
        if b2.count(): b2.first.click(); opened = True
    pg.wait_for_timeout(2500)
    shot(pg, f"D_{tag}_04_loudness")
    res["fenetre_loudness"] = pg.locator("[data-testid=loudness-panel]").count() == 1
    if res["fenetre_loudness"]:
        res["lufs_affiche"] = pg.locator("[data-testid=loud-I]").inner_text()
        res["crete_vraie_affichee"] = pg.locator("[data-testid=loud-TP]").inner_text()
    res["debordements"] = overflow_report(pg)[:5]
    # Menu des mètres (clic droit) sur PC
    if vp == "pc":
        pg.locator("[data-testid=loudness-panel] button[aria-label='Fermer la fenêtre Loudness']").first.click(); pg.wait_for_timeout(300)
        mtr = pg.locator("[data-meter]").locator("visible=true").nth(1)
        bb = mtr.bounding_box()
        if bb:
            pg.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2, button="right"); pg.wait_for_timeout(500)
            shot(pg, f"D_{tag}_05_menu_metres")
            res["menu_metres"] = pg.locator("[data-testid=meter-menu]").count() == 1
            pg.get_by_role("menuitemradio", name=re.compile("K-14")).first.click(); pg.wait_for_timeout(800)
            shot(pg, f"D_{tag}_06_echelle_K14")
            pg.evaluate("async () => { const { meterPrefs } = await window.__novaAppModule('/engine/meters/meterPrefs.ts'); meterPrefs.setScale('pt'); }")
    pg.keyboard.press("Space"); pg.wait_for_timeout(300)
    ctx.close()
    res["erreurs_page"] = [x["text"] for x in log.errors()][:5]
    return res


if __name__ == "__main__":
    parts = [a.upper() for a in sys.argv[1:]] or ["A", "B", "C", "D"]
    out = json.loads(RESULT.read_text(encoding="utf-8")) if RESULT.exists() else {}
    with sync_playwright() as p:
        b = launch(p)
        if "A" in parts:
            out["A_moteur"] = run_A(b); print(json.dumps(out["A_moteur"]["verdicts"], ensure_ascii=False))
        if "B" in parts:
            out["B_lufs_ffmpeg"] = run_B(b); print(json.dumps({k: out["B_lufs_ffmpeg"][k] for k in ("nova_direct", "ffmpeg", "nova_hors_ligne_sur_export", "ecarts_LU", "verdicts")}, ensure_ascii=False))
        if "C" in parts:
            out["C_cout_cpu"] = run_C(b); print(json.dumps(out["C_cout_cpu"], ensure_ascii=False))
        if "D" in parts:
            if not PROJECT.exists(): make_project()
            out["D_interface"] = {}
            for vp in ("pc", "tab", "tel"):
                for theme in ("dark", "light"):
                    out["D_interface"][f"{vp}_{theme}"] = r = run_D(b, vp, theme)
                    print(vp, theme, json.dumps({k: v for k, v in r.items() if k != "debordements"}, ensure_ascii=False))
        b.close()
    RESULT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("→", RESULT)
