
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
export type EditorTool = 'SELECT' | 'SPLIT' | 'ERASE' | 'AUTOMATION' | 'DRAW' | 'SMART' | 'RANGE' | 'ZOOM' | 'SCRUB';
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

export type PluginType = 'REVERB' | 'DELAY' | 'CHORUS' | 'FLANGER' | 'DOUBLER' | 'STEREOSPREADER' | 'COMPRESSOR' | 'AUTOTUNE' | 'DEESSER' | 'DENOISER' | 'PROEQ12' | 'VOCALSATURATOR' | 'MASTERSYNC' | 'LIMITER' | 'HARMONIZER' | 'VOICESHIFT' | 'TIMEFX' | 'DJFILTER' | 'LOFI' | 'GATEFX' | 'GATE' | 'OPTO_VINTAGE' | 'FET76' | 'LEVELER2A' | 'VOXSTRIP' | 'MASTERTRANSIENT' | 'VST3' | 'SAMPLER' | 'DRUM_SAMPLER' | 'MELODIC_SAMPLER' | 'DRUM_RACK_UI';

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
  /**
   * BYPASS (Pro Tools : Ctrl+clic) : faux = le son passe sans traitement, mais
   * l'effet reste chargé et sa latence reste compensée (alignement gardé).
   */
  isEnabled: boolean;
  params: Record<string, any>;
  latency: number; 
  /**
   * INACTIF (Pro Tools « Make Inactive », Ctrl+Démarrer+clic ; dans NOVA
   * Ctrl+Alt+clic ou le menu de l'effet) : l'effet est retiré du graphe audio,
   * ne consomme rien et n'a plus de latence (PDC recalculée). Ses réglages
   * (params, stateB64 d'un VST) sont gardés pour le recharger à l'identique.
   * Absent : actif (anciens projets). Indépendant du bypass. Voir utils/trackStructure.
   */
  isInactive?: boolean;
  /**
   * Side-chain (R7, Pro Tools « Key Input ») : la détection du Compresseur, du
   * Gate, du Gate rythmique ou du De-esser écoute une autre piste (son id) ou
   * un bus nommé (« bus:<id du bus> ») au lieu du son de sa piste. Le filtre et
   * l'écoute de la clé sont dans params (keyHpf, keyLpf, keyListen). Voir engine/sidechain.ts.
   */
  sidechainSourceId?: string;
  /** Nom de la source quand elle a été choisie (retrouver la clé dans un preset de chaîne / un modèle). */
  sidechainSourceName?: string;
  /** Prise de la clé : « pre » (défaut) = après les effets de la source, avant son fader et son mute ; « post » = après le fader. */
  sidechainTap?: 'pre' | 'post';
}

export interface TrackSend {
  id: string;          
  level: number;       
  isEnabled: boolean;
  /**
   * Envoi pré-fader (Pro Tools « PRE ») : le signal part après les effets mais
   * avant le fader et le pan de la piste. Absent : post-fader (comme avant).
   */
  preFader?: boolean;
  /**
   * Pan propre de l'envoi (-1 … 1), Pro Tools « FMP » éteint. Absent : l'envoi
   * suit le pan de la piste (comme avant).
   */
  pan?: number;
  /** Mute de l'envoi (Pro Tools) : coupé mais routé (PDC et câblage gardés). */
  isMuted?: boolean;
  /** Position de l'envoi dans la piste : 0 = a … 9 = j (Pro Tools : 10 envois). Absent : ordre du tableau. */
  slot?: number;
}

/** Bus interne nommé (I/O Setup de Pro Tools) : « LEAD A », « VOX ALL », « RV »… */
export interface NamedBus {
  id: string;
  name: string;
  /** Mono (1) ou stéréo (2, par défaut). Informatif. */
  channels?: 1 | 2;
}

/** Dossier de pistes (Pro Tools 2020.3+). */
export interface TrackFolder {
  /** routing = « Routing Folder » (c'est un bus : les enfants y sont routés) ; basic = « Basic Folder » (range seulement). */
  kind: 'routing' | 'basic';
  /** Déplié (enfants visibles). Absent : déplié. */
  isOpen?: boolean;
}

export interface MidiNote {
  id: string;
  pitch: number;
  start: number; 
  duration: number; 
  velocity: number; 
  isSelected?: boolean;
  /**
   * Batterie importée d'un .mid (V25) : note General MIDI d'origine (40 = caisse
   * claire électrique, 44 = charley au pied…). Plusieurs notes GM partagent un pad
   * de la boîte à rythmes ; à l'export, la note revient à sa valeur d'origine tant
   * qu'elle n'a pas changé de pad.
   */
  gm?: number;
  /**
   * Note muette (R16, Pro Tools : Mute Notes, FL : outil Muet) : gardée dans le
   * clip, affichée en gris, jamais jouée ni exportée.
   */
  muted?: boolean;
  /**
   * R18 · Réglages par note venus de la boîte à rythmes (Graph Editor de FL
   * Studio) : panoramique (-1 … 1, ajouté à celui du pad) et hauteur en
   * demi-tons (ajoutée à l'accordage). Le sampler mélodique les suit aussi.
   * Absents : 0 (une ancienne version les ignore).
   */
  pan?: number;
  tune?: number;
}

/** Groove (V25, utils/groove) : décalage et vélocité par case de grille, comme le Groove Pool de Live. */
export interface GrooveTemplate {
  id: string;
  name: string;
  /** Cases par temps : 2 = croches, 4 = doubles-croches. */
  stepsPerBeat: number;
  /** Longueur du motif en temps (4 = une mesure en 4/4). */
  lengthBeats: number;
  /** Décalage de chaque case, en fraction de case (+ = en retard). */
  timing: number[];
  /** Multiplicateur de vélocité de chaque case. */
  velocity: number[];
}

/** Groove posé sur un clip MIDI, réglable tant qu'il n'est pas appliqué (Commit Groove). */
export interface ClipGroove {
  template: GrooveTemplate;
  /** Intensité du décalage (0-1, comme Timing dans Live). */
  amount: number;
  /** Effet sur la vélocité (0-1). */
  velocity: number;
  /** Calage sur la grille avant le groove (0-1, comme Quantize dans Live). */
  quantize?: number;
  /** Notes d'origine (sans groove). */
  source: MidiNote[];
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
  // ─── R12 · Groupes Pro Tools complets (utils/editGroups) ─────────────────────
  /**
   * Édition, Mix ou les deux (Pro Tools : Edit / Mix / Edit and Mix). Absent :
   * « mix » (les groupes d'avant R12 ne liaient que la console).
   */
  kind?: 'edit' | 'mix' | 'both';
  /** Groupe actif (surligné dans la liste des groupes). Absent : actif. */
  isActive?: boolean;
  /** Envois liés (niveau relatif, muet). */
  linkedSends?: boolean;
  /** Mode d'automation lié (Read, Touch, Latch…). */
  linkedAutomation?: boolean;
  /**
   * R14 · Armement lié (Pro Tools : Record Enable) : armer (ou désarmer) une piste du
   * groupe arme tout le groupe. Vaut pour les groupes d'édition comme de mix.
   */
  linkedRecord?: boolean;
  /** Membres déduits (modèle relevé sans la fenêtre des groupes) : à vérifier. */
  deduced?: boolean;
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
  /**
   * Contrôleurs MIDI (R16, utils/midiCc) : pitch bend (« pb »), aftertouch
   * (« at ») et CC (« cc1 », « cc64 »…), points { t (s depuis le début du
   * clip), v (valeur MIDI brute) }. Absent : aucun contrôleur.
   */
  cc?: Record<string, { t: number; v: number }[]>;
  isMuted?: boolean;
  gain?: number;
  isReversed?: boolean; 
  audioRef?: string;
  isUnlicensed?: boolean;
  /** Son introuvable ou illisible à l'ouverture (projet réparé) : clip gardé à sa place, muet. */
  isOffline?: boolean;
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
   * Point de synchro (Pro Tools : Sync Point, Ctrl+,) en temps du fichier audio
   * (même repère que offset) : c'est lui qui se cale sur la grille et en Spot.
   */
  syncPoint?: number;
  /**
   * Position d'origine (Pro Tools : Original Time Stamp) : instant de la
   * timeline où commençait le fichier audio à l'enregistrement.
   */
  originStart?: number;
  /**
   * Justesse note par note (V19) : ce clip joue un son corrigé (rendu hors
   * ligne). La prise d'origine et les retouches sont gardées pour revenir en
   * arrière ou retoucher. Une ancienne version ignore ce champ et joue le son
   * corrigé comme un clip normal. Voir utils/pitchEdit.
   */
  pitchEdit?: PitchEditInfo;
  /**
   * Respirations baissées ou supprimées (utils/breaths) : zones de l'audio
   * SOURCE (secondes du buffer, comme `offset`) où le gain du clip descend,
   * avec de courts fondus. Non destructif ; survit aux découpes et voyage
   * avec le clip (collaboration). Absent : rien de traité.
   */
  breaths?: BreathEdit[];
  /**
   * Ligne de gain du clip (Pro Tools : Clip Gain Line, utils/clipGain) :
   * points en dB rangés en secondes de l'audio SOURCE (même repère que
   * `offset`), donc ils survivent aux découpes et aux rognages. Le gain
   * s'ajoute (en dB) au gain global `gain`. Lue par le même plan de gain que
   * les fondus et les respirations (utils/fades) : lecture = export. Une
   * ancienne version ignore ce champ. Absent : ligne plate (0 dB).
   */
  gainPoints?: ClipGainPoint[];
  /**
   * « Rendre le gain dans le fichier » (Pro Tools : Render Clip Gain) : le
   * clip joue un son où la ligne de gain est déjà appliquée ; le son d'origine
   * et la ligne sont gardés pour revenir en arrière. Non destructif.
   */
  gainRender?: ClipGainRenderInfo;
  /**
   * Boucle de clip (Pro Tools : Clip Looping, utils/clipLoop) : ce clip est
   * une itération d'une boucle. Chaque itération est un vrai clip (même son,
   * même offset) : une ancienne version joue la boucle telle quelle.
   */
  loop?: ClipLoopInfo;
  /**
   * Groove / swing en cours de réglage (V25, utils/groove) : `notes` contient
   * déjà le résultat (une ancienne version joue donc le clip groové) ; la
   * source sert à changer de réglage. Absent : pas de groove.
   */
  groove?: ClipGroove;
  /**
   * Retouche par un plugin ARA (Melodyne, VocAlign) : ce clip joue le son rendu
   * par le plugin. La prise d'origine et l'état du plugin (archive ARA, les
   * retouches de Melodyne) sont gardés pour rouvrir, retoucher ou revenir à
   * l'original. Une ancienne version ignore ce champ et joue le son rendu.
   * Voir utils/araEdit.
   */
  araEdit?: AraEditInfo;
  /**
   * Traitement de clip (AudioSuite de Pro Tools, R6) : ce clip joue le son
   * rendu par un ou plusieurs effets. La prise d'origine est gardée pour
   * « Revenir à l'original ». Une ancienne version ignore ce champ et joue le
   * son traité comme un clip normal. Voir utils/clipProcess.
   */
  audioSuite?: AudioSuiteInfo;
  /**
   * Transposition, étirement et marqueurs de warp (R13, utils/clipTranspose) :
   * ce clip joue un son rendu hors ligne (transposé, étiré, recalé). Le son
   * d'origine et les réglages sont gardés pour rouvrir le réglage ou revenir à
   * l'original. Une ancienne version ignore ce champ et joue le son rendu.
   */
  elastic?: ElasticInfo;
}

/**
 * Marqueur de warp (R13, Elastic Audio de Pro Tools, Flex Time de Logic) :
 * l'instant `src` du son d'origine (s) joue à `dst` secondes du début du clip.
 * (L'ancien `WarpMarker`, en temps musical, n'a jamais été branché.)
 */
export interface ElasticMarker { id: string; src: number; dst: number }

/** Ce que garde un clip transposé / étiré / recalé (R13). */
export interface ElasticInfo {
  version: 1;
  /** Son d'origine (registre audio). Absent ou introuvable (reçu en collaboration) : on repart du son rendu. */
  sourceBufferId?: string;
  /** Fichier du son d'origine dans un projet sauvegardé (le temps de la sauvegarde). */
  sourceRef?: string;
  /** Partie du son d'origine que montre le clip (s, repère du son d'origine). */
  sourceOffset: number;
  sourceDuration: number;
  /** Partie du son d'origine rendue (avec des marges, pour rallonger le clip). */
  regionStart: number;
  regionEnd: number;
  /** Où commence la partie montrée dans le son rendu (s) au moment du rendu. */
  renderedOffset: number;
  /** Durée de la partie montrée une fois étirée (s). */
  duration: number;
  /** Transposition en demi-tons, au cent près (−12 à +12). */
  semitones: number;
  /** Garder les formants (voix naturelle, pas d'effet « chipmunk »). */
  formants: boolean;
  /** Moteur choisi : automatique, voix (PSOLA) ou polyphonique (beat, sample). */
  algo: 'auto' | 'voice' | 'poly';
  /** Moteur réellement utilisé au dernier rendu. */
  used?: 'voice' | 'poly';
  /** Marqueurs de warp (triés). */
  markers?: ElasticMarker[];
  /** Calage au tempo (warp automatique, Ableton) : tempo d'origine du son et tempo visé. */
  tempo?: { sourceBpm: number; bpm: number };
  /** R23 : attaques ancrées (chaque attaque tombe à l'échantillon près à sa nouvelle place). */
  attacks?: boolean;
  /** Nom et calage du clip d'origine. */
  sourceName?: string;
  sourceWarp?: WarpSettings;
}

/** Ce que garde un clip traité par un effet (AudioSuite). */
export interface AudioSuiteInfo {
  version: 1;
  /** Son d'origine (registre audio). Absent ou introuvable : on ne peut que garder le son traité. */
  sourceBufferId?: string;
  /** Fichier du son d'origine dans un projet sauvegardé (le temps de la sauvegarde). */
  sourceRef?: string;
  /** Instant du son d'origine qui correspond au début du son traité (s). */
  regionStart: number;
  /** Décalage du clip dans le son d'origine et dans le son traité, au moment du traitement (retour exact). */
  sourceOffset?: number;
  processedOffset?: number;
  /** Effets appliqués, dans l'ordre. */
  steps: { type: PluginType; name: string; preset?: string; at: number }[];
  /** Nom et calage du clip d'origine. */
  sourceName?: string;
  sourceWarp?: WarpSettings;
}

/** Piste rendue par Commit, Consolider avec effets ou impression de bus (utils/commit). */
export interface TrackCommitInfo {
  kind: 'commit' | 'bounce' | 'bus';
  /** Piste d'origine : rendue inactive et masquée (commit), clips coupés (bounce), bus coupé (bus). */
  sourceTrackId: string;
  at: number;
  /** Dernier effet inclus dans le rendu (index) ; -1 : aucun. */
  upTo?: number;
  /** Queue rendue après la fin (s). */
  tail?: number;
  /** Plage rendue (bounce). */
  range?: { start: number; end: number };
  /** Clips d'origine coupés par le bounce (rallumés à la restauration). */
  mutedClipIds?: string[];
  /** Le bus d'origine a été coupé à l'impression. */
  mutedSource?: boolean;
  /** État de la piste d'origine avant le commit (restauré à l'identique). */
  sourceWasHidden?: boolean;
  sourceWasInactive?: boolean;
}

/** Plugin ARA connu de NOVA. */
export type AraPluginKey = 'melodyne' | 'vocalign';

/** Ce que garde un clip retouché par un plugin ARA. */
export interface AraEditInfo {
  version: 1;
  plugin: AraPluginKey;
  /** Nom et version du plugin au moment de la retouche (« Melodyne 5.4.2 »). */
  pluginName?: string;
  /** Comment le son a été obtenu : ARA (Melodyne), capture (VocAlign), ou alignement NOVA (sans plugin). */
  mode: 'ara' | 'capture' | 'nova';
  /** Son d'origine (registre audio). Absent ou introuvable : on ne peut que garder le son rendu. */
  sourceBufferId?: string;
  /** Fichier du son d'origine dans un projet sauvegardé (le temps de la sauvegarde). */
  sourceRef?: string;
  /** Instant du son d'origine qui correspond au début du son rendu (s). */
  regionStart: number;
  /** Identifiant stable du son confié au plugin (relie l'archive au bon son). */
  persistentId: string;
  /** État ARA du plugin (base64) : les retouches de Melodyne, pour rouvrir et retoucher. */
  archive?: string;
  /** VocAlign : le guide (la lead) sur lequel ce clip a été calé. */
  guide?: { trackId?: string; clipId?: string; name?: string };
  sourceWarp?: WarpSettings;
  sourceName?: string;
  at?: number;
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

/** Une respiration traitée : zone de l'audio source et gain appliqué. */
export interface BreathEdit {
  /** Début / fin dans l'audio source (s, même repère que Clip.offset). */
  start: number;
  end: number;
  /** Gain au creux de la respiration (dB, ≤ 0) ; -120 ou moins = supprimée. */
  gainDb: number;
  /** Durée de chaque fondu (s), dans la zone ; absent = 10 ms. */
  fade?: number;
}

/** Point de la ligne de gain d'un clip (utils/clipGain). */
export interface ClipGainPoint {
  /** Instant dans l'audio source (s, même repère que Clip.offset). */
  t: number;
  /** Gain en dB (s'ajoute au gain global du clip). */
  db: number;
  /** Courbure du segment vers le point suivant (−1 … 1, 0 ou absent = droit). */
  curve?: number;
}

/** Ce que garde un clip dont la ligne de gain a été rendue dans le fichier. */
export interface ClipGainRenderInfo {
  /** Son d'origine (registre audio). */
  sourceBufferId?: string;
  /** Fichier du son d'origine dans un projet sauvegardé. */
  sourceRef?: string;
  /** Ligne de gain et gain global rendus (rétablis par « Revenir »). */
  gainPoints: ClipGainPoint[];
  gain: number;
}

/** Itération d'une boucle de clip (utils/clipLoop). */
export interface ClipLoopInfo {
  /** Identifiant de la boucle (commun à toutes ses itérations). */
  id: string;
  /** Rang de l'itération (0 = le clip d'origine). */
  index: number;
  /** Durée d'une itération (s) : la longueur du clip bouclé. */
  unit: number;
  /** Fondu aux jonctions (s), 0 = aucun. */
  xfade?: number;
  /** Fondus du clip d'origine (le premier garde l'entrée, le dernier la sortie). */
  srcFadeIn?: number;
  srcFadeOut?: number;
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
  /** Respirations traitées (Clip.breaths) déjà contenues dans le rendu. */
  breaths?: BreathEdit[];
  /** Ligne de gain (Clip.gainPoints) déjà contenue dans le rendu. */
  gainPoints?: ClipGainPoint[];
  /**
   * Son joué par le clip au moment du rendu (bufferId). S'il change (justesse,
   * Melodyne, alignement, retour à l'original…), la tranche ne peut plus
   * suivre : le rendu est périmé. Dans un fichier projet : « = » (même son que
   * le clip) ou « ≠ » (les identifiants des sons changent à la réouverture).
   */
  buf?: string;
  /**
   * Empreinte du reste du son au moment du rendu (sens, calage, notes : utils/freeze
   * clipContentSig). Absent (avec buf) : rendus d'avant l'empreinte.
   */
  content?: string;
  /** Clip muet au moment du rendu (le rendu ne contient pas son son). */
  muted?: boolean;
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
  /** Canal MIDI d'un .mid importé (V25) : 10 = batterie General MIDI gardée en notes brutes. */
  midiChannel?: number;
  name: string;
  type: TrackType;
  color: string;
  isMuted: boolean;
  isSolo: boolean;
  isTrackArmed: boolean;
  /**
   * R14 · Entrée physique enregistrée par la piste (Pro Tools : sélecteur d'entrée) :
   * `ch` = 1re entrée (0 = entrée 1), `stereo` = paire ch / ch+1. Absent : entrée
   * choisie dans les Réglages audio (micro par défaut, ou entrée de la carte).
   */
  recordInput?: RecordInput | null;
  isFrozen: boolean;
  volume: number;
  pan: number;
  /** Tête de tranche (R11), avant les inserts : trim d'entrée en dB (−24 à +24, 0 par défaut). */
  inputTrimDb?: number;
  /** Inversion de polarité Ø des deux canaux. */
  phaseInvert?: boolean;
  /** Somme mono (prime sur la largeur). */
  monoSum?: boolean;
  /** Largeur stéréo : 0 = mono, 1 = inchangée (défaut), 2 = très large. */
  stereoWidth?: number;
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
   * (R9) Empreinte de l'automation des VST rendus (voies jouées des effets
   * [0..frozenUpToPluginIndex]) : si elle change, le rendu est périmé.
   */
  frozenVstAutoSig?: string;
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
   * Respirations (utils/breaths) : type de voix choisi à la main quand la
   * devinette par le nom se trompe. Absent : deviné (LEAD, BACK, ADLIB…).
   */
  breathKind?: 'lead' | 'extra' | 'skip';
  /**
   * Collaboration : rôle qui possède le contenu de la piste (prises, motifs).
   * Absent : les pistes voix sont à l'artiste, le beat à personne.
   */
  collabOwner?: CollabRole;
  /**
   * « Feat à distance » : personne qui possède la piste (« u:<compte> »), son
   * nom et sa couleur. Seul son propriétaire peut en changer le contenu : la
   * prise d'un artiste n'écrase jamais celle d'un autre. Absent : la piste est
   * à tout le rôle (anciennes sessions).
   */
  collabOwnerKey?: string;
  collabOwnerName?: string;
  collabOwnerColor?: string;
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
   * Piste MIDI jouée par le synthé NOVA (3 oscillateurs, filtre, préréglages).
   * Absent : l'ancien synthé simple (les anciens projets sonnent comme avant).
   */
  novaSynth?: import('./utils/novaSynth').NovaSynthSettings;
  /**
   * R18 · Piste MIDI jouée par le sampler mélodique (ton son, chromatique,
   * ADSR, boucle, glide, mono / poly) ou, R20, par un instrument
   * multi-échantillons (piano, Rhodes, guitare, cordes, cloches, nappe).
   * Absent : synthé. Une ancienne version l'ignore et joue le synthé.
   */
  melodicSampler?: import('./utils/melodicSampler').MelodicSamplerSettings;
  /**
   * Piste MIDI (mode instru) jouée par un instrument VST3 du PC (pont VST).
   * Les notes sont rendues hors temps réel dans frozenClip (isFrozen, aucun
   * effet inclus : frozenUpToPluginIndex = -1) : le son est sauvegardé avec
   * le projet et se joue partout, même sans le pont.
   */
  vstInstrument?: VstInstrument;
  groupId?: string;            // NEW: Track group reference
  /**
   * R12 : tous les groupes de la piste quand elle en a plusieurs (Pro Tools :
   * une piste peut être dans plusieurs groupes). Dérivé de TrackGroup.trackIds
   * (utils/editGroups.syncGroupFields) ; `groupId` reste le premier.
   */
  groupIds?: string[];
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

  /**
   * Piste guide (R3) : la voix témoin (démo du topliner, yaourt, ancienne prise)
   * s'entend pendant la prise mais n'est jamais exportée, ni mixée, ni masterisée
   * (Pro Tools : piste « Guide » inactive au Bounce ; Logic : piste mise hors du
   * Bounce). `guideLevel` : son niveau à part (×, 0,7 par défaut), `guideMuted` :
   * coupée d'un geste (bouton GUIDE de la barre, touche G).
   */
  isGuide?: boolean;
  guideLevel?: number;
  guideMuted?: boolean;

  // ─── Structure façon Pro Tools (utils/trackStructure.ts) ───────────────────
  /** Piste masquée (liste des pistes de Pro Tools) : elle joue quand même si elle est active. */
  isHidden?: boolean;
  /** Piste inactive (Pro Tools « Make Inactive ») : aucun traitement, aucune voix, routage gardé. */
  isInactive?: boolean;
  /** La piste est un dossier (routage ou simple). */
  folder?: TrackFolder;
  /** Dossier parent (id de la piste dossier). */
  parentFolderId?: string;
  /** La piste est un VCA Master : pas de son, son fader pilote les membres (dB relatifs). */
  isVca?: boolean;
  /** VCA qui pilote cette piste (choisi à la main). */
  vcaId?: string;
  /** VCA : groupe dont les pistes sont membres (en plus des pistes choisies à la main). */
  vcaGroupId?: string;
  /** Entrée : bus interne nommé écouté par cette piste (aux / bus). */
  inputBusId?: string;
  /** Sortie : bus interne nommé (prioritaire sur outputTrackId, résolu vers la piste qui l'écoute). */
  outputBusId?: string;
  /** Bus nommés de la session (I/O Setup) : rangés sur la piste master seulement. */
  ioBuses?: NamedBus[];
  /** Piste rendue (Commit, bounce, bus imprimé) : d'où elle vient, pour « Restaurer la piste d'origine ». */
  commit?: TrackCommitInfo;
  /**
   * R21 · Commentaire de la piste (Pro Tools : Comments, vue Commentaires de la
   * console et de la fenêtre d'édition) : micro utilisé, consigne de mix… Affiché
   * dans la console et l'en-tête ; voyage en collaboration (utils/sessionNotes).
   */
  comment?: string;
}

/** R14 · Entrée physique d'une piste (0 = entrée 1 de la carte / du micro). */
export interface RecordInput {
  ch: number;
  stereo?: boolean;
}

/** R15 · Niveau d'une piste dans un mix casque. */
export interface CueLevel {
  /** Gain linéaire (1 = 0 dB, 0 à 2). */
  level: number;
  /** Panoramique -1 (gauche) à 1 (droite). */
  pan: number;
  muted?: boolean;
}

/** R15 · Mix casque (cue mix) d'un musicien. */
export interface CueMix {
  id: string;
  name: string;
  /** Paire de sorties de la carte : 0 = sorties 1-2, 1 = sorties 3-4… */
  pair: number;
  /** Niveaux par piste ; une piste absente prend son volume et son pan du mix principal. */
  levels: Record<string, CueLevel>;
  /** Niveau du clic dans ce mix (0 = pas de clic). */
  click: number;
  /** Volume général du mix (1 = 0 dB). */
  master?: number;
  /** Mix coupé. */
  muted?: boolean;
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
  /**
   * R14 · Groupe de prises (take group) : les prises d'un MÊME passage enregistré sur
   * plusieurs pistes partagent cet identifiant ; elles se coupent et se compent ensemble.
   */
  group?: string;
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
  /** Collaboration : qui a posé ce repère (affiché aux autres). */
  by?: string;
}

// Metronome settings
export interface MetronomeSettings {
  enabled: boolean;
  volume: number;        // 0-1
  /** Décompte : 0, 1, 2, 4 (mesures ou temps selon countInUnit). utils/countIn. */
  countIn: number;
  /** Unité du décompte. Absente (projet d'avant R2) : mesures, 1 mesure si countIn = 0. */
  countInUnit?: 'bars' | 'beats';
  accentDownbeat: boolean;
  /** Force de l'accent du premier temps (0…1, 0,6 par défaut). */
  accentLevel?: number;
  sound: 'CLICK' | 'WOODBLOCK' | 'BEEP' | 'COWBELL' | 'STICK' | 'CUSTOM';
  /** Quand le clic sonne : pendant l'enregistrement seulement, ou aussi en lecture (défaut). */
  mode?: 'record' | 'always';
  /** Sortie : comme la musique (carte son de NOVA, défaut) ou sortie de l'ordinateur. */
  output?: 'main' | 'system';
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
  /** Pré-roll / post-roll en secondes (R2), prioritaires sur les mesures quand ils sont réglés. */
  preRollSec?: number;
  postRollSec?: number;
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
  /** Changements de tempo et de mesure (piste tempo, R2). utils/tempoMap. */
  tempoEvents?: import('./utils/tempoMap').TempoEvent[];
  projectKey?: number; 
  projectScale?: string; 
  /** Dernier style de mix voix appliqué (utils/vocalPresets). */
  vocalMixStyle?: string;
  /**
   * Respirations traitées automatiquement après chaque prise (utils/breaths).
   * Absent : on suit la préférence de l'appareil (désactivé par défaut).
   */
  breathAuto?: boolean;
  /**
   * R15 · Mixes casque (cue mixes) : un mix séparé par musicien, envoyé sur une paire
   * de sorties de la carte (envois pré-fader de Pro Tools).
   */
  cueMixes?: CueMix[];
  /**
   * Type de projet : VOCAL = poser sa voix sur une instru (par défaut) ;
   * BEATMAKING = faire une instru (batterie) sur une mélodie du studio, avec
   * la possibilité d'y poser ensuite sa voix.
   */
  projectMode?: 'VOCAL' | 'BEATMAKING';
  /** Collaboration : dernière opération du journal incluse dans cet instantané. */
  collabSeq?: number;
  /**
   * Collaboration : opérations sur le temps (R12) déjà appliquées à ce projet (leurs identifiants, les
   * 200 dernières). L'instantané en ligne peut contenir une opération reçue en direct que le journal
   * rejoue ensuite à celui qui arrive : sans cette liste, le temps était inséré deux fois.
   */
  collabTimeOps?: string[];
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
  /**
   * R12 : réglages globaux des groupes (Pro Tools : « Suspendre tous les
   * groupes », groupe <TOUT>). Absent : rien de suspendu, <TOUT> inactif.
   */
  groupSettings?: import('./utils/editGroups').GroupSettings;
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
  /** Mode d'édition Pro Tools (Shuffle, Slip, Spot, Grid) et grille : utils/editModes. */
  editMode?: import('./utils/editModes').EditModeSettings;
  /**
   * Piste d'accords (V20, Chord Track de Logic) : accords posés à la main ou
   * détectés sur le beat (utils/chordTrack). Absent : pas d'accords (anciens
   * projets) ; une ancienne version l'ignore sans rien casser.
   */
  chords?: import('./utils/chordDetect').ChordEvent[];
  // ─── R21 · Session pro ─────────────────────────────────────────────────────
  /**
   * Notes du projet (Pro Tools : Project Notes) : consignes de mix, références,
   * notes libres. Les paroles restent dans `lyrics` (prompteur). Voyagent en
   * collaboration (utils/sessionNotes). Une ancienne version les ignore.
   */
  projectNotes?: import('./utils/sessionNotes').ProjectNotes;
  /**
   * Arrangements du morceau (« clean » / « explicite », « radio edit »…) : ordre
   * des sections de la piste Arrangement et clips coupés. utils/arrangements.
   */
  arrangements?: import('./utils/arrangements').SongArrangement[];
  /**
   * Clips de la session qui ne sont plus sur la timeline (Pro Tools : Clips
   * List) : gardés dans la liste des clips, à reposer d'un glisser. utils/clipsList.
   */
  clipBin?: import('./utils/clipsList').BinClip[];
  /** Numéro de version nommée (Enregistrer comme nouvelle version : v2, v3…). utils/projectVersions. */
  sessionVersion?: number;
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
  /** Sous-menu (un niveau) : l'entrée l'ouvre au survol, au clic / doigt ou avec →. */
  submenu?: (ContextMenuItem | 'separator')[];
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
  // Respirations (utils/breaths) : baisser sur la lead, supprimer sur les backs
  | 'BREATHS'
  | 'SET_BREATH_AUTO'
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
  /**
   * Ingé : l'artiste qui a envoyé la piste (« u:<compte> »). Plusieurs artistes
   * sur le même lien peuvent avoir une piste au même identifiant : chez l'ingé
   * ce sont deux pistes, et le rendu ne revient qu'à son artiste.
   */
  peerKey?: string;
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
