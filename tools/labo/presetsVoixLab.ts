/**
 * Labo des presets voix (lot 8a), côté navigateur : chargé dans NOVA (serveur de
 * développement) par tools/labo/presets_voix_mesures.py, il rend les chaînes avec
 * LE MOTEUR DE L'APPLI (AudioEngine.renderProject, même chemin que l'export) sur de
 * vraies prises, mesure et cale :
 *  - étage 1 (Compresseur NOVA 2:1) : seuil pour ~3 dB de réduction max au VU (pire prise) ;
 *  - étage 2 (Opto Vintage / Vox Strip 2:1) : seuil pour ~4,5 dB max au VU (pire prise),
 *    mesuré avec le cœur DSP de l'effet (même code que l'AudioWorklet) ; règle : 5 dB max ;
 *  - gain de sortie : tous les presets sortent à TARGET_OUTPUT_LUFS ;
 *  - crête vraie, échantillons ≥ 0 dBFS (saturation numérique), écart entre prises.
 * Les macros du One Knob sont mesurées à 100 % (écart de niveau, réduction, crêtes).
 */
import { audioEngine } from '../../engine/AudioEngine';
import { TrackType, type PluginInstance, type Track } from '../../types';
import { lufsOf, truePeakOf, samplePeakOf } from '../../utils/audioMeasure';
import { vuMaxGr, novaVuGr, bisectForTarget } from '../../utils/grCalibration';
import { ANALOG_SPECS } from '../../engine/analogCompParams';
import {
  VOICE_PRESETS, presetChain, makeVoicePlugin, trimFor, TARGET_OUTPUT_LUFS, findVoicePreset, applyVoicePreset,
  type VoiceChainItem, type VoicePreset,
} from '../../utils/voicePresets';
import type { VoicePresetCalib } from '../../utils/voicePresetCalib';
import { applyOneKnob, ONE_KNOB_MACROS } from '../../utils/oneKnob';

type Mono = Float32Array;
interface Take { name: string; x: Mono; sr: number; lufs: number }

const takes: Take[] = [];

const b64ToF32 = (b64: string): Float32Array => {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
};

/**
 * Ajoute une prise. `clipLufs` : niveau donné par le gain du clip (comme un ingé qui remonte
 * une prise enregistrée très bas) ; la prise garde sa dynamique, seul le gain change.
 */
export function addTake(name: string, b64: string, sr: number, clipLufs?: number) {
  let x = b64ToF32(b64);
  const raw = lufsOf([x], sr);
  if (typeof clipLufs === 'number') { const g = Math.pow(10, (clipLufs - raw) / 20); x = x.map(v => v * g); }
  const lufs = lufsOf([x], sr);
  takes.push({ name, x, sr, lufs });
  return { name, seconds: Math.round((x.length / sr) * 10) / 10, rawLufs: Math.round(raw * 10) / 10, lufs: Math.round(lufs * 10) / 10, peakDb: Math.round(samplePeakOf([x]) * 10) / 10 };
}
export const clearTakes = () => { takes.length = 0; };

const labTrack = (plugins: PluginInstance[], x: Mono, sr: number, trimDb = 0): Track => {
  const buffer = new AudioBuffer({ length: x.length, numberOfChannels: 1, sampleRate: sr });
  buffer.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
  return {
    id: 'lab-voix', name: 'Lab', type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 1, pan: 0, outputTrackId: 'master', sends: [], plugins, automationLanes: [], totalLatency: 0, inputTrimDb: trimDb,
    clips: [{ id: 'lab-clip', start: 0, offset: 0, duration: x.length / sr, fadeIn: 0, fadeOut: 0, name: 'prise', color: '#fff', type: TrackType.AUDIO, buffer, gain: 1 } as any],
  } as Track;
};

/** Rend une suite d'effets NOVA sur un son mono ; renvoie les 2 canaux (latence retirée). */
export async function renderItems(items: VoiceChainItem[] | PluginInstance[], x: Mono, sr: number, trimDb = 0): Promise<[Float32Array, Float32Array]> {
  const plugins = (items as any[]).map(i => ('id' in i && 'latency' in i) ? i as PluginInstance
    : makeVoicePlugin(i.type, i.type === 'AUTOTUNE' ? { ...i.params, rootKey: 0, scale: 'CHROMATIC' } : i.params, 'pl-lab'));
  const out = await audioEngine.renderProject([labTrack(plugins, x, sr, trimDb)], x.length / sr + 0.25, 0, sr, undefined, { preFader: true, keepGuides: true });
  const n = x.length;
  return [out.getChannelData(0).slice(0, n), out.getChannelData(1).slice(0, n)];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function clipCount(ch: Float32Array[]): number {
  let n = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) >= 1) n++;
  return n;
}

/** Index des étages dans une chaîne. */
const idx = (items: VoiceChainItem[], t: string) => items.findIndex(i => i.type === t);
const comp2Index = (items: VoiceChainItem[]) => items.findIndex(i => i.type === 'OPTO_VINTAGE' || i.type === 'VOXSTRIP');

interface StageTargets { g1: number; g2: number }
const targetsFor = (p: VoicePreset): StageTargets => ({ g1: p.gr?.stage1 ?? 3, g2: p.gr?.stage2 ?? 4.5 });

/** Correction de niveau propre à chaque mode du Compresseur NOVA (CompressorPlugin, modeDynamics). */
const MODE_TRIM_DB: Record<string, number> = { CLEAN: 0, VCA: 0.3, OPTO: 0.3, FET: 0.6 };

/**
 * Réduction (VU) de l'étage 1 : entrée = sortie du préfixe, sortie = après le Compresseur seul
 * (gain de compensation 1, sans anticipation : sortie alignée). Gain court terme par fenêtres
 * de 10 ms (passages au-dessus de −60 dBFS), référence = gain sans compression (0 dB + correction
 * du mode), puis balistique VU.
 */
async function stage1Gr(comp: VoiceChainItem, pre: Mono, sr: number): Promise<{ gr: number; out: Mono }> {
  const [o] = await renderItems([{ ...comp, params: { ...comp.params, makeupGain: 1 } }], pre, sr);
  const ref = MODE_TRIM_DB[comp.params.mode || 'CLEAN'] ?? 0;
  const w = Math.max(1, Math.round(0.01 * sr));
  const nb = Math.floor(pre.length / w);
  const trace = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let ei = 0, eo = 0;
    for (let i = b * w; i < (b + 1) * w; i++) { ei += pre[i] * pre[i]; eo += o[i] * o[i]; }
    if (ei / w < 1e-6) continue;
    trace[b] = Math.max(0, ref - 10 * Math.log10(Math.max(eo, 1e-20) / ei));
  }
  return { gr: vuMaxGr(trace, w / sr), out: o };
}

/**
 * Cale un preset (étages 1 et 2, sortie) sur les prises chargées. Renvoie le calage
 * et le détail par prise.
 */
export async function calibrate(presetId: string, opts: { levelPasses?: number } = {}) {
  const p = findVoicePreset(presetId);
  if (!p) throw new Error(`preset inconnu : ${presetId}`);
  if (p.bus) return calibrateBus(p);
  const tg = targetsFor(p);
  const t0 = performance.now();
  const base = presetChain(p, { ...p.calib, levelDb: 0 });
  const i1 = idx(base, 'COMPRESSOR'), i2 = comp2Index(base);
  // Préfixe commun (avant l'étage 1) : gain d'entrée de chaque prise.
  const pres: Mono[] = [];
  for (const tk of takes) {
    const stop = i1 >= 0 ? i1 : i2 >= 0 ? i2 : base.length;
    pres.push((await renderItems(base.slice(0, stop), tk.x, tk.sr, trimFor(tk.lufs)))[0]);
  }
  const sr = takes[0].sr;
  let thr1 = p.calib.thr1;
  let gr1 = 0;
  if (i1 >= 0) {
    const comp = base[i1];
    const meas = async (thr: number) => {
      let worst = 0;
      for (const pre of pres) worst = Math.max(worst, (await stage1Gr({ ...comp, params: { ...comp.params, threshold: thr } }, pre, sr)).gr);
      return worst;
    };
    const res = await bisectForTarget(meas, -50, -4, -1, tg.g1, { iterations: 9, tolerance: 0.15, step: 0.5 });
    thr1 = res.value; gr1 = await meas(thr1);
  }
  // Entrée de l'étage 2 : après étage 1 et de-esser.
  let thr2 = p.calib.thr2, gr2 = 0, head2 = 0;
  const kind = i2 >= 0 ? base[i2].type : null;
  if (i2 >= 0 && kind) {
    const spec = ANALOG_SPECS[kind];
    const ps = spec.specs.find(s => s.id === spec.driveParam)!;
    const ins: Mono[] = [];
    for (let k = 0; k < takes.length; k++) {
      const items = presetChain(p, { ...p.calib, thr1, levelDb: 0 });
      const mid = items.slice(i1 >= 0 ? i1 : 0, i2);
      ins.push(mid.length ? (await renderItems(mid, pres[k], sr))[0] : pres[k]);
    }
    const params = { ...base[i2].params };
    const grAt = (v: number) => Math.max(...ins.map(x => novaVuGr(kind, { ...params, [spec.driveParam]: v }, [x], sr)));
    const res = await bisectForTarget(v => grAt(v), ps.min, ps.max, spec.driveSense, tg.g2, { iterations: 16, tolerance: 0.1, step: ps.step });
    thr2 = res.value; gr2 = grAt(thr2);
    // Marge jusqu'à 5 dB (pire prise) : macro « Compression ».
    const r5 = await bisectForTarget(v => grAt(v), ps.min, ps.max, spec.driveSense, 5, { iterations: 16, tolerance: 0.08, step: ps.step });
    head2 = Math.abs(r5.value - thr2);
    // Le calage à 5 dB ne doit pas dépasser 5 dB.
    if (grAt(r5.value) > 5.05) head2 = Math.max(0, head2 - ps.step * 2);
  }
  // Sortie : même niveau pour tous les presets (2 passes : la saturation suit le niveau).
  let levelDb = 0;
  let outs: { lufs: number; tp: number; sp: number; clips: number }[] = [];
  for (let pass = 0; pass < (opts.levelPasses ?? 3); pass++) {
    outs = [];
    for (const tk of takes) {
      const items = presetChain(p, { ...p.calib, thr1, thr2, levelDb });
      const o = await renderItems(items, tk.x, tk.sr, trimFor(tk.lufs));
      outs.push({ lufs: lufsOf(o, tk.sr), tp: truePeakOf(o, 4, 32), sp: samplePeakOf(o), clips: clipCount(o) });
    }
    const mean = outs.reduce((s, o) => s + o.lufs, 0) / outs.length;
    const delta = TARGET_OUTPUT_LUFS - mean;
    if (Math.abs(delta) < 0.1 && pass > 0) break;
    levelDb = r1(levelDb + delta);
  }
  const lufsAll = outs.map(o => o.lufs);
  const calib: VoicePresetCalib = {
    thr1: r2(thr1), thr2: r2(thr2), levelDb, gr1: r2(gr1), gr2: r2(gr2), head2: r2(head2),
    outLufs: r2(lufsAll.reduce((s, v) => s + v, 0) / lufsAll.length), spreadDb: r2(Math.max(...lufsAll) - Math.min(...lufsAll)),
    truePeakDb: r2(Math.max(...outs.map(o => o.tp))),
  };
  return {
    id: p.id, kind, calib, secs: r1((performance.now() - t0) / 1000),
    takes: takes.map((tk, k) => ({ name: tk.name, inLufs: r1(tk.lufs), trimDb: trimFor(tk.lufs), outLufs: r2(outs[k].lufs), truePeakDb: r2(outs[k].tp), samplePeakDb: r2(outs[k].sp), clips: outs[k].clips })),
  };
}

/**
 * Bus voix : FET 76 (5 dB max au VU) puis Leveler 2A (2 dB max), sur la voix lead « trap » traitée.
 * Ordre du calage : entrée du FET (réduction), sortie du FET (niveau d'entrée gardé), réduction
 * du Leveler, gain du Leveler (le bus sort au niveau où les voix y entrent).
 */
async function calibrateBus(p: VoicePreset) {
  const t0 = performance.now();
  const lead = findVoicePreset('trap-lead')!;
  const sr = takes[0].sr;
  const ins: Mono[] = [];
  for (const tk of takes) ins.push((await renderItems(presetChain(lead, lead.calib), tk.x, sr, trimFor(tk.lufs)))[0]);
  const inMean = ins.reduce((acc, x) => acc + lufsOf([x, x], sr), 0) / ins.length;
  const fetBase = presetChain(p, p.calib).find(i => i.type === 'FET76')!;
  const levBase = presetChain(p, p.calib).find(i => i.type === 'LEVELER2A');
  const fsp = ANALOG_SPECS.FET76.specs.find(s => s.id === 'input')!;
  const grFet = (v: number) => Math.max(...ins.map(x => novaVuGr('FET76', { ...fetBase.params, input: v }, [x], sr)));
  const thr1 = (await bisectForTarget(v => grFet(v), fsp.min, fsp.max, 1, 4.5, { iterations: 16, tolerance: 0.1, step: fsp.step })).value;
  const gr1 = grFet(thr1);
  const fo = ANALOG_SPECS.FET76.specs.find(s => s.id === 'output')!;
  const fet = (out: number): VoiceChainItem => ({ ...fetBase, params: { ...fetBase.params, input: thr1, output: out } });
  const fetLevel = async (out: number) => { let sum = 0; for (const x of ins) sum += lufsOf(await renderItems([fet(out)], x, sr), sr); return sum / ins.length - inMean; };
  const busOut = (await bisectForTarget(v => fetLevel(v).then(d => d + 40), fo.min, fo.max, 1, 40, { iterations: 12, tolerance: 0.1, step: fo.step })).value;
  let thr2 = 0, gr2 = 0, busGain: number | undefined;
  if (levBase) {
    const mids: Mono[] = [];
    for (const x of ins) mids.push((await renderItems([fet(busOut)], x, sr))[0]);
    const ls = ANALOG_SPECS.LEVELER2A.specs.find(s => s.id === 'peakReduction')!;
    const grLev = (v: number) => Math.max(...mids.map(x => novaVuGr('LEVELER2A', { ...levBase.params, peakReduction: v }, [x], sr)));
    thr2 = (await bisectForTarget(v => grLev(v), ls.min, ls.max, 1, 1.8, { iterations: 16, tolerance: 0.08, step: ls.step })).value;
    gr2 = grLev(thr2);
    const gs = ANALOG_SPECS.LEVELER2A.specs.find(s => s.id === 'gain')!;
    const levLevel = async (g: number) => { let sum = 0; for (const x of mids) sum += lufsOf(await renderItems([{ ...levBase, params: { ...levBase.params, peakReduction: thr2, gain: g } }], x, sr), sr); return sum / mids.length - inMean; };
    busGain = (await bisectForTarget(v => levLevel(v).then(d => d + 40), gs.min, gs.max, 1, 40, { iterations: 12, tolerance: 0.1, step: gs.step })).value;
  }
  const cal = { ...p.calib, thr1, thr2, levelDb: 0, busOut, busGain };
  const outs: { lufs: number; tp: number; inL: number; clips: number }[] = [];
  for (let k = 0; k < ins.length; k++) {
    const o = await renderItems(presetChain(p, cal), ins[k], sr);
    outs.push({ lufs: lufsOf(o, sr), tp: truePeakOf(o, 4, 32), inL: lufsOf([ins[k], ins[k]], sr), clips: clipCount(o) });
  }
  const lufsAll = outs.map(o => o.lufs);
  const calib: VoicePresetCalib = {
    thr1: r2(thr1), thr2: r2(thr2), levelDb: 0, gr1: r2(gr1), gr2: r2(gr2), head2: 0, busOut: r2(busOut), ...(busGain !== undefined ? { busGain: r2(busGain) } : {}),
    outLufs: r2(lufsAll.reduce((s2, v) => s2 + v, 0) / lufsAll.length), spreadDb: r2(Math.max(...lufsAll) - Math.min(...lufsAll)),
    truePeakDb: r2(Math.max(...outs.map(o => o.tp))),
  };
  return { id: p.id, kind: 'BUS', calib, inLufs: r2(inMean), secs: r1((performance.now() - t0) / 1000), takes: takes.map((tk, k) => ({ name: tk.name, inLufs: r2(outs[k].inL), outLufs: r2(outs[k].lufs), truePeakDb: r2(outs[k].tp), clips: outs[k].clips })) };
}

/**
 * Mesure finale d'un preset tel qu'il est livré (calage du fichier) : niveau, crêtes,
 * réduction des deux étages, sur chaque prise. Même chemin que l'appli : applyVoicePreset.
 */
export async function measure(presetId: string) {
  const p = findVoicePreset(presetId)!;
  const rows = [];
  for (const tk of takes) {
    const tr = applyVoicePreset(labTrack([], tk.x, tk.sr), p, { allTracks: [], inputLufs: tk.lufs, keepFader: true }).track;
    rows.push({ name: tk.name, trimDb: tr.inputTrimDb ?? 0, ...(await measurePlugins(tr.plugins, tk, tr.inputTrimDb ?? 0)) });
  }
  return { id: p.id, rows };
}

async function measurePlugins(plugins: PluginInstance[], tk: Take, trimDb: number) {
  const sr = tk.sr;
  const o = await renderItems(plugins, tk.x, sr, trimDb);
  const res: Record<string, number | null> = { outLufs: r2(lufsOf(o, sr)), truePeakDb: r2(truePeakOf(o, 4, 32)), samplePeakDb: r2(samplePeakOf(o)), clips: clipCount(o), gr1: null, gr2: null, grFet: null, grLev: null };
  const i1 = plugins.findIndex(x => x.type === 'COMPRESSOR');
  const i2 = plugins.findIndex(x => x.type === 'OPTO_VINTAGE' || x.type === 'VOXSTRIP');
  if (i1 >= 0) {
    const pre = (await renderItems(plugins.slice(0, i1), tk.x, sr, trimDb))[0];
    res.gr1 = r2((await stage1Gr({ type: 'COMPRESSOR', params: plugins[i1].params }, pre, sr)).gr);
  }
  if (i2 >= 0) {
    const pre = (await renderItems(plugins.slice(0, i2), tk.x, sr, trimDb))[0];
    res.gr2 = r2(novaVuGr(plugins[i2].type, plugins[i2].params as any, [pre], sr));
  }
  return res;
}

/** Macros du One Knob à 100 % sur un preset : écart de niveau, réductions, crêtes. */
export async function measureMacros(presetId: string, amount = 1) {
  const p = findVoicePreset(presetId)!;
  const out: any[] = [];
  for (const tk of takes) {
    const allTracks: Track[] = [{ id: 'send-delay' } as any, { id: 'send-verb-short' } as any, { id: 'send-verb-long' } as any];
    const t0 = applyVoicePreset(labTrack([], tk.x, tk.sr), p, { allTracks, inputLufs: tk.lufs, keepFader: true }).track;
    const ref = await measurePlugins(t0.plugins, tk, t0.inputTrimDb ?? 0);
    for (const m of ONE_KNOB_MACROS) {
      const t1 = applyOneKnob(t0, m.id, amount).track;
      const r = await measurePlugins(t1.plugins, tk, t1.inputTrimDb ?? 0);
      out.push({ take: tk.name, macro: m.id, amount, deltaLufs: r2((r.outLufs as number) - (ref.outLufs as number)), gr1: r.gr1, gr2: r.gr2, truePeakDb: r.truePeakDb, clips: r.clips,
        sends: Object.fromEntries((t1.sends || []).map(s => [s.id, r2(s.level)])) });
    }
  }
  return out;
}

/** Démo audio : prise brute (au gain d'entrée) et prise traitée, en stéréo 16 bits. */
export async function demo(presetId: string, takeIndex: number, macros: Record<string, number> = {}) {
  const p = findVoicePreset(presetId)!;
  const tk = takes[takeIndex];
  let tr = applyVoicePreset(labTrack([], tk.x, tk.sr), p, { allTracks: [], inputLufs: tk.lufs, keepFader: true }).track;
  for (const [m, a] of Object.entries(macros)) tr = applyOneKnob(tr, m as any, a).track;
  const o = await renderItems(tr.plugins, tk.x, tk.sr, tr.inputTrimDb ?? 0);
  // Avant : la prise au même niveau intégré que l'après (comparaison honnête).
  const g = Math.pow(10, (lufsOf(o, tk.sr) - lufsOf([tk.x, tk.x], tk.sr)) / 20);
  const before = tk.x.map(v => v * g);
  const enc = (L: Float32Array, R: Float32Array) => {
    const n = L.length, buf = new ArrayBuffer(44 + n * 4), dv = new DataView(buf);
    const w = (o2: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o2 + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, tk.sr, true); dv.setUint32(28, tk.sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) { dv.setInt16(44 + i * 4, Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), true); dv.setInt16(46 + i * 4, Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), true); }
    let s = ''; const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return { before: enc(before, before), after: enc(o[0], o[1]), lufs: r2(lufsOf(o, tk.sr)), chain: tr.plugins.map(x => x.name) };
}

export const presetIds = () => VOICE_PRESETS.map(p => p.id);

/** Diagnostic : niveau (LUFS) et crête après chaque effet de la chaîne, prise par prise. */
export async function stageLevels(presetId: string) {
  const p = findVoicePreset(presetId)!;
  const res: any[] = [];
  for (const tk of takes) {
    const items = presetChain(p, p.calib);
    const row: any = { take: tk.name, inLufs: r2(tk.lufs), trim: trimFor(tk.lufs), steps: [] };
    for (let i = 0; i <= items.length; i++) {
      const o = i ? await renderItems(items.slice(0, i), tk.x, tk.sr, trimFor(tk.lufs)) : [tk.x, tk.x] as [Float32Array, Float32Array];
      row.steps.push({ after: i ? items[i - 1].type : 'brut', lufs: r2(lufsOf(o, tk.sr)), peak: r2(samplePeakOf(o)) });
    }
    res.push(row);
  }
  return res;
}
