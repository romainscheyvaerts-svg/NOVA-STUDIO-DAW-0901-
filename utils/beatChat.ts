/**
 * Lot 10 · Le chatbot ingé son et les commandes locales (sans IA) pour « Démarrer un beat » et
 * « Prolonger / Varier » : validation des appels (utils/chatTools) et phrases comprises hors
 * ligne (utils/novaCommands). Les notes restent écrites par des RÈGLES (utils/beatStarter, patternVary).
 */
import type { AIAction, DAWState } from '../types';
import { BEAT_GENRES, genreFromText, genreRecipe } from './beatRecipes';
import { varyRuleOf, VARY_RULES } from './patternVary';
import { NOTE_NAMES_FR } from './scales';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const NOTE_FR = ['do', 'do#', 're', 're#', 'mi', 'fa', 'fa#', 'sol', 'sol#', 'la', 'la#', 'si'];
const NOTE_EN = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLATS: Record<string, number> = { 'reb': 1, 'mib': 3, 'solb': 6, 'lab': 8, 'sib': 10, 'db': 1, 'eb': 3, 'gb': 6, 'ab': 8, 'bb': 10 };

/** Tonalité lue dans une phrase : « en fa mineur », « F#m », « la majeur », « en sol ». */
export function keyFromText(t: string): { root: number; mode: 'minor' | 'major' | null } | null {
  const s = fold(t).replace(/\s*(diese|sharp)\b/g, '#').replace(/\s*(bemol|flat)\b/g, 'b');
  const m = /\b(?:en|in|tonalite|key)\s+(do|re|mi|fa|sol|la|si|[a-g])(#|b)?(?:\s*(mineur|majeur|minor|major|min|maj|m))?(?![a-z#])/.exec(s)
    || /\b(do|re|mi|fa|sol|la|si)(#|b)?\s+(mineur|majeur|minor|major)\b/.exec(s)
    || /\b([a-g])(#|b)?(m|min)\b/.exec(s);
  if (!m) return null;
  const base = m[1], acc = m[2] || '';
  let root = FLATS[base + acc];
  if (root === undefined) {
    const i = (base.length > 1 ? NOTE_FR : NOTE_EN).indexOf(base + (acc === '#' ? '#' : ''));
    if (i < 0) return null;
    root = i;
  }
  const q = m[3] || '';
  const mode = /^(m|min|mineur|minor)$/.test(q) ? 'minor' : /^(maj|majeur|major)$/.test(q) ? 'major' : null;
  return { root: ((root % 12) + 12) % 12, mode };
}

export interface BeatCallCheck { ok: boolean; label?: string; reason?: string }

/** Valide START_BEAT / VARY_MIDI (le payload est normalisé sur place). */
export function checkBeatCall(name: string, p: Record<string, any>, st: DAWState): BeatCallCheck {
  if (name === 'START_BEAT') {
    const g = genreFromText(String(p.genre || p.style || ''));
    if (!g) return { ok: false, reason: `genre « ${p.genre || '?'} » inconnu (${BEAT_GENRES.map(x => x.name).join(', ')})` };
    p.genre = g;
    if (typeof p.key === 'string' && p.root === undefined) {
      const k = keyFromText(`en ${p.key}`);
      if (k) { p.root = k.root; if (k.mode && !p.mode) p.mode = k.mode; }
    }
    if (p.root !== undefined) {
      const r = Number(p.root);
      if (!Number.isFinite(r)) return { ok: false, reason: 'tonalité illisible' };
      p.root = ((Math.round(r) % 12) + 12) % 12;
    }
    if (p.mode !== undefined && p.mode !== 'minor' && p.mode !== 'major') delete p.mode;
    if (p.variant !== undefined) p.variant = Math.max(0, Math.min(2, Math.round(Number(p.variant)) || 0));
    const gr = genreRecipe(g);
    const key = typeof p.root === 'number' ? ` en ${NOTE_NAMES_FR[p.root]}${p.mode === 'major' ? ' majeur' : p.mode === 'minor' ? ' mineur' : ''}` : '';
    return { ok: true, label: `Squelette ${gr.name}${key} : batterie, accords et 808 (règles, sans IA)` };
  }
  if (name === 'VARY_MIDI') {
    const mode = /prolong|extend|allong/.test(fold(String(p.mode || ''))) ? 'prolonger' : 'varier';
    p.mode = mode;
    const rule = varyRuleOf(fold(String(p.rule || 'rythme')).replace(/[^a-z]/g, '')) || 'rythme';
    p.rule = rule;
    if (mode === 'prolonger') p.bars = [1, 2, 4, 8].includes(Number(p.bars)) ? Number(p.bars) : 4;
    if (p.trackId !== undefined && !st.tracks.some(t => t.id === p.trackId)) return { ok: false, reason: `piste « ${p.trackId} » introuvable` };
    const rl = VARY_RULES.find(r => r.id === rule)!.label.toLowerCase();
    return { ok: true, label: mode === 'prolonger' ? `Clip MIDI prolongé de ${p.bars} mesure${p.bars > 1 ? 's' : ''} (${rl})` : `Variation « ${rl} » du clip MIDI` };
  }
  return { ok: false, reason: 'action inconnue' };
}

/**
 * Phrases comprises SANS l'IA : « démarre un beat drill en fa mineur », « lance une prod trap »,
 * « prolonge le clip de 4 mesures », « varie la mélodie (inversion) ».
 */
export function parseBeatCommand(raw: string): { text: string; actions: AIAction[] } | null {
  const msg = fold(raw);
  const start = /\b(demarre|lance|commence|cree|fais|fait|pose)\w*\b.*\b(beat|prod|instru|squelette)\b/.test(msg) || /\bdemarrer un beat\b/.test(msg);
  if (start) {
    const genre = genreFromText(msg);
    if (!genre) return { text: '🎲 J’ouvre « Démarrer un beat » : choisis le genre, la tonalité et une des 3 variantes.', actions: [{ action: 'RUN_COMMAND', payload: { id: 'pal.startBeat' } } as AIAction] };
    const k = keyFromText(msg);
    const payload: Record<string, unknown> = { genre, ...(k ? { root: k.root, ...(k.mode ? { mode: k.mode } : {}) } : {}) };
    return { text: `🎲 Je pose un squelette ${genreRecipe(genre).name}${k ? ` en ${NOTE_NAMES_FR[k.root]}${k.mode === 'major' ? ' majeur' : k.mode === 'minor' ? ' mineur' : ''}` : ''} : batterie, accords et 808, à base de règles (Ctrl+Z pour annuler).`, actions: [{ action: 'START_BEAT', payload } as AIAction] };
  }
  const ext = /\b(prolonge|allonge|etends|extend)\w*\b/.test(msg) && /\b(clip|melodie|boucle|motif|midi|mesures?)\b/.test(msg);
  const vary = /\b(varie|variation|recompose|change le rythme|inverse)\w*\b/.test(msg) && /\b(clip|melodie|motif|midi|notes?|accords?)\b/.test(msg);
  if (ext || vary) {
    const bars = Number(/\b(1|2|4|8)\s*mesures?\b/.exec(msg)?.[1]) || 4;
    const rule = /invers/.test(msg) ? 'inversion' : /decal|deplac/.test(msg) ? 'deplacement' : /transpos|monte|descend/.test(msg) ? 'transposition' : 'rythme';
    return {
      text: ext ? `➕ Je prolonge le clip MIDI sélectionné de ${bars} mesure${bars > 1 ? 's' : ''}, en variant une reprise sur deux.` : `🔀 Je varie le clip MIDI sélectionné (${rule}), les notes restent dans la gamme.`,
      actions: [{ action: 'VARY_MIDI', payload: { mode: ext ? 'prolonger' : 'varier', rule, ...(ext ? { bars } : {}) } } as AIAction],
    };
  }
  return null;
}
