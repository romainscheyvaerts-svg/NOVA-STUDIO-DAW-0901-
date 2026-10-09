"""Preuve : l'Harmoniseur suit la piste d'accords, au temps près, à l'export ET en lecture.

Vrai moteur de NOVA dans un navigateur headless (aucune fenêtre) :
- Export (renderProject) : une voix TENUE (Do3) sur Am → F → C → G, un accord par
  mesure (120 BPM) ; voix d'harmonie seule (« tierce au-dessus », voix principale
  coupée). On mesure la hauteur au milieu de chaque accord (écart en cents) et
  l'instant où elle bascule (écart en ms avec la barre de mesure).
- Même chose sur la fondamentale chantée (La2, Fa2, Do3, Sol2) en tonalité
  inconnue : la tierce = la tierce de chaque accord (Do, La, Mi, Si).
- PDC : un 2e effet latent après l'harmoniseur, puis la piste routée dans un bus
  latent : le changement tombe toujours sur le temps.
- Lecture réelle : la sortie du master est enregistrée (AudioWorklet témoin).
- Décoché : la gamme seule (aucun changement).
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions-accords\\ (harmoniseur_accords.json + WAV).

Usage : NOVA_URL=http://127.0.0.1:3437/ python qa/harmoniseur_accords.py
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import base64, json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-finitions-accords"))
OUT.mkdir(parents=True, exist_ok=True)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3437/")

HELPERS = r"""
const { audioEngine: E } = await import('/engine/AudioEngine.ts');
const { TrackType } = await import('/types.ts');
const { V21_DEFAULTS } = await import('/engine/v21Params.ts');
E.currentBpm = 120;
const vowel = (f0, sec, sr) => {
  const n = Math.round(sec * sr), src = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { ph += f0 / sr; if (ph >= 1) ph -= 1; src[i] = ph < 0.4 ? 0.5 * (1 - Math.cos(Math.PI * ph / 0.4)) : ph < 0.6 ? Math.cos(Math.PI * (ph - 0.4) / 0.4) : 0; }
  const d = new Float32Array(n); for (let i = 1; i < n; i++) d[i] = src[i] - src[i - 1];
  const out = new Float32Array(n);
  [700, 1220, 2600].forEach((fc, k) => { const bw = 130 + 60 * k, r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * fc / sr, a1 = -2 * r * Math.cos(th), a2 = r * r; let y1 = 0, y2 = 0; const g = [1, 0.6, 0.3][k]; for (let i = 0; i < n; i++) { const y = d[i] - a1 * y1 - a2 * y2; y2 = y1; y1 = y; out[i] += g * y; } });
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i])); for (let i = 0; i < n; i++) out[i] *= 0.5 / pk;
  const fade = Math.round(0.02 * sr); for (let i = 0; i < fade; i++) { out[i] *= i / fade; out[n - 1 - i] *= i / fade; }
  return out;
};
const toBuf = (x, sr) => { const b = new AudioBuffer({ length: x.length, numberOfChannels: 2, sampleRate: sr }); b.getChannelData(0).set(x); b.getChannelData(1).set(x); return b; };
const f0Of = (x, sr, fmin = 40, fmax = 1200) => {
  const lagMin = Math.floor(sr / fmax), lagMax = Math.ceil(sr / fmin), W = x.length - lagMax - 2; if (W < 16) return 0; const ns = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) { let ac = 0, e1 = 0, e2 = 0; for (let j = 0; j < W; j++) { ac += x[j] * x[j + lag]; e1 += x[j] * x[j]; e2 += x[j + lag] * x[j + lag]; } ns[lag] = 2 * ac / (e1 + e2 + 1e-20); }
  let max = 0; for (let l = lagMin; l <= lagMax; l++) max = Math.max(max, ns[l]);
  for (let l = lagMin; l <= lagMax; l++) if (ns[l] >= 0.97 * max && ns[l] >= ns[l - 1] && ns[l] >= ns[l + 1]) { const a = ns[l - 1], b = ns[l], c = ns[l + 1], den = a - 2 * b + c; return sr / (l + (Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0)); }
  return 0;
};
const cents = (f, ref) => Math.round(1200 * Math.log2(f / ref) * 100) / 100;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const NAMES = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const nameOf = f => { const m = Math.round(69 + 12 * Math.log2(f / 440)); return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 2}`; };
const plugin = (type, params = {}, id) => ({ id: id || `pl-${type}`, type, name: type, isEnabled: true, params: { ...V21_DEFAULTS[type](), ...params }, latency: 0 });
const track = (id, buf, plugins, start, extra = {}) => ({ id, name: id, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [],
  clips: buf ? [{ id: `c-${id}`, type: TrackType.AUDIO, start, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id }] : [], plugins, ...extra });
// Un accord par mesure (120 BPM, 4/4 : 2 s) à partir de la mesure 2.
const BAR = 2, T0 = 2;
const CH = [[9, 'min', 'Am'], [5, 'maj', 'F'], [0, 'maj', 'C'], [7, 'maj', 'G']];
const chords = CH.map(([root, quality], k) => ({ id: `ch${k}`, start: T0 + k * BAR, end: T0 + (k + 1) * BAR, root, quality }));
const HARM = (extra = {}) => plugin('HARMONIZER', { rootKey: 9, scale: 'MINOR', voices: 1, v1Deg: 2, v1Level: 0, v1Pan: 0, dry: -60, humanize: 0, ...extra }, 'harm');
/** Voyelle dont la hauteur change d'un coup à `at` (phase continue) : bascule idéale de référence. */
const vowelSwitch = (f1, f2, at, sec, sr) => {
  const n = Math.round(sec * sr), src = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { ph += (i / sr < at ? f1 : f2) / sr; if (ph >= 1) ph -= 1; src[i] = ph < 0.4 ? 0.5 * (1 - Math.cos(Math.PI * ph / 0.4)) : ph < 0.6 ? Math.cos(Math.PI * (ph - 0.4) / 0.4) : 0; }
  const d = new Float32Array(n); for (let i = 1; i < n; i++) d[i] = src[i] - src[i - 1];
  const out = new Float32Array(n);
  [700, 1220, 2600].forEach((fc, k) => { const bw = 130 + 60 * k, r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * fc / sr, a1 = -2 * r * Math.cos(th), a2 = r * r; let y1 = 0, y2 = 0; const g = [1, 0.6, 0.3][k]; for (let i = 0; i < n; i++) { const y = d[i] - a1 * y1 - a2 * y2; y2 = y1; y1 = y; out[i] += g * y; } });
  return out;
};
/** Premier instant (pas 0,5 ms, fenêtres de 20 ms) où la hauteur a franchi le milieu des deux notes. */
const basculeAt = (y, sr, a, f1, f2) => {
  const mid = Math.sqrt(f1 * f2), up = f2 > f1;
  for (let t = a - 0.05; t < a + 0.05; t += 0.0005) {
    const ff = f0Of(y.slice(Math.round((t - 0.01) * sr), Math.round((t + 0.01) * sr)), sr, 150, 800);
    if (ff > 0 && (up ? ff > mid : ff < mid)) return t;
  }
  return null;
};
/**
 * Hauteur au milieu de chaque accord + instant de bascule vers la note
 * suivante. Le détecteur (fenêtre de 20 ms) a son propre retard : il est
 * mesuré sur une bascule IDÉALE (voyelle qui change de note pile au temps)
 * et retiré ; reste l'écart propre à l'harmoniseur.
 */
const analyse = (y, sr, want) => {
  const res = [];
  for (let k = 0; k < 4; k++) {
    const a = T0 + k * BAR, f = f0Of(y.slice(Math.round((a + 0.6) * sr), Math.round((a + 1.4) * sr)), sr);
    const r = { accord: CH[k][2], attendu: `${nameOf(hz(want[k]))} (${hz(want[k]).toFixed(2)} Hz)`, mesure_hz: Math.round(f * 1000) / 1000, note_mesuree: nameOf(f), ecart_cents: cents(f, hz(want[k])) };
    if (k > 0 && want[k] !== want[k - 1]) {
      const at = basculeAt(y, sr, a, hz(want[k - 1]), hz(want[k]));
      const ref = basculeAt(vowelSwitch(hz(want[k - 1]), hz(want[k]), 0.2, 0.4, sr), sr, 0.2, hz(want[k - 1]), hz(want[k]));
      r.bascule_s = at === null ? null : Math.round(at * 10000) / 10000;
      r.retard_du_detecteur_ms = ref === null ? null : Math.round((ref - 0.2) * 10000) / 10;
      r.ecart_temps_ms = at === null || ref === null ? null : Math.round(((at - a) - (ref - 0.2)) * 10000) / 10;
    }
    res.push(r);
  }
  return res;
};
const wav = (b) => { const n = b.length, ch = b.numberOfChannels; const bytes = new Uint8Array(44 + n * ch * 2); const dv = new DataView(bytes.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, b.sampleRate, true); dv.setUint32(28, b.sampleRate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(b.getChannelData(c));
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2; }
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
"""

EXPORT_JS = "async () => {" + HELPERS + r"""
const SR = 48000, out = { wav: {} };
E.setChords(chords);
const tenue = toBuf(vowel(hz(60), 9.5, SR), SR);          // Do3 tenu
const WANT = [64, 65, 64, 62];                              // tierce calée sur Am, F, C, G : Mi3, Fa3, Mi3, Ré3
// 1) Voix tenue, tierce au-dessus, la piste seule.
{ const b = await E.renderProject([track('voix', tenue, [HARM()], 1.5)], 11, 0, SR);
  out.export_voix_tenue = analyse(b.getChannelData(0), SR, WANT); out.wav.export_voix_tenue_tierce = wav(b); }
// 2) Fondamentale chantée (La2, Fa2, Do3, Sol2), tonalité inconnue (chromatique) : tierce = tierce de l'accord.
{ const x = new Float32Array(Math.round(9.5 * SR)); const roots = [57, 53, 60, 55];
  roots.forEach((m, k) => x.set(vowel(hz(m), BAR, SR), Math.round((T0 - 1.5 + k * BAR) * SR)));
  const b = await E.renderProject([track('voix', toBuf(x, SR), [HARM({ rootKey: 0, scale: 'CHROMATIC' })], 1.5)], 11, 0, SR);
  const y = b.getChannelData(0); const want = [60, 57, 64, 59];   // Do3, La2, Mi3, Si2
  out.export_fondamentales = CH.map(([, , nom], k) => { const a = T0 + k * BAR, f = f0Of(y.slice(Math.round((a + 0.6) * SR), Math.round((a + 1.4) * SR)), SR);
    return { accord: nom, chantee: nameOf(hz(roots[k])), attendu: nameOf(hz(want[k])), mesure_hz: Math.round(f * 1000) / 1000, ecart_cents: cents(f, hz(want[k])) }; });
  out.wav.export_fondamentales_tierce = wav(b); }
// 3) PDC : un 2e effet latent après l'harmoniseur (Voix grave / aiguë neutre, 57 ms).
{ const b = await E.renderProject([track('voix', tenue, [HARM(), plugin('VOICESHIFT', { pitch: 0, formant: 0 }, 'vs')], 1.5)], 11, 0, SR);
  out.export_chaine_latente = analyse(b.getChannelData(0), SR, WANT); }
// 4) PDC : piste routée dans un bus latent (Voix grave / aiguë neutre sur le bus).
{ const bus = track('bus', null, [plugin('VOICESHIFT', { pitch: 0, formant: 0 }, 'vsb')], 0, { type: TrackType.BUS });
  const b = await E.renderProject([track('voix', tenue, [HARM()], 1.5, { outputTrackId: 'bus' }), bus], 11, 0, SR);
  out.export_bus_latent = analyse(b.getChannelData(0), SR, WANT); }
// 5) Export d'une boucle qui commence au milieu (mesure 3 + 1 temps) : même résultat.
{ const b = await E.renderProject([track('voix', tenue, [HARM()], 1.5)], 6, 4.5, SR);
  const y = b.getChannelData(0); const pad = new Float32Array(Math.round(11 * SR)); pad.set(y, Math.round(4.5 * SR));
  out.export_depuis_4_5s = analyse(pad, SR, WANT).slice(2); }
// 6) Décoché : la gamme seule (La mineur : tierce de Do = Mi), aucun changement.
{ const b = await E.renderProject([track('voix', tenue, [HARM({ followChords: 0 })], 1.5)], 11, 0, SR);
  const y = b.getChannelData(0);
  out.export_decoche = CH.map(([, , nom], k) => { const a = T0 + k * BAR, f = f0Of(y.slice(Math.round((a + 0.6) * SR), Math.round((a + 1.4) * SR)), SR); return { accord: nom, note: nameOf(f), ecart_cents_mi: cents(f, hz(64)) }; }); }
E.setChords([]);
return out;
}"""

LIVE_JS = "async () => {" + HELPERS + r"""
await E.init(); await E.resume();
const ctx = E.ctx, sr = ctx.sampleRate;
const code = `class Rec extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec-acc', Rec);`;
await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
const rec = new AudioWorkletNode(ctx, 'nova-qa-rec-acc', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
E.masterOutput.connect(rec);
E.setChords(chords);
const capture = async (tracks, sec, from = 0) => {
  tracks.forEach(t => E.updateTrack(t, tracks));
  await new Promise(r => setTimeout(r, 1200));
  chunks.length = 0;
  E.startPlayback(from, tracks); const t0 = E.playbackStartTime;
  await new Promise(r => setTimeout(r, (sec - from) * 1000 + 300)); E.stopAll();
  await new Promise(r => setTimeout(r, 200));
  const out = new Float32Array(Math.round(sec * sr));
  for (const c of chunks) for (let i = 0; i < c.d.length; i++) { const k = Math.round(c.f + i - t0 * sr); if (k >= 0 && k < out.length) out[k] = c.d[i]; }
  tracks.forEach(t => E.disposeTrack(t.id));
  return out;
};
const tenue = toBuf(vowel(hz(60), 9.5, sr), sr);
const WANT = [64, 65, 64, 62];
const res = { sampleRate: sr };
res.lecture_voix_tenue = analyse(await capture([track('voix', tenue, [HARM()], 1.5)], 10.5), sr, WANT);
res.lecture_chaine_latente = analyse(await capture([track('voix', tenue, [HARM(), plugin('VOICESHIFT', { pitch: 0, formant: 0 }, 'vs')], 1.5)], 10.5), sr, WANT);
// Lecture lancée au milieu d'un accord (5,3 s) : les accords suivants tombent toujours sur le temps.
res.lecture_depuis_5_3s = analyse(await capture([track('voix', tenue, [HARM()], 1.5)], 10.5, 5.3), sr, WANT).slice(2);
E.setChords([]);
return res;
}"""


def save_wavs(d):
    for name, b64 in (d.pop("wav", {}) or {}).items():
        (OUT / f"{name}.wav").write_bytes(base64.b64decode(b64))


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    res = {}
    which = sys.argv[1:] or ["export", "lecture"]
    if "export" in which:
        r = pg.evaluate(EXPORT_JS); save_wavs(r); res["export"] = r
    if "lecture" in which:
        res["lecture"] = pg.evaluate(LIVE_JS)
    res["erreurs_page"] = errs[:5]
    b.close()

(OUT / "harmoniseur_accords.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps(res, ensure_ascii=False, indent=1))
