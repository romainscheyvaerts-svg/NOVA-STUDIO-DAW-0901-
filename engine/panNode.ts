/**
 * Panoramique de piste à la loi de pan du projet (22/10/2026), en nœuds Web Audio natifs :
 * même code en lecture et à l'export (OfflineAudioContext), rien d'asynchrone à charger.
 *
 *   entrée (2 canaux, mono recopié) → séparateur → 4 gains (matrice 2×2) → fusion → sortie
 *
 * Chaque gain de la matrice est piloté à la fréquence audio par la position : une source
 * constante (`pan`, `panR` = AudioParam, automatisables comme avant) passe dans une table
 * (WaveShaper) qui donne le gain de la loi. Aux positions de la table (pas de 1/2048 : bords,
 * centre, ±0,5…) la valeur est exacte ; entre deux, l'écart est sous 1e-7.
 *
 *  - « mono »   : un pan (`pan`) ; matrice utils/panLaw · monoMatrix (loi exacte sur une source mono).
 *  - « stereo » : double pan, canal gauche en `pan`, canal droit en `panR` (stereoMatrix).
 *                 G = −1, D = +1 : gains 1 et 0 exacts, le son passe bit à bit.
 *  - « neutral »: matrice identité (rendus pré-fader / pré-pan).
 */
import { monoMatrix, panGains, type PanLaw, type PanMatrix, DEFAULT_PAN_LAW } from '../utils/panLaw';

export type PanMode = 'mono' | 'stereo' | 'neutral';
type Coef = keyof PanMatrix;
const COEFS: Coef[] = ['ll', 'rl', 'lr', 'rr'];

/** Points de la table : impair (centre exact), pas de 2/4096 sur −1…1. */
export const PAN_TABLE_SIZE = 4097;

const tables = new Map<string, Float32Array>();
function table(mode: PanMode, law: PanLaw, coef: Coef): Float32Array {
  const key = `${mode}|${law}|${coef}`;
  let t = tables.get(key);
  if (t) return t;
  if (mode === 'neutral') {
    const v = coef === 'll' || coef === 'rr' ? 1 : 0;
    t = new Float32Array([v, v]);
  } else {
    t = new Float32Array(PAN_TABLE_SIZE);
    for (let i = 0; i < PAN_TABLE_SIZE; i++) {
      const p = i === (PAN_TABLE_SIZE - 1) / 2 ? 0 : -1 + (2 * i) / (PAN_TABLE_SIZE - 1);
      if (mode === 'mono') t[i] = monoMatrix(p, law)[coef];
      else {
        // Double pan : ll / lr = canal gauche placé en p ; rl / rr = canal droit placé en p.
        const [g, d] = panGains(p, law);
        t[i] = coef === 'll' || coef === 'rl' ? g : d;
      }
    }
  }
  tables.set(key, t);
  return t;
}

export class NovaPanner {
  readonly input: GainNode;
  readonly output: ChannelMergerNode;
  /** Pan (piste mono) ou position du canal GAUCHE (piste stéréo). */
  readonly pan: AudioParam;
  /** Position du canal DROIT (piste stéréo). */
  readonly panR: AudioParam;
  private split: ChannelSplitterNode;
  private gains: Record<Coef, GainNode>;
  private shapers: Record<Coef, WaveShaperNode>;
  private srcL: ConstantSourceNode;
  private srcR: ConstantSourceNode;
  private _mode: PanMode | null = null;
  private _law: PanLaw = DEFAULT_PAN_LAW;

  constructor(ctx: BaseAudioContext, mode: PanMode = 'mono', law: PanLaw = DEFAULT_PAN_LAW, at = 0) {
    this.input = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers'; // source mono : recopiée sur les deux canaux
    this.split = ctx.createChannelSplitter(2);
    this.output = ctx.createChannelMerger(2);
    this.input.connect(this.split);
    this.srcL = ctx.createConstantSource();
    this.srcR = ctx.createConstantSource();
    this.srcL.offset.value = 0;
    this.srcR.offset.value = 1;
    this.pan = this.srcL.offset;
    this.panR = this.srcR.offset;
    this.gains = {} as Record<Coef, GainNode>;
    this.shapers = {} as Record<Coef, WaveShaperNode>;
    for (const c of COEFS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      const s = ctx.createWaveShaper();
      s.connect(g.gain);
      this.gains[c] = g; this.shapers[c] = s;
    }
    // Entrée G → ll (sortie G) et lr (sortie D) ; entrée D → rl et rr.
    this.split.connect(this.gains.ll, 0); this.split.connect(this.gains.lr, 0);
    this.split.connect(this.gains.rl, 1); this.split.connect(this.gains.rr, 1);
    this.gains.ll.connect(this.output, 0, 0); this.gains.rl.connect(this.output, 0, 0);
    this.gains.lr.connect(this.output, 0, 1); this.gains.rr.connect(this.output, 0, 1);
    this.srcL.connect(this.shapers.ll); this.srcL.connect(this.shapers.lr);
    this.setFormat(mode, law);
    try { this.srcL.start(at); this.srcR.start(at); } catch { /* déjà démarrées */ }
  }

  get mode(): PanMode { return this._mode || 'mono'; }
  get law(): PanLaw { return this._law; }

  /** Change le format (mono / stéréo / neutre) ou la loi : tables et câblage du canal droit. */
  setFormat(mode: PanMode, law: PanLaw): void {
    if (mode === this._mode && law === this._law) return;
    const wasStereo = this._mode === 'stereo';
    const stereo = mode === 'stereo';
    if (this._mode === null || wasStereo !== stereo) {
      const from = stereo ? this.srcR : this.srcL;
      const other = stereo ? this.srcL : this.srcR;
      for (const c of ['rl', 'rr'] as Coef[]) {
        try { other.disconnect(this.shapers[c]); } catch { /* pas branché */ }
        from.connect(this.shapers[c]);
      }
    }
    for (const c of COEFS) this.shapers[c].curve = table(mode, law, c);
    this._mode = mode;
    this._law = law;
  }

  connect(dest: any, output = 0, input = 0): any {
    // AudioParam (setValueAtTime) : pas d'entrée à préciser.
    return dest && typeof dest.setValueAtTime === 'function' ? this.output.connect(dest, output) : this.output.connect(dest, output, input);
  }

  disconnect(dest?: any): void {
    if (dest === undefined) this.output.disconnect();
    else this.output.disconnect(dest);
  }

  /** Arrête les sources et défait tout (piste supprimée). */
  dispose(): void {
    try { this.srcL.stop(); this.srcR.stop(); } catch { /* */ }
    const all: AudioNode[] = [this.input, this.split, this.output, this.srcL, this.srcR, ...COEFS.map(c => this.gains[c]), ...COEFS.map(c => this.shapers[c])];
    for (const n of all) { try { n.disconnect(); } catch { /* */ } }
  }
}
