
import React from 'react';

export enum TrackType {
  AUDIO = 'AUDIO',
  MIDI = 'MIDI',
  BUS = 'BUS',
  SEND = 'SEND',
  SAMPLER = 'SAMPLER',
  DRUM_RACK = 'DRUM_RACK',
  DRUM_SAMPLER = 'DRUM_SAMPLER',
  MELODIC_SAMPLER = 'MELODIC_SAMPLER'
}

export type ViewType = 'ARRANGEMENT' | 'MIXER' | 'AUTOMATION' | 'PIANO_ROLL';
export type MobileTab = 'TRACKS' | 'ARRANGEMENT' | 'MIXER' | 'PLUGINS' | 'BROWSER' | 'NOVA';
export type EditorTool = 'SELECT' | 'SPLIT' | 'ERASE' | 'AUTOMATION' | 'DRAW' | 'SMART' | 'RANGE';
export type ViewMode = 'DESKTOP' | 'TABLET' | 'MOBILE';
export type Theme = 'dark' | 'light';

export enum ProjectPhase {
  SETUP = 'SETUP',
  RECORDING = 'RECORDING',
  MIXING = 'MIXING',
  MASTERING = 'MASTERING'
}

export enum GuideStep {
  WELCOME = 'WELCOME',
  IMPORT_INSTRUMENTAL = 'IMPORT_INSTRUMENTAL',
  PREPARE_VOCAL = 'PREPARE_VOCAL',
  RECORDING = 'RECORDING',
  REVIEW = 'REVIEW',
  EXPORT = 'EXPORT'
}

export interface User {
  id: string;
  email: string;
  username: string;
  isVerified: boolean;
  avatar?: string;
  plan: 'FREE' | 'PRO' | 'STUDIO';
  // Identifiants des instrumentaux achetes. Le catalogue utilise des UUID
  // (chaines) tandis que l'ancien schema de licences utilisait des entiers :
  // on accepte les deux et la comparaison se fait sur la forme texte.
  owned_instruments?: (string | number)[]; 
}

export interface Instrument {
  id: number | string;  // UUID in Supabase
  created_at: string;
  name: string;
  category: 'Trap' | 'Drill' | 'Boombap' | 'Afro' | 'RnB' | 'Pop' | 'Electro';
  image_url: string;
  bpm: number;
  musical_key: string;
  preview_url: string; 
  stems_url?: string;  
  price_basic: number;     
  price_premium: number;   
  price_exclusive: number; 
  is_visible: boolean; 
  stripe_link_basic?: string; 
  stripe_link_premium?: string; 
  stripe_link_exclusive?: string; 
  stripe_link_recording?: string; 
}

// Type pour la table "instrumentals" du nouveau Supabase (catalogue Google Drive)
export interface Instrumental {
  id: string;                     // UUID unique
  title: string;                  // Titre de l'instru (ex: "1248 F MIN 105 BPM")
  description: string | null;     // Description optionnelle
  genre: string | null;           // Genre musical (ex: "Trap", "Drill", "RnB")
  bpm: number | null;             // Tempo en BPM (ex: 105)
  key: string | null;             // Tonalité (ex: "F MIN", "C MIN")
  /** « beat » = instru complète, « melody » = mélodie seule (sans batterie). */
  kind?: 'beat' | 'melody' | null;
  preview_url: string | null;     // URL de preview audio
  cover_image_url: string | null; // URL de l'image de couverture
  drive_file_id: string;          // ID du fichier Google Drive
  is_active: boolean;             // Si visible publiquement
  price_base: number | null;      // Prix licence de base (€)
  price_exclusive: number | null; // Prix licence exclusive (€)
  price_stems: number | null;     // Prix avec stems (€)
  has_stems: boolean | null;      // Si stems disponibles
  stems_folder_id: string | null; // ID dossier Google Drive des stems
  created_at: string;             // Date de création
  updated_at: string;             // Dernière modification
}

export interface PendingUpload {
  id: number;
  filename: string;
  download_url: string;
  is_processed: boolean;
  created_at: string;
}

export type AuthStage = 'LOGIN' | 'REGISTER' | 'VERIFY_EMAIL' | 'FORGOT_PASSWORD';

export type PluginType = 'REVERB' | 'DELAY' | 'CHORUS' | 'FLANGER' | 'DOUBLER' | 'STEREOSPREADER' | 'COMPRESSOR' | 'AUTOTUNE' | 'DEESSER' | 'DENOISER' | 'PROEQ12' | 'VOCALSATURATOR' | 'MASTERSYNC' | 'LIMITER' | 'VST3' | 'SAMPLER' | 'DRUM_SAMPLER' | 'MELODIC_SAMPLER' | 'DRUM_RACK_UI';

export interface PluginMetadata {
  id: string;
  name: string;
  type: PluginType;
  format: 'VST3' | 'AU' | 'VST' | 'INTERNAL';
  vendor: string;
  version: string;
  latency: number; 
  localPath?: string;
}

export interface PluginInstance {
  id: string;
  name: string;
  type: PluginType;
  isEnabled: boolean;
  params: Record<string, any>;
  latency: number; 
}

export interface TrackSend {
  id: string;          
  level: number;       
  isEnabled: boolean;
}

export interface MidiNote {
  id: string;
  pitch: number; 
  start: number; 
  duration: number; 
  velocity: number; 
  isSelected?: boolean;
}

// Crossfade curve types (inspired by Pro Tools)
export type CrossfadeCurve = 'LINEAR' | 'EQUAL_POWER' | 'S_CURVE' | 'EXPONENTIAL';

// Time stretch/Warp settings (inspired by Ableton)
export type WarpMode = 'OFF' | 'BEATS' | 'TONES' | 'TEXTURE' | 'REPITCH' | 'COMPLEX';

export interface WarpMarker {
  id: string;
  sampleTime: number;  // position in original audio
  beatTime: number;    // position in beats
}

export interface WarpSettings {
  enabled: boolean;
  mode: WarpMode;
  /** Tempo auquel le clip est actuellement cale. */
  originalBpm?: number;
  markers?: WarpMarker[];
  preservePitch: boolean;
  grainSize?: number;     // for granular modes

  // --- Reference d'origine ---
  // On garde le buffer intact et ses mesures pour toujours reetirer DEPUIS
  // l'original. Sans ca, chaque changement de tempo etirerait un buffer deja
  // etire et la qualite se degraderait a chaque fois.
  sourceBufferId?: string;
  sourceBpm?: number;
  sourceDuration?: number;
  sourceOffset?: number;
  sourceFadeIn?: number;
  sourceFadeOut?: number;
}

// Track Group (inspired by Reaper/Pro Tools)
export interface TrackGroup {
  id: string;
  name: string;
  color: string;
  trackIds: string[];
  isCollapsed: boolean;
  // Linked parameters
  linkedVolume: boolean;
  linkedMute: boolean;
  linkedSolo: boolean;
  linkedPan: boolean;
}

export interface Clip {
  id: string;
  /** Numéro de prise (Prise N) : survit au renommage du clip. */
  takeNumber?: number;
  start: number;
  duration: number;
  offset: number; 
  fadeIn: number; 
  fadeOut: number; 
  fadeInCurve?: CrossfadeCurve;   // NEW: fade in curve type
  fadeOutCurve?: CrossfadeCurve;  // NEW: fade out curve type
  name: string;
  color: string;
  type: TrackType;
  buffer?: AudioBuffer;
  bufferId?: string; 
  notes?: MidiNote[]; 
  isMuted?: boolean;
  gain?: number;
  isReversed?: boolean; 
  audioRef?: string;
  isUnlicensed?: boolean;
  warp?: WarpSettings;            // NEW: time stretch (Ableton-style)
  groupId?: string;               // NEW: clip grouping
  /**
   * Place du clip dans le rendu gelé de sa piste (au moment du rendu). Couper,
   * déplacer, raccourcir ou changer le volume d'un clip gelé (sur iPad, dans le
   * navigateur…) se fait sur le clip d'origine : la lecture rejoue la tranche
   * correspondante du rendu, et au dégel les vrais effets (VST du PC)
   * retrouvent directement les modifications. Copié avec le clip (découpe).
   */
  freezeRef?: FreezeRef;
  /** Tranche de rendu gelé fabriquée pour la lecture (jamais dans le projet). */
  isFreezeSlice?: boolean;
  /**
   * Justesse note par note (V19) : ce clip joue un son corrigé (rendu hors
   * ligne). La prise d'origine et les retouches sont gardées pour revenir en
   * arrière ou retoucher. Une ancienne version ignore ce champ et joue le son
   * corrigé comme un clip normal. Voir utils/pitchEdit.
   */
  pitchEdit?: PitchEditInfo;
}

/** Retouche d'une note (justesse), rangée par instant (secondes dans le son d'origine). */
export interface StoredNoteEdit {
  t0: number;
  t1: number;
  /** Décalage (demi-tons, au cent près). */
  shift: number;
  /** Redressement de la dérive (0 à 1). */
  drift: number;
  /** Vibrato (1 = intact, 0 = supprimé, 2 = doublé). */
  vibrato: number;
  /** Transition depuis la note précédente (ms). */
  transitionMs?: number;
  /** Retouchée à la main (sinon : par « Corriger tout », recalculée si on change le dosage). */
  manual?: boolean;
}

/** Ce que le clip corrigé garde de sa correction de justesse. */
export interface PitchEditInfo {
  version: 1;
  /** Son d'origine (registre audio). Absent ou introuvable : retouche depuis le son corrigé. */
  sourceBufferId?: string;
  /** Fichier du son d'origine dans un projet sauvegardé (le temps de la sauvegarde). */
  sourceRef?: string;
  /** Instant du son d'origine qui correspond au début du son corrigé (s). */
  regionStart: number;
  /** Retouches note par note (instants dans le son d'origine). */
  edits: StoredNoteEdit[];
  /** Réglage global utilisé (« Corriger tout »), pour rouvrir l'éditeur comme on l'a laissé. */
  amount?: number;
  style?: 'naturel' | 'robot';
  /** Calage sur le tempo du clip d'origine (rendu au retour à l'original). */
  sourceWarp?: WarpSettings;
  /** Nom du clip d'origine. */
  sourceName?: string;
  /** Heure de la correction (ms). */
  at?: number;
}

export interface FreezeRef {
  /** Id du rendu (frozenClip.id) auquel l'ancrage se rapporte. */
  renderId: string;
  /** Temps du rendu correspondant à l'offset 0 de l'audio source. */
  anchor: number;
  /** Partie de l'audio source rendue (offsets source). */
  from: number;
  to: number;
  /** Fondus et gain déjà contenus dans le rendu. */
  fadeIn: number;
  fadeOut: number;
  gain: number;
  /** Courbes de ces fondus (absent = linéaire, rendus d'avant les courbes). */
  fadeInCurve?: CrossfadeCurve;
  fadeOutCurve?: CrossfadeCurve;
  /**
   * Clip d'origine (au moment du rendu) dont ce clip est issu : survit aux
   * découpes. Sert au journal des éditions pré-effet (utils/preFxEdits).
   */
  srcClipId?: string;
}

/** Clip tel qu'il était au moment du gel (référence des éditions pré-effet). */
export interface FreezeBaseClip {
  id: string;
  name?: string;
  start: number;
  offset: number;
  duration: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  isMuted?: boolean;
}

/**
 * Photo de la piste au moment du gel automatique (PC de l'ingé) : les éditions
 * faites ensuite ailleurs (tablette, chez l'artiste) se lisent par rapport à
 * elle, et l'ingé peut toujours y revenir.
 */
export interface FreezeBase {
  /** Id du rendu (frozenClip.id) photographié. */
  renderId: string;
  at: number;
  /** Qui a gelé (nom affiché). */
  by?: string;
  clips: FreezeBaseClip[];
  /** Volume avant effets (automation) au moment du gel. */
  preVolume?: AutomationPoint[];
}

/** Une édition pré-effet, décrite pour l'humain (résumé, conflits). */
export interface PreFxOp {
  kind: 'delete' | 'split' | 'remove' | 'move' | 'gain' | 'fade' | 'mute' | 'unmute' | 'add' | 'volume';
  /** Clip d'origine concerné (absent : nouvelle prise, automation). */
  baseClipId?: string;
  /** Position sur la ligne de temps (s), pour l'affichage. */
  at: number;
  /** Fin de la zone concernée (s). */
  end?: number;
  /** Détail lisible (« -3 dB », « 0,8 s »…). */
  detail?: string;
  /** Auteur (nom affiché) et date. */
  by?: string;
  ts?: number;
}

/** Journal des éditions faites sur une piste gelée (enregistré avec la session). */
export interface PreFxJournal {
  v: 1;
  /** Rendu auquel le journal se rapporte (freezeBase.renderId). */
  renderId: string;
  ops: PreFxOp[];
}

/**
 * Rendu, à travers les effets VST d'un bus / envoi (reverb VST…), de la part
 * qu'une piste y envoie. Rangé sur la piste SOURCE : ses tranches suivent les
 * éditions de ses clips (une voix supprimée emporte sa reverb).
 */
export interface SendFreeze {
  /** Bus / envoi d'effets concerné. */
  busId: string;
  /** Rendu du bus au moment du gel (= bus.frozenClip.id) : sinon périmé. */
  busRenderId: string;
  /** Rendu des clips de la source auquel les tranches se rapportent (freezeRef.renderId). */
  anchorId: string;
  /** Rendu (après les effets du bus jusqu'au dernier VST inclus). */
  clip: Clip;
  /** Volume de la source et niveau d'envoi au moment du rendu. */
  volume: number;
  level: number;
  /** Empreinte de ce qui a été rendu (source + effets du bus). */
  sig: string;
}

export interface AutomationPoint {
  id: string;
  time: number;
  value: number;
  curveType?: AutomationCurveType; // NEW: curve to next point
}

export interface AutomationLane {
  id: string;
  parameterName: 'volume' | 'pan' | string;
  points: AutomationPoint[];
  color: string;
  isExpanded: boolean;
  min: number;
  max: number;
}

// DRUM RACK SPECIFIC INTERFACES
export interface DrumPad {
  id: number; // 1 to 30
  name: string;
  sampleName: string;
  volume: number; // 0 to 1
  pan: number; // -1 to 1
  isMuted: boolean;
  isSolo: boolean;
  midiNote: number; // 60 + (id - 1)
  buffer?: AudioBuffer;
  audioRef?: string; // URL for persistence
  /** Accordage (demi-tons) et longueur (0.05-1) du son. */
  tune?: number;
  decay?: number;
  /** Groupe de « choke » (hi-hat fermé / ouvert, 808). */
  chokeGroup?: number;
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  color: string;
  isMuted: boolean;
  isSolo: boolean;
  isTrackArmed: boolean;
  isFrozen: boolean;
  volume: number;
  pan: number;
  inputDeviceId?: string; 
  outputTrackId: string;  
  instrumentId?: string | number; 
  sends: TrackSend[];
  clips: Clip[];
  plugins: PluginInstance[];
  automationLanes: AutomationLane[];
  totalLatency: number;
  events?: any[];
  drumPads?: DrumPad[];        // Only for DRUM_RACK tracks
  /**
   * Rendu audio de la piste quand elle est gelee (isFrozen), PRE-fader/pan.
   * Les clips et plugins d'origine ne sont jamais supprimes : degeler
   * consiste simplement a repasser sur la chaine normale.
   * Sur PC avec le pont VST, le rendu des effets VST3 fait a la sauvegarde
   * reste en cache (isFrozen = false) : le projet s'ouvre gele ailleurs.
   */
  frozenClip?: Clip;
  /**
   * Dernier effet inclus dans le rendu gele (index dans plugins). Les effets
   * suivants restent actifs et modifiables (lecture : rendu -> effets restants
   * -> fader/pan -> departs). Absent : tous les effets sont dans le rendu.
   */
  frozenUpToPluginIndex?: number;
  /** Clips inclus dans le rendu : les clips ajoutes ensuite sont joues normalement. */
  frozenClipIds?: string[];
  /** Empreinte des clips et effets rendus : si elle change, le rendu est perime. */
  frozenSourceSig?: string;
  /**
   * Empreinte des seuls effets rendus (modèle « clips ancrés », voir
   * Clip.freezeRef) : tant qu'elle ne change pas, le rendu reste valable
   * même si les clips sont édités.
   */
  frozenPluginSig?: string;
  /**
   * Gel automatique (sauvegarde / fermeture sur le PC avec le pont VST) : la
   * piste se dégèle toute seule quand la session rouvre sur un PC qui a les
   * plugins ; un gel manuel (CPU) reste, lui, tel quel.
   */
  frozenAuto?: boolean;
  /** Photo de la piste au gel : référence des éditions pré-effet (voir PreFxJournal). */
  freezeBase?: FreezeBase;
  /** Éditions faites sur la piste gelée (auteur, date), pour le résumé au dégel. */
  preFxJournal?: PreFxJournal;
  /** Rendus des envois de cette piste vers des bus à effets VST gelés. */
  sendFreezes?: SendFreeze[];
  /**
   * Collaboration : rôle qui possède le contenu de la piste (prises, motifs).
   * Absent : les pistes voix sont à l'artiste, le beat à personne.
   */
  collabOwner?: CollabRole;
  /**
   * Mode « Ingé à distance » : piste envoyée par l'artiste à l'ingé (chez
   * l'artiste) ou reçue de l'artiste (chez l'ingé). Voir utils/remoteInge.
   */
  remote?: RemoteTrackInfo;
  /**
   * Collaboration « En direct », chez l'ingé : la piste joue l'APERÇU rendu par
   * le pont VST de l'artiste (ses VST, que l'ingé n'a pas) sur une fenêtre du
   * morceau. Voir services/LivePreview.
   */
  livePreview?: { renderId: string; from: number; to: number; at: number };
  /**
   * Volume verrouillé par l'artiste (« c'est ce volume-là que je veux ») :
   * l'ingé son le voit, peut le déverrouiller, mais le message est clair.
   */
  volumeLock?: { volume: number; by: string; at: number };
  /** Boîte à rythmes Make Music (piste PERCUSSIONS) : motif éditable. */
  drumMachine?: import('./utils/drumKits').DrumMachine;
  /** Piste MIDI jouée par la basse 808 mélodique (piano roll, glissés). */
  bass808?: import('./utils/bass808').Bass808Settings;
  /**
   * Piste MIDI (mode instru) jouée par un instrument VST3 du PC (pont VST).
   * Les notes sont rendues hors temps réel dans frozenClip (isFrozen, aucun
   * effet inclus : frozenUpToPluginIndex = -1) : le son est sauvegardé avec
   * le projet et se joue partout, même sans le pont.
   */
  vstInstrument?: VstInstrument;
  groupId?: string;            // NEW: Track group reference
  /**
   * Mode d'automation façon Pro Tools (voir utils/automationWrite). Absent :
   * Read (l'automation est rejouée), comme avant l'ajout des modes.
   */
  automationMode?: 'off' | 'read' | 'touch' | 'latch' | 'write' | 'trim';
  height?: number;             // NEW: Custom track height
  isMinimized?: boolean;       // NEW: Collapsed state
  /**
   * Couloirs de prises (« Playlists » de Pro Tools, « take lanes » d'Ableton) :
   * l'audio des prises reste dans `clips` (clips portant `takeNumber`, les
   * passages non retenus sont mutés) ; ce tableau ne porte que ce qui décore
   * chaque couloir (nom choisi, heure, tour de boucle, note de l'IA). Une
   * ancienne version l'ignore et joue simplement le comp. Voir utils/playlists.
   */
  takeMeta?: TakeMeta[];
}

/** Infos d'un couloir de prise (Track.takeMeta). */
export interface TakeMeta {
  /** Numéro de la prise (Clip.takeNumber). */
  n: number;
  /** Nom choisi par l'utilisateur (sinon « Prise N »). */
  name?: string;
  /** Heure de l'enregistrement (ms depuis 1970). */
  recordedAt?: number;
  /** Loop Record : numéro du tour de boucle (1, 2, 3…). */
  loopPass?: number;
  /** « Meilleure prise » : note de l'IA locale (0-100) et détail. */
  score?: { total: number; pitch: number; timing: number; level: number; noise: number };
}

/** Instrument VST3 du PC choisi pour une piste MIDI (voir Track.vstInstrument). */
export interface VstInstrument {
  name: string;
  vendor?: string;
  /** Bundle .vst3 sur le PC du beatmaker. */
  path: string;
  /** Bundle à plusieurs plugins : nom du plugin. */
  pluginName?: string | null;
  uid?: string;
  /** Son réglé dans la fenêtre du plugin (état binaire en base64). */
  stateB64?: string | null;
  /** Empreinte (notes, tempo, son) du rendu actuel : différente = à refaire. */
  renderSig?: string;
}

// Time Signature type (inspired by Reaper/Ableton)
export interface TimeSignature {
  numerator: number;   // beats per bar (4 in 4/4)
  denominator: number; // note value (4 = quarter note)
}

// Marker types (inspired by Pro Tools/Reaper)
export type MarkerType = 'MARKER' | 'REGION';

export interface Marker {
  id: string;
  name: string;
  time: number;
  type: MarkerType;
  endTime?: number;  // Only for REGION type
  color: string;
  /** Numéro du repère (Pro Tools : Memory Location n°) ; absent sur les anciens projets. */
  number?: number;
}

// Metronome settings
export interface MetronomeSettings {
  enabled: boolean;
  volume: number;        // 0-1
  countIn: number;       // bars before recording (0, 1, 2, 4)
  accentDownbeat: boolean;
  sound: 'CLICK' | 'WOODBLOCK' | 'BEEP' | 'CUSTOM';
}

// Punch recording settings (inspired by Pro Tools)
export interface PunchSettings {
  enabled: boolean;
  punchIn: number;    // time in seconds
  punchOut: number;   // time in seconds
  preRoll: number;    // seconds before punch in
  postRoll: number;   // seconds after punch out
  /** Pré-roll / post-roll en mesures (prioritaires sur les secondes ci-dessus). utils/punch.ts */
  preRollBars?: number;
  postRollBars?: number;
  /** Pré-roll actif. Non réglé : actif en punch seulement (comportement d'origine). */
  preRollOn?: boolean;
  postRollOn?: boolean;
  /** Crossfade aux bords du punch (ms). 10 par défaut. */
  crossfadeMs?: number;
  /** QuickPunch : REC bascule l'enregistrement pendant la lecture, sans l'arrêter. */
  quickPunch?: boolean;
}

// Automation curve types (inspired by Ableton/Logic)
export type AutomationCurveType = 'LINEAR' | 'EXPONENTIAL' | 'LOGARITHMIC' | 'S_CURVE' | 'HOLD';

export interface DAWState {
  id: string;
  name: string;
  /**
   * Version du format de la session (absent = avant le gel pré-effet).
   * 2 : gel automatique avec photo, journal pré-effet et rendus d'envois VST.
   */
  schemaVersion?: number;
  bpm: number;
  timeSignature: TimeSignature;  // NEW
  projectKey?: number; 
  projectScale?: string; 
  /** Dernier style de mix voix appliqué (utils/vocalPresets). */
  vocalMixStyle?: string;
  /**
   * Type de projet : VOCAL = poser sa voix sur une instru (par défaut) ;
   * BEATMAKING = faire une instru (batterie) sur une mélodie du studio, avec
   * la possibilité d'y poser ensuite sa voix.
   */
  projectMode?: 'VOCAL' | 'BEATMAKING';
  /** Collaboration : dernière opération du journal incluse dans cet instantané. */
  collabSeq?: number;
  /** Mode « Ingé à distance » : lien avec la session de l'autre (artiste / ingé). */
  remoteInge?: RemoteIngeLinkInfo;
  /** Genre du beat du catalogue (sert à proposer le style de mix adapté). */
  beatGenre?: string;
  /** Titre du beat du catalogue. */
  beatTitle?: string;
  /** Paroles de l'artiste (prompteur) : sauvegardées avec le projet. */
  lyrics?: string;
  /** Position (s) où la 1re ligne passe sur la ligne de lecture. */
  lyricsStart?: number;
  /** Vitesse de défilement (lignes / minute). */
  lyricsSpeed?: number;
  /** Bloc de paroles (n° dans l'ordre, séparés par une ligne vide) → id de la région
   *  où il doit défiler : la vitesse du prompteur vient alors de la durée des régions. */
  lyricsRegions?: Record<string, string>;
  isPlaying: boolean;
  isRecording: boolean;
  currentTime: number;
  isLoopActive: boolean;
  loopStart: number;
  loopEnd: number;
  tracks: Track[];
  trackGroups: TrackGroup[];      // NEW
  markers: Marker[];              // NEW
  selectedTrackId: string | null;
  currentView: ViewType;
  projectPhase: ProjectPhase;
  isLowLatencyMode: boolean; 
  isRecModeActive: boolean;
  systemMaxLatency: number; 
  recStartTime: number | null;
  isDelayCompEnabled: boolean;
  metronome: MetronomeSettings;   // NEW
  punch: PunchSettings;           // NEW
}

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  icon?: string;
  danger?: boolean;
  component?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  /** Infobulle (ex. l'équivalent dans Logic / FL Studio). */
  title?: string;
}

export type AIChatRole = 'user' | 'assistant' | 'system';

export interface AIChatMessage {
  id: string;
  role: AIChatRole;
  content: string;
  timestamp: number;
  isCommand?: boolean;
  executedAction?: string;
}

export type AIActionType = 
  | 'UPDATE_PLUGIN' 
  | 'UPDATE_TRACK' 
  | 'ADD_TRACK'
  | 'CREATE_TRACK' 
  | 'DELETE_TRACK' 
  | 'SET_VOLUME'
  | 'SET_PAN'
  | 'MUTE_TRACK'
  | 'SOLO_TRACK'
  | 'RENAME_TRACK'
  | 'OPEN_PLUGIN'
  | 'CLOSE_PLUGIN'
  | 'SET_PLUGIN_PARAM'
  | 'BYPASS_PLUGIN'
  | 'SET_SEND_LEVEL'
  | 'PREPARE_REC' 
  | 'CLEAN_MIX'
  | 'RESET_FX'
  | 'NORMALIZE_CLIP'
  | 'SPLIT_CLIP'
  | 'MUTE_CLIP'
  | 'PLAY'
  | 'STOP'
  | 'RECORD'
  | 'SEEK'
  | 'SET_LOOP'
  | 'SET_BPM'
  | 'SET_AUTOMATION'
  | 'RUN_MASTER_SYNC'
  | 'ANALYZE_INSTRU'
  | 'DUPLICATE_TRACK'
  | 'REMOVE_SILENCE'
  // Contrôle complet du DAW par l'assistant
  | 'REMOVE_PLUGIN'
  | 'MOVE_PLUGIN'
  | 'COPY_PLUGIN'
  | 'SET_TRACK_OUTPUT'
  | 'ARM_TRACK'
  | 'FREEZE_TRACK'
  | 'ADD_MARKER'
  | 'DELETE_MARKER'
  | 'GOTO_MARKER'
  | 'SET_METRONOME'
  | 'SET_TIME_SIGNATURE'
  | 'CREATE_GROUP'
  | 'DELETE_GROUP'
  | 'UPDATE_GROUP'
  | 'DELETE_CLIP'
  | 'DUPLICATE_CLIP'
  | 'RENAME_CLIP'
  | 'MOVE_CLIP'
  | 'SET_CLIP_GAIN'
  | 'SET_CLIP_FADE'
  | 'CREATE_PATTERN'
  | 'ADD_NOTES'
  | 'CLEAR_NOTES'
  | 'CLEAR_AUTOMATION'
  | 'SET_VIEW'
  | 'TOGGLE_LOOP'
  | 'SET_PROJECT_KEY'
  | 'UNDO'
  | 'REDO'
  | 'SAVE_PROJECT'
  | 'OPEN_EXPORT'
  | 'LOAD_BEAT'
  // Outils voix
  | 'APPLY_MIX_STYLE'
  | 'OPEN_MIX_STYLES'
  // Nova pilote les plugins VST du PC (services/NovaVstMix)
  | 'VST_MIX' | 'VST_LIST' | 'VST_SHOW_PARAMS' | 'VST_SET_PARAM' | 'VST_REMOVE' | 'VST_MOVE' | 'VST_MIX_FALLBACK'
  | 'CLEAN_SILENCE'
  | 'SET_AUTO_CLEAN'
  // Ingé son : session guidée, écoute du mix, montrer un réglage
  | 'PREPARE_PART'
  | 'ANALYZE_MIX'
  | 'HIGHLIGHT'
  | 'OPEN_STUDIO_OFFER'
  | 'OPEN_LYRICS'
  | 'OPEN_SHARE'
  // Batterie Make Music
  | 'ADD_DRUMS'
  | 'OPEN_DRUMS'
  | 'REMOVE_DRUMS'
  | 'LOAD_DAILY_CHALLENGE'
  | 'GOTO_SECTION'
  | 'SET_PUNCH'
  | 'OPEN_TAKE_HOME'
  | 'COMP_TAKE'
  | 'AUTO_COMP';

export interface AIAction {
  action: AIActionType;
  payload: any;
  description?: string;
}

export interface PluginParameter {
  id: string;
  name: string;
  type: 'float' | 'int' | 'boolean' | 'string';
  min: number;
  max: number;
  value: any;
  unit?: string;
}

export interface VSTFrameData {
  pluginId: string;
  image: string; 
  width: number;
  height: number;
}

// Nouvelle interface MIDI
export interface MidiDevice {
  id: string;
  name: string;
  manufacturer?: string;
  state: 'connected' | 'disconnected';
  type: 'input' | 'output';
}

declare global {
  interface Window {
    DAW_CONTROL: any;
    gridSize: string;
    isSnapEnabled: boolean;
    clipClipboard: any;
    DAW_CORE: any;
  }
}

/** Rôles de la collaboration à distance dans Nova. */
export type CollabRole = 'artist' | 'engineer' | 'beatmaker';

// --- Mode « Ingé à distance » (utils/remoteInge) ----------------------------------

/** Enregistrement en direct (effets temporels de NOVA seulement) ou mix (VST de l'ingé). */
export type RemoteIngePhase = 'recording' | 'mixing';

/** Lien entre la session de l'artiste et celle de l'ingé (chacun garde la sienne). */
export interface RemoteIngeLinkInfo {
  /** Session en ligne qui sert de boîte aux lettres (« id.clé »). */
  link: string;
  role: 'artist' | 'engineer';
  phase: RemoteIngePhase;
  /** Dernière opération du lien déjà appliquée (rattrapage à la reconnexion). */
  seq?: number;
  /** Artiste : l'ingé avec qui ce lien travaille (le premier arrivé) ; un 2e ingé est ignoré. */
  peerKey?: string;
  peerName?: string;
}

/** Réglages de l'artiste sur une piste avant les réglages de l'ingé (retour possible). */
export interface RemoteBefore {
  plugins: PluginInstance[];
  sends: TrackSend[];
  pan: number;
}

export interface RemoteTrackInfo {
  /** Piste correspondante dans la session de l'autre. */
  peerTrackId: string;
  /** Emplacement choisi par l'artiste en glissant la piste (lead, backs…). */
  slot?: string;
  /** Artiste : dernière version envoyée et empreinte de l'audio brut + éditions. */
  sentV?: number;
  sentSig?: string;
  /** Artiste : version (et empreinte) des réglages de l'ingé appliqués. */
  appliedV?: number;
  appliedSig?: string;
  /** Artiste : réglages de l'ingé reçus, pas encore appliqués (« Recevoir les réglages de l'ingé »). */
  pending?: any;
  /** Artiste : derniers réglages de l'ingé appliqués (pour les réappliquer après un retour à la prise brute). */
  last?: any;
  /** Artiste : l'artiste a accepté une fois → les mises à jour suivantes s'appliquent toutes seules. */
  accepted?: boolean;
  /** Artiste : ses réglages d'avant (« Revenir à ma prise brute »). */
  before?: RemoteBefore;
  /** Artiste : prise brute remise (réglages de l'ingé gardés en réserve). */
  reverted?: boolean;
  /** Ingé : dernière version reçue de l'artiste. */
  recvV?: number;
  recvSig?: string;
  /** Ingé : version renvoyée et empreinte du renvoi (jamais deux fois le même). */
  returnedV?: number;
  returnedSig?: string;
  /** Ingé : renvoi automatique (après le premier « Envoyer à l'artiste »). */
  auto?: boolean;
}
