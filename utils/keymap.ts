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
 * - context « midi » : clavier de l'ordinateur joué comme un clavier MIDI, dans
 *   le piano roll quand le bouton « Clavier » est allumé (Live : Computer MIDI
 *   Keyboard). Géré par components/PianoRoll + utils/computerKeyboard, par
 *   position physique (A en QWERTY = Q en AZERTY) ; ces lettres remplacent
 *   alors les raccourcis de NOVA (S ne coupe plus, L ne boucle plus…), voulu.
 */
import { KEY_TO_SEMITONE, OCTAVE_DOWN, OCTAVE_UP, VELOCITY_DOWN, VELOCITY_UP } from './computerKeyboard';
import type { EditCommandId } from './editCommands';

/**
 * Contextes : « global » (arrangement), « focus » (Keyboard Focus, passe avant
 * global quand il est actif), « pianoroll » (piano roll ouvert : passe avant
 * global), « midi » (clavier de l'ordinateur joué comme un clavier MIDI).
 * Deux raccourcis n'entrent en conflit que dans un même contexte.
 */
export type ShortcutContext = 'global' | 'focus' | 'midi' | 'pianoroll';
export type ShortcutCategory = 'Transport' | 'Scrub et shuttle' | 'Édition' | 'Outils' | 'Modes d’édition' | 'Navigation' | 'Zoom et affichage' | 'Repères' | 'Fenêtres' | 'Dispositions' | 'Keyboard Focus' | 'Piano roll' | 'Clavier MIDI';

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
  /** Lettre de NOVA remplacée en Keyboard Focus ou par le clavier MIDI (documenté, voulu). */
  overridesNova?: boolean;
  /** Raccourci fixe (famille de touches : clavier MIDI, Shuttle Lock) : pas remappable. */
  fixed?: boolean;
}

const g = (d: Omit<ShortcutDef, 'context' | 'owner'>): ShortcutDef => ({ ...d, context: 'global', owner: 'keymap' });
const nova = (d: Omit<ShortcutDef, 'context' | 'owner'>): ShortcutDef => ({ ...d, context: 'global', owner: 'nova' });
const f = (d: Omit<ShortcutDef, 'context' | 'owner'>): ShortcutDef => ({ ...d, context: 'focus', owner: 'keymap' });
const m = (d: Omit<ShortcutDef, 'context' | 'owner' | 'category'>): ShortcutDef => ({ ...d, context: 'midi', owner: 'nova', category: 'Clavier MIDI', fixed: true });
const pr = (d: Omit<ShortcutDef, 'context' | 'owner' | 'category'>): ShortcutDef => ({ ...d, context: 'pianoroll', owner: 'nova', category: 'Piano roll' });

/** Lettre QWERTY d'un code de touche (« KeyA » → « a », « Semicolon » → « ; »). */
const letterOf = (code: string) => (code === 'Semicolon' ? ';' : code === 'Quote' ? "'" : code.replace(/^Key/, '').toLowerCase());
const NOTE_FR = ['Do', 'Do#', 'Ré', 'Mib', 'Mi', 'Fa', 'Fa#', 'Sol', 'Lab', 'La', 'Sib', 'Si'];
const WHITE = Object.entries(KEY_TO_SEMITONE).filter(([, n]) => [0, 2, 4, 5, 7, 9, 11].includes(n % 12));
const BLACK = Object.entries(KEY_TO_SEMITONE).filter(([, n]) => ![0, 2, 4, 5, 7, 9, 11].includes(n % 12));
/** Raccourcis du clavier MIDI : pour l'aide, et pour vérifier qu'ils ne se marchent pas dessus. */
export const MIDI_KEYBOARD_SHORTCUTS: ShortcutDef[] = [
  m({ id: 'midi.white', keys: WHITE.map(([c]) => letterOf(c)), label: `Touches blanches : ${WHITE.map(([, n]) => NOTE_FR[n % 12]).join(' ')} (en AZERTY : Q S D F G H J K L M ù)`, pt: 'Live : Computer MIDI Keyboard', overridesNova: true }),
  m({ id: 'midi.black', keys: BLACK.map(([c]) => letterOf(c)), label: `Touches noires : ${BLACK.map(([, n]) => NOTE_FR[n % 12]).join(' ')} (en AZERTY : Z E T Y U O P)`, pt: 'Live : rangée du dessus', overridesNova: true }),
  m({ id: 'midi.octave', keys: [letterOf(OCTAVE_DOWN), letterOf(OCTAVE_UP)], label: 'Octave − / + (en AZERTY : W / X)', pt: 'Live : Z / X', overridesNova: true }),
  m({ id: 'midi.velocity', keys: [letterOf(VELOCITY_DOWN), letterOf(VELOCITY_UP)], label: 'Vélocité − / + (20, 40… 127)', pt: 'Live : C / V', overridesNova: true }),
];

export const KEYMAP: ShortcutDef[] = [
  // --- Déjà dans NOVA ------------------------------------------------------------
  nova({ id: 'nova.play', keys: ['space'], label: 'Lecture / pause', pt: 'Barre d’espace', category: 'Transport' }),
  nova({ id: 'nova.record', keys: ['r'], label: 'Enregistrer sur la piste armée', pt: 'Ctrl+Espace, F12 ou pavé 3', category: 'Transport' }),
  nova({ id: 'nova.stop', keys: ['escape'], label: 'Stop', pt: 'Barre d’espace', category: 'Transport' }),
  nova({ id: 'nova.home', keys: ['enter', 'home'], label: 'Retour au début', pt: 'Entrée (Return)', category: 'Transport' }),
  nova({ id: 'nova.end', keys: ['end'], label: 'Aller à la fin du morceau', pt: 'Ctrl+Entrée', category: 'Transport' }),
  // En AZERTY « ; » et « : » sont sur les touches voisines : ils servent aussi. Maj = un temps au lieu d'une mesure.
  nova({ id: 'nova.barPrev', keys: [',', ';'], label: 'Mesure précédente (avec Maj : temps précédent)', pt: 'Pavé 1 (Rewind)', category: 'Navigation' }),
  nova({ id: 'nova.barNext', keys: ['.', ':'], label: 'Mesure suivante (avec Maj : temps suivant)', pt: 'Pavé 2 (Fast Forward)', category: 'Navigation' }),
  nova({ id: 'nova.loop', keys: ['l'], label: 'Boucle on / off', pt: 'Ctrl+Maj+L (Loop Playback)', category: 'Transport' }),
  nova({ id: 'nova.capture', keys: ['shift+r'], label: 'Capturer la dernière prise (ce que tu as joué sans enregistrer)', pt: 'Pas dans Pro Tools : Capture as Recording de Logic', category: 'Transport' }),
  nova({ id: 'nova.guide', keys: ['g'], label: 'Couper / rallumer la piste guide', category: 'Transport' }),
  nova({ id: 'nova.marker', keys: ['k'], label: 'Poser un repère à la tête de lecture', pt: 'Entrée du pavé', category: 'Repères' }),
  nova({ id: 'nova.tap', keys: ['t'], label: 'Tap tempo (tape au rythme, appliqué après la dernière tape)', pt: 'T dans le champ tempo', category: 'Transport' }),
  nova({ id: 'nova.help', keys: ['?', 'shift+/'], label: 'Afficher / masquer l’aide des raccourcis', category: 'Fenêtres' }),
  // Géré par components/FeedbackModal (FeedbackHost), même sur la page d'accueil.
  nova({ id: 'nova.feedback', keys: ['ctrl+shift+b'], label: 'Signaler un bug / proposer une idée', category: 'Fenêtres' }),
  nova({ id: 'nova.undo', keys: ['ctrl+z'], label: 'Annuler', pt: 'Ctrl+Z', category: 'Édition' }),
  nova({ id: 'nova.redo', keys: ['ctrl+y', 'ctrl+shift+z'], label: 'Rétablir', pt: 'Ctrl+Maj+Z', category: 'Édition' }),
  nova({ id: 'nova.save', keys: ['ctrl+s'], label: 'Sauvegarder', pt: 'Ctrl+S', category: 'Fenêtres' }),
  nova({ id: 'nova.export', keys: ['ctrl+shift+e'], label: 'Exporter (mix, stems, voix seules)', pt: 'Bounce to Disk : Ctrl+Alt+B', category: 'Fenêtres' }),
  nova({ id: 'nova.copy', keys: ['ctrl+c'], label: 'Copier le clip', pt: 'Ctrl+C', category: 'Édition' }),
  nova({ id: 'nova.cut', keys: ['ctrl+x'], label: 'Couper le clip', pt: 'Ctrl+X', category: 'Édition' }),
  nova({ id: 'nova.paste', keys: ['ctrl+v'], label: 'Coller à la tête de lecture', pt: 'Ctrl+V', category: 'Édition' }),
  nova({ id: 'nova.duplicate', keys: ['ctrl+d'], label: 'Dupliquer le clip', pt: 'Ctrl+D', category: 'Édition' }),
  nova({ id: 'nova.delete', keys: ['delete', 'backspace'], label: 'Supprimer le clip', pt: 'Suppr', category: 'Édition' }),
  nova({ id: 'nova.mute', keys: ['m'], label: 'Rendre le clip muet / le réactiver', pt: 'Ctrl+M (Clip Mute)', category: 'Édition' }),
  nova({ id: 'nova.split', keys: ['s'], label: 'Couper le clip à la tête de lecture', pt: 'Ctrl+E ou B', category: 'Édition' }),
  // Outils de l'arrangement (components/ArrangementView) : chiffres de NOVA + F5–F10 de Pro Tools.
  nova({ id: 'tool.zoom', keys: ['f5'], label: 'Outil Zoom : clic = zoom avant sur ce point, Alt+clic = zoom arrière', pt: 'F5 (Zoomer)', category: 'Outils' }),
  nova({ id: 'tool.smart', keys: ['5', 'f6'], label: 'Smart Tool : rogner aux bords, sélectionner en haut, déplacer en bas, fondus aux coins', pt: 'F6 (Trimmer) · F6+F7 (Smart Tool)', category: 'Outils' }),
  nova({ id: 'tool.range', keys: ['4', 'f7'], label: 'Sélecteur : sélection de plage (temps)', pt: 'F7 (Selector)', category: 'Outils' }),
  nova({ id: 'tool.select', keys: ['1', 'f8'], label: 'Main : déplacer et sélectionner les clips', pt: 'F8 (Grabber)', category: 'Outils' }),
  nova({ id: 'tool.scrub', keys: ['7', 'f9'], label: 'Scrubber : glisse sur la forme d’onde pour l’entendre (Alt+glisser = shuttle). Ctrl+glisser le fait avec tous les outils', pt: 'F9 (Scrubber)', category: 'Outils' }),
  nova({ id: 'tool.draw', keys: ['6', 'f10'], label: 'Crayon : dessiner la ligne de gain d’un clip ou une ligne d’automation (libre, ligne, triangle, carré, aléatoire)', pt: 'F10 (Pencil)', category: 'Outils' }),
  nova({ id: 'tool.split', keys: ['2'], label: 'Ciseaux : couper le clip à l’endroit du clic', pt: 'Pas d’outil dédié (B en Keyboard Focus)', category: 'Outils' }),
  nova({ id: 'tool.erase', keys: ['3'], label: 'Gomme : supprimer le clip cliqué', category: 'Outils' }),
  nova({ id: 'tool.cycle', keys: [], label: 'Passer à l’outil suivant', pt: 'Échap (Cycle through Edit tools)', category: 'Outils' }),
  // Géré par components/MidiHost (V25). Ctrl+Alt+C : repli quand le navigateur garde Ctrl+Maj+C (outils de développement).
  nova({ id: 'nova.computerKeyboard', keys: ['ctrl+shift+k'], label: 'Clavier de l’ordinateur = clavier MIDI sur la piste armée ou sélectionnée, sans ouvrir le piano roll (R reste l’enregistrement, Espace la lecture)', pt: 'Pro Tools : clavier MIDI (Ctrl+Démarrer+K) · Live : M (Computer MIDI Keyboard) · FL : Typing keyboard to piano', category: 'Transport' }),
  nova({ id: 'nova.captureMidi', keys: ['ctrl+shift+c', 'ctrl+alt+c'], label: 'Capturer ce que tu viens de jouer (clip MIDI créé après coup)', pt: 'Pas dans Pro Tools : Capture MIDI de Live (Ctrl+Maj+C)', category: 'Transport' }),

  // --- Ajoutés façon Pro Tools (toujours actifs) ----------------------------------
  g({ id: 'pt.split', keys: ['ctrl+e'], label: 'Séparer le clip à la tête de lecture', pt: 'Ctrl+E (Separate Clip at Selection)', category: 'Édition', command: 'split' }),
  g({ id: 'pt.quickFades', keys: ['ctrl+alt+f'], label: 'Fondus rapides (10 ms) sur les clips sélectionnés, contre les clics', pt: 'Ctrl+F (Fades) / Batch Fades', category: 'Édition', command: 'quickFades' }),
  g({ id: 'pt.selectAll', keys: ['ctrl+a'], label: 'Sélectionner tous les clips', pt: 'Ctrl+A', category: 'Édition', command: 'selectAllClips' }),
  g({ id: 'pt.rename', keys: ['ctrl+shift+r'], label: 'Renommer le clip', pt: 'Ctrl+Maj+R (Rename Clip)', category: 'Édition', command: 'renameClip' }),
  g({ id: 'pt.stripSilence', keys: ['ctrl+u'], label: 'Supprimer les silences (Strip Silence) : retirer les blancs (fenêtre)', pt: 'Ctrl+U', category: 'Édition', command: 'stripSilence' }),
  g({ id: 'nova.breaths', keys: ['ctrl+alt+r'], label: 'Respirations : baisser la lead, supprimer sur les backs (fenêtre)', pt: 'Pas dans Pro Tools : comme Breath Control de Waves / De-breath de RX', category: 'Édition', command: 'breaths' }),
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
  g({ id: 'pt.zoomSel', keys: [], label: 'Zoom sur la sélection (clip ou plage)', pt: 'E en Keyboard Focus (Zoom Toggle)', category: 'Zoom et affichage', command: 'zoomToSelection' }),
  g({ id: 'pt.heightUp', keys: ['ctrl+arrowup'], label: 'Pistes plus hautes', pt: 'Ctrl+↑ (Track Height)', category: 'Zoom et affichage', command: 'trackHeightUp' }),
  g({ id: 'pt.heightDown', keys: ['ctrl+arrowdown'], label: 'Pistes plus basses', pt: 'Ctrl+↓ (Track Height)', category: 'Zoom et affichage', command: 'trackHeightDown' }),
  // --- Modes d'édition (hooks/useEditModes, utils/editModes) -----------------------
  // F1–F4 comme Pro Tools ; Alt+1–4 en repli quand le navigateur ou Windows prend F1–F4.
  // Ctrl ou Maj maintenus PENDANT un glissement inversent Grid et Slip (Pro Tools : Ctrl).
  g({ id: 'pt.modeShuffle', keys: ['f1', 'alt+1'], label: 'Mode Shuffle : les clips se collent, supprimer recolle la suite, coller pousse le reste', pt: 'F1 (Shuffle)', category: 'Modes d’édition', command: 'editMode', arg: 'SHUFFLE' }),
  g({ id: 'pt.modeSlip', keys: ['f2', 'alt+2'], label: 'Mode Slip : déplacement et rognage libres, à l’échantillon près', pt: 'F2 (Slip)', category: 'Modes d’édition', command: 'editMode', arg: 'SLIP' }),
  g({ id: 'pt.modeSpot', keys: ['f3', 'alt+3'], label: 'Mode Spot : un clic sur un clip ouvre « Position exacte »', pt: 'F3 (Spot)', category: 'Modes d’édition', command: 'editMode', arg: 'SPOT' }),
  g({ id: 'pt.modeGrid', keys: ['f4', 'alt+4'], label: 'Mode Grid (2e appui : Grid relatif, le clip garde son décalage)', pt: 'F4 (Grid, F4 deux fois = Relative Grid)', category: 'Modes d’édition', command: 'editMode', arg: 'GRID' }),
  g({ id: 'pt.tabTransient', keys: ['tab'], label: 'Tête de lecture à l’attaque suivante du clip sélectionné (Tab to Transient), sinon au bord de clip suivant', pt: 'Tab (Tab to Transient)', category: 'Modes d’édition', command: 'tabToTransient', arg: { dir: 1 } }),
  g({ id: 'pt.tabTransientBack', keys: ['shift+tab'], label: 'Tête de lecture à l’attaque précédente', pt: 'Ctrl+Tab (Windows) / Option+Tab (Mac)', category: 'Modes d’édition', command: 'tabToTransient', arg: { dir: -1 } }),
  g({ id: 'pt.tabClip', keys: ['alt+tab', 'ctrl+alt+arrowright'], label: 'Clip suivant de la piste (le sélectionne). Sous Windows, Alt+Tab est pris par le système : Ctrl+Alt+→', pt: 'Ctrl+Tab (clip suivant, Tab to Transient éteint)', category: 'Modes d’édition', command: 'tabToTransient', arg: { dir: 1, clip: true } }),
  g({ id: 'pt.tabClipBack', keys: ['alt+shift+tab', 'ctrl+alt+arrowleft'], label: 'Clip précédent de la piste (le sélectionne)', pt: 'Ctrl+Maj+Tab', category: 'Modes d’édition', command: 'tabToTransient', arg: { dir: -1, clip: true } }),
  g({ id: 'pt.syncPoint', keys: ['ctrl+,'], label: 'Point de synchro du clip à la tête de lecture (ou au début de la plage) : c’est lui qui se cale sur la grille et en Spot', pt: 'Ctrl+, (Identify Sync Point)', category: 'Modes d’édition', command: 'syncPoint' }),
  g({ id: 'pt.syncPointRemove', keys: ['ctrl+alt+,'], label: 'Enlever le point de synchro des clips sélectionnés', pt: 'Alt+clic sur le point (Remove Sync Point)', category: 'Modes d’édition', command: 'syncPoint', arg: { remove: true } }),
  // --- Gain de clip, Heal, boucle (R5, components/ClipGainTools) --------------------
  // Ctrl+Maj+− : selon le clavier, le navigateur voit « _ » (QWERTY) ou « 6 » (AZERTY) ; Alt+G marche partout.
  g({ id: 'pt.clipGainLine', keys: ['alt+g', 'ctrl+shift+-', 'ctrl+_', 'ctrl+shift+6', 'ctrl+shift+numsub'], label: 'Afficher / masquer la ligne de gain des clips (points à tirer, Alt+clic pour enlever)', pt: 'Ctrl+Maj+− (Show Clip Gain Line)', category: 'Zoom et affichage', command: 'clipGainLine' }),
  g({ id: 'pt.clipGainUp', keys: ['ctrl+shift+arrowup'], label: 'Gain du clip +0,5 dB (sur la plage sélectionnée si elle existe)', pt: 'Ctrl+Maj+↑ (Clip Gain Nudge)', category: 'Édition', command: 'clipGainNudge', arg: { db: 0.5 } }),
  g({ id: 'pt.clipGainDown', keys: ['ctrl+shift+arrowdown'], label: 'Gain du clip −0,5 dB (sur la plage sélectionnée si elle existe)', pt: 'Ctrl+Maj+↓ (Clip Gain Nudge)', category: 'Édition', command: 'clipGainNudge', arg: { db: -0.5 } }),
  g({ id: 'pt.clipGainUpFine', keys: ['ctrl+alt+shift+arrowup', 'alt+shift+arrowup'], label: 'Gain du clip +0,1 dB (réglage fin)', pt: 'Pas fin du Clip Gain Nudge', category: 'Édition', command: 'clipGainNudge', arg: { db: 0.1 } }),
  g({ id: 'pt.clipGainDownFine', keys: ['ctrl+alt+shift+arrowdown', 'alt+shift+arrowdown'], label: 'Gain du clip −0,1 dB (réglage fin)', pt: 'Pas fin du Clip Gain Nudge', category: 'Édition', command: 'clipGainNudge', arg: { db: -0.1 } }),
  g({ id: 'pt.heal', keys: ['ctrl+h', 'ctrl+alt+h'], label: 'Recoller deux morceaux d’un même fichier (Heal) : sélection, plage ou jonction sous la tête de lecture', pt: 'Ctrl+H (Heal Separation)', category: 'Édition', command: 'heal' }),
  g({ id: 'pt.repeat', keys: ['alt+r'], label: 'Répéter les clips sélectionnés n fois à la suite (fenêtre)', pt: 'Alt+R (Repeat)', category: 'Édition', command: 'repeatClips' }),
  g({ id: 'pt.loopClip', keys: ['ctrl+alt+l'], label: 'Boucler le clip sélectionné (nombre de tours, fondus aux jonctions)', pt: 'Ctrl+Alt+L (Loop Clip)', category: 'Édition', command: 'loopClips' }),
  // Groupes et temps (R12, hooks/useR12).
  g({ id: 'pt.groupCreate', keys: ['ctrl+g'], label: 'Créer un groupe avec les pistes sélectionnées (édition et mix)', pt: 'Ctrl+G (Group)', category: 'Édition', command: 'groupCreate' }),
  g({ id: 'pt.groupsSuspend', keys: ['ctrl+shift+g'], label: 'Suspendre / reprendre tous les groupes', pt: 'Ctrl+Maj+G (Suspend All Groups)', category: 'Édition', command: 'groupsSuspend' }),
  g({ id: 'pt.insertTime', keys: ['ctrl+alt+i'], label: 'Insérer ou supprimer du temps (repères, accords, tempo, automation et clips suivent)', pt: 'Ctrl+Maj+E (Insert Silence) — pris par Exporter dans NOVA', category: 'Édition', command: 'insertTime' }),
  g({ id: 'pt.focus', keys: ['ctrl+alt+1'], label: 'Commands Keyboard Focus on / off (une touche = une commande)', pt: 'Ctrl+Alt+1 (bouton a–z)', category: 'Keyboard Focus' }),
  // --- R17 : pavé numérique complet (mode Transport de Pro Tools) ---------------------
  g({ id: 'pt.numLoopRec', keys: ['num5'], label: 'Enregistrement en boucle on / off (une prise par tour)', pt: 'Pavé 5 (Loop Record)', category: 'Transport' }),
  g({ id: 'pt.numQuickPunch', keys: ['num6'], label: 'QuickPunch on / off', pt: 'Pavé 6 (QuickPunch)', category: 'Transport' }),
  g({ id: 'pt.numCountoff', keys: ['num8'], label: 'Décompte avant l’enregistrement on / off', pt: 'Pavé 8 (Countoff)', category: 'Transport' }),
  g({ id: 'pt.numMidiMerge', keys: ['num9'], label: 'Prise MIDI : fusion / remplacement', pt: 'Pavé 9 (MIDI Merge/Replace)', category: 'Transport' }),
  g({ id: 'pt.quickPunch', keys: ['ctrl+shift+p'], label: 'QuickPunch on / off', pt: 'Ctrl+Maj+P (QuickPunch)', category: 'Transport' }),
  // --- Scrub et shuttle (engine/AudioEngine.scrub) ------------------------------------
  g({ id: 'shuttle.back', keys: ['alt+j'], label: 'Shuttle arrière : chaque appui accélère (×1, ×2, ×4, ×8)', pt: 'Pavé 4 / 7 en mode Shuttle', category: 'Scrub et shuttle' }),
  g({ id: 'shuttle.stop', keys: ['alt+k'], label: 'Arrêter le shuttle (la tête de lecture reste où tu l’as amenée)', pt: 'Pavé 0 (Shuttle Lock stop)', category: 'Scrub et shuttle' }),
  g({ id: 'shuttle.fwd', keys: ['alt+l'], label: 'Shuttle avant : chaque appui accélère (×1, ×2, ×4, ×8)', pt: 'Pavé 6 / 9 en mode Shuttle', category: 'Scrub et shuttle' }),
  g({ id: 'shuttle.lock', keys: ['ctrl+alt+num1', 'ctrl+alt+num2', 'ctrl+alt+num3', 'ctrl+alt+num4', 'ctrl+alt+num5', 'ctrl+alt+num6', 'ctrl+alt+num7', 'ctrl+alt+num8', 'ctrl+alt+num9'], label: 'Shuttle Lock : vitesse 1 (lente) à 9 (×8), 5 = temps réel ; pavé − / + change de sens, pavé 0 arrête, Espace ou Échap sort', pt: 'Démarrer+1–9 (Shuttle Lock) : la touche Démarrer est réservée à Windows', category: 'Scrub et shuttle', fixed: true }),
  g({ id: 'scrub.nudgeL', keys: [], label: 'Scrub d’un pas vers la gauche (entendre le petit bout de son)', pt: 'Pas dans Pro Tools', category: 'Scrub et shuttle' }),
  g({ id: 'scrub.nudgeR', keys: [], label: 'Scrub d’un pas vers la droite', pt: 'Pas dans Pro Tools', category: 'Scrub et shuttle' }),
  // --- Fondus, consolidation, modes ----------------------------------------------------
  g({ id: 'pt.fadesRange', keys: ['ctrl+f'], label: 'Fondus sur la plage sélectionnée. Sans plage : la recherche du navigateur, sauf si « Ctrl+F = fondus » est coché (fondus rapides sur les clips)', pt: 'Ctrl+F (Fades)', category: 'Édition', command: 'quickFades' }),
  nova({ id: 'pt.consolidate', keys: ['alt+shift+3'], label: 'Consolider la plage sélectionnée en un seul clip', pt: 'Alt+Maj+3 (Consolidate Clip)', category: 'Édition' }),
  g({ id: 'pt.modeCycle', keys: [], label: 'Passer au mode d’édition suivant (Shuffle, Slip, Spot, Grid)', pt: '` (Cycle through Edit modes)', category: 'Modes d’édition' }),
  // --- Dispositions de fenêtres (utils/windowLayouts) ----------------------------------
  g({ id: 'layout.1', keys: ['ctrl+shift+1'], label: 'Disposition 1 (livrée : Enregistrement)', pt: 'Pavé . 1 * (Recall Window Configuration)', category: 'Dispositions', arg: 1 }),
  g({ id: 'layout.2', keys: ['ctrl+shift+2'], label: 'Disposition 2 (livrée : Édition)', pt: 'Pavé . 2 *', category: 'Dispositions', arg: 2 }),
  g({ id: 'layout.3', keys: ['ctrl+shift+3'], label: 'Disposition 3 (livrée : Mix)', pt: 'Pavé . 3 *', category: 'Dispositions', arg: 3 }),
  g({ id: 'layout.4', keys: ['ctrl+shift+4'], label: 'Disposition 4 (la tienne)', pt: 'Pavé . 4 *', category: 'Dispositions', arg: 4 }),
  g({ id: 'layout.5', keys: ['ctrl+shift+5'], label: 'Disposition 5 (la tienne)', pt: 'Pavé . 5 *', category: 'Dispositions', arg: 5 }),
  g({ id: 'layout.list', keys: ['ctrl+alt+j'], label: 'Dispositions de fenêtres : enregistrer, rappeler, renommer', pt: 'Ctrl+Alt+J (Window Configuration List)', category: 'Dispositions' }),
  g({ id: 'layout.numpad', keys: [], label: 'Au pavé : « . » N « * » rappelle la disposition N, « . » N « / » y enregistre la vue actuelle', pt: 'Pavé . N * / Pavé . N /', category: 'Dispositions', fixed: true }),
  g({ id: 'keymap.editor', keys: ['ctrl+alt+k'], label: 'Personnaliser les raccourcis (éditeur, préréglages Pro Tools, FL Studio, Ableton Live)', pt: 'Démarrer+Maj+K (Keyboard Shortcuts)', category: 'Fenêtres' }),

  // --- Commands Keyboard Focus (une touche = une commande) ------------------------
  f({ id: 'kf.trimStart', keys: ['a'], label: 'Couper le début du clip jusqu’à la tête de lecture', pt: 'A (Trim Start to Insertion)', category: 'Keyboard Focus', command: 'trimStartToCursor' }),
  f({ id: 'kf.trimEnd', keys: ['s'], label: 'Couper la fin du clip depuis la tête de lecture', pt: 'S (Trim End to Insertion)', category: 'Keyboard Focus', command: 'trimEndToCursor', overridesNova: true }),
  f({ id: 'kf.fadeIn', keys: ['d'], label: 'Fondu d’entrée jusqu’à la tête de lecture', pt: 'D (Fade to Start)', category: 'Keyboard Focus', command: 'fadeInToCursor' }),
  f({ id: 'kf.fades', keys: ['f'], label: 'Fondus rapides sur les clips sélectionnés', pt: 'F (Fade)', category: 'Keyboard Focus', command: 'quickFades' }),
  f({ id: 'kf.fadeOut', keys: ['g'], label: 'Fondu de sortie depuis la tête de lecture', pt: 'G (Fade to End)', category: 'Keyboard Focus', command: 'fadeOutToCursor', overridesNova: true }),
  f({ id: 'kf.separate', keys: ['b'], label: 'Séparer le clip à la tête de lecture', pt: 'B (Separate)', category: 'Keyboard Focus', command: 'split' }),
  f({ id: 'kf.copy', keys: ['c'], label: 'Copier', pt: 'C', category: 'Keyboard Focus', command: 'copy' }),
  f({ id: 'kf.cut', keys: ['x'], label: 'Couper', pt: 'X', category: 'Keyboard Focus', command: 'cut' }),
  f({ id: 'kf.paste', keys: ['v'], label: 'Coller', pt: 'V', category: 'Keyboard Focus', command: 'paste' }),
  f({ id: 'kf.undo', keys: ['z'], label: 'Annuler', pt: 'Z', category: 'Keyboard Focus' }),
  f({ id: 'kf.zoomOut', keys: ['r'], label: 'Zoom arrière (en Keyboard Focus, Ctrl+Espace enregistre)', pt: 'R', category: 'Keyboard Focus', command: 'zoomOut', overridesNova: true }),
  f({ id: 'kf.zoomIn', keys: ['t'], label: 'Zoom avant', pt: 'T', category: 'Keyboard Focus', command: 'zoomIn', overridesNova: true }),
  f({ id: 'kf.zoomSel', keys: ['e'], label: 'Zoom sur le clip sélectionné', pt: 'E (Zoom Toggle)', category: 'Keyboard Focus', command: 'zoomToSelection' }),
  f({ id: 'kf.prevTrack', keys: ['p'], label: 'Piste du dessus', pt: 'P', category: 'Keyboard Focus' }),
  f({ id: 'kf.nextTrack', keys: [';'], label: 'Piste du dessous', pt: ';', category: 'Keyboard Focus', overridesNova: true }),
  f({ id: 'kf.zoom1', keys: ['1'], label: 'Zoom préréglé 1 (tout le morceau)', pt: '1 (Zoom Preset 1)', category: 'Keyboard Focus', command: 'zoomPreset', arg: 1, overridesNova: true }),
  f({ id: 'kf.zoom2', keys: ['2'], label: 'Zoom préréglé 2', pt: '2', category: 'Keyboard Focus', command: 'zoomPreset', arg: 2, overridesNova: true }),
  f({ id: 'kf.zoom3', keys: ['3'], label: 'Zoom préréglé 3', pt: '3', category: 'Keyboard Focus', command: 'zoomPreset', arg: 3, overridesNova: true }),
  f({ id: 'kf.zoom4', keys: ['4'], label: 'Zoom préréglé 4', pt: '4', category: 'Keyboard Focus', command: 'zoomPreset', arg: 4, overridesNova: true }),
  f({ id: 'kf.zoom5', keys: ['5'], label: 'Zoom préréglé 5 (au plus près)', pt: '5', category: 'Keyboard Focus', command: 'zoomPreset', arg: 5, overridesNova: true }),

  // --- Vues (App.tsx) ------------------------------------------------------------------
  nova({ id: 'view.mixEdit', keys: ['ctrl+='], label: 'Basculer entre l’arrangement et la console de mixage', pt: 'Ctrl+= (Mix / Edit)', category: 'Fenêtres' }),
  nova({ id: 'view.arrangement', keys: [], label: 'Afficher l’arrangement', pt: 'Fenêtre › Édition', category: 'Fenêtres' }),
  nova({ id: 'view.mixer', keys: [], label: 'Afficher la console de mixage', pt: 'Fenêtre › Mixage', category: 'Fenêtres' }),
  nova({ id: 'view.browser', keys: ['ctrl+alt+b'], label: 'Afficher / masquer le navigateur (sons, effets)', pt: 'Pas de raccourci dans Pro Tools', category: 'Fenêtres' }),
  nova({ id: 'nova.metronome', keys: [], label: 'Métronome on / off', pt: 'Pavé 7 (Click)', category: 'Transport' }),

  // --- Piano roll ouvert (components/PianoRoll) : passe avant les raccourcis globaux ---
  pr({ id: 'pr.close', keys: ['escape'], label: 'Fermer le piano roll' }),
  pr({ id: 'nova.muteNotes', keys: ['ctrl+m'], label: 'Rendre muettes (ou réactiver) les notes sélectionnées, sans les effacer (Alt+clic sur une note aussi)', pt: 'Pro Tools : Mute Notes (Ctrl+M) · FL : Alt+M' }),
  pr({ id: 'pr.delete', keys: ['delete', 'backspace'], label: 'Effacer les notes sélectionnées' }),
  pr({ id: 'pr.selectAll', keys: ['ctrl+a'], label: 'Sélectionner toutes les notes' }),
  pr({ id: 'pr.double', keys: ['ctrl+d'], label: 'Dupliquer les notes sélectionnées à la suite' }),
  pr({ id: 'pr.up', keys: ['arrowup'], label: 'Transposer d’un demi-ton vers le haut' }),
  pr({ id: 'pr.down', keys: ['arrowdown'], label: 'Transposer d’un demi-ton vers le bas' }),
  pr({ id: 'pr.octUp', keys: ['ctrl+arrowup'], label: 'Transposer d’une octave vers le haut' }),
  pr({ id: 'pr.octDown', keys: ['ctrl+arrowdown'], label: 'Transposer d’une octave vers le bas' }),
  pr({ id: 'pr.quantize', keys: ['q'], label: 'Quantifier les notes (sélection, sinon tout le clip)', pt: 'Alt+0 (Quantize) · FL : Ctrl+Alt+Q · Live : Ctrl+U' }),
  pr({ id: 'pr.humanize', keys: ['h'], label: 'Humaniser (petits décalages de temps et de vélocité)' }),

  // --- Clavier MIDI de l'ordinateur (piano roll, bouton « Clavier » allumé) -------
  ...MIDI_KEYBOARD_SHORTCUTS,
];

// --- Normalisation des touches ------------------------------------------------------

export interface KeyLike { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

const NAMED: Record<string, string> = {
  ' ': 'space', Spacebar: 'space', Escape: 'escape', Esc: 'escape', Enter: 'enter', Home: 'home', End: 'end',
  Delete: 'delete', Backspace: 'backspace', Tab: 'tab',
  ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', ArrowUp: 'arrowup', ArrowDown: 'arrowdown',
};

/** Touche US à la même position physique (Pro Tools : « Lock to U.S. Layout »). */
const US_CODE: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Backquote: '`', Comma: ',', Period: '.', Slash: '/', IntlBackslash: '<',
};

/**
 * Touche seule, sans modificateurs : « e », « num3 », « arrowleft », « ] »…
 * `usLayout` : les lettres, chiffres et signes sont lus par leur POSITION
 * (code de la touche) comme sur un clavier US, à la manière de Pro Tools sous
 * Windows : en AZERTY, la touche « W » vaut « z ».
 */
export const keyToken = (e: KeyLike, usLayout = false): string => {
  const code = e.code || '';
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    // Pas de « + » dans un nom de touche : c'est le séparateur des combinaisons.
    const map: Record<string, string> = { Enter: 'enter', Add: 'add', Subtract: 'sub', Decimal: 'dec', Multiply: 'mul', Divide: 'div', Equal: 'eq' };
    return `num${map[rest] ?? rest.toLowerCase()}`;
  }
  if (code === 'Space') return 'space';
  if (usLayout) {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1].toLowerCase();
    const d = /^Digit(\d)$/.exec(code);
    if (d) return d[1];
    if (US_CODE[code]) return US_CODE[code];
  }
  if (/^F\d{1,2}$/.test(e.key)) return e.key.toLowerCase();
  if (NAMED[e.key]) return NAMED[e.key];
  if (e.key === '+') return 'plus';
  if (/^[a-zA-Z]$/.test(e.key)) return e.key.toLowerCase();
  // Chiffres de la rangée du haut, même sur un clavier AZERTY (& é " ' ( …).
  const digit = /^Digit(\d)$/.exec(code);
  if (digit && (e.ctrlKey || e.metaKey || e.altKey || !/^\d$/.test(e.key))) return digit[1];
  return (e.key || '').toLowerCase();
};

const SHIFT_SIGNIFICANT = (k: string) => /^[a-z0-9]$/.test(k) || k.length > 1;

/** Combinaison normalisée : « ctrl+alt+shift+touche » (ordre fixe). */
export const chordFromEvent = (e: KeyLike, usLayout = false): string => {
  const k = keyToken(e, usLayout);
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  // Positions US : Maj compte toujours (Maj+/ = « ? »), comme dans Pro Tools.
  if (e.shiftKey && (usLayout || SHIFT_SIGNIFICANT(k))) parts.push('shift');
  parts.push(k);
  return parts.join('+');
};

// --- Table ACTIVE (utils/keymapStore : préréglage + remappages de l'utilisateur) ------
// keymapStore s'inscrit ici au chargement ; sans lui, la table d'origine.
const runtime: { map: () => ShortcutDef[]; usLayout: () => boolean } = { map: () => KEYMAP, usLayout: () => false };
export const configureKeymapRuntime = (r: Partial<typeof runtime>) => { Object.assign(runtime, r); };
/** Table active (raccourcis remappés compris). */
export const activeKeymap = (): ShortcutDef[] => runtime.map();
/** Combinaison d'un évènement selon le réglage actif (positions US ou caractères). */
export const eventChord = (e: KeyLike): string => chordFromEvent(e, runtime.usLayout());
/** Touches actives d'une commande. */
export const keysOf = (id: string): string[] => runtime.map().find(s => s.id === id)?.keys || [];
/** L'évènement déclenche-t-il cette commande (table active) ? */
export const isShortcut = (e: KeyLike, id: string): boolean => keysOf(id).includes(eventChord(e));
/** Première commande de la liste déclenchée par l'évènement. */
export const matchShortcut = (e: KeyLike, ids: readonly string[]): string | null => {
  const c = eventChord(e);
  const map = runtime.map();
  for (const id of ids) if (map.find(s => s.id === id)?.keys.includes(c)) return id;
  return null;
};
/** Une commande du piano roll (ouvert) prend cette combinaison : les autres la laissent. */
export const takenByPianoRoll = (e: KeyLike): boolean => {
  if (typeof document === 'undefined' || !document.querySelector('[data-nova-pianoroll]')) return false;
  const c = eventChord(e);
  return runtime.map().some(s => s.context === 'pianoroll' && s.keys.includes(c));
};

/** Raccourci géré par la table (jamais ceux de NOVA, gérés ailleurs). */
export const findShortcut = (chord: string, keyboardFocus: boolean, map: ShortcutDef[] = runtime.map()): ShortcutDef | null => {
  if (keyboardFocus) {
    const hit = map.find(s => s.context === 'focus' && s.keys.includes(chord));
    if (hit) return hit;
  }
  return map.find(s => s.context === 'global' && s.owner === 'keymap' && s.keys.includes(chord)) || null;
};

/** Conflits : une même combinaison pour deux raccourcis du même contexte. */
export const findConflicts = (map: ShortcutDef[] = KEYMAP): string[] => {
  const out: string[] = [];
  for (const ctx of ['global', 'focus', 'midi', 'pianoroll'] as ShortcutContext[]) {
    const seen = new Map<string, string>();
    for (const s of map.filter(x => x.context === ctx)) {
      for (const k of s.keys) {
        const prev = seen.get(k);
        if (prev && prev !== s.id) out.push(`${ctx} « ${k} » : ${prev} et ${s.id}`);
        seen.set(k, s.id);
      }
    }
  }
  // En Keyboard Focus ou au clavier MIDI, remplacer une lettre de NOVA doit être voulu (overridesNova).
  const novaKeys = new Map<string, string>();
  map.filter(s => s.owner === 'nova' && s.context === 'global').forEach(s => s.keys.forEach(k => novaKeys.set(k, s.id)));
  for (const s of map.filter(x => x.context === 'focus' || x.context === 'midi')) {
    for (const k of s.keys) if (novaKeys.has(k) && !s.overridesNova) out.push(`focus « ${k} » remplace ${novaKeys.get(k)} sans le dire`);
  }
  return out;
};

// --- Affichage -------------------------------------------------------------------

const KEY_LABELS: Record<string, string> = {
  ctrl: 'Ctrl', alt: 'Alt', shift: 'Maj', space: 'Espace', escape: 'Échap', enter: 'Entrée', home: 'Début', end: 'Fin',
  delete: 'Suppr', backspace: 'Retour arr.', tab: 'Tab', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
  numenter: 'Entrée (pavé)', numadd: 'Pavé +', numsub: 'Pavé −', numdec: 'Pavé .', nummul: 'Pavé *', numdiv: 'Pavé /',
  plus: '+', pageup: 'Page ↑', pagedown: 'Page ↓', insert: 'Inser',
};

export const chordLabel = (chord: string): string =>
  chord.split('+').filter(Boolean).map(p => KEY_LABELS[p] ?? (/^num\d$/.test(p) ? `Pavé ${p.slice(3)}` : /^f\d+$/.test(p) ? p.toUpperCase() : p.length === 1 ? p.toUpperCase() : p)).join(' + ');

export const shortcutKeysLabel = (s: ShortcutDef): string => s.keys.map(chordLabel).join(' · ');

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = ['Transport', 'Scrub et shuttle', 'Édition', 'Outils', 'Modes d’édition', 'Navigation', 'Zoom et affichage', 'Repères', 'Fenêtres', 'Dispositions', 'Keyboard Focus', 'Piano roll', 'Clavier MIDI'];

/** Recherche dans l'aide : libellé, touches, équivalent Pro Tools (sans accents ni casse). */
export const searchShortcuts = (query: string, map: ShortcutDef[] = runtime.map()): ShortcutDef[] => {
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
  const k = keysOf(id)[0];
  return k ? chordLabel(k) : '';
};
