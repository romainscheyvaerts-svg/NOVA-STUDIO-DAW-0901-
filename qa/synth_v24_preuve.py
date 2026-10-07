"""Preuves audio du synthé NOVA (V24), navigateur headless, aucune fenêtre.

1. Un accord (Do mineur 9) joué avec 5 sons -> WAV + mesures.
2. Tous les sons : niveau (RMS) et clics aux attaques / relâchements.
3. Torture : notes rapides, même touche relancée, plus de 16 voix, mono glissé.
4. Lecture réelle (AudioContext) contre export (renderProject) : écart en dB.
5. Charge CPU : vitesse du rendu hors temps réel (8 voix tenues, 10 s).
6. Ancien projet (piste MIDI sans novaSynth) : l'ancien synthé simple, à l'identique.

Usage : python qa/synth_v24_preuve.py [URL]   (par défaut http://localhost:3422/)
Sorties : D:\\1 WORK\\CONTENU\\nova-v24\\
"""
import base64, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
URL = ARGS[0] if ARGS else "http://localhost:3422/"
ONLY_LEVELS = "--niveaux" in sys.argv
ONLY_LIVE = "--lecture" in sys.argv
OUT = Path(r"D:\1 WORK\CONTENU\nova-v24")
OUT.mkdir(parents=True, exist_ok=True)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"

LIB = r"""
window.__v24 = (async () => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const P = await import('/utils/novaSynthPresets.ts');
  const { Synthesizer } = await import('/engine/Synthesizer.ts');
  const SR = 48000;
  const CHORD = [48, 55, 58, 62, 65];
  const track = (id, novaSynth, notes, dur = 4) => ({ id, name: id, type: TrackType.MIDI, volume: 1, pan: 0, isMuted: false, isSolo: false,
    clips: [{ id: id + '-c', type: TrackType.MIDI, start: 0, duration: dur, offset: 0, name: 'm', notes }], plugins: [], sends: [], automationLanes: [],
    outputTrackId: 'master', ...(novaSynth ? { novaSynth } : {}) });
  const chordNotes = (pitches, at = 0.25, dur = 1.5, vel = 0.8) => pitches.map((p, i) => ({ id: 'n' + i, pitch: p, start: at, duration: dur, velocity: vel }));
  const mono = buf => { const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L; const x = new Float32Array(L.length); for (let i = 0; i < x.length; i++) x[i] = (L[i] + R[i]) / 2; return x; };
  const db = v => v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -999;
  const rms = (x, a, b) => { let s = 0; const i0 = Math.floor(a * SR), i1 = Math.min(x.length, Math.floor(b * SR)); for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
  const peak = x => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; };
  // Clic = pic de la dérivée seconde à l'instant d'un événement, comparé au même son
  // juste après (attaque) ou juste avant (relâchement). ≤ 1,5 : rien de plus que l'onde elle-même.
  const d2 = x => { const d = new Float32Array(x.length); for (let i = 2; i < x.length; i++) d[i] = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]); return d; };
  const maxIn = (d, a, b) => { let m = 0; const i0 = Math.max(2, Math.floor(a * SR)), i1 = Math.min(d.length, Math.floor(b * SR)); for (let i = i0; i < i1; i++) m = Math.max(m, d[i]); return m; };
  const clickAt = (d, t, kind) => {
    const w = maxIn(d, t - 0.001, t + 0.005);
    const ref = kind === 'on' ? maxIn(d, t + 0.006, t + 0.05) : maxIn(d, t - 0.04, t - 0.002);
    return w / Math.max(ref, 1e-6);
  };
  const clickRatio = (x, events, kind) => {
    const d = d2(x); let worst = 0;
    for (const e of events) { const [t, k] = Array.isArray(e) ? e : [e, kind]; worst = Math.max(worst, clickAt(d, t, k)); }
    return Math.round(worst * 100) / 100;
  };
  // Niveau ressenti : RMS maximal sur une fenêtre glissante de 300 ms.
  const loud = (x, a, b) => { let best = 0; for (let t = a; t + 0.3 <= b; t += 0.05) best = Math.max(best, rms(x, t, t + 0.3)); return best; };
  const wav = buf => {
    const n = buf.length, ch = 2, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const W = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    W(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); W(8, 'WAVE'); W(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); W(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    for (let i = 0; i < n; i++) { out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
    let s = ''; const u = new Uint8Array(out.buffer); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s);
  };
  const render = (tracks, dur, sr = SR) => audioEngine.renderProject(tracks, dur, 0, sr);
  return { audioEngine, TrackType, P, Synthesizer, SR, CHORD, track, chordNotes, mono, db, rms, peak, clickRatio, loud, wav, render };
})();
"""

CHORDS_JS = r"""
async (ids) => {
  const L = await window.__v24; const out = {};
  for (const id of ids) {
    const s = L.P.presetSettings(id);
    const pitches = s.mono ? [60] : L.CHORD;
    const buf = await L.render([L.track('synth', s, L.chordNotes(pitches))], 4);
    const x = L.mono(buf);
    out[id] = { nom: s.name, notes: pitches, crete_dBFS: L.db(L.peak(x)), niveau_dB: L.db(L.loud(x, 0.25, 2.1)),
      clic_attaque: L.clickRatio(x, [0.25], 'on'), clic_relachement: L.clickRatio(x, [1.75], 'off'), wav: L.wav(buf) };
  }
  return out;
}
"""

LEVELS_JS = r"""
async () => {
  const L = await window.__v24; const out = [];
  for (const p of L.P.SYNTH_PRESETS) {
    const s = L.P.presetSettings(p.id);
    const pitches = s.mono ? [60] : L.CHORD;
    const buf = await L.render([L.track('synth', s, L.chordNotes(pitches))], 4);
    const x = L.mono(buf);
    out.push({ id: p.id, cat: p.cat, mono: s.mono, level: s.level, crete_dBFS: L.db(L.peak(x)), rms_dB: L.db(L.loud(x, 0.25, 2.1)),
      clic_attaque: L.clickRatio(x, [0.25], 'on'), clic_relachement: L.clickRatio(x, [1.75], 'off') });
  }
  return out;
}
"""

TORTURE_JS = r"""
async () => {
  const L = await window.__v24; const out = {};
  // 1) Notes rapides, même touche relancée, chevauchements ; 2) 20 notes à la fois (> 16 voix).
  const fast = []; let k = 0;
  for (let i = 0; i < 24; i++) fast.push({ id: 'f' + k++, pitch: [60, 60, 63, 67, 60, 70][i % 6], start: 0.2 + i * 0.09, duration: 0.13, velocity: 0.5 + (i % 4) * 0.15 });
  const big = Array.from({ length: 20 }, (_, i) => ({ id: 'b' + i, pitch: 40 + i * 2, start: 2.8 + i * 0.01, duration: 1.2, velocity: 0.8 }));
  const notes = [...fast, ...big];
  const events = notes.flatMap(n => [[n.start, 'on'], [n.start + n.duration, 'off']]);
  for (const id of ['pluck-trap', 'nappe-chaude', 'rhodes-soul', 'lead-trap-glisse', 'basse-reese', 'cloche-trap']) {
    const s = L.P.presetSettings(id);
    const buf = await L.render([L.track('synth', s, notes, 6)], 6);
    const x = L.mono(buf);
    out[id] = { crete_dBFS: L.db(L.peak(x)), pire_clic: L.clickRatio(x, events), evenements: events.length };
  }
  return out;
}
"""

LIVE_JS = r"""
async (ids) => {
  const L = await window.__v24; const E = L.audioEngine; const out = {};
  await E.init(); await E.resume();
  const ctx = E.ctx, SRL = ctx.sampleRate;
  // Enregistreur à l'échantillon près : chaque bloc arrive avec son numéro d'image (currentFrame).
  try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([`class R extends AudioWorkletProcessor { process(i){ const a = i[0]; if (a && a.length) this.port.postMessage({ f: currentFrame, l: new Float32Array(a[0]), r: new Float32Array(a[1] || a[0]) }); return true; } } registerProcessor('v24-rec', R);`], { type: 'application/javascript' }))); } catch (e) {}
  const notes = [
    ...L.CHORD.map((p, i) => ({ id: 'a' + i, pitch: p, start: 0.3, duration: 0.9, velocity: 0.8 })),
    { id: 'm1', pitch: 60, start: 1.6, duration: 0.5, velocity: 0.9 }, { id: 'm2', pitch: 67, start: 2.0, duration: 0.5, velocity: 0.6 },
    { id: 'm3', pitch: 63, start: 2.4, duration: 0.4, velocity: 0.7 },
  ];
  const DUR = 3.5;
  for (const id of ids) {
    const s = L.P.presetSettings(id);
    const tid = 'live-' + id; // piste neuve : pas d'écho restant d'un essai précédent
    const tr = [L.track(tid, s, notes, DUR)];
    const rb = await L.render(tr, DUR, SRL);
    tr.forEach(t => E.updateTrack(t, tr));
    await new Promise(r => setTimeout(r, 400));
    const dsp = E.tracksDSP.get(tid);
    const rec = new AudioWorkletNode(ctx, 'v24-rec', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
    dsp.output.connect(rec);
    const calls = []; const oa = E.triggerTrackAttack, orl = E.triggerTrackRelease;
    E.triggerTrackAttack = function (i, p, v, t) { calls.push(['on', p, t, ctx.currentTime]); return oa.call(this, i, p, v, t); };
    E.triggerTrackRelease = function (i, p, t) { calls.push(['off', p, t, ctx.currentTime]); return orl.call(this, i, p, t); };
    E.startPlayback(0, tr);
    const f0 = Math.round(E.playbackStartTime * SRL);
    await new Promise(r => setTimeout(r, (DUR + 0.6) * 1000));
    E.stopAll?.(); dsp.output.disconnect(rec);
    E.triggerTrackAttack = oa; E.triggerTrackRelease = orl;
    const t0 = E.playbackStartTime;
    const late = calls.filter(c => c[2] - c[3] < 0.003).map(c => [c[0], c[1], Math.round((c[2] - t0) * 1000) / 1000, Math.round((c[3] - t0) * 1000) / 1000]);
    const n = Math.floor(DUR * SRL), live = [new Float32Array(n), new Float32Array(n)], seen = new Uint8Array(n);
    for (const c of chunks) for (let i = 0; i < c.l.length; i++) { const k = c.f - f0 + i; if (k >= 0 && k < n) { live[0][k] = c.l[i]; live[1][k] = c.r[i]; seen[k] = 1; } }
    // Blocs jamais reçus par l'enregistreur (le navigateur headless en saute parfois) : exclus et comptés.
    let missing = 0; for (let i = 0; i < n; i++) if (!seen[i]) missing++;
    // Autour d'un bloc perdu, les blocs voisins ne sont pas fiables non plus : marge de 2 blocs.
    const ok = Uint8Array.from(seen);
    for (let i = 0; i < n; i++) if (!seen[i]) for (let k = Math.max(0, i - 256); k < Math.min(n, i + 256); k++) ok[k] = 0;
    let e = 0, sref = 0, worst = 0, worstAt = 0;
    for (const ch of [0, 1]) { const x = rb.getChannelData(ch); for (let i = 0; i < n; i++) { if (!ok[i]) continue; const d = x[i] - live[ch][i]; e += d * d; sref += x[i] * x[i]; if (Math.abs(d) > worst) { worst = Math.abs(d); worstAt = i / SRL; } } }
    out[id] = { ecart_dB: L.db(Math.sqrt(e / sref)), pire_ecart_echantillon_dBFS: L.db(worst), pire_a_s: Math.round(worstAt * 1000) / 1000, echantillons_non_recus: missing, appels: calls.length, appels_en_retard: late, frequence: SRL, duree_s: DUR, chorus: s.fx.chorus.mix > 0, delay: s.fx.delay.mix > 0, mono: s.mono, glisse: s.glide };
  }
  return out;
}
"""

CPU_JS = r"""
async (ids) => {
  const L = await window.__v24; const out = {};
  const notes = [];
  for (let b = 0; b < 5; b++) [48, 52, 55, 59, 62, 64, 67, 71].forEach((p, i) => notes.push({ id: `c${b}-${i}`, pitch: p + (b % 2 ? 2 : 0), start: b * 2, duration: 1.9, velocity: 0.8 }));
  for (const id of ids) {
    const s = id === 'ancien' ? null : L.P.presetSettings(id);
    const tr = [L.track('synth', s, notes, 10)];
    await L.render(tr, 2); // échauffement
    const t0 = performance.now(); await L.render(tr, 10.5); const ms = performance.now() - t0;
    out[id] = { rendu_ms_pour_10s: Math.round(ms), charge_pct_8_voix: Math.round(ms / 10500 * 1000) / 10, voix_osc: s ? s.osc.filter(o => o.on).reduce((a, o) => a + o.unison, 0) : 1 };
  }
  return out;
}
"""

LEGACY_JS = r"""
async () => {
  const L = await window.__v24; const E = L.audioEngine;
  const notes = L.chordNotes(L.CHORD);
  // Projet ancien : piste MIDI sans novaSynth.
  const viaEngine = L.mono(await L.render([L.track('synth', null, notes)], 3));
  // Référence : l'ancien Synthesizer seul dans un contexte hors temps réel, même chaîne de piste.
  const ctx = new OfflineAudioContext(2, 3 * L.SR, L.SR);
  // Même chaîne de piste que le moteur : entrée stéréo (« speakers »), volume, panoramique.
  const syn = new L.Synthesizer(ctx); const inp = ctx.createGain(); inp.channelCount = 2; inp.channelCountMode = 'explicit'; inp.channelInterpretation = 'speakers';
  const pan = ctx.createStereoPanner(); syn.output.connect(inp); inp.connect(pan); pan.connect(ctx.destination);
  notes.forEach(n => { syn.triggerAttack(n.pitch, n.velocity, n.start); syn.triggerRelease(n.pitch, n.start + n.duration); });
  const ref = L.mono(await ctx.startRendering());
  let e = 0, s = 0; for (let i = 0; i < ref.length; i++) { e += (ref[i] - viaEngine[i]) ** 2; s += ref[i] ** 2; }
  await E.init();
  const tr = [L.track('old', null, notes)]; tr.forEach(t => E.updateTrack(t, tr));
  const kind = E.tracksDSP.get('old')?.synth?.constructor?.name;
  const tr2 = [L.track('old', L.P.presetSettings('rhodes-soul'), notes)]; tr2.forEach(t => E.updateTrack(t, tr2));
  const kind2 = E.tracksDSP.get('old')?.synth?.constructor?.name;
  const tr3 = [L.track('old', null, notes)]; tr3.forEach(t => E.updateTrack(t, tr3));
  const kind3 = E.tracksDSP.get('old')?.synth?.constructor?.name;
  return { ecart_ancien_synthe_dB: L.db(Math.sqrt(e / s)), moteur_sans_novaSynth: kind, moteur_avec_novaSynth: kind2, retour_ancien_apres_annuler: kind3 };
}
"""


def main():
    res = {}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
        pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2500)
        pg.evaluate(LIB)
        pg.wait_for_function("() => window.__v24", timeout=30000)
        if ONLY_LEVELS:
            lv = pg.evaluate(LEVELS_JS)
            print(json.dumps(lv, ensure_ascii=False))
            b.close()
            return
        if ONLY_LIVE:
            print(json.dumps(pg.evaluate(LIVE_JS, ["rhodes-soul", "nappe-chaude", "pluck-trap", "cloche-trap", "choeur-ah", "lead-trap-glisse", "basse-reese", "flute-trap", "arp-nuit"]), ensure_ascii=False))
            b.close()
            return
        five = ["rhodes-soul", "nappe-chaude", "pluck-trap", "cloche-trap", "choeur-ah"]
        chords = pg.evaluate(CHORDS_JS, five)
        for i, (k, v) in enumerate(chords.items()):
            (OUT / f"accord_{i + 1}_{k}.wav").write_bytes(base64.b64decode(v.pop("wav")))
        res["1_accord_5_sons"] = chords
        res["2_tous_les_sons"] = pg.evaluate(LEVELS_JS)
        res["3_torture_clics"] = pg.evaluate(TORTURE_JS)
        res["4_lecture_vs_export"] = pg.evaluate(LIVE_JS, ["rhodes-soul", "nappe-chaude", "pluck-trap", "cloche-trap", "choeur-ah", "lead-trap-glisse", "basse-reese", "flute-trap", "arp-nuit"])
        res["5_cpu"] = pg.evaluate(CPU_JS, ["ancien", "pluck-trap", "rhodes-soul", "nappe-chaude", "lead-supersaw", "cordes-cinema"])
        res["6_ancien_projet"] = pg.evaluate(LEGACY_JS)
        res["erreurs_page"] = errs[:5]
        b.close()
    (OUT / "preuves_audio.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    lv = res["2_tous_les_sons"]
    print(json.dumps({k: v for k, v in res.items() if k != "2_tous_les_sons"}, ensure_ascii=False, indent=1))
    rms = [x["rms_dB"] for x in lv]
    print("niveaux RMS : min", min(rms), "max", max(rms), "| pire clic attaque", max(x["clic_attaque"] for x in lv), "relachement", max(x["clic_relachement"] for x in lv))
    for x in sorted(lv, key=lambda x: x["rms_dB"]):
        print(f'  {x["id"]:22s} {x["cat"]:18s} rms {x["rms_dB"]:6.1f}  crete {x["crete_dBFS"]:6.1f}  clicA {x["clic_attaque"]:5.2f}  clicR {x["clic_relachement"]:5.2f}')


if __name__ == "__main__":
    main()
