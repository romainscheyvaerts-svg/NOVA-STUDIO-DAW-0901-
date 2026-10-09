"""Preuves audio des effets V21 (harmoniseur, voix grave / aiguë, tape stop, filtre DJ, lo-fi)
sur le VRAI moteur de NOVA, dans un navigateur headless (aucune fenêtre).

- Export (renderProject, OfflineAudioContext) : hauteur mesurée sur le rendu.
- Lecture réelle : la sortie du master est enregistrée par un AudioWorklet témoin.
- PDC : un clic à 1,000 s à travers chaque effet (latence déclarée) doit tomber à 1,000 s.
Sorties : D:\\1 WORK\\CONTENU\\nova-v21\\ (preuves_audio.json + WAV à écouter).

Usage : NOVA_URL=http://localhost:3426/ python qa/v21_preuves.py
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import base64, json, os, struct, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-v21"))
OUT.mkdir(parents=True, exist_ok=True)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://localhost:3426/")

HELPERS = r"""
const SR = 48000;
const { audioEngine: E } = await import('/engine/AudioEngine.ts');
const { TrackType } = await import('/types.ts');
const { V21_DEFAULTS } = await import('/engine/v21Params.ts');
const { psolaLatencySamples } = await import('/engine/psolaCore.ts');
E.currentBpm = 120;
// Voyelle « a » synthétique (même recette que les tests vitest).
const vowel = (f0, sec, sr = SR) => {
  const n = Math.round(sec * sr), src = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { ph += f0 / sr; if (ph >= 1) ph -= 1; src[i] = ph < 0.4 ? 0.5 * (1 - Math.cos(Math.PI * ph / 0.4)) : ph < 0.6 ? Math.cos(Math.PI * (ph - 0.4) / 0.4) : 0; }
  const d = new Float32Array(n); for (let i = 1; i < n; i++) d[i] = src[i] - src[i - 1];
  const out = new Float32Array(n);
  [700, 1220, 2600].forEach((fc, k) => { const bw = 130 + 60 * k, r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * fc / sr, a1 = -2 * r * Math.cos(th), a2 = r * r; let y1 = 0, y2 = 0; const g = [1, 0.6, 0.3][k]; for (let i = 0; i < n; i++) { const y = d[i] - a1 * y1 - a2 * y2; y2 = y1; y1 = y; out[i] += g * y; } });
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i])); for (let i = 0; i < n; i++) out[i] *= 0.5 / pk;
  // Attaque / relâchement doux (comme une note chantée).
  const fade = Math.round(0.02 * sr); for (let i = 0; i < fade; i++) { out[i] *= i / fade; out[n - 1 - i] *= i / fade; }
  return out;
};
const toBuf = (x, sr = SR) => { const b = new AudioBuffer({ length: x.length, numberOfChannels: 2, sampleRate: sr }); b.getChannelData(0).set(x); b.getChannelData(1).set(x); return b; };
const f0Of = (x, sr = SR, fmin = 40, fmax = 1200) => {
  const lagMin = Math.floor(sr / fmax), lagMax = Math.ceil(sr / fmin), W = x.length - lagMax - 2; const ns = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) { let ac = 0, e1 = 0, e2 = 0; for (let j = 0; j < W; j++) { ac += x[j] * x[j + lag]; e1 += x[j] * x[j]; e2 += x[j + lag] * x[j + lag]; } ns[lag] = 2 * ac / (e1 + e2 + 1e-20); }
  let max = 0; for (let l = lagMin; l <= lagMax; l++) max = Math.max(max, ns[l]);
  for (let l = lagMin; l <= lagMax; l++) if (ns[l] >= 0.97 * max && ns[l] >= ns[l - 1] && ns[l] >= ns[l + 1]) { const a = ns[l - 1], b = ns[l], c = ns[l + 1], den = a - 2 * b + c; return sr / (l + (Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0)); }
  return 0;
};
const cents = (f, ref) => Math.round(1200 * Math.log2(f / ref) * 10) / 10;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const NAMES = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const nameOf = f => { const m = Math.round(69 + 12 * Math.log2(f / 440)); return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 2}`; };
const seg = (b, a, z, ch = 0) => b.getChannelData(ch).slice(Math.round(a * b.sampleRate), Math.round(z * b.sampleRate));
const plugin = (type, params = {}, id) => ({ id: id || `pl-${type}`, type, name: type, isEnabled: true, params: { ...V21_DEFAULTS[type](), ...params }, latency: 0 });
const track = (id, buf, plugins, extra = {}) => ({ id, name: id, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [],
  clips: [{ id: `c-${id}`, type: TrackType.AUDIO, start: 0.5, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id }], plugins, ...extra });
const render = (tracks, sec) => E.renderProject(tracks, sec, 0, SR);
const zcFreq = (x, sr, from, to) => { const a = Math.round(from * sr), b = Math.round(to * sr); const c = []; for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) c.push(i - 1 + (-x[i - 1]) / (x[i] - x[i - 1])); return c.length < 2 ? 0 : Math.round((c.length - 1) / ((c[c.length - 1] - c[0]) / sr) * 10) / 10; };
const rms = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));
const wav = (b) => { const n = b.length, ch = b.numberOfChannels; const bytes = new Uint8Array(44 + n * ch * 2); const dv = new DataView(bytes.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, b.sampleRate, true); dv.setUint32(28, b.sampleRate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(b.getChannelData(c));
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2; }
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
"""

EXPORT_JS = "async () => {" + HELPERS + r"""
const out = { latence_psola_ms: psolaLatencySamples(SR) / SR * 1000, harmoniseur: [], voix: [], wav: {} };
const KEY = { rootKey: 0, scale: 'MAJOR' };   // Do majeur
const voixLa = toBuf(vowel(220, 1.6));        // La2 chanté (220 Hz)
// 1) Harmoniseur : chaque voix seule (voix principale coupée), sans humanisation, puis avec.
for (const [deg, want, nom] of [[2, 60, 'tierce au-dessus'], [4, 64, 'quinte au-dessus'], [5, 65, 'sixte au-dessus'], [7, 69, 'octave au-dessus'], [-2, 53, 'tierce en dessous'], [-7, 45, 'octave en dessous']]) {
  for (const humanize of [0, 0.35]) {
    const b = await render([track('voix', voixLa, [plugin('HARMONIZER', { ...KEY, voices: 1, v1Deg: deg, v1Level: 0, v1Pan: 0, dry: -60, humanize })])], 2.4);
    const f = f0Of(seg(b, 1.0, 1.6));
    out.harmoniseur.push({ intervalle: nom, humanisation: humanize, attendu: `${nameOf(hz(want))} (${hz(want).toFixed(2)} Hz)`, mesure_hz: Math.round(f * 100) / 100, note_mesuree: nameOf(f), ecart_cents: cents(f, hz(want)) });
  }
}
// Préréglage complet « Harmonie tierce + quinte » (à écouter).
{ const b = await render([track('voix', voixLa, [plugin('HARMONIZER', { ...KEY })])], 2.4); out.wav['harmoniseur_tierce_quinte'] = wav(b); }
// Note qui change : La2 puis Do3 → tierce = Do3 puis Mi3 (suit la mélodie).
{ const mel = new Float32Array(Math.round(1.6 * SR) * 2); mel.set(vowel(220, 1.6)); mel.set(vowel(hz(60), 1.6), Math.round(1.6 * SR));
  const b = await render([track('voix', toBuf(mel), [plugin('HARMONIZER', { ...KEY, voices: 1, v1Deg: 2, v1Level: 0, dry: -60, humanize: 0 })])], 4.0);
  const f1 = f0Of(seg(b, 1.0, 1.6)), f2 = f0Of(seg(b, 2.6, 3.2));
  out.harmoniseur_melodie = { 'La2 → tierce': `${nameOf(f1)} ${cents(f1, hz(60))} cents`, 'Do3 → tierce': `${nameOf(f2)} ${cents(f2, hz(64))} cents` }; }
// 2) Voix grave / aiguë.
for (const [nom, params, want] of [['formant seul +5', { pitch: 0, formant: 5, link: 0, mix: 1, output: 0 }, 220], ['formant seul −5', { pitch: 0, formant: -5, link: 0, mix: 1, output: 0 }, 220],
                                   ['formant seul +12', { pitch: 0, formant: 12, link: 0, mix: 1, output: 0 }, 220], ['Voix démon (−12, formant −4)', { pitch: -12, formant: -4, link: 0, mix: 1, output: 0 }, 110],
                                   ['Chipmunk (+12 lié)', { pitch: 12, formant: 0, link: 1, mix: 1, output: 0 }, 440], ['Voix grave (−5, formant −2)', { pitch: -5, formant: -2, link: 0, mix: 1, output: 0 }, 220 * Math.pow(2, -5 / 12)]]) {
  const b = await render([track('voix', voixLa, [plugin('VOICESHIFT', params)])], 2.4);
  const f = f0Of(seg(b, 1.0, 1.6));
  out.voix.push({ reglage: nom, attendu_hz: Math.round(want * 100) / 100, mesure_hz: Math.round(f * 100) / 100, ecart_cents: cents(f, want) });
  if (/démon|Chipmunk|\+12$/.test(nom)) out.wav['voix_' + nom.split(' ')[0].toLowerCase() + (nom.includes('+12') && nom.includes('formant') ? '_formant12' : '')] = wav(b);
}
// 3) Tape stop déclenché par l'automation (export) : sinus 440 Hz, arrêt à 1,5 s, 1 temps à 120 BPM = 0,5 s.
{ const n = Math.round(3 * SR), s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);
  const tf = plugin('TIMEFX', { stopBeats: 1, stopCurve: 0 }, 'pl-tape');
  const tr = track('beat', toBuf(s), [tf], { automationMode: 'read', automationLanes: [{ id: 'l1', parameterName: 'plugin::pl-tape::stop', color: '#f90', isExpanded: true, min: 0, max: 1,
    points: [{ id: 'a', time: 0, value: 0, curveType: 'HOLD' }, { id: 'b', time: 1.5, value: 1, curveType: 'HOLD' }] }] });
  tr.clips[0].start = 0;
  const b = await render([tr], 3.0);
  const x = b.getChannelData(0);
  const pts = []; for (let t = 1.3; t < 2.1; t += 0.05) pts.push([Math.round(t * 100) / 100, zcFreq(x, SR, t, t + 0.04)]);
  out.tape_stop_export = { courbe_hz: pts, rms_apres_2_05s: rms(x.slice(Math.round(2.05 * SR), Math.round(2.9 * SR))) };
  out.wav['tape_stop_export'] = wav(b);
}
// 4) Half-time automatisé sur une zone (1,0 → 2,0 s) : 440 Hz → 220 Hz pendant la zone.
{ const n = Math.round(3 * SR), s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);
  const tf = plugin('TIMEFX', { halfBeats: 4 }, 'pl-half');
  const tr = track('beat', toBuf(s), [tf], { automationMode: 'read', automationLanes: [{ id: 'l1', parameterName: 'plugin::pl-half::half', color: '#f90', isExpanded: true, min: 0, max: 1,
    points: [{ id: 'a', time: 0, value: 0, curveType: 'HOLD' }, { id: 'b', time: 1.0, value: 1, curveType: 'HOLD' }, { id: 'c', time: 2.0, value: 0, curveType: 'HOLD' }] }] });
  tr.clips[0].start = 0;
  const b = await render([tr], 3.0); const x = b.getChannelData(0);
  out.half_time_export = { avant_hz: zcFreq(x, SR, 0.5, 0.95), pendant_hz: zcFreq(x, SR, 1.1, 1.9), apres_hz: zcFreq(x, SR, 2.1, 2.9) };
}
// 5) Lo-fi téléphone et filtre DJ (à écouter).
{ const b = await render([track('voix', voixLa, [plugin('LOFI', {})])], 2.4); out.wav['lofi_telephone'] = wav(b); }
{ const b = await render([track('voix', voixLa, [plugin('DJFILTER', { filter: -0.6 })])], 2.4); out.wav['filtre_dj_passe_bas'] = wav(b); }
return out;
}"""

PDC_JS = "async () => {" + HELPERS + r"""
// Clic à 1,000 s sur une piste « voix » qui passe par chaque effet (latence réelle déclarée),
// et sur une piste « beat » sans effet : les deux doivent arriver à 1,000 s (export).
const click = (() => { const b = new AudioBuffer({ length: 4800, numberOfChannels: 2, sampleRate: SR }); for (let ch = 0; ch < 2; ch++) b.getChannelData(ch)[0] = 1; return b; })();
const onset = (buf) => { const x = buf.getChannelData(0); for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.05) return Math.round(i / SR * 1e6) / 1000; return null; };
const res = {};
const chains = {
  'Harmoniseur (défaut)': [plugin('HARMONIZER', {})],
  'Voix grave / aiguë (neutre : 0 / 0)': [plugin('VOICESHIFT', { pitch: 0, formant: 0 })],
  // Défaut « Voix grave » : formant −2 → le clic lui-même est un peu étiré (1 échantillon), la latence reste exacte.
  'Voix grave / aiguë (défaut −5 / −2)': [plugin('VOICESHIFT', {})],
  'Lo-fi (neutre)': [plugin('LOFI', { bits: 16, rate: 48000, lowCut: 20, highCut: 20000, drive: 0, noise: 0, mix: 1, output: 0 })],
  'Tape stop & half-time (repos)': [plugin('TIMEFX', {})],
  'Filtre DJ (centre)': [plugin('DJFILTER', {})],
  'Harmoniseur + Voix grave + Filtre DJ': [plugin('HARMONIZER', {}, 'h1'), plugin('VOICESHIFT', {}, 'v1'), plugin('DJFILTER', {}, 'd1')],
};
for (const [nom, pls] of Object.entries(chains)) {
  const voix = track('voix', click, pls); voix.clips[0].start = 1.0;
  const beat = track('beat', click, [], { isMuted: true }); beat.clips[0].start = 1.0;
  const bv = await render([voix, beat], 2);
  voix.isMuted = true; beat.isMuted = false;
  const bb = await render([voix, beat], 2);
  res[nom] = { voix_ms: onset(bv), beat_ms: onset(bb) };
}
// Lecture réelle : départ des clips avancé de la latence déclarée.
// Robustesse (08/10) : « departs_ms: [] » venait d'un moteur dans un état imprévu
// (instance partagée avec l'appli : boucle active, lecture/prise en cours, contexte
// suspendu) ou d'une fenêtre d'attente trop courte quand l'onglet est chargé.
// On repart d'un transport propre, on attend que l'horloge audio tourne, puis on
// attend les 2 départs (jusqu'à 5 s) ; sinon on rend un diagnostic au lieu d'une liste vide muette.
await E.init(); await E.resume();
if (E.isPlaying) E.stopAll();
E.setLoop(false, 0, 8);
E.setDelayCompensationSuspended?.(false);
const ctxSR = E.ctx.sampleRate;
const tc0 = E.ctx.currentTime; await new Promise(r => setTimeout(r, 300));
const horloge_tourne = E.ctx.currentTime > tc0;
const buf = new AudioBuffer({ length: ctxSR / 10, numberOfChannels: 2, sampleRate: ctxSR });
const tr = [track('voix', buf, [plugin('HARMONIZER', {}, 'live-h')]), track('beat', buf, [])];
tr.forEach(t => { t.clips[0].start = 1.0; t.clips[0].duration = 0.1; });
tr.forEach(t => E.updateTrack(t, tr));
await new Promise(r => setTimeout(r, 800));
const starts = []; const orig = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function (when, off, dur) { if (this.buffer === buf) starts.push(when); return orig.call(this, when, off, dur); };
E.startPlayback(0, tr); const t0 = E.playbackStartTime;
for (let k = 0; k < 50 && starts.length < 2; k++) await new Promise(r => setTimeout(r, 100));
await new Promise(r => setTimeout(r, 200)); E.stopAll();
AudioBufferSourceNode.prototype.start = orig;
const lat = E.getTrackLatency('voix');
res['lecture réelle'] = { latence_declaree_ms: Math.round(lat * 1e6) / 1000, departs_ms: starts.map(w => Math.round((w - t0) * 1e6) / 1000),
  arrivee_voix_ms: starts.length ? Math.round((starts[0] - t0 + E.getPluginNodeInstance('voix', 'live-h').latency) * 1e6) / 1000 : null };
if (starts.length < 2) res['lecture réelle'].diagnostic = { etat_contexte: E.ctx.state, horloge_tourne, pistes_moteur: ['voix', 'beat'].filter(id => E.tracksDSP?.has?.(id)), boucle: E.isLoopActive };
tr.forEach(t => E.disposeTrack(t.id));
return res;
}"""

LIVE_JS = "async () => {" + HELPERS + r"""
// Lecture RÉELLE : la sortie du master est enregistrée (AudioWorklet témoin) pendant qu'on joue.
await E.init(); await E.resume();
const ctx = E.ctx, sr = ctx.sampleRate;
const code = `class Rec extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec', Rec);`;
await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
const rec = new AudioWorkletNode(ctx, 'nova-qa-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
E.masterOutput.connect(rec);
const capture = async (tracks, sec) => {
  tracks.forEach(t => E.updateTrack(t, tracks));
  await new Promise(r => setTimeout(r, 900));
  chunks.length = 0;
  E.startPlayback(0, tracks); const t0 = E.playbackStartTime;
  await new Promise(r => setTimeout(r, sec * 1000 + 300)); E.stopAll();
  await new Promise(r => setTimeout(r, 200));
  // Échantillons remis à l'heure du projet (temps 0 = début de la lecture).
  const out = new Float32Array(Math.round(sec * sr));
  for (const c of chunks) for (let i = 0; i < c.d.length; i++) { const k = Math.round(c.f + i - t0 * sr); if (k >= 0 && k < out.length) out[k] = c.d[i]; }
  tracks.forEach(t => E.disposeTrack(t.id));
  return out;
};
const res = { sampleRate: sr };
const KEY = { rootKey: 0, scale: 'MAJOR' };
const v = vowel(220, 1.6, sr);
const tb = (x) => { const b = new AudioBuffer({ length: x.length, numberOfChannels: 2, sampleRate: sr }); b.getChannelData(0).set(x); b.getChannelData(1).set(x); return b; };
// Harmoniseur, tierce et quinte au-dessus de La2 en Do majeur.
for (const [deg, want] of [[2, 60], [4, 64]]) {
  const y = await capture([track('voix', tb(v), [plugin('HARMONIZER', { ...KEY, voices: 1, v1Deg: deg, v1Level: 0, v1Pan: 0, dry: -60, humanize: 0 }, `lh${deg}`)])], 2.3);
  const f = f0Of(y.slice(Math.round(1.0 * sr), Math.round(1.6 * sr)), sr);
  res[`harmoniseur_degre_${deg}`] = { attendu: nameOf(hz(want)), mesure_hz: Math.round(f * 100) / 100, ecart_cents: cents(f, hz(want)) };
}
// Formant seul.
{ const y = await capture([track('voix', tb(v), [plugin('VOICESHIFT', { pitch: 0, formant: 5, mix: 1, output: 0 }, 'lv')])], 2.3);
  const f = f0Of(y.slice(Math.round(1.0 * sr), Math.round(1.6 * sr)), sr); res.formant_seul_plus5 = { attendu_hz: 220, mesure_hz: Math.round(f * 100) / 100, ecart_cents: cents(f, 220) }; }
// Tape stop automatisé (comme à l'export) : arrêt à 1,5 s.
{ const n = Math.round(3 * sr), s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
  const tr = track('beat', tb(s), [plugin('TIMEFX', { stopBeats: 1, stopCurve: 0 }, 'lt')], { automationMode: 'read', automationLanes: [{ id: 'l1', parameterName: 'plugin::lt::stop', color: '#f90', isExpanded: true, min: 0, max: 1,
    points: [{ id: 'a', time: 0, value: 0, curveType: 'HOLD' }, { id: 'b', time: 1.5, value: 1, curveType: 'HOLD' }] }] });
  tr.clips[0].start = 0;
  const y = await capture([tr], 2.8);
  const pts = []; for (let t = 1.3; t < 2.1; t += 0.05) pts.push([Math.round(t * 100) / 100, zcFreq(y, sr, t, t + 0.04)]);
  res.tape_stop_lecture = { courbe_hz: pts, rms_apres_2_05s: rms(y.slice(Math.round(2.05 * sr), Math.round(2.7 * sr))) };
}
return res;
}"""


def save_wavs(d):
    for name, b64 in (d.pop("wav", {}) or {}).items():
        (OUT / f"v21_{name}.wav").write_bytes(base64.b64decode(b64))


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    # Accueil réellement affiché (serveur Vite à froid : 10 s et plus) avant de mesurer :
    # sinon la compilation des modules occupe l'onglet pendant la lecture chronométrée.
    try:
        pg.get_by_text("Nouveau Projet").first.wait_for(timeout=45000)
    except Exception:
        pass
    pg.wait_for_timeout(1500)
    res = {}
    which = sys.argv[1:] or ["export", "pdc", "lecture"]
    if "export" in which:
        r = pg.evaluate(EXPORT_JS); save_wavs(r); res["export"] = r
    if "pdc" in which:
        res["pdc"] = pg.evaluate(PDC_JS)
    if "lecture" in which:
        res["lecture"] = pg.evaluate(LIVE_JS)
    res["erreurs_page"] = errs[:5]
    b.close()

(OUT / "preuves_audio.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps(res, ensure_ascii=False, indent=1))
