/**
 * Table centrale des raccourcis clavier de NOVA, avec leurs équivalents Pro Tools.
 *
 * - owner « nova » : raccourcis qui existaient déjà (App.tsx, ArrangementView) ;
 *   ils restent gérés là où ils sont et figurent ici pour l'aide et pour la
 *   vérification des conflits (tests/keymap.test.ts).
 * - owner « keymap » : raccourcis ajoutés façon Pro Tools, gérés par
 *   hooks/useProToolsShortcuts. Ceux qui agissent sur les clips passent par le
 *   bus utils/editCommands (champ `command`), où la sélection de plage, le
 *   nudge et les fondus des vagues V1 à V3 viendront se brancher.
 * - context « focus » : actifs seulement en Commands Keyboard Focus (une
 *   touche = une commande, comme Pro Tools) ; ils remplacent alors quelques
 *   lettres de NOVA (R n'enregistre plus, il dézoome : Ctrl+Espace enregistre).
 */
import type { EditCommandId } from './editCommands';

export type ShortcutContext = 'global' | 'focus';
export type ShortcutCategory = 'Transport' | 'Édition' | 'Navigation' | 'Zoom et affichage' | 'Repères' | 'Fenêtres' | 'Keyboard Focus';

export interface ShortcutDef {
  id: string;
  /** Combinaisons normalisées (voir chordFromEvent), la première est affichée. */
  keys: string[];
  label: string;
  /** Équivalent Pro Tools (affiché dans l'aide et les infobulles). */
  pt?: string;
  category: ShortcutCategory;
  context: ShortcutContext;
  owner: 'nova' | 'keymap';
  /** Commande d'édition (bus utils/editCommands). */
  command?: EditCommandId;
  arg?: any;
  /** Lettre de NOVA remplacée en Keyboard Focus (documenté, voulu). */
  overridesNova?: boolean;
}

const g = (d: Omit<ShortcutDef, 'context' | 'owner'>): ShortcutDef => ({ ...d, context: 'global', owner: 'keymap' });
const nova = (d: Omit<ShortcutDef, 'context' | 'owner'>): ShortcutDef => ({ ...d, context: 'global', owner: 'nova' });
const f = (d: Omit<ShortcutDef, 'context' | 'owner'>): ShortcutDef => ({ ...d, context: 'focus', owner: 'keymap' });

export const KEYMAP: ShortcutDef[] = [
  // --- Déjà dans NOVA ------------------------------------------------------------
  nova({ id: 'nova.play', keys: ['space'], label: 'Lecture / pause', pt: 'Barre d’espace', category: 'Transport' }),
  nova({ id: 'nova.record', keys: ['r'], label: 'Enregistrer sur la piste armée', pt: 'Ctrl+Espace, F12 ou pavé 3', category: 'Transport' }),
  nova({ id: 'nova.stop', keys: ['escape'], label: 'Stop', pt: 'Barre d’espace', category: 'Transport' }),
  nova({ id: 'nova.home', keys: ['enter', 'home'], label: 'Retour au début', pt: 'Entrée (Return)', category: 'Transport' }),
  nova({ id: 'nova.end', keys: ['end'], label: 'Aller à la fin du morceau', pt: 'Ctrl+Entrée', category: 'Transport' }),
  nova({ id: 'nova.bar', keys: [',', '.'], label: 'Mesure précédente / suivante', pt: 'Pavé 1 / 2 (Rewind / FF)', category: 'Navigation' }),
  nova({ id: 'nova.beat', keys: [';', ':'], label: 'Temps précédent / suivant (Maj + , / .)', category: 'Navigation' }),
  nova({ id: 'nova.loop', keys: ['l'], label: 'Boucle on / off', pt: 'Ctrl+Maj+L (Loop Playback)', category: 'Transport' }),
  nova({ id: 'nova.marker', keys: ['k'], label: 'Poser un repère à la tête de lecture', pt: 'Entrée du pavé', category: 'Repères' }),
  nova({ id: 'nova.help', keys: ['?'], label: 'Afficher / masquer l’aide des raccourcis', category: 'Fenêtres' }),
  // Géré par components/FeedbackModal (FeedbackHost), même sur la page d'accueil.
  nova({ id: 'nova.feedback', keys: ['ctrl+shift+b'], label: 'Signaler un bug / proposer une idée', category: 'Fenêtres' }),
  nova({ id: 'nova.undo', keys: ['ctrl+z'], label: 'Annuler', pt: 'Ctrl+Z', category: 'Édition' }),
  nova({ id: 'nova.redo', keys: ['ctrl+y', 'ctrl+shift+z'], label: 'Rétablir', pt: 'Ctrl+Maj+Z', category: 'Édition' }),
  nova({ id: 'nova.save', keys: ['ctrl+s'], label: 'Sauvegarder', pt: 'Ctrl+S', category: 'Fenêtres' }),
  nova({ id: 'nova.copy', keys: ['ctrl+c'], label: 'Copier le clip', pt: 'Ctrl+C', category: 'Édition' }),
  nova({ id: 'nova.cut', keys: ['ctrl+x'], label: 'Couper le clip', pt: 'Ctrl+X', category: 'Édition' }),
  nova({ id: 'nova.paste', keys: ['ctrl+v'], label: 'Coller à la tête de lecture', pt: 'Ctrl+V', category: 'Édition' }),
  nova({ id: 'nova.duplicate', keys: ['ctrl+d'], label: 'Dupliquer le clip', pt: 'Ctrl+D', category: 'Édition' }),
  nova({ id: 'nova.delete', keys: ['delete', 'backspace'], label: 'Supprimer le clip', pt: 'Suppr', category: 'Édition' }),
  nova({ id: 'nova.mute', keys: ['m'], label: 'Rendre le clip muet / le réactiver', pt: 'Ctrl+M (Clip Mute)', category: 'Édition' }),
  nova({ id: 'nova.split', keys: ['s'], label: 'Couper le clip à la tête de lecture', pt: 'Ctrl+E ou B', category: 'Édition' }),
  nova({ id: 'nova.tools', keys: ['1', '2', '3'], label: 'Outil sélection / ciseaux / gomme', pt: 'F6 / F7 / F8', category: 'Édition' }),

  // --- Ajoutés façon Pro Tools (toujours actifs) ----------------------------------
  g({ id: 'pt.split', keys: ['ctrl+e'], label: 'Séparer le clip à la tête de lecture', pt: 'Ctrl+E (Separate Clip at Selection)', category: 'Édition', command: 'split' }),
  g({ id: 'pt.quickFades', keys: ['ctrl+alt+f'], label: 'Fondus rapides (10 ms) sur les clips sélectionnés, contre les clics', pt: 'Ctrl+F (Fades) / Batch Fades', category: 'Édition', command: 'quickFades' }),
  g({ id: 'pt.selectAll', keys: ['ctrl+a'], label: 'Sélectionner tous les clips', pt: 'Ctrl+A', category: 'Édition', command: 'selectAllClips' }),
  g({ id: 'pt.rename', keys: ['ctrl+shift+r'], label: 'Renommer le clip', pt: 'Ctrl+Maj+R (Rename Clip)', category: 'Édition', command: 'renameClip' }),
  g({ id: 'pt.stripSilence', keys: ['ctrl+u'], label: 'Strip Silence : retirer les blancs (fenêtre)', pt: 'Ctrl+U', category: 'Édition', command: 'stripSilence' }),
  g({ id: 'pt.nudgeL', keys: ['arrowleft', 'numsub'], label: 'Nudge : clip(s) sélectionné(s) d’un pas de grille vers la gauche ; sans sélection, la tête de lecture', pt: 'Pavé − (Nudge)', category: 'Édition', command: 'nudgeLeft' }),
  g({ id: 'pt.nudgeR', keys: ['arrowright', 'numadd'], label: 'Nudge : clip(s) sélectionné(s) d’un pas de grille vers la droite ; sans sélection, la tête de lecture', pt: 'Pavé + (Nudge)', category: 'Édition', command: 'nudgeRight' }),
  g({ id: 'pt.nudgeFineL', keys: ['alt+arrowleft'], label: 'Nudge fin (10 ms) vers la gauche', pt: 'Nudge 10 ms', category: 'Édition', command: 'nudgeLeft', arg: { fine: true } }),
  g({ id: 'pt.nudgeFineR', keys: ['alt+arrowright'], label: 'Nudge fin (10 ms) vers la droite', pt: 'Nudge 10 ms', category: 'Édition', command: 'nudgeRight', arg: { fine: true } }),
  g({ id: 'pt.trackUp', keys: ['arrowup'], label: 'Sélectionner la piste du dessus', pt: 'P (Keyboard Focus)', category: 'Navigation' }),
  g({ id: 'pt.trackDown', keys: ['arrowdown'], label: 'Sélectionner la piste du dessous', pt: '; (Keyboard Focus)', category: 'Navigation' }),
  g({ id: 'pt.recordAlt', keys: ['ctrl+space', 'f12', 'num3'], label: 'Enregistrer', pt: 'Ctrl+Espace / F12 / pavé 3', category: 'Transport' }),
  g({ id: 'pt.numPlay', keys: ['num0'], label: 'Lecture / pause', pt: 'Pavé 0', category: 'Transport' }),
  g({ id: 'pt.numRew', keys: ['num1'], label: 'Retour rapide (une mesure)', pt: 'Pavé 1 (Rewind)', category: 'Transport' }),
  g({ id: 'pt.numFf', keys: ['num2'], label: 'Avance rapide (une mesure)', pt: 'Pavé 2 (Fast Forward)', category: 'Transport' }),
  g({ id: 'pt.numLoop', keys: ['num4'], label: 'Boucle on / off', pt: 'Pavé 4 (Loop Playback)', category: 'Transport' }),
  g({ id: 'pt.numClick', keys: ['num7'], label: 'Métronome on / off', pt: 'Pavé 7 (Click)', category: 'Transport' }),
  g({ id: 'pt.newMarker', keys: ['numenter'], label: 'Nouveau repère numéroté à la tête de lecture', pt: 'Entrée du pavé', category: 'Repères' }),
  g({ id: 'pt.recallMarker', keys: ['numdec'], label: 'Aller au repère N : pavé « . », numéro, « . » (ou Entrée)', pt: 'Pavé . N .', category: 'Repères' }),
  g({ id: 'pt.memoryWindow', keys: ['ctrl+5', 'ctrl+num5'], label: 'Liste des repères (Memory Locations)', pt: 'Ctrl+5 (pavé)', category: 'Repères' }),
  g({ id: 'pt.zoomIn', keys: ['ctrl+]'], label: 'Zoom avant', pt: 'Ctrl+]', category: 'Zoom et affichage', command: 'zoomIn' }),
  g({ id: 'pt.zoomOut', keys: ['ctrl+['], label: 'Zoom arrière', pt: 'Ctrl+[', category: 'Zoom et affichage', command: 'zoomOut' }),
  g({ id: 'pt.heightUp', keys: ['ctrl+arrowup'], label: 'Pistes plus hautes', pt: 'Ctrl+↑ (Track Height)', category: 'Zoom et affichage', command: 'trackHeightUp' }),
  g({ id: 'pt.heightDown', keys: ['ctrl+arrowdown'], label: 'Pistes plus basses', pt: 'Ctrl+↓ (Track Height)', category: 'Zoom et affichage', command: 'trackHeightDown' }),
  g({ id: 'pt.focus', keys: ['ctrl+alt+1'], label: 'Commands Keyboard Focus on / off (une touche = une commande)', pt: 'Ctrl+Alt+1 (bouton a–z)', category: 'Keyboard Focus' }),

  // --- Commands Keyboard Focus (une touche = une commande) ------------------------
  f({ id: 'kf.trimStart', keys: ['a'], label: 'Couper le début du clip jusqu’à la tête de lecture', pt: 'A (Trim Start to Insertion)', category: 'Keyboard Focus', command: 'trimStartToCursor' }),
  f({ id: 'kf.trimEnd', keys: ['s'], label: 'Couper la fin du clip depuis la tête de lecture', pt: 'S (Trim End to Insertion)', category: 'Keyboard Focus', command: 'trimEndToCursor', overridesNova: true }),
  f({ id: 'kf.fadeIn', keys: ['d'], label: 'Fondu d’entrée jusqu’à la tête de lecture', pt: 'D (Fade to Start)', category: 'Keyboard Focus', command: 'fadeInToCursor' }),
  f({ id: 'kf.fades', keys: ['f'], label: 'Fondus rapides sur les clips sélectionnés', pt: 'F (Fade)', category: 'Keyboard Focus', command: 'quickFades' }),
  f({ id: 'kf.fadeOut', keys: ['g'], label: 'Fondu de sortie depuis la tête de lecture', pt: 'G (Fade to End)', category: 'Keyboard Focus', command: 'fadeOutToCursor' }),
  f({ id: 'kf.separate', keys: ['b'], label: 'Séparer le clip à la tête de lecture', pt: 'B (Separate)', category: 'Keyboard Focus', command: 'split' }),
  f({ id: 'kf.copy', keys: ['c'], label: 'Copier', pt: 'C', category: 'Keyboard Focus', command: 'copy' }),
  f({ id: 'kf.cut', keys: ['x'], label: 'Couper', pt: 'X', category: 'Keyboard Focus', command: 'cut' }),
  f({ id: 'kf.paste', keys: ['v'], label: 'Coller', pt: 'V', category: 'Keyboard Focus', command: 'paste' }),
  f({ id: 'kf.undo', keys: ['z'], label: 'Annuler', pt: 'Z', category: 'Keyboard Focus' }),
  f({ id: 'kf.zoomOut', keys: ['r'], label: 'Zoom arrière (en Keyboard Focus, Ctrl+Espace enregistre)', pt: 'R', category: 'Keyboard Focus', command: 'zoomOut', overridesNova: true }),
  f({ id: 'kf.zoomIn', keys: ['t'], label: 'Zoom avant', pt: 'T', category: 'Keyboard Focus', command: 'zoomIn' }),
  f({ id: 'kf.zoomSel', keys: ['e'], label: 'Zoom sur le clip sélectionné', pt: 'E (Zoom Toggle)', category: 'Keyboard Focus', command: 'zoomToSelection' }),
  f({ id: 'kf.prevTrack', keys: ['p'], label: 'Piste du dessus', pt: 'P', category: 'Keyboard Focus' }),
  f({ id: 'kf.nextTrack', keys: [';'], label: 'Piste du dessous', pt: ';', category: 'Keyboard Focus', overridesNova: true }),
  f({ id: 'kf.zoom1', keys: ['1'], label: 'Zoom préréglé 1 (tout le morceau)', pt: '1 (Zoom Preset 1)', category: 'Keyboard Focus', command: 'zoomPreset', arg: 1, overridesNova: true }),
  f({ id: 'kf.zoom2', keys: ['2'], label: 'Zoom préréglé 2', pt: '2', category: 'Keyboard Focus', command: 'zoomPreset', arg: 2, overridesNova: true }),
  f({ id: 'kf.zoom3', keys: ['3'], label: 'Zoom préréglé 3', pt: '3', category: 'Keyboard Focus', command: 'zoomPreset', arg: 3, overridesNova: true }),
  f({ id: 'kf.zoom4', keys: ['4'], label: 'Zoom préréglé 4', pt: '4', category: 'Keyboard Focus', command: 'zoomPreset', arg: 4 }),
  f({ id: 'kf.zoom5', keys: ['5'], label: 'Zoom préréglé 5 (au plus près)', pt: '5', category: 'Keyboard Focus', command: 'zoomPreset', arg: 5 }),
];

// --- Normalisation des touches ------------------------------------------------------

export interface KeyLike { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

const NAMED: Record<string, string> = {
  ' ': 'space', Spacebar: 'space', Escape: 'escape', Esc: 'escape', Enter: 'enter', Home: 'home', End: 'end',
  Delete: 'delete', Backspace: 'backspace', Tab: 'tab',
  ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', ArrowUp: 'arrowup', ArrowDown: 'arrowdown',
};

/** Touche seule, sans modificateurs : « e », « num3 », « arrowleft », « ] »… */
export const keyToken = (e: KeyLike): string => {
  const code = e.code || '';
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    // Pas de « + » dans un nom de touche : c'est le séparateur des combinaisons.
    const map: Record<string, string> = { Enter: 'enter', Add: 'add', Subtract: 'sub', Decimal: 'dec', Multiply: 'mul', Divide: 'div', Equal: 'eq' };
    return `num${map[rest] ?? rest.toLowerCase()}`;
  }
  if (code === 'Space') return 'space';
  if (/^F\d{1,2}$/.test(e.key)) return e.key.toLowerCase();
  if (NAMED[e.key]) return NAMED[e.key];
  if (/^[a-zA-Z]$/.test(e.key)) return e.key.toLowerCase();
  // Chiffres de la rangée du haut, même sur un clavier AZERTY (& é " ' ( …).
  const digit = /^Digit(\d)$/.exec(code);
  if (digit && (e.ctrlKey || e.metaKey || e.altKey || !/^\d$/.test(e.key))) return digit[1];
  return (e.key || '').toLowerCase();
};

const SHIFT_SIGNIFICANT = (k: string) => /^[a-z0-9]$/.test(k) || k.length > 1;

/** Combinaison normalisée : « ctrl+alt+shift+touche » (ordre fixe). */
export const chordFromEvent = (e: KeyLike): string => {
  const k = keyToken(e);
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && SHIFT_SIGNIFICANT(k)) parts.push('shift');
  parts.push(k);
  return parts.join('+');
};

/** Raccourci géré par la table (jamais ceux de NOVA, gérés ailleurs). */
export const findShortcut = (chord: string, keyboardFocus: boolean): ShortcutDef | null => {
  if (keyboardFocus) {
    const hit = KEYMAP.find(s => s.context === 'focus' && s.keys.includes(chord));
    if (hit) return hit;
  }
  return KEYMAP.find(s => s.context === 'global' && s.owner === 'keymap' && s.keys.includes(chord)) || null;
};

/** Conflits : une même combinaison pour deux raccourcis du même contexte. */
export const findConflicts = (map: ShortcutDef[] = KEYMAP): string[] => {
  const out: string[] = [];
  for (const ctx of ['global', 'focus'] as ShortcutContext[]) {
    const seen = new Map<string, string>();
    for (const s of map.filter(x => x.context === ctx)) {
      for (const k of s.keys) {
        const prev = seen.get(k);
        if (prev && prev !== s.id) out.push(`${ctx} « ${k} » : ${prev} et ${s.id}`);
        seen.set(k, s.id);
      }
    }
  }
  // En Keyboard Focus, remplacer une lettre de NOVA doit être voulu (overridesNova).
  const novaKeys = new Map<string, string>();
  map.filter(s => s.owner === 'nova').forEach(s => s.keys.forEach(k => novaKeys.set(k, s.id)));
  for (const s of map.filter(x => x.context === 'focus')) {
    for (const k of s.keys) if (novaKeys.has(k) && !s.overridesNova) out.push(`focus « ${k} » remplace ${novaKeys.get(k)} sans le dire`);
  }
  return out;
};

// --- Affichage -------------------------------------------------------------------

const KEY_LABELS: Record<string, string> = {
  ctrl: 'Ctrl', alt: 'Alt', shift: 'Maj', space: 'Espace', escape: 'Échap', enter: 'Entrée', home: 'Début', end: 'Fin',
  delete: 'Suppr', backspace: 'Retour arr.', tab: 'Tab', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
  numenter: 'Entrée (pavé)', numadd: 'Pavé +', numsub: 'Pavé −', numdec: 'Pavé .', nummul: 'Pavé *', numdiv: 'Pavé /',
};

export const chordLabel = (chord: string): string =>
  chord.split('+').filter(Boolean).map(p => KEY_LABELS[p] ?? (/^num\d$/.test(p) ? `Pavé ${p.slice(3)}` : /^f\d+$/.test(p) ? p.toUpperCase() : p.length === 1 ? p.toUpperCase() : p)).join(' + ');

export const shortcutKeysLabel = (s: ShortcutDef): string => s.keys.map(chordLabel).join(' · ');

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = ['Transport', 'Édition', 'Navigation', 'Zoom et affichage', 'Repères', 'Fenêtres', 'Keyboard Focus'];

/** Recherche dans l'aide : libellé, touches, équivalent Pro Tools (sans accents ni casse). */
export const searchShortcuts = (query: string, map: ShortcutDef[] = KEYMAP): ShortcutDef[] => {
  const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return map;
  return map.filter(s => {
    const hay = norm(`${s.label} ${s.pt || ''} ${shortcutKeysLabel(s)} ${s.keys.join(' ')} ${s.category}`);
    return words.every(w => hay.includes(w));
  });
};

/** Libellé court pour une infobulle (« Ctrl + E »). */
export const shortcutHint = (id: string): string => {
  const s = KEYMAP.find(x => x.id === id);
  return s ? chordLabel(s.keys[0]) : '';
};
