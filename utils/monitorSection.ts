import { useSyncExternalStore } from 'react';

/**
 * Section d'écoute (« control room ») : ce que l'ingé ENTEND, jamais ce qui est
 * exporté. Comme la section monitoring d'une console ou le Control Room d'un
 * séquenceur pro : mono, côtés seuls, Dim, coupure et volume d'écoute, plus le
 * mode de solo (solo dans le mix, AFL, PFL).
 *
 * Câblage (engine/AudioEngine) : master → limiteur de sécurité → mètres →
 * [mix ou bus d'écoute solo] → matrice → volume / Dim / coupure → sortie de
 * l'ordinateur et carte ASIO. L'export (renderProject) n'a pas cette section :
 * aucun réglage d'ici ne peut changer un fichier exporté.
 *
 * ── Somme mono à −6 dB : L' = R' = (G + D) / 2 ─────────────────────────────
 * Choix voulu (et pas −3 dB) :
 *  - un son au centre (voix, kick, basse : G = D) garde EXACTEMENT son niveau
 *    quand on passe en mono ; ce qu'on entend baisser ou disparaître est donc un
 *    vrai défaut de phase / de largeur, pas un saut de niveau du bouton ;
 *  - c'est le « M » de la matrice milieu / côtés (M = (G + D) / 2), le même que
 *    la tête de tranche (engine/meters/channelStrip) et le corrélateur ;
 *  - c'est ce que fait un appareil mono qui additionne les deux canaux sans
 *    saturer (téléphone, enceinte Bluetooth, mixage mono en diffusion).
 * Le −3 dB est une loi de panoramique (sources décorrélées), pas une somme de
 * contrôle : avec lui, un son centré monterait de 3 dB en mono et masquerait les
 * pertes de phase qu'on cherche justement à entendre.
 * « Côtés » (S) : (G − D) / 2 dans les deux enceintes, ce que la somme mono jette.
 *
 * Réglages du poste (stockés localement, jamais dans le projet ni envoyés en
 * collaboration) : le mode de solo et le volume d'écoute sont gardés ; mono,
 * côtés, Dim et coupure repartent à zéro à chaque ouverture, pour ne jamais
 * rester coincés sans qu'on s'en souvienne.
 */

export type MonitorMatrix = 'stereo' | 'mono' | 'side';
/** Solo dans le mix (« solo in place »), écoute après fader (AFL), avant fader (PFL). */
export type SoloListen = 'sip' | 'afl' | 'pfl';

export interface MonitorState {
  matrix: MonitorMatrix;
  /** Dim : écoute baissée de DIM_DB. */
  dim: boolean;
  /** Écoute coupée. */
  cut: boolean;
  /** Volume d'écoute (dB), séparé du fader master. */
  volumeDb: number;
}

export const DIM_DB = -20;
export const MONITOR_VOL_MIN_DB = -60;
export const MONITOR_VOL_MAX_DB = 6;
export const NEUTRAL_MONITOR: MonitorState = { matrix: 'stereo', dim: false, cut: false, volumeDb: 0 };

export const dbToGain = (db: number) => Math.pow(10, db / 20);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const clampMonitorDb = (db: number) => (Number.isFinite(db) ? clamp(Math.round(db * 10) / 10, MONITOR_VOL_MIN_DB, MONITOR_VOL_MAX_DB) : 0);

/**
 * Coefficients de la matrice : L' = ll·G + rl·D ; R' = lr·G + rr·D.
 */
export function monitorCoefs(m: MonitorMatrix): { ll: number; rl: number; lr: number; rr: number } {
  if (m === 'mono') return { ll: 0.5, rl: 0.5, lr: 0.5, rr: 0.5 };
  if (m === 'side') return { ll: 0.5, rl: -0.5, lr: 0.5, rr: -0.5 };
  return { ll: 1, rl: 0, lr: 0, rr: 1 };
}

/** Gain final de l'écoute : volume, Dim, coupure. */
export function monitorGain(s: MonitorState): number {
  if (s.cut) return 0;
  return dbToGain(clampMonitorDb(s.volumeDb) + (s.dim ? DIM_DB : 0));
}

/** Matrice + gain appliqués à deux canaux (module pur : tests et vérifications). */
export function applyMonitor(l: Float32Array, r: Float32Array, s: MonitorState): [Float32Array, Float32Array] {
  const c = monitorCoefs(s.matrix);
  const g = monitorGain(s);
  const n = Math.min(l.length, r.length);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = g * (c.ll * l[i] + c.rl * r[i]);
    R[i] = g * (c.lr * l[i] + c.rr * r[i]);
  }
  return [L, R];
}

export const isMonitorNeutral = (s: MonitorState) => s.matrix === 'stereo' && !s.dim && !s.cut && Math.abs(clampMonitorDb(s.volumeDb)) < 0.05;

/** Pastilles à afficher tant qu'un réglage d'écoute est actif (pour ne jamais l'oublier). */
export function monitorBadges(s: MonitorState, listen: SoloListen, listening: boolean): { id: string; text: string; title: string }[] {
  const out: { id: string; text: string; title: string }[] = [];
  if (s.cut) out.push({ id: 'cut', text: 'ÉCOUTE COUPÉE', title: "L'écoute est coupée (rien ne sort). L'export n'est pas touché." });
  if (s.matrix === 'mono') out.push({ id: 'mono', text: 'MONO', title: "Écoute en mono (G + D, −6 dB). L'export reste en stéréo." });
  if (s.matrix === 'side') out.push({ id: 'side', text: 'CÔTÉS', title: "Écoute des côtés seuls (G − D) : ce que le mono fait disparaître. L'export n'est pas touché." });
  if (s.dim) out.push({ id: 'dim', text: `DIM ${DIM_DB}`, title: `Écoute baissée de ${-DIM_DB} dB (Dim). L'export n'est pas touché.` });
  if (!s.cut && Math.abs(clampMonitorDb(s.volumeDb)) >= 0.05) {
    const v = clampMonitorDb(s.volumeDb);
    out.push({ id: 'vol', text: `ÉCOUTE ${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} dB`, title: "Volume d'écoute (séparé du master) : l'export n'est pas touché." });
  }
  if (listen !== 'sip' && listening) out.push({ id: listen, text: listen.toUpperCase(), title: listen === 'afl'
    ? "Écoute AFL : tu entends les pistes en solo après leur fader, seules ; le mix et l'export ne changent pas."
    : "Écoute PFL : tu entends les pistes en solo avant leur fader, seules ; le mix et l'export ne changent pas." });
  return out;
}

export const SOLO_LISTEN_LABEL: Record<SoloListen, string> = {
  sip: 'Solo dans le mix',
  afl: 'AFL (après fader)',
  pfl: 'PFL (avant fader)',
};
export const SOLO_LISTEN_HELP: Record<SoloListen, string> = {
  sip: 'Solo classique : les autres pistes se taisent, les bus et retours d’effet qui reçoivent la piste restent audibles. Solo safe respecté.',
  afl: 'Écoute après fader : seules les pistes en solo, avec leur volume et leur panoramique, sans couper le mix (l’export ne change jamais). Solo un retour de réverbe pour l’entendre aussi.',
  pfl: 'Écoute avant fader : seules les pistes en solo, au niveau de leurs effets, avant volume, panoramique et muet (vérifier une piste coupée avant de la remonter). L’export ne change jamais.',
};

// ── Magasin (réglages du poste) ─────────────────────────────────────────────

const KEY_LISTEN = 'nova_solo_listen';
const KEY_VOL = 'nova_monitor_volume_db';

const readListen = (): SoloListen => {
  try { const v = localStorage.getItem(KEY_LISTEN); return v === 'afl' || v === 'pfl' ? v : 'sip'; } catch { return 'sip'; }
};
const readVol = (): number => {
  try { const v = parseFloat(localStorage.getItem(KEY_VOL) || ''); return Number.isFinite(v) ? clampMonitorDb(v) : 0; } catch { return 0; }
};

export interface MonitorSnapshot extends MonitorState { listen: SoloListen }

let snap: MonitorSnapshot = { ...NEUTRAL_MONITOR, volumeDb: readVol(), listen: readListen() };
const subs = new Set<() => void>();

export const monitorStore = {
  get: (): MonitorSnapshot => snap,
  set(patch: Partial<MonitorSnapshot>) {
    const next: MonitorSnapshot = { ...snap, ...patch };
    if (patch.volumeDb !== undefined) next.volumeDb = clampMonitorDb(patch.volumeDb);
    if (next.listen !== 'afl' && next.listen !== 'pfl') next.listen = 'sip';
    if (next.matrix !== 'mono' && next.matrix !== 'side') next.matrix = 'stereo';
    next.dim = !!next.dim; next.cut = !!next.cut;
    if (next.matrix === snap.matrix && next.dim === snap.dim && next.cut === snap.cut && next.volumeDb === snap.volumeDb && next.listen === snap.listen) return;
    const listenChanged = next.listen !== snap.listen;
    const volChanged = next.volumeDb !== snap.volumeDb;
    snap = next;
    try {
      if (listenChanged) localStorage.setItem(KEY_LISTEN, snap.listen);
      if (volChanged) localStorage.setItem(KEY_VOL, String(snap.volumeDb));
    } catch { /* stockage indisponible */ }
    subs.forEach(f => f());
  },
  /** Mono ⇄ stéréo (raccourci). Depuis « côtés », revient en stéréo. */
  toggleMono() { monitorStore.set({ matrix: snap.matrix === 'mono' ? 'stereo' : 'mono' }); },
  toggleSide() { monitorStore.set({ matrix: snap.matrix === 'side' ? 'stereo' : 'side' }); },
  toggleDim() { monitorStore.set({ dim: !snap.dim }); },
  toggleCut() { monitorStore.set({ cut: !snap.cut }); },
  /** Tout remettre à zéro (sauf le mode de solo, réglage du poste). */
  reset() { monitorStore.set({ ...NEUTRAL_MONITOR }); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  /** Tests : relit le stockage et remet l'écoute à zéro. */
  reload() { snap = { ...NEUTRAL_MONITOR, volumeDb: readVol(), listen: readListen() }; subs.forEach(f => f()); },
};

export const useMonitor = (): MonitorSnapshot => useSyncExternalStore(monitorStore.subscribe, monitorStore.get, monitorStore.get);
