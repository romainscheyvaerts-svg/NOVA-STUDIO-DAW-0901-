/**
 * Palette de commandes (Ctrl+K) : chercher n'importe quelle action par son nom,
 * comme VS Code (Ctrl+Maj+P), Logic (Commandes rapides) ou Ableton (Ctrl+K dans Live 12).
 *
 * Deux sources :
 * - les actions du studio (fenêtres, pistes, vues…) fournies par App.tsx ;
 * - TOUS les raccourcis de la table active (utils/keymap + remappages) : la palette les
 *   rejoue (commande d'édition directe, sinon la combinaison de touches), donc chaque
 *   nouvelle commande ajoutée à la table y apparaît sans rien câbler.
 * La recherche ignore accents et casse, accepte plusieurs mots dans n'importe quel ordre,
 * le nom Pro Tools (« Separate », « Strip Silence »…) et les touches (« ctrl+e »).
 */
import { activeKeymap, chordLabel, type ShortcutDef } from './keymap';
import { runEditCommand, type EditCommandId } from './editCommands';

export interface PaletteAction {
  id: string;
  label: string;
  /** Rubrique affichée à droite (Fenêtres, Pistes, Édition…). */
  group: string;
  /** Mots en plus pour la recherche (synonymes, nom anglais / Pro Tools). */
  keywords?: string;
  /** Touches affichées (libellé lisible), si l'action a un raccourci. */
  keys?: string;
  /** Équivalent Pro Tools (infobulle). */
  pt?: string;
  /** Pourquoi l'action est grisée (« sélectionne un clip d'abord »…) ; absente = disponible. */
  disabledReason?: string;
  run: () => void;
}

export const normText = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const RECENT_KEY = 'nova_palette_recent';
export const recentActions = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 8) : []; } catch { return []; }
};
export const rememberAction = (id: string) => {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentActions().filter(x => x !== id)].slice(0, 8))); } catch { /* stockage indisponible */ }
};

/**
 * Classement : tous les mots doivent se trouver (libellé, mots-clés, rubrique, Pro Tools,
 * touches). Bonus : libellé qui commence par la recherche, mot du libellé qui commence par
 * un mot cherché, action récente. Sans recherche : récentes d'abord, puis l'ordre donné.
 */
export function searchActions(query: string, actions: PaletteAction[], recent: string[] = []): PaletteAction[] {
  const words = normText(query).split(/\s+/).filter(Boolean);
  const rank = (a: PaletteAction) => { const i = recent.indexOf(a.id); return i < 0 ? 0 : 20 - i; };
  if (!words.length) {
    return [...actions].map((a, i) => ({ a, i, s: rank(a) })).sort((x, y) => y.s - x.s || x.i - y.i).map(x => x.a);
  }
  const q = words.join(' ');
  const out: { a: PaletteAction; s: number; i: number }[] = [];
  actions.forEach((a, i) => {
    const label = normText(a.label);
    const hay = `${label} ${normText(a.keywords || '')} ${normText(a.group)} ${normText(a.pt || '')} ${normText(a.keys || '')}`;
    if (!words.every(w => hay.includes(w))) return;
    let s = 0;
    if (label.startsWith(q)) s += 50;
    else if (label.includes(q)) s += 25;
    const lw = label.split(/[\s'’(),:/·«»-]+/).filter(Boolean);
    for (const w of words) {
      const at = lw.findIndex(x => x.startsWith(w));
      // Mot du libellé qui commence par le mot cherché, d'autant plus fort qu'il vient tôt
      // (« bus » : « Nouveau bus » avant « Exporter … par bus »).
      if (at >= 0) s += 10 + Math.max(0, 8 - at * 2) + (lw[at] === w ? 4 : 0);
    }
    if (words.every(w => label.includes(w))) s += 8;
    if (a.disabledReason) s -= 5;
    // Récente : départage seulement (une action récente ne passe pas devant une meilleure réponse).
    s += Math.min(3, rank(a) / 6);
    // Libellés courts d'abord à score égal (« Exporter » avant « Exporter les stems par bus »).
    s -= label.length / 200;
    out.push({ a, s, i });
  });
  return out.sort((x, y) => y.s - x.s || x.i - y.i).map(x => x.a);
}

// --- Rejouer une combinaison de touches ------------------------------------------------
const NAMED: Record<string, { key: string; code: string }> = {
  space: { key: ' ', code: 'Space' }, escape: { key: 'Escape', code: 'Escape' }, enter: { key: 'Enter', code: 'Enter' },
  home: { key: 'Home', code: 'Home' }, end: { key: 'End', code: 'End' }, delete: { key: 'Delete', code: 'Delete' },
  backspace: { key: 'Backspace', code: 'Backspace' }, tab: { key: 'Tab', code: 'Tab' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' }, arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
  numenter: { key: 'Enter', code: 'NumpadEnter' }, numadd: { key: '+', code: 'NumpadAdd' }, numsub: { key: '-', code: 'NumpadSubtract' },
  numdec: { key: '.', code: 'NumpadDecimal' }, nummul: { key: '*', code: 'NumpadMultiply' }, numdiv: { key: '/', code: 'NumpadDivide' },
  plus: { key: '+', code: 'Equal' }, '-': { key: '-', code: 'Minus' }, '_': { key: '_', code: 'Minus' }, '=': { key: '=', code: 'Equal' },
  '[': { key: '[', code: 'BracketLeft' }, ']': { key: ']', code: 'BracketRight' }, '\\': { key: '\\', code: 'Backslash' },
  ';': { key: ';', code: 'Semicolon' }, "'": { key: "'", code: 'Quote' }, '`': { key: '`', code: 'Backquote' },
  ',': { key: ',', code: 'Comma' }, '.': { key: '.', code: 'Period' }, '/': { key: '/', code: 'Slash' }, '?': { key: '?', code: 'Slash' },
  ':': { key: ':', code: 'Period' }, '<': { key: '<', code: 'IntlBackslash' },
};

/** « ctrl+shift+e » → propriétés d'un KeyboardEvent (touche, code physique, modificateurs). */
export function chordToEventInit(chord: string): KeyboardEventInit | null {
  const parts = chord.split('+');
  // « ctrl++ » n'existe pas dans la table (« plus ») : le dernier morceau est la touche.
  const k = parts[parts.length - 1];
  if (!k) return null;
  const mods = new Set(parts.slice(0, -1));
  const shiftKey = mods.has('shift');
  let key: string; let code: string;
  if (/^[a-z]$/.test(k)) { key = shiftKey ? k.toUpperCase() : k; code = `Key${k.toUpperCase()}`; }
  else if (/^\d$/.test(k)) { key = k; code = `Digit${k}`; }
  else if (/^num\d$/.test(k)) { key = k.slice(3); code = `Numpad${k.slice(3)}`; }
  else if (/^f\d{1,2}$/.test(k)) { key = k.toUpperCase(); code = key; }
  else if (NAMED[k]) ({ key, code } = NAMED[k]);
  else return null;
  return { key, code, ctrlKey: mods.has('ctrl'), altKey: mods.has('alt'), shiftKey, metaKey: false, bubbles: true, cancelable: true };
}

/** Rejoue la combinaison sur la page (même chemin que le clavier : remappages compris). */
export function replayChord(chord: string): boolean {
  const init = chordToEventInit(chord);
  if (!init || typeof document === 'undefined') return false;
  const target = (document.activeElement && document.activeElement !== document.body && !(document.activeElement as HTMLElement).closest?.('input, textarea, select, [contenteditable]'))
    ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
}

/** Contextes rejoués depuis la palette (Keyboard Focus, piano roll, clavier MIDI : non). */
const usable = (s: ShortcutDef) => s.context === 'global' && !s.fixed && (s.keys.length > 0 || !!s.command);

/** Les raccourcis de la table active, en actions de palette. `skip` : ids déjà fournis par le studio. */
export function keymapActions(skip: Set<string>, map: ShortcutDef[] = activeKeymap()): PaletteAction[] {
  return map.filter(s => usable(s) && !skip.has(s.id)).map(s => ({
    id: s.id,
    label: s.label,
    group: s.category,
    pt: s.pt,
    keys: s.keys.length ? chordLabel(s.keys[0]) : undefined,
    keywords: `${s.pt || ''} ${s.keys.join(' ')}`,
    run: () => {
      if (s.command && runEditCommand(s.command as EditCommandId, s.arg)) return;
      if (s.keys.length) replayChord(s.keys[0]);
    },
  }));
}
