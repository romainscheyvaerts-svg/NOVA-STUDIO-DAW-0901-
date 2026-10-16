/**
 * « Comment faire ? » : la base des PARCOURS de NOVA, source unique du DAW ET du chat.
 *
 * Un parcours = une démarche complète (enregistrer sa voix, comper ses prises, mettre de
 * l'autotune, exporter, mettre son morceau sur Spotify…), découpée en étapes courtes.
 * Chaque étape pointe vers ce qui existe VRAIMENT dans NOVA :
 *   - `action` : l'id d'une action de la palette Ctrl+K (App.tsx buildPaletteActions, ou un
 *     raccourci de utils/keymap) — « Fais-le pour moi » la lance ;
 *   - `target` : un sélecteur `[data-…="…"]` du bouton à montrer à l'écran (mode « Montre-moi »).
 * tests/guides.test.ts vérifie chaque id et chaque sélecteur dans le code : renommer une action
 * ou un attribut fait échouer le test, la base ne peut pas vieillir en silence.
 *
 * Utilisé par : components/HowToPanel (liste + recherche), components/HowToCoach (« Montre-moi »),
 * components/HowToHost (branchement, « Et après ? »), components/ChatAssistant (carte d'étapes),
 * utils/chatTools (outil GUIDE validé), App.tsx (questions « comment je fais pour… » sans l'IA)
 * et api/chat.ts (résumé COURT des parcours proches de la demande, jamais toute la base).
 *
 * Données pures (aucun React).
 */
import type { AIAction, DAWState, Track } from '../types';
import { TrackType } from '../types';
import { normText } from './commandPalette';
import { listTakes } from './takes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ce qu'il faut avoir avant de commencer (affiché en pastilles, dit par le chat). */
export type PrereqId = 'appli-windows' | 'compte' | 'micro' | 'casque' | 'licence-instru' | 'export-payant' | 'nova-pro' | 'internet' | 'distributeur';

export const PREREQ_LABELS: Record<PrereqId, string> = {
  'appli-windows': '💻 Appli NOVA pour Windows',
  compte: '👤 Un compte Make Music (gratuit, le même que sur studiomakemusic.com)',
  micro: '🎙️ Un micro (celui du téléphone suffit)',
  casque: '🎧 Un casque filaire',
  'licence-instru': '🛒 La licence de l’instru (si elle vient du catalogue)',
  'export-payant': '💳 Export payant selon ton offre (prix affiché, instru achetée = offert)',
  'nova-pro': '⭐ Nova Pro (pour toi seulement : tes invités ne paient rien)',
  internet: '📡 Une connexion internet',
  distributeur: '🌍 Un compte chez un distributeur (DistroKid, TuneCore…)',
};

/** Faits du projet et de l'appareil, lus par les étapes (sauter ce qui est fait, adapter au téléphone). */
export type FactId =
  | 'hasBeat' | 'hasVoiceTrack' | 'hasArmedTrack' | 'isRecording' | 'isPlaying' | 'hasTake' | 'takeStopped' | 'hasTwoTakes'
  | 'hasMixStyle' | 'hasVoicePreset' | 'hasAutotune' | 'hasSynthTrack' | 'hasDrumTrack' | 'hasMidiTrack'
  | 'hasSelectedTrack' | 'mobile' | 'simple' | 'desktopApp' | 'loggedIn' | 'inCollab';

export type GuideFacts = Record<FactId, boolean> & {
  /** Piste voix visée (sélectionnée si c'est une voix, sinon la piste REC, sinon la 1re voix). */
  voiceId?: string;
  selectedId?: string;
};

/** Étape faite quand un fait devient vrai, ou quand un élément apparaît (fenêtre ouverte). */
export type GuideDone = { fact: FactId } | { visible: string };

export interface GuideStep {
  /** Texte court, à l'impératif. */
  text: string;
  /** Variante téléphone (autre emplacement du bouton). */
  phone?: string;
  /** Id d'une action de la palette Ctrl+K : « Fais-le pour moi ». */
  action?: string;
  /**
   * Bouton à montrer : sélecteur `[data-…="…"]` (plusieurs = le premier visible). Jetons :
   * `{voice}` (piste voix visée), `{selected}` (piste sélectionnée).
   */
  target?: string | string[];
  /** Dit quand le bouton n'est pas à l'écran (« dans le menu ☰ »…). */
  hint?: string;
  /** Sans `done`, l'étape est faite au clic sur le bouton montré (ou par « Fais-le pour moi »). */
  done?: GuideDone;
  /** Déjà fait si ce fait est vrai (instru déjà chargée…) : sautée, marquée « déjà fait ». */
  skipIf?: FactId;
  /** Pas d'avance au clic sur le bouton montré (bloc où l'on choisit, écoute…) : « Passer › » ou `done`. */
  manual?: boolean;
  /** Seulement sur cet appareil. */
  device?: 'phone' | 'desktop';
  /** Seulement si (`when`) / sauf si (`unless`) ce fait est vrai au départ (mode simple…). */
  when?: FactId;
  unless?: FactId;
}

export interface Guide {
  id: string;
  emoji: string;
  title: string;
  /** Mots de recherche (synonymes, fautes courantes, anglais). */
  keywords: string;
  /** Une phrase : ce que fait le parcours. */
  summary: string;
  steps: GuideStep[];
  /** Ce qu'on obtient à la fin. */
  result: string;
  /** Pièges fréquents (vérifiés dans le code : messages, règles, limites). */
  pitfalls: string[];
  prereqs: PrereqId[];
  /**
   * « Fais-le pour moi » du chat : les appels d'outils (validés par utils/chatTools, les
   * sensibles demandent « Oui, fais-le ») qui font le gros du travail. Absent = rien à faire
   * à la place de l'artiste (choisir, chanter, payer restent à lui).
   */
  doIt?: (f: GuideFacts) => AIAction[];
}

// ---------------------------------------------------------------------------
// Les parcours
// ---------------------------------------------------------------------------

const nt = (v: string) => `[data-nova-target="${v}"]`;
const tid = (v: string) => `[data-testid="${v}"]`;
const cmd = (id: string, description: string): AIAction => ({ action: 'RUN_COMMAND', payload: { id }, description });

// Sélecteurs partagés.
const PHONE_MENU = tid('transport-menu');
/** Mode simple : le menu ☰ range le reste sous « Plus d'outils » (un toucher de plus). */
const MENU_PLUS = tid('menu-plus-toggle');
const EXPORT_OPEN: GuideDone = { visible: '[role="dialog"][aria-labelledby="export-title"]' };
const MIX_AUTO_OPEN: GuideDone = { visible: '[aria-labelledby="vocal-tools-title"]' };
const OPEN_NOVA = [tid('nova-open'), nt('tab-NOVA')];
const NOVA_OPEN: GuideDone = { visible: tid('nova-chat') };
const pickBeat: GuideStep[] = [
  { text: 'Choisis une instru dans le catalogue à gauche : écoute-la, puis « Essayer ».', target: [nt('beat-catalog'), '[data-bar-item="navigateur"]'],
    hint: 'Ouvre le navigateur (bouton ▥ en haut à gauche).', device: 'desktop', skipIf: 'hasBeat', done: { fact: 'hasBeat' } },
  { text: 'Ouvre l’onglet « Sons » en bas, écoute une instru, puis « Essayer ».', target: [nt('beat-catalog'), nt('tab-BROWSER')],
    device: 'phone', skipIf: 'hasBeat', done: { fact: 'hasBeat' } },
];

export const GUIDES: Guide[] = [
  {
    id: 'enregistrer-voix', emoji: '🎙️', title: 'Enregistrer ta voix sur une instru',
    keywords: 'enregistrer voix chanter rapper poser prise rec micro instru beat record vocal couplet refrain',
    summary: 'Choisir un beat, avoir une piste voix armée, REC, chanter, arrêter.',
    steps: [
      ...pickBeat,
      { text: 'Ajoute une piste voix : elle arrive armée, prête à enregistrer.', action: 'pal.voiceTrack', target: '[aria-label="Ajouter une piste voix"]',
        skipIf: 'hasVoiceTrack' },
      { text: 'Mets ton casque, puis appuie sur REC : décompte 4-3-2-1, et chante.', action: 'nova.record', target: nt('rec'), done: { fact: 'isRecording' } },
      { text: 'Réappuie sur REC (ou Stop) pour arrêter : ta prise est gardée, les blancs retirés.', target: nt('rec'), done: { fact: 'takeStopped' } },
    ],
    result: 'Ta voix est posée sur l’instru, calée sur son tempo. Une nouvelle prise par-dessus coupe l’ancienne sans l’effacer (Ctrl+Z si besoin).',
    pitfalls: [
      'Casque Bluetooth : il décale ta voix. Prends un casque filaire.',
      '« Aucune piste n’est prête à enregistrer » : ajoute une piste voix (ou clique le R de la piste).',
      'Rien ne s’enregistre : autorise le micro dans le navigateur (cadenas 🔒 de la barre d’adresse).',
      'Attends la fin du chargement du beat avant REC.',
    ],
    prereqs: ['micro', 'casque'],
    doIt: () => [{ action: 'PREPARE_PART', payload: { part: 'lead' }, description: 'Préparer la piste voix principale (micro armé, calage)' }],
  },
  {
    id: 'comp-prises', emoji: '🧩', title: 'Faire un comp de plusieurs prises',
    keywords: 'comp comping prises meilleure prise garder gardees choisir phrase par phrase couloirs take lanes playlist assembler',
    summary: 'Enregistrer plusieurs prises, les écouter, garder le meilleur de chacune.',
    steps: [
      { text: 'Enregistre au moins 2 prises sur la même piste : chaque nouvelle prise coupe l’ancienne, sans l’effacer.', action: 'nova.record', target: nt('rec'),
        skipIf: 'hasTwoTakes', done: { fact: 'hasTwoTakes' } },
      { text: 'Après chaque bonne prise, « 📌 Garder Prise N » (au-dessus de la piste REC) la met de côté pour choisir à la fin.', target: tid('kept-keep-last'), manual: true },
      { text: 'Ouvre « Mix auto » : le bloc « 🎙️ Mes prises » liste tes prises.', action: 'pal.mixAuto', target: nt('mix-auto'), done: { visible: '[data-mes-prises]' } },
      { text: 'Écoute chaque prise, puis « Garder » la meilleure, ou « Garder sur » une partie (couplet, refrain…).', target: '[data-mes-prises]', manual: true },
      { text: 'Ou laisse l’IA choisir phrase par phrase : « ✨ Meilleure prise », puis « ✓ Garder ce comp » ou « ↩ Revenir ».', target: '[data-mes-prises]', manual: true },
      { text: 'Pour le détail : le bouton « Prises » de la piste ouvre les couloirs. Glisse sur un passage pour le garder.', target: '[data-takes-button]',
        device: 'desktop', manual: true },
    ],
    result: 'Une seule prise « parfaite » faite des meilleurs passages. Les autres restent dans les couloirs, rien n’est effacé.',
    pitfalls: [
      'Il faut au moins 2 prises sur la même piste pour comper.',
      'Boucle allumée (L) : chaque passage de la boucle devient une prise, pratique pour enchaîner.',
      'Les couloirs détaillés sont sur ordinateur ; au téléphone, passe par « Mes prises » dans Mix auto.',
    ],
    prereqs: [],
    doIt: (f) => (f.hasTwoTakes ? [{ action: 'AUTO_COMP', payload: f.voiceId ? { trackId: f.voiceId } : {}, description: 'Meilleure prise, phrase par phrase (IA)' }] : []),
  },
  {
    id: 'autotune', emoji: '🤖', title: 'Mettre de l’autotune',
    keywords: 'autotune auto-tune auto tune robot justesse pitch voix juste corriger fausse t-pain trap melodyne',
    summary: 'L’Auto-Tune se cale sur la gamme de l’instru : un style de Mix auto suffit.',
    steps: [
      ...pickBeat.map(s => ({ ...s, text: `${s.text} L’Auto-Tune se règle sur sa gamme.` })),
      { text: 'Ouvre « Mix auto ».', action: 'pal.mixAuto', target: nt('mix-auto'), done: MIX_AUTO_OPEN },
      { text: 'Choisis « 🤖 Trap autotune » (effet robot). « Drill » et « Chant / R&B » en mettent une dose plus naturelle.', target: '[aria-labelledby="vocal-tools-title"]',
        done: { fact: 'hasAutotune' } },
      { text: 'Lance la lecture et écoute. Change de style pour comparer ; Ctrl+Z revient en arrière.', action: 'nova.play', hint: 'Barre d’espace, ou ▶ en haut.' },
      { text: 'Note par note : clique un clip voix, puis « Justesse note par note du clip » (Ctrl+K).', action: 'pal.pitch', unless: 'simple', manual: true },
    ],
    result: 'Ta voix est corrigée dans la tonalité du beat, du robot trap au naturel.',
    pitfalls: [
      '« Gamme inconnue » : l’Auto-Tune corrige alors sur toutes les notes. Charge une instru du catalogue, ou règle la gamme dans le piano roll (« Gamme »).',
      'Un style de Mix auto remplace les effets de tes pistes voix (Ctrl+Z pour revenir).',
      'Melodyne (ARA) : seulement dans l’appli Windows, avec Melodyne installé.',
    ],
    prereqs: [],
    doIt: () => [{ action: 'APPLY_MIX_STYLE', payload: { style: 'trap-autotune' }, description: 'Style « Trap autotune »' }],
  },
  {
    id: 'backs', emoji: '🎤', title: 'Faire les backs, harmonies et ad-libs',
    keywords: 'backs back doublage doubler choeurs choeur harmonie harmonies adlib ad-libs adlibs fins de phrase punchline seconde voix',
    summary: 'Après la voix principale, Nova prépare une piste par partie, micro armé et calé.',
    steps: [
      { text: 'Enregistre d’abord ta voix principale.', action: 'nova.record', target: nt('rec'), skipIf: 'hasTake', done: { fact: 'takeStopped' } },
      { text: 'Ouvre Nova, ton ingé son.', phone: 'Ouvre l’onglet « Nova » en bas.', target: OPEN_NOVA, done: NOVA_OPEN },
      { text: 'Touche « Faire les backs » : Nova crée la piste BACKS, arme le micro et se cale 2 s avant ta voix.', target: tid('nova-quick-backs') },
      { text: 'Reviens sur l’onglet « Morceau » en bas.', target: nt('tab-ARRANGEMENT'), device: 'phone' },
      { text: 'Appuie sur REC et rechante tes fins de phrase et tes punchlines.', action: 'nova.record', target: nt('rec'), done: { fact: 'isRecording' } },
      { text: 'Ensuite, Nova propose « ➡️ Harmonies » et « ➡️ Ad-libs » : même chemin.', target: [tid('nova-chat'), ...OPEN_NOVA], manual: true },
    ],
    result: 'Des pistes BACKS, HARMONIES, AD-LIBS avec la chaîne de ta voix ; après la prise, Nova les baisse et les écarte comme au studio.',
    pitfalls: [
      'Sans casque, le beat repasse dans le micro : mets un casque.',
      'Garde le même placement que ta voix principale (mêmes mots, même énergie).',
    ],
    prereqs: ['micro', 'casque'],
    doIt: () => [{ action: 'PREPARE_PART', payload: { part: 'back' }, description: 'Préparer les backs (piste, micro armé, calage)' }],
  },
  {
    id: 'mixer-voix', emoji: '🎚️', title: 'Mixer ta voix',
    keywords: 'mix mixer mixage voix son pro effets eq compresseur reverb reverbe style preset one knob decris ton son niveaux',
    summary: 'Un style de Mix auto, puis Nova écoute tes niveaux et te dit quoi corriger.',
    steps: [
      { text: 'Ouvre « Mix auto ».', action: 'pal.mixAuto', target: nt('mix-auto'), done: MIX_AUTO_OPEN, skipIf: 'hasMixStyle' },
      { text: 'Choisis un style : Rap clair, Trap autotune, Drill, Chant / R&B, Voix brute ou Effet téléphone.', target: '[aria-labelledby="vocal-tools-title"]',
        done: { fact: 'hasMixStyle' } },
      { text: 'Lance la lecture et compare les styles. Ctrl+Z revient en arrière.', action: 'nova.play', hint: 'Barre d’espace, ou ▶ en haut.' },
      { text: 'Ouvre Nova et touche « Écoute mon mix » : elle mesure tes niveaux et te montre quoi régler.', phone: 'Onglet « Nova », puis « Écoute mon mix ».',
        target: [tid('nova-quick-listen'), ...OPEN_NOVA], manual: true },
      { text: 'Plus loin : dans la console, le One Knob de ta piste voix (presets voix, « Décris ton son »).', action: 'view.mixer',
        target: '[data-testid="one-knob-open-{voice}"]', unless: 'simple', manual: true },
    ],
    result: 'Une voix propre et placée sur le beat, avec un retour chiffré de Nova sur ce qui reste à corriger.',
    pitfalls: [
      'Un style remplace les effets de toutes tes pistes voix (Ctrl+Z annule).',
      'Le One Knob et les presets voix sont dans la console : passe en mode avancé.',
      'Écoute au casque ET sur une autre écoute (téléphone, voiture) avant d’exporter.',
    ],
    prereqs: [],
    doIt: (f) => [
      ...(f.hasMixStyle ? [] : [{ action: 'APPLY_MIX_STYLE', payload: { style: 'rap-clair' }, description: 'Style « Rap clair » (change-le dans Mix auto)' } as AIAction]),
      { action: 'ANALYZE_MIX', payload: {}, description: 'Écouter le mix et lister les corrections' },
    ],
  },
  {
    id: 'exporter', emoji: '💾', title: 'Exporter ton morceau',
    keywords: 'exporter export telecharger fichier wav mp3 bounce stems voix seule demo sortir rendre',
    summary: 'Le mix, les stems ou les voix seules, en WAV ou MP3.',
    steps: [
      { text: 'Ouvre « Exporter » (en haut, ou Ctrl+Maj+E).', phone: 'Touche « Exporter » (flèche ⬆ en haut), ou ☰ › « Exporter ».', action: 'nova.export',
        target: ['[data-bar-item="exporter"]', tid('phone-export'), tid('menu-export'), PHONE_MENU], done: EXPORT_OPEN },
      { text: 'Choisis quoi exporter : « Mon morceau complet », ou « ⚙️ Réglages avancés » (mix, stems, voix seules, WAV ou MP3).', target: '[aria-labelledby="export-title"]', manual: true },
      { text: 'Débloque si besoin : instru achetée = export offert ; sinon l’export de ce projet ou Nova Pro (prix affiché).', target: [tid('export-paywall'), '[aria-labelledby="export-title"]'], manual: true },
    ],
    result: 'Ton fichier se télécharge sur ton appareil.',
    pitfalls: [
      'Instru du catalogue non achetée : démo gratuite seulement, ou « Acheter l’instru ».',
      'Kits de batterie NOVA dans le projet : l’export est toujours payant.',
      'Nova n’achète jamais rien à ta place : le paiement se fait dans la fenêtre.',
    ],
    prereqs: ['export-payant', 'licence-instru'],
    doIt: () => [{ action: 'OPEN_EXPORT', payload: {}, description: 'Ouvrir la fenêtre d’export' }],
  },
  {
    id: 'masteriser', emoji: '✨', title: 'Masteriser avec Master Nova',
    keywords: 'master mastering masteriser loudness lufs fort volume spotify plateforme finaliser reference',
    summary: 'Choisir la plateforme, analyser, appliquer sur le master.',
    steps: [
      { text: 'Ouvre « Master Nova ».', phone: 'Touche ☰ › « Plus d’outils » › « Master Nova ».', action: 'pal.masterNova',
        target: ['[data-bar-item="master"]', tid('menu-master-nova'), MENU_PLUS, PHONE_MENU], done: { visible: '[role="dialog"][aria-label="Master Nova"]' } },
      { text: 'Dis où va ton morceau : Spotify, Apple, YouTube, Deezer, TikTok ou club.', target: '[data-nova-cible]' },
      { text: '« Analyser et masteriser », puis écoute.', target: '[data-nova-master-run]' },
      { text: '« Appliquer sur le master ».', target: '[data-nova-master-apply]' },
    ],
    result: 'Ton morceau sonne fort et propre pour la plateforme choisie.',
    pitfalls: [
      '« Le mix est silencieux » : rien à masteriser, vérifie tes pistes.',
      'Le master ne rattrape pas un mauvais mix : équilibre d’abord ta voix et le beat.',
      'Un morceau déjà fini (un seul fichier) : ☰ → « Masteriser un morceau ».',
    ],
    prereqs: [],
    doIt: () => [cmd('pal.masterNova', 'Ouvrir Master Nova')],
  },
  {
    id: 'spotify', emoji: '🚀', title: 'Mettre ton morceau sur Spotify, Apple, TikTok',
    keywords: 'spotify apple music deezer tiktok youtube distribution distribuer sortir publier plateforme streaming distrokid tunecore isrc pochette',
    summary: 'NOVA vérifie ton morceau et prépare le paquet ; un distributeur le met en ligne.',
    steps: [
      { text: 'Ouvre « Exporter ».', phone: 'Touche « Exporter » (flèche ⬆ en haut), ou ☰ › « Exporter ».', action: 'nova.export',
        target: ['[data-bar-item="exporter"]', tid('phone-export'), tid('menu-export'), PHONE_MENU], done: EXPORT_OPEN },
      { text: 'Touche « 🚀 Prêt pour Spotify / Apple / TikTok ? » (sous « ⚙️ Réglages avancés »).', target: [tid('export-distribution'), tid('export-avance')], done: { visible: tid('distribution-panel') } },
      { text: 'Choisis la plateforme, puis « Vérifier mon morceau ».', target: tid('dist-analyze') },
      { text: 'Corrige les feux rouges (« Corriger : … ») et remplis titre, artiste, année.', target: tid('dist-form'), manual: true },
      { text: '« Télécharger le paquet Livraison (.zip) ».', target: tid('dist-package') },
      { text: 'Envoie le WAV et la pochette à ton distributeur (DistroKid, TuneCore, CD Baby…) : c’est lui qui publie.', target: [tid('dist-done'), tid('dist-package')], manual: true },
    ],
    result: 'Un paquet prêt pour les plateformes (WAV, pochette, infos). NOVA ne publie pas à ta place : ton distributeur le fait.',
    pitfalls: [
      'Instru du catalogue : il faut sa licence (« Acheter la licence ») pour distribuer.',
      'Le paquet se télécharge seulement si l’export est débloqué (licence, paiement ou Nova Pro).',
    ],
    prereqs: ['licence-instru', 'export-payant', 'distributeur'],
  },
  {
    id: 'clip-tiktok', emoji: '🎬', title: 'Faire un clip TikTok / Reels avec tes paroles',
    keywords: 'clip video tiktok reels instagram shorts paroles karaoke lyrics vertical mp4 reseaux',
    summary: 'Une vidéo verticale avec tes paroles synchronisées, prête à poster.',
    steps: [
      { text: 'Ouvre « 🎬 Clip pour TikTok / Reels » (Ctrl+K).', action: 'pal.lyricClip', done: { visible: tid('lyric-clip') } },
      { text: 'Ajoute tes paroles : « Taper les paroles » (la transcription automatique est dans l’appli Windows).', target: [tid('clip-type-lyrics'), tid('lyric-clip')], manual: true },
      { text: '« 🎬 Créer le clip ».', target: tid('clip-export') },
    ],
    result: 'Un MP4 vertical avec tes paroles qui défilent, à poster sur TikTok, Reels ou Shorts.',
    pitfalls: [
      'Instru non achetée et export non payé : clip limité à 30 s, avec ta voix sur au moins la moitié.',
      'Ouvre NOVA dans Chrome ou Edge pour créer la vidéo.',
    ],
    prereqs: [],
    doIt: () => [cmd('pal.lyricClip', 'Ouvrir le clip TikTok / Reels')],
  },
  {
    id: 'partager', emoji: '📲', title: 'Faire écouter un extrait',
    keywords: 'partager extrait ecouter envoyer whatsapp insta story demo 30 secondes faire ecouter pote',
    summary: 'Un extrait de 30 s (vidéo ou audio) ou la démo complète, à envoyer.',
    steps: [
      { text: 'Ouvre « Partager » (Ctrl+K : « partager »).', phone: 'Touche « Exporter » (flèche ⬆ en haut), puis « Extrait 30 s pour les réseaux ».', action: 'pal.share',
        target: ['[data-bar-item="partager"]', tid('export-share'), tid('phone-export')], done: { visible: '[aria-labelledby="share-title"]' } },
      { text: 'Choisis « 📼 Vidéo rapide 30 s », « 🎧 Extrait audio 30 s » ou « ⬇️ Démo complète (MP3) ».', target: '[aria-labelledby="share-title"]', manual: true },
    ],
    result: 'Un fichier prêt à envoyer (WhatsApp, Insta, mail), signé Make Music.',
    pitfalls: ['« Enregistre d’abord une prise » : il faut ta voix sur le beat.'],
    prereqs: [],
    doIt: () => [{ action: 'OPEN_SHARE', payload: {}, description: 'Ouvrir le partage' }],
  },
  {
    id: 'sauvegarder', emoji: '🗂️', title: 'Sauvegarder et rouvrir ton projet',
    keywords: 'sauvegarder sauver enregistrer projet ouvrir rouvrir charger retrouver fichier zip version perdu',
    summary: 'En ligne avec un compte, ou en fichier .zip sur ton appareil.',
    steps: [
      { text: 'Ouvre « Sauvegarder » (Ctrl+S).', phone: 'Touche ☰, puis « Sauvegarder ».', action: 'nova.save',
        target: ['[data-bar-item="sauver"]', tid('menu-save'), PHONE_MENU], done: { visible: tid('save-new-version-box') } },
      { text: 'En ligne : « Emporter la session » (compte Make Music). Sans compte : « Fichier sur cet appareil (.zip) ».', target: tid('save-new-version-box'), manual: true },
      { text: 'Pour le retrouver : « Ouvrir un projet ».', phone: 'Touche ☰, puis « Ouvrir un projet ».', action: 'pal.open',
        target: ['[data-bar-item="ouvrir"]', tid('menu-open-project'), PHONE_MENU], manual: true },
    ],
    result: 'Ton projet est en sécurité ; NOVA garde aussi une sauvegarde automatique dans ce navigateur.',
    pitfalls: [
      'Sans compte, la sauvegarde automatique reste dans CE navigateur : fais un .zip pour changer d’appareil.',
      'Les versions de la session restent sur cet appareil.',
    ],
    prereqs: [],
    doIt: () => [cmd('nova.save', 'Ouvrir la sauvegarde')],
  },
  {
    id: 'creer-compte', emoji: '👤', title: 'Créer ton compte Make Music (gratuit)',
    keywords: 'compte creer inscription inscrire s inscrire connexion connecter login sign up register mot de passe email studiomakemusic',
    summary: 'Le même compte que sur studiomakemusic.com : en ligne, Nova Pro, collaboration, instrus.',
    steps: [
      { text: 'Touche « Connexion » en haut à droite.', phone: 'Touche ☰, puis « Se connecter ».', action: 'pal.signup',
        target: ['[aria-label="Connexion"]', PHONE_MENU], unless: 'loggedIn', done: { visible: '[role="dialog"][aria-label="Connexion"]' } },
      { text: 'Touche « Créer un compte ».', target: tid('auth-signup-open'), unless: 'loggedIn', done: { visible: '[data-mm-signup="form"]' } },
      { text: 'Ton nom, ton e-mail, un mot de passe (12 caractères, une majuscule, une minuscule, un chiffre), puis « Créer mon compte ».',
        target: '[data-mm-signup="form"]', unless: 'loggedIn', done: { visible: '[data-mm-signup="sent"]' } },
      { text: 'Clique le lien reçu par e-mail (regarde les spams), puis « J’ai confirmé, me connecter ».', target: '[data-mm-signup="sent"]', manual: true },
    ],
    result: 'Ton compte Make Music : connecte-toi avec lui dans NOVA, l’appli Windows et sur studiomakemusic.com.',
    pitfalls: [
      'Tu as déjà un compte sur studiomakemusic.com ? Connecte-toi avec lui, inutile d’en créer un autre.',
      'Rien reçu ? « Renvoyer l’e-mail », et regarde dans les spams.',
      'Projets en ligne avec ce compte : « Sauvegarder » → « Emporter la session ».',
    ],
    prereqs: ['internet'],
    doIt: () => [cmd('pal.signup', 'Ouvrir la création de compte Make Music')],
  },
  {
    id: 'emporter', emoji: '🏠', title: 'Continuer sur un autre appareil',
    keywords: 'emporter session autre appareil telephone ordi maison qr code lien en ligne continuer reprendre cloud',
    summary: 'Mettre la session en ligne et l’ouvrir ailleurs par un lien ou un QR code.',
    steps: [
      { text: 'Ouvre « Sauvegarder » (Ctrl+S).', phone: 'Touche ☰, puis « Sauvegarder ».', action: 'nova.save',
        target: ['[data-bar-item="sauver"]', tid('menu-save'), PHONE_MENU], done: { visible: tid('save-takehome') } },
      { text: 'Touche « 🏠 Emporter la session (en ligne) ».', target: tid('save-takehome'), done: { visible: '[aria-labelledby="takehome-title"]' } },
      { text: '« Mettre la session en ligne ».', target: tid('takehome-sync'), done: { visible: tid('takehome-url') } },
      { text: 'Scanne le QR code, ou copie le lien et envoie-le (WhatsApp, e-mail).', target: tid('takehome-url'), manual: true },
    ],
    result: 'La même session s’ouvre sur ton autre appareil, avec tes prises.',
    pitfalls: ['Le lien donne accès à la session : ne l’envoie qu’à toi ou à ton équipe.'],
    prereqs: ['internet'],
  },
  {
    id: 'collab', emoji: '👥', title: 'Inviter un ingé son ou un artiste',
    keywords: 'inviter collaborer collaboration collab feat featuring inge ingenieur son distance a distance artiste beatmaker lien code session ensemble notification notifications prevenu alerte',
    summary: 'Une séance partagée en direct, ou un ingé qui mixe à distance avec ses plugins.',
    steps: [
      { text: 'Ouvre « Collaborer » (en bas ; en mode simple : ☰ › « Plus d’outils » › « Collaborer à distance »).', phone: 'Touche ☰ › « Plus d’outils » › « Collaborer à distance ».', action: 'pal.collab',
        target: ['[aria-label="Collaborer"]', tid('menu-collab'), MENU_PLUS, PHONE_MENU], done: { visible: '[aria-labelledby="collab-title"]' } },
      { text: 'Choisis « En direct » ou « Ingé à distance (ses propres VST) », ton rôle et ton nom, puis démarre.', target: tid('collab-role'),
        done: { visible: `${tid('collab-invite-copy')}, ${tid('remote-panel')}` } },
      { text: '« 🔗 Copier le lien » (ou donne le code à 6 caractères, valable 24 h) et envoie-le.', target: [tid('collab-invite-copy'), tid('remote-panel')], manual: true },
      { text: 'Ton invité ouvre le lien, choisit son rôle et rejoint : il apparaît dans la liste.', target: [tid('collab-members'), tid('remote-panel')], manual: true },
      { text: 'Quand NOVA propose « 🔔 Être prévenu… », touche « Activer » : tu sauras quand ton invité commente ou envoie une prise.', target: tid('notif-ask-yes'),
        hint: 'Plus tard : Ctrl+K › « Notifications » (compte connecté).', manual: true },
    ],
    result: 'Vous travaillez sur la même séance (4 personnes au plus) ; l’ingé à distance renvoie son mix tout seul.',
    pitfalls: [
      '« Code inconnu ou expiré » : un code dure 24 h, crée-en un nouveau.',
      'L’ingé « à distance » travaille dans l’appli Windows, avec ses plugins.',
      'Une instru du catalogue non achetée n’est pas envoyée aux invités.',
      'Notifications sur iPhone : ajoute d’abord NOVA à l’écran d’accueil ; dans l’appli Windows, elles arrivent tant que Nova Studio est ouvert.',
      'Ton invité n’a rien à payer : un compte gratuit suffit pour rejoindre. Seul l’hôte a Nova Pro.',
    ],
    prereqs: ['compte', 'nova-pro'],
    doIt: () => [cmd('pal.collab', 'Ouvrir la collaboration')],
  },
  {
    id: 'faire-sa-version', emoji: '🎁', title: 'Envoyer ta séance à plusieurs artistes (chacun sa version)',
    keywords: 'faire sa version copie copier dupliquer fork remix envoyer seance session plusieurs rappeurs artistes beatmaker stems pistes lien chacun',
    summary: 'Un lien qui donne à chacun SA copie privée de ta séance : pistes, tempo, accords. Ton original ne bouge pas.',
    steps: [
      { text: 'Ouvre « Faire sa version » (Ctrl+K : « version »).', action: 'pal.forkLink', done: { visible: '[aria-labelledby="share-session-t"]' } },
      { text: 'Connecte-toi à ton compte Make Music (gratuit) dans la fenêtre : le lien est à ton nom.', target: tid('share-signin'), unless: 'loggedIn',
        done: { visible: tid('fork-create') } },
      { text: 'Écris pour qui (facultatif), puis « Créer le lien » : ta séance est mise en ligne et le lien est copié.', target: tid('fork-create'), done: { visible: tid('fork-url') } },
      { text: 'Envoie le lien (WhatsApp, Insta, mail). Chacun se connecte (gratuit) et reçoit sa version ; le compteur te dit combien l’ont prise.', target: tid('fork-url'), manual: true },
    ],
    result: 'Chaque artiste travaille sur sa propre copie ; tu désactives le lien quand tu veux.',
    pitfalls: [
      'La copie reprend ta séance telle qu’elle est quand tu crées le lien : refais un lien après de gros changements.',
      'Une instru du catalogue n’est pas copiée : chacun la retrouve dans le catalogue, et sa licence reste à acheter pour exporter.',
      'En gratuit, un seul projet en ligne à la fois (gardé 7 jours) : le lien vit tant que la séance est en ligne.',
    ],
    prereqs: ['compte', 'internet'],
    doIt: () => [cmd('pal.forkLink', 'Ouvrir « Faire sa version »')],
  },
  {
    id: 'page-publique', emoji: '🌍', title: 'Publier une page de ton morceau (lecteur à intégrer)',
    keywords: 'page publique publier morceau lecteur embed integrer iframe site lien public soundcloud bandcamp ecouter partager reserver studio',
    summary: 'Une page avec ton morceau (extrait ou mix), ta pochette et tes crédits, un lecteur à mettre sur ton site, et « Réserver au studio Make Music ».',
    steps: [
      { text: 'Ouvre « Page publique du morceau » (Ctrl+K : « page publique »).', action: 'pal.publicPage', done: { visible: '[aria-labelledby="share-session-t"]' } },
      { text: 'Connecte-toi à ton compte Make Music (gratuit) dans la fenêtre : la page est à ton nom.', target: tid('share-signin'), unless: 'loggedIn',
        done: { visible: tid('pub-title') } },
      { text: 'Écris le titre, l’artiste et les crédits ; choisis l’extrait de 30 s ou le morceau entier.', target: tid('pub-title'), manual: true },
      { text: 'Coche « Je publie ce morceau », puis « Publier la page ».', target: [tid('pub-consent'), tid('pub-publish')], done: { visible: tid('pub-url') } },
      { text: 'Copie le lien de la page, ou le code du lecteur pour ton site.', target: tid('pub-url'), manual: true },
    ],
    result: 'Ton morceau a sa page publique ; tu la retires d’un clic quand tu veux.',
    pitfalls: [
      'Le morceau entier se publie seulement quand son export est débloqué (Nova Pro ou export du projet) ; sinon l’extrait de 30 s.',
      'Pas de téléchargement sur la page, et jamais tes pistes séparées.',
    ],
    prereqs: ['compte', 'internet'],
    doIt: () => [cmd('pal.publicPage', 'Ouvrir la page publique')],
  },
  {
    id: 'synthe', emoji: '🎹', title: 'Composer avec le synthé NOVA',
    keywords: 'synthe synth synthetiseur clavier piano notes melodie composer instrument pad nappe lead pluck rhodes midi piano roll',
    summary: 'Une piste synthé, un son, puis les notes au piano roll ou au clavier.',
    steps: [
      { text: 'Crée une piste « 🎹 Synthé NOVA » (Ctrl+K : « synthé »).', action: 'pal.synth', target: tid('new-synth-track'),
        hint: 'Le bouton « Synthé » n’est en bas qu’en mode instru.', done: { visible: tid('synth-panel') } },
      { text: 'Choisis un son dans la liste et essaie-le au mini-clavier.', target: tid('synth-presets'), manual: true },
      { text: 'Ferme la fenêtre du son : tu es dans le piano roll. Clique pour poser une note, glisse pour l’allonger.', target: '[aria-label="Fermer le synthé"]' },
      { text: 'Ou joue au clavier de l’ordi (Ctrl+Maj+K : Q S D F G H J K L M), ou avec un clavier MIDI.', action: 'nova.computerKeyboard',
        target: '[data-nova-roll="clavier"]', device: 'desktop', manual: true },
    ],
    result: 'Une mélodie au synthé dans ton morceau, que tu peux modifier note par note.',
    pitfalls: [
      'Safari et l’iPhone ne lisent pas les claviers MIDI : utilise Chrome ou Edge.',
      'Les boutons « beat » (Synthé, Batterie, 808) sont en bas en mode instru ; sinon passe par Ctrl+K.',
    ],
    prereqs: [],
    doIt: () => [cmd('pal.synth', 'Nouvelle piste Synthé NOVA')],
  },
  {
    id: 'batterie-kits', emoji: '🥁', title: 'Faire une batterie avec les kits',
    keywords: 'batterie drums beat kit kits boite a rythmes rythme pas a pas sequenceur kick snare hihat charley 808 percussions faire une instru',
    summary: 'Un kit prêt à jouer, puis le rythme pas à pas.',
    steps: [
      { text: 'Ouvre la batterie (Ctrl+K : « batterie »).', action: 'pal.drums', target: '[aria-label="Batterie"]', done: { visible: '[aria-labelledby="drums-title"]' } },
      { text: 'Touche « Kits ».', target: tid('open-kits'), done: { visible: tid('kit-load') } },
      { text: 'Écoute un kit, puis « Charger ce kit ».', target: tid('kit-load') },
      { text: 'Allume les pas (cases) de chaque son, puis « Écouter ». Une 808 ? « Basse 808 » (Ctrl+K).', target: '[aria-labelledby="drums-title"]', manual: true },
    ],
    result: 'Un rythme qui tourne en boucle avec les sons du kit.',
    pitfalls: ['Un projet avec les kits NOVA s’exporte toujours en payant (export du projet ou Nova Pro).'],
    prereqs: ['export-payant'],
    doIt: () => [cmd('pal.drums', 'Ouvrir la batterie')],
  },
  {
    id: 'demarrer-beat', emoji: '🎲', title: 'Démarrer un beat (genre, batterie, accords, 808)',
    keywords: 'demarrer commencer beat prod instru squelette idee songstarter trap drill boom bap rnb afro accords progression suite 808 de variante prolonger varier extend recompose composer',
    summary: 'Un squelette de 8 mesures à base de règles du genre (tempo, batterie, accords, 808), puis tu le modifies.',
    steps: [
      { text: 'Ouvre « 🎲 Démarrer un beat » (Ctrl+K : « démarrer un beat »).', action: 'pal.startBeat', done: { visible: tid('beat-starter') } },
      { text: 'Choisis le genre, puis la tonalité (tonique, mineur ou majeur).', target: tid('beat-genre-trap'), manual: true },
      { text: 'Écoute les 3 variantes ; « 🎲 Relancer le dé » en propose 3 autres.', target: tid('beat-dice'), manual: true },
      { text: 'Touche « Poser le squelette » : batterie, 808, instrument et piste d’accords arrivent en une fois.', target: tid('beat-apply') },
      { text: 'Pour aller plus loin : sélectionne un clip MIDI, puis « Prolonger ou varier » (Ctrl+K).', action: 'pal.varyMidi', done: { visible: tid('pattern-vary') } },
    ],
    result: 'Un beat de 8 mesures qui tourne, que tu modifies note par note.',
    pitfalls: [
      'Une instru est déjà chargée : le squelette garde son tempo et sa tonalité.',
      'Rien n’est généré par une IA : ce sont des recettes de genre (tempo, motifs connus, accords classiques).',
      'Les sons des kits NOVA s’exportent en payant (export du projet ou Nova Pro).',
    ],
    prereqs: ['export-payant'],
    doIt: () => [cmd('pal.startBeat', 'Ouvrir Démarrer un beat')],
  },
  {
    id: 'sons-boucles', emoji: '🔎', title: 'Trouver un son ou une boucle (et la Palette)',
    keywords: 'sons samples one shot oneshot boucle loop navigateur bibliotheque kick snare hihat 808 perc fx splice bandlab sounds palette assortie tonalite bpm genre',
    summary: 'Filtre par type, genre, tempo et tonalité, écoute, puis pose sur une piste ou un pad.',
    steps: [
      { text: 'Ouvre « 🔎 Sons et boucles » (Ctrl+K : « sons »).', action: 'pal.sounds', done: { visible: tid('sound-library') } },
      { text: 'Choisis un type (Kick, 808…) ou un genre, et tape un mot si besoin.', target: tid('sounds-search'), manual: true },
      { text: 'Touche ▶ pour écouter, puis « Sur un pad » ou « Poser ». Au PC, tu peux glisser sur la timeline.', target: tid('sound-place') },
      { text: 'Onglet « 🎨 Palette » : 2 à 5 boucles dans ta tonalité et ton tempo, puis « Tout poser ».', target: tid('sounds-tab-palette'), manual: true },
    ],
    result: 'Des sons et des boucles NOVA dans ton morceau, calés sur la mesure.',
    pitfalls: [
      'Les sons NOVA ne se téléchargent pas : ils servent dans tes morceaux, exportés selon ton offre.',
      'Une boucle de batterie remplace le motif de la boîte à rythmes (Ctrl+Z pour revenir).',
    ],
    prereqs: ['export-payant'],
    doIt: () => [cmd('pal.sounds', 'Ouvrir les sons et boucles')],
  },
  {
    id: 'importer-instru', emoji: '📂', title: 'Importer ta propre instru',
    keywords: 'importer instru beat fichier wav mp3 mon beat ma prod charger import changer de beat remplacer',
    summary: 'Ton fichier sur la piste BEAT, puis le tempo réglé dessus.',
    steps: [
      { text: 'Lance « Importer un fichier audio » (Ctrl+K) et choisis ton beat.', action: 'pal.importAudio', done: { visible: `${tid('import-tempo-card')}, ${tid('pro-gate')}` } },
      { text: 'Accepte « Régler le projet à … BPM » pour caler le tempo (et la tonalité).', target: tid('import-tempo-card'), manual: true },
      { text: 'Déjà des voix posées ? « Changer de beat » dans Mix auto garde tes voix.', target: [tid('r23-swap'), nt('mix-auto')], manual: true },
    ],
    result: 'Ton beat est sur la piste BEAT, le projet suit son tempo.',
    pitfalls: [
      'Importer un fichier demande Nova Pro.',
      'Tempo mal détecté : ouvre « Tempo et mesure » et tape le tempo (T).',
    ],
    prereqs: ['nova-pro'],
    doIt: () => [cmd('pal.importAudio', 'Importer un fichier audio')],
  },
  {
    id: 'tempo', emoji: '⏱️', title: 'Régler le tempo',
    keywords: 'tempo bpm vitesse mesure tap taper caler rythme lent rapide',
    summary: 'Taper le tempo ou l’écrire ; la mesure se règle au même endroit.',
    steps: [
      { text: 'Ouvre « Tempo et mesure » (touche le BPM en haut, ou Ctrl+K : « tempo »).', action: 'pal.tempo', target: [tid('transport-bpm'), tid('open-tempo')],
        hint: 'Le BPM n’est pas affiché en haut en mode simple.', done: { visible: tid('tempo-dialog') } },
      { text: 'Écris le BPM, ou tape « Tap » en rythme puis « Utiliser … BPM ».', target: tid('tempo-tap'), manual: true },
    ],
    result: 'Le projet, le clic et la grille suivent le nouveau tempo.',
    pitfalls: [
      'Une instru du catalogue règle déjà le tempo et la tonalité toute seule.',
      'La tonalité ne se règle pas ici : piano roll → « Gamme », ou demande à Nova.',
    ],
    prereqs: [],
  },
  {
    id: 'micro-latence', emoji: '🔌', title: 'Brancher ton micro et régler le retard',
    keywords: 'micro carte son interface entree latence retard decalage asio casque retour reglages audio branchement focusrite',
    summary: 'Choisir l’entrée micro et la sortie casque ; le retard est compensé tout seul.',
    steps: [
      { text: 'Ouvre « Réglages audio » (en mode simple : ☰ › « Plus d’outils »).', phone: 'Touche ☰ › « Plus d’outils » › « Réglages audio ».', action: 'pal.audio',
        target: ['[aria-label="Réglages audio"]', tid('menu-audio'), MENU_PLUS, PHONE_MENU], done: { visible: tid('audio-input-select') } },
      { text: 'Choisis ton micro dans « Entrée (micro) » et ton casque dans « Sortie ».', target: tid('audio-input-select'), manual: true },
      { text: 'Fais une prise test : NOVA mesure le retard et recale tes prises tout seul.', action: 'nova.record', target: nt('rec'), done: { fact: 'isRecording' } },
    ],
    result: 'Ta voix arrive par le bon micro, pile en rythme sur le beat.',
    pitfalls: [
      '« Micro inaccessible » : autorise le micro (🔒 dans la barre d’adresse).',
      'Plus de 110 ms de retard : casque Bluetooth ? Prends un casque filaire.',
      'Carte son pro en ASIO : seulement dans l’appli Windows.',
    ],
    prereqs: ['micro'],
    doIt: () => [cmd('pal.audio', 'Ouvrir les réglages audio')],
  },
  {
    id: 'vst', emoji: '🧩', title: 'Utiliser tes plugins VST',
    keywords: 'vst vst3 plugin plugins waves fabfilter antares effets du pc pont bridge windows',
    summary: 'Dans l’appli Windows, le pont VST charge tes plugins sur tes pistes.',
    steps: [
      { text: 'Passe en mode avancé.', action: 'pal.simple', target: '[data-bar-item="vues"]', when: 'simple' },
      { text: 'Ouvre le navigateur, onglet « VST ».', target: [tid('browser-tab-vst'), '[data-bar-item="navigateur"]'], device: 'desktop' },
      { text: '« Connecter le pont VST » (il est intégré à l’appli Windows).', target: tid('vst-connect'), done: { visible: '[data-vst-plugin]' } },
      { text: 'Sélectionne ta piste, cherche ton plugin et clique-le : il s’ajoute à la piste.', target: '[data-vst-plugin]', manual: true },
    ],
    result: 'Tes plugins du PC tournent dans NOVA, sur tes pistes.',
    pitfalls: [
      'Sur le site, il faut l’appli NOVA pour Windows (gratuite, compte requis).',
      'Un plugin demande son activation de licence : fais-la dans sa fenêtre sur le PC.',
    ],
    prereqs: ['appli-windows', 'compte'],
  },
  {
    id: 'stems', emoji: '🪓', title: 'Séparer un morceau en stems',
    keywords: 'stems separer separation voix batterie basse acapella instrumental demucs extraire isoler',
    summary: 'Voix, batterie, basse et le reste, chacun sur sa piste.',
    steps: [
      { text: 'Clic droit sur le clip à séparer (dans la timeline) → « Traitement » → « Séparer en stems… ».', target: nt('track-instrumental'),
        device: 'desktop', done: { visible: tid('stems-dialog') } },
      { text: 'Choisis 2 stems (voix + instru) ou 4 stems, puis « Séparer ». Sur le site, la 1re fois télécharge le modèle (~250 Mo, une fois).', target: [tid('stems-start'), tid('stems-dialog')], manual: true },
    ],
    result: 'Une piste par stem, alignée sur l’original (coupé, pas effacé).',
    pitfalls: [
      'Sur le site, le calcul se fait dans ton navigateur : rapide avec une carte graphique (Chrome ou Edge à jour), lent sur le processeur seul.',
      '6 stems (guitare, piano) et voix lead / chœurs : seulement dans l’appli Windows, bien plus rapide.',
      'Instru du catalogue sans licence : séparation refusée. Tes propres sons : libre.',
      'Au téléphone : possible si le navigateur a accès à la carte graphique ; sinon, sépare sur ton PC. En 4G, attends le Wi-Fi pour le 1er téléchargement.',
    ],
    prereqs: ['licence-instru'],
  },
  {
    id: 'paroles', emoji: '📝', title: 'Afficher tes paroles en prompteur',
    keywords: 'paroles texte lyrics prompteur ecrire couplet refrain karaoke lire',
    summary: 'Tes paroles défilent pendant la prise.',
    steps: [
      { text: 'Ouvre « Paroles ».', action: 'pal.lyrics', target: [nt('lyrics'), nt('tab-LYRICS')], done: { visible: '[aria-label="Prompteur de paroles"]' } },
      { text: 'Écris ou colle tes paroles, puis « ✓ Prêt ». Règle la vitesse avec 🐢 / 🐇.', target: '[aria-label="Prompteur de paroles"]', manual: true },
    ],
    result: 'Le texte défile avec le morceau pendant que tu chantes.',
    pitfalls: ['« Calé sur la voix » et la transcription automatique sont dans l’appli Windows.'],
    prereqs: [],
    doIt: () => [{ action: 'OPEN_LYRICS', payload: {}, description: 'Ouvrir le prompteur de paroles' }],
  },
  {
    id: 'nettoyer-voix', emoji: '🧽', title: 'Nettoyer ta voix (bruit, blancs, respirations)',
    keywords: 'nettoyer voix bruit souffle ventilo clim rue propre denoise blancs silences respirations souffles debruiter',
    summary: 'Retirer le bruit de fond, les blancs et les respirations trop fortes.',
    steps: [
      { text: 'Clique ton clip voix, puis « ✨ Nettoyer la voix » (Ctrl+K).', phone: 'Touche ton clip voix, puis « NETTOYER ».', action: 'pal.voiceClean',
        target: tid('mobile-clip-clean'), done: { visible: tid('voice-clean-dialog') } },
      { text: '« ✨ Nettoyer la voix », compare Avant / Après…', target: tid('voice-clean-start') },
      { text: '…puis « Appliquer ».', target: tid('voice-clean-apply') },
      { text: 'Les blancs et les respirations : « Mix auto » → « 🧹 Retirer les blancs » et « 🌬️ Respirations ».', action: 'pal.mixAuto', target: nt('mix-auto'), manual: true },
    ],
    result: 'Une voix sans bruit de fond, sans blancs, avec des respirations à leur place.',
    pitfalls: [
      'Il faut d’abord sélectionner un clip voix.',
      'L’écho de la pièce se retire seulement dans l’appli Windows.',
    ],
    prereqs: [],
    doIt: (f) => [{ action: 'CLEAN_SILENCE', payload: f.voiceId ? { trackId: f.voiceId } : {}, description: 'Retirer les blancs' }],
  },
  {
    id: 'echauffement', emoji: '🔥', title: 'T’échauffer et t’accorder',
    keywords: 'echauffement echauffer voix flow vocalise diction virelangue souffle accordeur accorder justesse tessiture',
    summary: 'Sirènes, gammes, diction, flow en rythme, et l’accordeur.',
    steps: [
      { text: 'Ouvre « Voix et flow ».', phone: 'Touche ☰ › « Plus d’outils » › « Échauffement voix et flow ».', action: 'pal.warmup',
        target: [tid('open-warmup'), tid('menu-warmup'), MENU_PLUS, PHONE_MENU], done: { visible: tid('warmup-start-program') } },
      { text: '« Démarrer l’échauffement » et suis le programme (onglet Accordeur pour la justesse).', target: tid('warmup-start-program') },
    ],
    result: 'Voix chaude, diction et flow prêts pour la prise.',
    pitfalls: ['Mets un casque : sur haut-parleurs, le micro entend le guide.'],
    prereqs: ['micro'],
    doIt: () => [cmd('pal.warmup', 'Ouvrir l’échauffement')],
  },
  {
    id: 'filmer', emoji: '🎥', title: 'Filmer ta prise',
    keywords: 'filmer camera video webcam selfie performance clip prise',
    summary: 'La caméra filme pendant REC, la vidéo est calée sur le son.',
    steps: [
      { text: 'Ouvre « 🎥 Filmer la prise ».', action: 'pal.videoTake', target: tid('video-take-pill'), done: { visible: tid('video-take-panel') } },
      { text: '« Allumer la caméra » et choisis vertical ou horizontal.', target: tid('video-take-on') },
      { text: 'Coche « Filmer les prochaines prises », puis REC.', target: [tid('video-take-armed'), nt('rec')], done: { fact: 'isRecording' } },
      { text: 'Après la prise : « 🎬 Exporter la vidéo ».', target: tid('video-take-export'), manual: true },
    ],
    result: 'Une vidéo de ta performance avec le son du mix, prête pour les réseaux.',
    pitfalls: [
      'Autorise la caméra ; utilise Chrome ou Edge.',
      'Sans licence de l’instru ou export payé : vidéo limitée à 30 s.',
    ],
    prereqs: ['micro'],
    doIt: () => [cmd('pal.videoTake', 'Ouvrir « Filmer la prise »')],
  },
  {
    id: 'studio', emoji: '🏢', title: 'Envoyer ton projet au studio Make Music',
    keywords: 'studio make music envoyer reserver reservation inge mixage pro mastering session enregistrer au studio bruxelles',
    summary: 'Le projet, les stems et tes notes partent au studio avec ta demande.',
    steps: [
      { text: 'Ouvre « Exporter » (ou ☰ › « Plus d’outils » › « Envoyer au studio »).', phone: 'Touche « Exporter » (flèche ⬆ en haut).', action: 'nova.export',
        target: ['[data-bar-item="exporter"]', tid('phone-export'), tid('menu-send-studio'), MENU_PLUS, PHONE_MENU],
        done: { visible: `${tid('export-send-studio')}, ${tid('studio-send')}` } },
      { text: 'Touche « 🏠 Envoyer au studio Make Music ».', action: 'pal.sendStudio', target: tid('export-send-studio'), done: { visible: tid('studio-send') } },
      { text: 'Connecte-toi, choisis le service (enregistrement, mixage, mastering) et ajoute tes notes.', target: tid('studio-send'), manual: true },
      { text: '« Envoyer » : le studio répond avec une référence.', target: tid('studio-send-go'), done: { visible: tid('studio-done') } },
    ],
    result: 'Ta demande est « Reçue par le studio » ; rien n’est payé à cette étape.',
    pitfalls: ['Il faut un compte Make Music pour envoyer.'],
    prereqs: ['compte', 'internet'],
    doIt: () => [cmd('pal.sendStudio', 'Ouvrir « Envoyer au studio »')],
  },
];

// ---------------------------------------------------------------------------
// Faits du projet
// ---------------------------------------------------------------------------

const isVoiceTrack = (t: Track) => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId && !t.isGuide;

export interface FactsEnv { mobile?: boolean; simple?: boolean; desktopApp?: boolean; loggedIn?: boolean; inCollab?: boolean }

export function projectFacts(st: Pick<DAWState, 'tracks'> & Partial<DAWState> | null | undefined, env: FactsEnv = {}): GuideFacts {
  const tracks = st?.tracks || [];
  const voices = tracks.filter(isVoiceTrack);
  const beat = tracks.find(t => t.id === 'instrumental');
  const selected = tracks.find(t => t.id === st?.selectedTrackId);
  const voice = (selected && isVoiceTrack(selected) ? selected : undefined) || voices.find(t => t.id === 'track-rec-main') || voices[0];
  const hasPlugin = (type: string) => tracks.some(t => (t.plugins || []).some(p => p.type === type));
  const isSynth = (t: Track) => !!t.novaSynth;
  return {
    hasBeat: !!beat && beat.clips.length > 0,
    hasVoiceTrack: voices.length > 0,
    hasArmedTrack: tracks.some(t => t.isTrackArmed),
    isRecording: !!st?.isRecording,
    isPlaying: !!st?.isPlaying,
    hasTake: voices.some(t => t.clips.length > 0),
    takeStopped: !st?.isRecording && voices.some(t => t.clips.length > 0),
    hasTwoTakes: voices.some(t => { try { return listTakes(t).length >= 2; } catch { return false; } }),
    hasMixStyle: !!st?.vocalMixStyle,
    hasVoicePreset: voices.some(t => !!t.voiceChain?.presetId),
    hasAutotune: hasPlugin('AUTOTUNE'),
    hasSynthTrack: tracks.some(isSynth),
    hasDrumTrack: tracks.some(t => t.type === TrackType.DRUM_RACK || t.type === TrackType.DRUM_SAMPLER),
    hasMidiTrack: tracks.some(t => t.type === TrackType.MIDI),
    hasSelectedTrack: !!selected,
    mobile: !!env.mobile,
    simple: !!env.simple,
    desktopApp: !!env.desktopApp,
    loggedIn: !!env.loggedIn,
    inCollab: !!env.inCollab,
    voiceId: voice?.id,
    selectedId: selected?.id,
  };
}

// ---------------------------------------------------------------------------
// Étapes
// ---------------------------------------------------------------------------

export const guideById = (id: string | null | undefined): Guide | undefined => (id ? GUIDES.find(g => g.id === id) : undefined);

/** Étapes qui concernent cet appareil et ce mode (figées au départ d'un « Montre-moi »). */
export function applicableSteps(g: Guide, f: GuideFacts): GuideStep[] {
  return g.steps.filter(s => (!s.device || (s.device === 'phone') === f.mobile) && (!s.when || f[s.when]) && (!s.unless || !f[s.unless]));
}

/**
 * Phrase dite au doigt : pas de clavier au téléphone. « (Ctrl+K : « tempo ») » devient
 * « (☰ › « Chercher une action… » : « tempo ») », Ctrl+Z devient « Annuler » (☰) ; les autres
 * raccourcis entre parenthèses disparaissent.
 */
export function forPhone(text: string): string {
  return text
    .replace(/\(Ctrl\+K\s*:\s*(«[^»]*»)\)/g, '(☰ › « Chercher une action… » : $1)')
    .replace(/\(Ctrl\+K\)/g, '(☰ › « Chercher une action… »)')
    .replace(/Ctrl\+Z/g, '« Annuler » (☰)')
    .replace(/\s*\((?:ou )?(?:Ctrl|Alt|Maj)\+[^()]*\)/g, '')
    .replace(/,? ?ou Ctrl\+[A-Za-z+]+/g, '')
    .replace(/Barre d’espace, ou ▶/g, '▶');
}

/** Texte d'une étape pour cet appareil : variante téléphone, sinon le texte dit au doigt. */
export function stepText(s: Pick<GuideStep, 'text' | 'phone'>, mobile: boolean): string {
  if (!mobile) return s.text;
  return s.phone || forPhone(s.text);
}

/** Étapes à afficher (liste, chat) : `skipped` = déjà fait dans ce projet. */
export function stepsFor(g: Guide, f: GuideFacts): (GuideStep & { skipped: boolean; shown: string })[] {
  return applicableSteps(g, f).map(s => ({ ...s, skipped: isStepDone(s, f, null), shown: stepText(s, f.mobile) }));
}

/** Remplace les jetons {voice} / {selected} d'un sélecteur. */
export function resolveSelector(sel: string, f: GuideFacts): string | null {
  if (sel.includes('{voice}')) { if (!f.voiceId) return null; sel = sel.split('{voice}').join(f.voiceId); }
  if (sel.includes('{selected}')) { if (!f.selectedId) return null; sel = sel.split('{selected}').join(f.selectedId); }
  return sel;
}

const visibleEl = (el: Element): boolean => {
  const h = el as HTMLElement;
  if (!h.getClientRects().length) return false;
  const r = h.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = window.getComputedStyle(h);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
};

/** Premier élément visible d'une liste de sélecteurs. */
export function firstVisible(selectors: string[], root: ParentNode = document): HTMLElement | null {
  for (const s of selectors) {
    let list: Element[] = [];
    try { list = Array.from(root.querySelectorAll(s)); } catch { continue; }
    const el = list.find(visibleEl);
    if (el) return el as HTMLElement;
  }
  return null;
}

/** Le bouton à montrer pour cette étape, s'il est à l'écran. */
export function findTargetElement(s: GuideStep, f: GuideFacts): HTMLElement | null {
  if (!s.target || typeof document === 'undefined') return null;
  const sels = (Array.isArray(s.target) ? s.target : [s.target]).map(x => resolveSelector(x, f)).filter((x): x is string => !!x);
  return firstVisible(sels);
}

/** Étape faite ? `doc` absent : seulement les faits du projet (liste, chat). */
export function isStepDone(s: GuideStep, f: GuideFacts, doc: Document | null): boolean {
  if (s.skipIf && f[s.skipIf]) return true;
  if (!s.done) return false;
  if ('fact' in s.done) return !!f[s.done.fact];
  if (!doc) return false;
  return !!firstVisible([s.done.visible], doc);
}

// ---------------------------------------------------------------------------
// Recherche (liste, palette, chat)
// ---------------------------------------------------------------------------

const STOP = new Set(['comment', 'faire', 'fais', 'fait', 'pour', 'avec', 'dans', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'les', 'des', 'une', 'un', 'le', 'la', 'de', 'du',
  'je', 'tu', 'on', 'il', 'est', 'que', 'qui', 'quoi', 'peux', 'peut', 'veux', 'voudrais', 'aimerais', 'dois', 'faut', 'sur', 'au', 'aux', 'en', 'et', 'ou', 'ca', 'cela', 'ce',
  'cette', 'se', 'sa', 'son', 'ses', 'me', 'moi', 'te', 'toi', 'explique', 'montre', 'aide', 'aider', 'svp', 'stp', 'please', 'how', 'to', 'the', 'a', 'mettre', 'met', 'mets',
  'avoir', 'etre', 'bien', 'plus', 'tout', 'tous', 'nova', 'daw', 'etape', 'etapes', 'demarche', 'procedure', 'processus', 'possible', 'est-ce', 'quel', 'quelle']);

const words = (q: string) => normText(q).split(/[^a-z0-9#]+/).filter(w => w.length >= 2 && !STOP.has(w));

/** Score d'un parcours pour une recherche (0 = rien). */
export function guideScore(g: Guide, query: string): number {
  const ws = words(query);
  if (!ws.length) return 0;
  const title = normText(g.title);
  const hay = `${title} ${normText(g.keywords)} ${normText(g.summary)}`;
  let s = 0;
  for (const w of ws) {
    const stem = w.length > 5 ? w.slice(0, 5) : w;
    if (new RegExp(`(^|[^a-z0-9])${w}`).test(title)) s += 4;
    else if (hay.includes(w)) s += 3;
    else if (w.length >= 4 && hay.includes(stem)) s += 2;
  }
  return s;
}

/** Parcours triés pour la case de recherche (vide = tous, dans l'ordre de la base). */
export function searchGuides(query: string): Guide[] {
  if (!words(query).length) return GUIDES.slice();
  return GUIDES.map((g, i) => ({ g, i, s: guideScore(g, query) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.g);
}

/** La phrase ressemble à « comment je fais pour… » / « je veux mettre… » / « c'est quoi la démarche ». */
export function isHowToQuestion(msg: string): boolean {
  const m = normText(msg).replace(/[’'-]/g, ' ');
  return /\b(comment|how to|tuto\w*|demarche|procedure|etapes?|par ou commencer|je (ne )?sais pas (comment|quoi)|montre moi|explique moi|aide moi a|c est quoi la marche|j aimerais|je voudrais|je veux|on fait comment|ca marche comment)\b/.test(m);
}

/**
 * Question « comment faire » reconnue SANS l'IA : le parcours le plus proche si le score est
 * net. Sinon null (la question part à l'IA, avec le résumé des parcours proches).
 */
export function matchHowToQuestion(msg: string): Guide | null {
  if (!msg || msg.length > 200 || !isHowToQuestion(msg)) return null;
  const ranked = GUIDES.map(g => ({ g, s: guideScore(g, msg) })).sort((a, b) => b.s - a.s);
  const best = ranked[0];
  if (!best || best.s < 3) return null;
  // Deux parcours à égalité : on laisse l'IA trancher (ou poser la question).
  if (ranked[1] && ranked[1].s === best.s && best.s < 6) return null;
  return best.g;
}

/**
 * Résumé COURT des parcours pour le modèle (paliers gratuits) : les plus proches de la
 * demande d'abord, une ligne « id | titre » chacun, dans la limite de `maxChars`.
 */
export function guidesPromptSummary(query: string, maxChars = 700): string {
  const ranked = GUIDES.map((g, i) => ({ g, i, s: guideScore(g, query) })).sort((a, b) => b.s - a.s || a.i - b.i);
  const lines: string[] = [];
  let size = 0;
  for (const { g } of ranked) {
    const l = `${g.id} | ${g.title}`;
    if (size + l.length + 1 > maxChars) break;
    lines.push(l); size += l.length + 1;
  }
  return lines.join('\n');
}

/**
 * Ce que le client envoie au modèle : RIEN si la phrase n'est pas une question « comment faire »
 * (la plupart des messages : ordres de mix), sinon les 6 parcours les plus proches.
 */
export function guidesForPrompt(msg: string): string {
  if (!isHowToQuestion(msg)) return '';
  const ranked = GUIDES.map((g, i) => ({ g, i, s: guideScore(g, msg) })).sort((a, b) => b.s - a.s || a.i - b.i);
  const top = ranked.filter(x => x.s > 0).slice(0, 6);
  return (top.length ? top : ranked.slice(0, 8)).map(x => `${x.g.id} | ${x.g.title}`).join('\n');
}

// ---------------------------------------------------------------------------
// Chat : la carte d'étapes et « Fais-le pour moi »
// ---------------------------------------------------------------------------

export interface GuideCard {
  id: string;
  title: string;
  emoji: string;
  steps: { text: string; skipped: boolean }[];
  prereqs: string[];
  pitfalls: string[];
  result: string;
  canDoIt: boolean;
}

/** Ce que le chat affiche pour un parcours, adapté au projet (étapes déjà faites cochées). */
export function guideCard(g: Guide, f: GuideFacts): GuideCard {
  const steps = stepsFor(g, f);
  return {
    id: g.id, title: g.title, emoji: g.emoji,
    steps: steps.map(s => ({ text: s.shown, skipped: s.skipped })),
    prereqs: g.prereqs.map(p => PREREQ_LABELS[p]),
    pitfalls: g.pitfalls.slice(0, 2),
    result: g.result,
    canDoIt: (g.doIt?.(f) || []).length > 0,
  };
}

/** Phrase d'accroche du chat (la carte donne les étapes). */
export function howToIntro(g: Guide, f: GuideFacts): string {
  const steps = stepsFor(g, f);
  const done = steps.filter(s => s.skipped).length;
  const left = steps.length - done;
  const first = steps.find(s => !s.skipped);
  if (!left) return `${g.emoji} ${g.title} : c'est déjà en place dans ton projet. ${g.result}`;
  return `${g.emoji} ${g.title}, en ${left} étape${left > 1 ? 's' : ''}${done ? ` (${done} déjà faite${done > 1 ? 's' : ''} dans ton projet)` : ''}. On commence par : ${first ? first.shown.charAt(0).toLowerCase() + first.shown.slice(1) : ''}`;
}

/** Appels d'outils de « Fais-le pour moi » (vides si rien à faire à la place de l'artiste). */
export function doItCalls(g: Guide, f: GuideFacts): AIAction[] {
  try { return (g.doIt?.(f) || []).slice(0, 8); } catch { return []; }
}

// ---------------------------------------------------------------------------
// « Et après ? » : parcours proposés après un moment clé
// ---------------------------------------------------------------------------

export type HowToMoment = 'take' | 'mix' | 'export';

/** Deux parcours au plus par moment, du plus utile au moins utile. */
export const NEXT_GUIDES: Record<HowToMoment, string[]> = {
  take: ['comp-prises', 'mixer-voix'],
  mix: ['exporter', 'masteriser'],
  export: ['spotify', 'clip-tiktok'],
};

export function nextGuidesFor(moment: HowToMoment): Guide[] {
  return NEXT_GUIDES[moment].map(id => guideById(id)).filter((g): g is Guide => !!g);
}

// Réexporté pour les tests (sélecteurs fabriqués par la base).
export const __selectors = { nt, tid, cmd };
