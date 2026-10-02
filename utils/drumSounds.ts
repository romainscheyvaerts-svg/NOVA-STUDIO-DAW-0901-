/**
 * Sons de batterie Make Music générés par le DAW (aucun fichier, aucun souci
 * de droits) : kicks, 808 accordée, snares, claps, hi-hats, percus, crash.
 *
 * Un son est désigné par une référence :
 *   « synth:<id> »          → généré ici (ex. synth:808, synth:hat-closed)
 *   « synth:808@<midi> »    → 808 accordée sur une note (tonalité du morceau)
 *   « url:<adresse> »        → fichier audio (bibliothèque du studio, plus tard)
 */

export interface DrumSoundInfo { id: string; name: string; category: DrumCategory }
export type DrumCategory = 'kick' | '808' | 'snare' | 'clap' | 'hat-closed' | 'hat-open' | 'perc' | 'cymbal';

export const DRUM_SOUNDS: DrumSoundInfo[] = [
  { id: 'kick-punch', name: 'Kick punchy', category: 'kick' },
  { id: 'kick-boom', name: 'Kick trap', category: 'kick' },
  { id: 'kick-dusty', name: 'Kick boom bap', category: 'kick' },
  { id: '808', name: '808', category: '808' },
  { id: '808-dist', name: '808 saturée', category: '808' },
  { id: 'snare-crisp', name: 'Snare sèche', category: 'snare' },
  { id: 'snare-fat', name: 'Snare grasse', category: 'snare' },
  { id: 'rim', name: 'Rimshot', category: 'snare' },
  { id: 'clap', name: 'Clap', category: 'clap' },
  { id: 'clap-wide', name: 'Clap large', category: 'clap' },
  { id: 'snap', name: 'Claquement de doigts', category: 'clap' },
  { id: 'hat-closed', name: 'Hi-hat fermé', category: 'hat-closed' },
  { id: 'hat-tight', name: 'Hi-hat trap', category: 'hat-closed' },
  { id: 'shaker', name: 'Shaker', category: 'hat-closed' },
  { id: 'hat-open', name: 'Hi-hat ouvert', category: 'hat-open' },
  { id: 'perc-conga', name: 'Conga', category: 'perc' },
  { id: 'perc-log', name: 'Log drum', category: 'perc' },
  { id: 'perc-tom', name: 'Tom', category: 'perc' },
  { id: 'crash', name: 'Crash', category: 'cymbal' },
];

export const soundName = (ref: string) => {
  const id = ref.replace(/^synth:/, '').split('@')[0];
  return DRUM_SOUNDS.find(s => s.id === id)?.name || (ref.startsWith('url:') ? decodeURIComponent(ref.split('/').pop() || 'Sample') : id);
};

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function noise(ctx: BaseAudioContext, dur: number): AudioBufferSourceNode {
  const len = Math.max(1, Math.round(ctx.sampleRate * dur));
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = b; return s;
}

function env(ctx: BaseAudioContext, t: number, peak: number, attack: number, decay: number, curve = 0.0001): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + Math.max(0.0005, attack));
  g.gain.exponentialRampToValueAtTime(curve, t + attack + decay);
  return g;
}

function shaper(ctx: BaseAudioContext, drive: number): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * drive) / Math.tanh(drive); }
  ws.curve = c; return ws;
}

/** Hi-hat : six ondes carrées inharmoniques (comme une 808/909), filtrées. */
function metallic(ctx: BaseAudioContext, out: AudioNode, t: number, dur: number) {
  const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 10000; bp.Q.value = 0.6;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
  bp.connect(hp).connect(out);
  for (const r of ratios) {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 40 * r * 4.4;
    const g = ctx.createGain(); g.gain.value = 0.18;
    o.connect(g).connect(bp); o.start(t); o.stop(t + dur);
  }
  const n = noise(ctx, dur); const ng = ctx.createGain(); ng.gain.value = 0.5; n.connect(ng).connect(bp); n.start(t);
}

async function render(dur: number, sr: number, build: (ctx: OfflineAudioContext, out: GainNode) => void): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.round(sr * dur), sr);
  const out = ctx.createGain(); out.connect(ctx.destination);
  build(ctx, out);
  return ctx.startRendering();
}

/** Catégorie de la bibliothèque → réglage de crête équivalent. */
const LIB_PEAK_ID: Record<string, string> = { hatc: 'hat-closed', hato: 'hat-open', cymbal: 'crash', clap: 'clap', rim: 'rim' };

/** Crête visée par son (dBFS) : kicks / 808 / snares devant, hi-hats plus discrets. */
const PEAK_DB: Record<string, number> = {
  'hat-closed': -9, 'hat-tight': -9, shaker: -11, 'hat-open': -10, crash: -11,
  clap: -4, 'clap-wide': -4, snap: -6, rim: -6,
};

/** Niveau homogène d'un son à l'autre (certains dépassaient 0 dBFS). */
function normalize(buf: AudioBuffer, id: string): AudioBuffer {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a; }
  }
  if (pk <= 0) return buf;
  const g = Math.pow(10, (PEAK_DB[id] ?? -3) / 20) / pk;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return buf;
}

async function synth(id: string, sr: number, root: number): Promise<AudioBuffer> {
  switch (id) {
    case 'kick-punch':
    case 'kick-boom':
    case 'kick-dusty': {
      const boom = id === 'kick-boom', dusty = id === 'kick-dusty';
      return render(boom ? 0.7 : 0.45, sr, (ctx, out) => {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(boom ? 170 : 160, 0);
        o.frequency.exponentialRampToValueAtTime(boom ? 42 : 50, boom ? 0.12 : 0.07);
        const e = env(ctx, 0, 1, 0.001, boom ? 0.6 : dusty ? 0.32 : 0.38);
        const sat = shaper(ctx, dusty ? 3 : 1.6);
        o.connect(e).connect(sat).connect(out); o.start(0); o.stop(0.7);
        const click = noise(ctx, 0.01); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = dusty ? 1500 : 3000;
        const ce = env(ctx, 0, dusty ? 0.25 : 0.4, 0.0005, 0.008); click.connect(hp).connect(ce).connect(out); click.start(0);
        if (dusty) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3500; out.disconnect(); out.connect(lp).connect(ctx.destination); }
      });
    }
    case '808':
    case '808-dist': {
      // Fondamentale dans le grave (≈ 41-65 Hz) : la tonique du morceau.
      let m = root; while (m > 36) m -= 12; while (m < 28) m += 12;
      const f = midiToHz(m + 12);
      return render(1.6, sr, (ctx, out) => {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(f * 2.2, 0);
        o.frequency.exponentialRampToValueAtTime(f, 0.035);
        const e = env(ctx, 0, 1, 0.002, 1.5, 0.001);
        const sat = shaper(ctx, id === '808-dist' ? 4 : 1.8);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = id === '808-dist' ? 2500 : 900;
        o.connect(e).connect(sat).connect(lp).connect(out); o.start(0); o.stop(1.6);
      });
    }
    case 'snare-crisp':
    case 'snare-fat': {
      const fat = id === 'snare-fat';
      return render(0.4, sr, (ctx, out) => {
        const o = ctx.createOscillator(); o.frequency.setValueAtTime(fat ? 200 : 230, 0); o.frequency.exponentialRampToValueAtTime(fat ? 150 : 180, 0.08);
        o.connect(env(ctx, 0, 0.7, 0.001, fat ? 0.16 : 0.1)).connect(out); o.start(0); o.stop(0.3);
        const n = noise(ctx, 0.4); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fat ? 3000 : 5000; bp.Q.value = 0.7;
        n.connect(bp).connect(env(ctx, 0, 0.8, 0.001, fat ? 0.3 : 0.18)).connect(out); n.start(0);
      });
    }
    case 'rim':
      return render(0.12, sr, (ctx, out) => {
        for (const [f, a] of [[1700, 0.5], [420, 0.6]] as const) { const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f; o.connect(env(ctx, 0, a, 0.0005, 0.04)).connect(out); o.start(0); o.stop(0.1); }
        const n = noise(ctx, 0.02); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2000; n.connect(hp).connect(env(ctx, 0, 0.4, 0.0005, 0.015)).connect(out); n.start(0);
      });
    case 'clap':
    case 'clap-wide':
    case 'snap': {
      const snap = id === 'snap';
      return render(snap ? 0.15 : 0.45, sr, (ctx, out) => {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = snap ? 2600 : 1400; bp.Q.value = snap ? 1.5 : 0.9;
        bp.connect(out);
        const bursts = snap ? [0] : [0, 0.011, 0.022];
        bursts.forEach(t => { const n = noise(ctx, 0.03); n.connect(env(ctx, t, 1, 0.0008, 0.012)).connect(bp); n.start(t); });
        const tail = noise(ctx, 0.45); tail.connect(env(ctx, snap ? 0 : 0.03, snap ? 0.8 : 0.7, 0.001, snap ? 0.06 : id === 'clap-wide' ? 0.3 : 0.18)).connect(bp); tail.start(0);
        if (id === 'clap-wide') {
          // élargi : petit décalage gauche / droite
          const split = ctx.createChannelSplitter(2); const merge = ctx.createChannelMerger(2); const dl = ctx.createDelay(); dl.delayTime.value = 0.012;
          out.disconnect(); out.connect(split); split.connect(merge, 0, 0); split.connect(dl, 1); dl.connect(merge, 0, 1); merge.connect(ctx.destination);
        }
      });
    }
    case 'hat-closed':
    case 'hat-tight':
      return render(0.12, sr, (ctx, out) => { const e = env(ctx, 0, id === 'hat-tight' ? 0.55 : 0.5, 0.0005, id === 'hat-tight' ? 0.035 : 0.06); e.connect(out); metallic(ctx, e, 0, 0.12); });
    case 'hat-open':
      return render(0.6, sr, (ctx, out) => { const e = env(ctx, 0, 0.45, 0.001, 0.45, 0.001); e.connect(out); metallic(ctx, e, 0, 0.6); });
    case 'shaker':
      return render(0.15, sr, (ctx, out) => {
        const n = noise(ctx, 0.15); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 6500; bp.Q.value = 1;
        n.connect(bp).connect(env(ctx, 0, 0.5, 0.015, 0.07)).connect(out); n.start(0);
      });
    case 'perc-conga':
    case 'perc-tom':
    case 'perc-log': {
      const tom = id === 'perc-tom', log = id === 'perc-log';
      // Log drum (amapiano) : accordé sur la tonalité, une octave au-dessus de la 808.
      const f = log ? midiToHz(((root % 12) + 12) % 12 + 48) : tom ? 140 : 260;
      return render(log ? 0.5 : 0.35, sr, (ctx, out) => {
        const o = ctx.createOscillator(); o.type = log ? 'triangle' : 'sine';
        o.frequency.setValueAtTime(f * (log ? 1.6 : 1.25), 0); o.frequency.exponentialRampToValueAtTime(f, log ? 0.03 : 0.04);
        const sat = shaper(ctx, log ? 2.5 : 1.2);
        o.connect(env(ctx, 0, 0.9, 0.001, log ? 0.4 : tom ? 0.3 : 0.18)).connect(sat).connect(out); o.start(0); o.stop(0.5);
      });
    }
    case 'crash':
      return render(2.2, sr, (ctx, out) => {
        const e = env(ctx, 0, 0.4, 0.002, 2, 0.001); e.connect(out); metallic(ctx, e, 0, 2.2);
        const n = noise(ctx, 2.2); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000; n.connect(hp).connect(env(ctx, 0, 0.3, 0.002, 1.8, 0.001)).connect(out); n.start(0);
      });
    default:
      return render(0.1, sr, () => { /* silence */ });
  }
}

const cache = new Map<string, Promise<AudioBuffer>>();

/**
 * Buffer d'un son de batterie. `root` = tonique du morceau (0-11 ou MIDI),
 * utilisée par la 808 et le log drum.
 */
export function loadDrumSound(ref: string, ctx: BaseAudioContext, root = 0): Promise<AudioBuffer> {
  const sr = ctx.sampleRate;
  const id = ref.replace(/^synth:/, '').split('@')[0];
  const tuned = id.startsWith('808') || id === 'perc-log';
  const key = `${ref}|${sr}|${tuned ? root : ''}`;
  let p = cache.get(key);
  if (!p) {
    p = ref.startsWith('url:')
      ? fetch(ref.slice(4)).then(r => { if (!r.ok) throw new Error(`son introuvable (${r.status})`); return r.arrayBuffer(); })
          .then(b => ctx.decodeAudioData(b)).then(b => normalize(b, LIB_PEAK_ID[(/\/([a-z]+)-[0-9a-f]{8}\.wav$/.exec(ref) || [])[1] || ''] || 'sample'))
      : synth(id, sr, root).then(b => normalize(b, id));
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
