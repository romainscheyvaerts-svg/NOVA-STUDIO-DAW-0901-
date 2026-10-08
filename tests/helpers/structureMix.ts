import { Track, TrackType } from '../../types';
import { engineView, VOID_OUTPUT } from '../../utils/trackStructure';

/**
 * Mixeur de référence pour les tests (Node, sans Web Audio) : propage une
 * impulsion d'amplitude donnée par piste source dans le graphe RÉELLEMENT
 * joué (engineView) avec les mêmes règles que le moteur :
 *  - entrée forcée en stéréo (une source mono vaut L = R) ;
 *  - fader (muet / solo), pan = StereoPannerNode (formule de la spec Web Audio) ;
 *  - sortie vers la piste de destination, le master, ou le vide ;
 *  - envois : post-fader après le pan (ou avant le pan avec un pan propre),
 *    pré-fader après les effets ; mute = 0 ; pan propre = StereoPannerNode.
 * Les effets valent 1 (le test mesure le routage, pas le traitement).
 * Renvoie le niveau [L, R] arrivé au master.
 */
export type Stereo = [number, number];

/** StereoPannerNode sur une entrée stéréo (spec Web Audio). */
export const stereoPan = ([l, r]: Stereo, pan: number): Stereo => {
  const p = Math.max(-1, Math.min(1, pan || 0));
  if (p <= 0) {
    const x = p + 1;
    return [l + r * Math.cos(x * Math.PI / 2), r * Math.sin(x * Math.PI / 2)];
  }
  const x = p;
  return [l * Math.cos(x * Math.PI / 2), r + l * Math.sin(x * Math.PI / 2)];
};

const add = (a: Stereo, b: Stereo): Stereo => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Stereo, g: number): Stereo => [a[0] * g, a[1] * g];

const isSource = (t: Track) => t.type === TrackType.AUDIO || t.type === TrackType.MIDI || t.type === TrackType.SAMPLER || t.type === TrackType.DRUM_RACK;

/** Même règle de solo que le moteur (computeSoloSilencedIds). */
const soloSilenced = (tracks: Track[]): Set<string> => {
  const audible = new Set(tracks.filter(t => t.isSolo).map(t => t.id));
  if (!audible.size) return new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tracks) {
      if (audible.has(t.id)) continue;
      const feeds = (!!t.outputTrackId && audible.has(t.outputTrackId)) || (t.sends || []).some(s => s.isEnabled && !s.isMuted && s.level > 0 && audible.has(s.id));
      if (feeds) { audible.add(t.id); changed = true; }
    }
  }
  return new Set(tracks.filter(t => isSource(t) && !audible.has(t.id)).map(t => t.id));
};

export function mixImpulse(state: Track[], sources: Record<string, number>): { master: Stereo; inputs: Record<string, Stereo> } {
  const view = engineView(state);
  const tracks = view.tracks;
  const byId = view.byId;
  const silenced = soloSilenced(tracks);
  const inputs: Record<string, Stereo> = {};
  for (const t of tracks) inputs[t.id] = [0, 0];
  for (const [id, a] of Object.entries(sources)) if (inputs[id]) inputs[id] = add(inputs[id], [a, a]);
  let master: Stereo = [0, 0];
  // Ordre : on traite une piste quand tout ce qui l'alimente est traité.
  const mainDest = (t: Track): string => (t.id === 'master' || t.outputTrackId === VOID_OUTPUT ? '' : t.outputTrackId && byId.has(t.outputTrackId) ? t.outputTrackId : 'master');
  const feeds = (t: Track): string[] => [mainDest(t), ...(t.sends || []).filter(s => s.isEnabled).map(s => s.id)].filter(d => byId.has(d) && d !== t.id);
  const pending = new Map<string, number>();
  for (const t of tracks) pending.set(t.id, 0);
  for (const t of tracks) for (const d of feeds(t)) pending.set(d, (pending.get(d) || 0) + 1);
  const ready = tracks.filter(t => !pending.get(t.id)).map(t => t.id);
  const done = new Set<string>();
  while (ready.length) {
    const id = ready.shift()!;
    if (done.has(id)) continue;
    done.add(id);
    const t = byId.get(id)!;
    const pre = inputs[id];
    const off = t.isMuted || silenced.has(id);
    const post = mul(pre, off ? 0 : t.volume);
    const main = stereoPan(post, t.pan);
    const out = t.outputTrackId;
    if (t.id === 'master') master = add(master, main);
    else if (out === VOID_OUTPUT) { /* dans le vide */ } else if (out && out !== 'master' && byId.has(out) && out !== t.id) inputs[out] = add(inputs[out], main);
    else if (byId.has('master') && t.id !== 'master') inputs['master'] = add(inputs['master'], main);
    else master = add(master, main);
    for (const s of t.sends || []) {
      if (!s.isEnabled || !byId.has(s.id) || s.id === t.id) continue;
      const own = typeof s.pan === 'number';
      const src = s.preFader ? mul(pre, off ? 0 : 1) : own ? post : main;
      let sig = mul(src, s.isMuted ? 0 : s.level);
      if (own) sig = stereoPan(sig, s.pan!);
      inputs[s.id] = add(inputs[s.id], sig);
    }
    for (const d of feeds(t)) { const n = (pending.get(d) || 1) - 1; pending.set(d, n); if (n <= 0) ready.push(d); }
  }
  return { master, inputs };
}
