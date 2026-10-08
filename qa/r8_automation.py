"""R8 · Automation des effets historiques de NOVA et du mute : preuves audio sur le VRAI moteur
de NOVA, dans un Chrome headless (aucune fenêtre).

Scénarios, à l'export (renderProject) ET en lecture réelle (sortie du master captée par un
AudioWorklet témoin), à 48 kHz :
 A. Compresseur : seuil automatisé 0 → −30 dB à 2,000 s (palier), sinus 997 Hz à −6 dBFS, ratio 20 ;
 B. EQ : fréquence de la bande 5 (cloche +12 dB, Q 4) automatisée 500 → 4000 Hz à 2,000 s, sinus 4 kHz ;
 B2. EQ : GAIN de la bande 5 (cloche à 4 kHz, 0 dB fixe : bande neutre, retirée de la chaîne par
    l'égaliseur économe) automatisé 0 → +12 dB à 2,000 s : la voie doit la remettre en chaîne ;
 A2. Opto Vintage (labo) : gain de sortie automatisé 0 → −12 dB à 2,000 s, sinus faible (pas de
    compression) : le niveau baisse de 12 dB pile à 2,000 s ;
 C. Reverb : mix automatisé 0 → 100 % à 2,000 s (palier) puis rampe 100 → 0 % de 3 à 5 s ;
 D. Mute : voie « Muet » 0 → 1 à 1,500 s → 0 à 2,500 s, piste routée vers un bus qui porte un
    limiteur (latence en aval : le mute doit rester calé sur la musique, pas avancé ni retardé).
Pour chaque changement : l'instant où on l'ENTEND (premier échantillon qui change) comparé à
l'instant écrit dans la voie. Export : au bloc près (128 échantillons = 2,67 ms à 48 kHz) ;
lecture : quelques ms.

Usage : serveur `npx vite --port 3447 --strictPort`, puis
  set NOVA_URL=http://127.0.0.1:3447/ && python qa/r8_automation.py
Sortie : D:\\1 WORK\\CONTENU\\nova-r7-r8\\r8_automation.json
"""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-r7-r8"))
OUT.mkdir(parents=True, exist_ok=True)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3447/")

HELPERS = r"""
const { audioEngine: E } = await import('/engine/AudioEngine.ts');
const { TrackType } = await import('/types.ts');
const { DEFAULT_LIMITER_PARAMS } = await import('/engine/LimiterNode.ts');
const r2 = v => Math.round(v * 100) / 100;
const sine = (sec, amp, f, sr) => { const n = Math.round(sec * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr + 0.3); return x; };
const noise = (sec, amp, sr) => { const n = Math.round(sec * sr), x = new Float32Array(n); let s = 12345; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = amp * (s / 4294967296 * 2 - 1); } return x; };
const toBuf = (x, sr) => { const b = new AudioBuffer({ length: x.length, numberOfChannels: 2, sampleRate: sr }); b.getChannelData(0).set(x); b.getChannelData(1).set(x); return b; };
const pts = (key, list) => list.map(([time, value, curveType], i) => ({ id: key + i, time, value, curveType: curveType || 'HOLD' }));
const laneP = (pid, key, list, min, max) => ({ id: 'l-' + pid + key, parameterName: 'plugin::' + pid + '::' + key, color: '#0ff', isExpanded: true, min, max, points: pts(key, list) });
const laneMute = list => ({ id: 'l-mute', parameterName: 'mute', color: '#f00', isExpanded: true, min: 0, max: 1, points: pts('m', list) });
const audioTrack = (id, buf, plugins, lanes, extra = {}) => ({ id, name: id, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], outputTrackId: 'master',
  automationMode: 'read', automationLanes: lanes, plugins,
  clips: [{ id: 'c-' + id, type: TrackType.AUDIO, start: 0, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id }], ...extra });
const busTrack = (id, plugins) => ({ id, name: id, type: TrackType.BUS, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], outputTrackId: 'master', automationMode: 'read', automationLanes: [], plugins, clips: [] });
const pl = (id, type, params) => ({ id, type, name: type, isEnabled: true, latency: 0, params });
const env = (x, sr, t, w = 0.004) => { let m = 0; for (let i = Math.round(t * sr), e = i + Math.round(w * sr); i < e && i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; };
const peakDb = (x, sr, a, z) => { let m = 0; for (let i = Math.round(a * sr); i < Math.round(z * sr); i++) m = Math.max(m, Math.abs(x[i])); return r2(20 * Math.log10(m + 1e-12)); };
// Premier instant (ms) après `from` où l'enveloppe (crête sur 1 ms) s'écarte de plus de `db` du niveau de référence pris juste avant.
const onset = (x, sr, from, to, db = 1) => {
  const w = 0.001; const ref = 20 * Math.log10(env(x, sr, from - 0.05, 0.04) + 1e-12);
  // Fenêtre qui FINIT à t : l'instant rendu est celui où le changement est entendu (jamais en avance).
  for (let t = from - 0.02; t < to; t += 1 / sr) { const v = 20 * Math.log10(env(x, sr, t - w, w) + 1e-12); if (Math.abs(v - ref) > db) return r2(t * 1000); }
  return null;
};
// Premier échantillon après `from` où la sortie s'écarte du signal d'entrée de plus de `eps` (dry seul avant).
const diverge = (y, x, sr, from, to, eps = 1e-3, lag = 0) => { for (let i = Math.round(from * sr); i < Math.round(to * sr); i++) if (Math.abs(y[i] - (x[i - lag] || 0)) > eps) return r2(i / sr * 1000); return null; };
"""

SCENARIOS = r"""
const SCEN = (sr) => {
  const s = {};
  // A. Compresseur : seuil 0 → −30 dB à 2,000 s.
  s.A = { sec: 4, tracks: [audioTrack('voix', toBuf(sine(4, 0.5, 997, sr), sr), [pl('comp', 'COMPRESSOR', { threshold: 0, ratio: 20, knee: 0, attack: 0.0005, release: 0.05, makeupGain: 1, mix: 1, scHpFreq: 20, lookahead: 0, autoMakeup: false, mode: 'CLEAN', isEnabled: true })],
    [laneP('comp', 'threshold', [[0, 0], [2.0, -30]], -60, 0)])] };
  // A2. Opto Vintage : gain de sortie 0 → −12 dB à 2,000 s (sinus à −40 dBFS, sous le seuil).
  s.A2 = { sec: 4, tracks: [audioTrack('voix', toBuf(sine(4, 0.01, 997, sr), sr), [pl('opto', 'OPTO_VINTAGE', { threshold: 0, output: 0, mix: 100 })],
    [laneP('opto', 'output', [[0, 0], [2.0, -12]], -18, 28)])] };
  // B. EQ : bande 5 en cloche +12 dB, Q 4 ; fréquence 500 → 4000 Hz à 2,000 s ; sinus 4 kHz.
  const bands = Array.from({ length: 12 }, (_, i) => ({ id: i, type: i === 4 ? 'peaking' : 'peaking', frequency: [80,150,300,500,500,2000,4000,6000,8000,10000,12000,18000][i], gain: i === 4 ? 12 : 0, q: i === 4 ? 4 : 1, isEnabled: true, isSolo: false }));
  s.B = { sec: 4, tracks: [audioTrack('synth', toBuf(sine(4, 0.1, 4000, sr), sr), [pl('eq', 'PROEQ12', { isEnabled: true, masterGain: 1, bands })], [laneP('eq', 'b5Freq', [[0, 500], [2.0, 4000]], 20, 20000)])] };
  // B2. EQ : bande 5 neutre (0 dB fixe) dont le GAIN est automatisé 0 → +12 dB à 2,000 s.
  const bands2 = bands.map((b, i) => i === 4 ? { ...b, frequency: 4000, gain: 0 } : b);
  s.B2 = { sec: 4, tracks: [audioTrack('synth', toBuf(sine(4, 0.1, 4000, sr), sr), [pl('eq', 'PROEQ12', { isEnabled: true, masterGain: 1, bands: bands2 })], [laneP('eq', 'b5Gain', [[0, 0], [2.0, 12]], -30, 30)])] };
  // C. Reverb : mix 0 → 1 à 2,000 s (palier), puis rampe 1 → 0 de 3 à 5 s.
  s.C = { sec: 5.5, input: noise(5.5, 0.3, sr), tracks: null };
  s.C.tracks = [audioTrack('voix', toBuf(s.C.input, sr), [pl('rev', 'REVERB', { mix: 0, decay: 1.2, preDelay: 0.02, isEnabled: true })], [laneP('rev', 'mix', [[0, 0], [2.0, 1], [3.0, 1, 'LINEAR'], [5.0, 0]], 0, 1)])];
  // D. Mute 0 → 1 à 1,5 s → 0 à 2,5 s ; piste vers un bus avec limiteur (latence en aval).
  s.D = { sec: 4, tracks: [audioTrack('adlib', toBuf(sine(4, 0.25, 660, sr), sr), [], [laneMute([[0, 0], [1.5, 1], [2.5, 0]])], { outputTrackId: 'busvoix' }),
    busTrack('busvoix', [pl('lim', 'LIMITER', { ...DEFAULT_LIMITER_PARAMS, ceiling: -0.1, lookahead: 5 })])] };
  return s;
};
const MEASURE = (k, y, sr, sc) => {
  if (k === 'A') return { attendu: 'avant −6,02 dB ; après ≈ −28,5 dB (ratio 20 au-dessus de −30) ; changement à 2000 ms', avant_db: peakDb(y, sr, 1.0, 1.9), apres_db: peakDb(y, sr, 2.5, 3.5), changement_entendu_ms: onset(y, sr, 2.0, 2.2, 1) };
  if (k === 'A2') { const av = peakDb(y, sr, 1.0, 1.9), ap = peakDb(y, sr, 2.5, 3.5); return { attendu: 'baisse de 12 dB (±0,3) pile à 2000 ms', avant_db: av, apres_db: ap, baisse_db: r2(ap - av), changement_entendu_ms: onset(y, sr, 2.0, 2.2, 1) }; }
  if (k === 'B') return { attendu: 'avant ≈ −20 dB (4 kHz hors de la cloche) ; après ≈ −8 dB (+12 dB) ; changement à 2000 ms', avant_db: peakDb(y, sr, 1.0, 1.9), apres_db: peakDb(y, sr, 2.5, 3.5), changement_entendu_ms: onset(y, sr, 2.0, 2.2, 1) };
  if (k === 'B2') return { attendu: 'avant ≈ −20 dB (bande à 0 dB) ; après ≈ −8 dB (+12 dB automatisés) ; changement à 2000 ms', avant_db: peakDb(y, sr, 1.0, 1.9), apres_db: peakDb(y, sr, 2.5, 3.5), changement_entendu_ms: onset(y, sr, 2.0, 2.2, 1) };
  if (k === 'C') {
    // Avant 2 s : la sortie EST l'entrée (sec seul). Rampe 3 → 5 s : part du sec = cos(mix·π/2), mesurée par projection sur l'entrée.
    const proj = (a, z) => { let xy = 0, xx = 0; for (let i = Math.round(a * sr); i < Math.round(z * sr); i++) { xy += y[i] * sc.input[i]; xx += sc.input[i] * sc.input[i]; } return xy / xx; };
    const rows = []; let worst = 0;
    for (const t of [3.25, 3.5, 3.75, 4.0, 4.25, 4.5, 4.75]) { const mix = 1 - (t - 3) / 2; const exp = Math.cos(mix * Math.PI / 2); const got = proj(t - 0.02, t + 0.02); worst = Math.max(worst, Math.abs(got - exp)); rows.push([t, r2(exp * 1000) / 1000, Math.round(got * 1000) / 1000]); }
    return { attendu: 'sortie = entrée jusqu’à 2000 ms, puis le sec disparaît pile à 2000 ms ; rampe 3→5 s : part du sec = cos(mix·π/2)', sec_seul_jusqu_a_ms: diverge(y, sc.input, sr, 0.5, 2.2), part_du_sec_rampe_t_attendu_mesure: rows, pire_ecart_part_du_sec: Math.round(worst * 10000) / 10000 };
  }
  if (k === 'D') {
    let a = null, b = null; for (let i = Math.round(1.3 * sr); i < Math.round(1.8 * sr); i++) if (Math.abs(y[i]) < 1e-4 && env(y, sr, i / sr, 0.002) < 1e-4) { a = r2(i / sr * 1000); break; }
    for (let i = Math.round(2.3 * sr); i < Math.round(2.8 * sr); i++) if (Math.abs(y[i]) > 0.01) { b = r2(i / sr * 1000); break; }
    return { attendu: 'silence de 1500 à 2500 ms (mute calé sur la musique malgré le limiteur du bus en aval)', debut_du_silence_ms: a, retour_du_son_ms: b, niveau_pendant_db: peakDb(y, sr, 1.6, 2.4), niveau_avant_db: peakDb(y, sr, 0.5, 1.4) };
  }
};
"""

EXPORT_JS = "async () => {" + HELPERS + SCENARIOS + r"""
const sr = 48000, out = {};
const sc = SCEN(sr);
for (const k of Object.keys(sc)) {
  const b = await E.renderProject(sc[k].tracks, sc[k].sec, 0, sr);
  out[k] = MEASURE(k, b.getChannelData(0), sr, sc[k]);
}
return out;
}"""

LIVE_JS = "async () => {" + HELPERS + SCENARIOS + r"""
await E.init(); await E.resume();
const ctx = E.ctx, sr = ctx.sampleRate;
const code = `class Rec extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec-r8', Rec);`;
await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
const rec = new AudioWorkletNode(ctx, 'nova-qa-rec-r8', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
E.masterOutput.connect(rec);
const capture = async (tracks, sec) => {
  E.setLiveTracks(tracks);
  tracks.forEach(t => E.updateTrack(t, tracks));
  await new Promise(r => setTimeout(r, 1200));
  chunks.length = 0;
  E.startPlayback(0, tracks); const t0 = E.playbackStartTime;
  await new Promise(r => setTimeout(r, sec * 1000 + 300)); E.stopAll();
  await new Promise(r => setTimeout(r, 200));
  const o = new Float32Array(Math.round(sec * sr));
  for (const c of chunks) for (let i = 0; i < c.d.length; i++) { const k = Math.round(c.f + i - t0 * sr); if (k >= 0 && k < o.length) o[k] = c.d[i]; }
  tracks.forEach(t => E.disposeTrack(t.id));
  return o;
};
const sc = SCEN(sr), out = { sampleRate: sr };
for (const k of Object.keys(sc)) out[k] = MEASURE(k, await capture(sc[k].tracks, sc[k].sec), sr, sc[k]);
return out;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    res = {"export": pg.evaluate(EXPORT_JS)}
    if "--export-only" not in sys.argv:
        res["lecture"] = pg.evaluate(LIVE_JS)
    res["erreurs_page"] = errs
    b.close()

(OUT / "r8_automation.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps(res, ensure_ascii=False, indent=1))
