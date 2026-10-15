/**
 * Nova, l'ingé son du chat : ce qu'elle voit du DAW et ce qu'elle a le droit d'y faire.
 *
 * - Catalogue des commandes : construit à partir de la palette Ctrl+K (utils/commandPalette),
 *   la seule liste de TOUTES les actions du studio. Une action ajoutée à la palette (ou un
 *   raccourci ajouté à la table) est vue par Nova sans rien câbler de plus.
 * - État du projet résumé (pistes, effets et leurs réglages principaux, bus, envois, tempo,
 *   tonalité, sélection, transport), avec une taille maximale : les modèles sont utilisés
 *   dans leurs paliers gratuits (Groq, Gemini), une grosse séance (64 pistes et plus) est résumée.
 * - Validation des appels d'outils renvoyés par le modèle : action ou commande inconnue
 *   refusée, piste / clip / envoi introuvable refusé, valeurs bornées, règles de mix de la
 *   maison appliquées (compresseur voix en 2:1), jamais de paiement.
 * - Confirmation obligatoire pour ce qui détruit ou se voit de l'extérieur (supprimer, vider,
 *   exporter, publier, envoyer, payer, quitter, collaboration).
 * - Phrase de compte rendu pour chaque appel (« Compresseur ajouté sur Lead : 2:1, seuil −18 dB »).
 *
 * Données pures (aucun React) : App.tsx branche, les tests vérifient.
 */
import type { AIAction, DAWState, PluginInstance, Track } from '../types';
import { TrackType } from '../types';
import type { PaletteAction } from './commandPalette';
import { normText } from './commandPalette';
import { ANALOG_SPECS } from '../engine/analogCompParams';
import { v21Automatable } from '../engine/v21Params';
import { getVocalRole, isVoiceTrack } from './vocalRoles';
import { findVoicePreset, roleFromTrackName } from './voicePresets';
import { describeSound } from './describeSound';
import { macroDef, MACRO_ORDER } from './oneKnob';

// ---------------------------------------------------------------------------
// Limites (paliers gratuits des modèles)
// ---------------------------------------------------------------------------

export const CHAT_LIMITS = {
  /** Appels d'outils exécutés pour un message. */
  maxCalls: 16,
  /** Catalogue des commandes envoyé au modèle (caractères). */
  catalogChars: 3200,
  /** État du projet envoyé au modèle (caractères de JSON). */
  stateChars: 6500,
  /** Échanges précédents envoyés au modèle (caractères). */
  historyChars: 1400,
  /** À partir de ce nombre de pistes, la séance est résumée. */
  bigSession: 64,
} as const;

// ---------------------------------------------------------------------------
// Catalogue des commandes (palette Ctrl+K)
// ---------------------------------------------------------------------------

export interface ChatCommand {
  id: string;
  label: string;
  group: string;
  /** Disponible maintenant (sinon `why` dit pourquoi). */
  ok: boolean;
  why?: string;
  /** Demande une confirmation dans le chat avant d'être lancée. */
  sensitive: boolean;
  /** Jamais lancée par le chat (paiement). */
  blocked: boolean;
  /** Texte de recherche (libellé, mots-clés, rubrique, Pro Tools, touches). */
  hay: string;
}

/**
 * Ce qui détruit, sort du studio ou engage : confirmation dans le chat. Par l'id (anglais,
 * stable) ou par le verbe qui ouvre le libellé ; pas pour un outil (gomme), une fenêtre
 * qui s'ouvre avant d'agir (« (fenêtre) ») ni pour effacer des solos / mutes / diodes.
 */
const SENSITIVE_ID = /\b(export|bounce|publi|share|send|quit|collab|invite|delete|erase|revert|aafexport|pay|buy|checkout)/;
const SENSITIVE_LABEL = /^\W*(supprimer|effacer|vider|exporter|publier|partager|envoyer|quitter|collaborer|inviter|revenir a la version|payer|acheter)\b/;
const HARMLESS = /\(fenetre\)|\b(solos?|mutes?|diodes?|indicateurs?)\b/;
/** Paiement : le chat n'y touche jamais (le bouton reste à l'artiste). */
const PAYMENT_RX = /\b(pay\w*|payer|checkout|stripe|unlock\w*|debloqu\w*)\b/;

export function isSensitiveCommand(id: string, label: string): boolean {
  const lab = normText(label);
  if (/^tool\./.test(id) || HARMLESS.test(lab)) return false;
  return SENSITIVE_ID.test(normText(id).replace(/[._]/g, ' ')) || SENSITIVE_LABEL.test(lab);
}

/** Palette (actions du studio + raccourcis) → catalogue compact pour le modèle. */
export function buildChatCatalog(actions: PaletteAction[]): ChatCommand[] {
  const seen = new Set<string>();
  const out: ChatCommand[] = [];
  for (const a of actions) {
    if (!a || !a.id || seen.has(a.id) || a.id.startsWith('word:') || a.id === 'nova.palette') continue;
    seen.add(a.id);
    const idWords = normText(a.id).replace(/[._]/g, ' ');
    out.push({
      id: a.id,
      label: a.label,
      group: a.group,
      ok: !a.disabledReason,
      why: a.disabledReason || undefined,
      sensitive: isSensitiveCommand(a.id, a.label),
      blocked: PAYMENT_RX.test(`${idWords} ${normText(a.label)}`),
      hay: normText(`${a.label} ${a.keywords || ''} ${a.group} ${a.pt || ''} ${idWords}`),
    });
  }
  return out;
}

/** Commandes toujours montrées (navigation, transport, fenêtres de l'ingé). */
const CORE_IDS = ['nova.play', 'nova.stop', 'nova.record', 'nova.home', 'nova.undo', 'nova.export', 'nova.save', 'view.mixer',
  'view.arrangement', 'pal.automation', 'pal.mixAuto', 'pal.loudness', 'pal.masterNova', 'pal.bus', 'pal.reverbReturn', 'pal.delayReturn', 'pal.tempo'];

const STOP_WORDS = new Set(['les', 'des', 'une', 'sur', 'dans', 'pour', 'avec', 'mets', 'met', 'fais', 'fait', 'moi', 'mon', 'ma', 'mes', 'ton', 'ta',
  'tes', 'est', 'que', 'qui', 'pas', 'plus', 'moins', 'peux', 'tu', 'je', 'il', 'elle', 'du', 'de', 'la', 'le', 'un', 'et', 'ou', 'a', 'au', 'aux', 'en', 'ca', 'cette', 'ce']);

/**
 * Lignes du catalogue envoyées au modèle : les commandes les plus proches de la demande
 * d'abord, puis les commandes de base, dans la limite de `maxChars`. Une ligne :
 * `id | libellé | rubrique` (+ `⚠ confirmation`, `✗ raison` si indisponible).
 */
export function catalogText(cmds: ChatCommand[], query: string, maxChars: number = CHAT_LIMITS.catalogChars): string {
  const words = normText(query).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w));
  const scored = cmds.filter(c => !c.blocked).map((c, i) => {
    let s = 0;
    for (const w of words) {
      const stem = w.length > 5 ? w.slice(0, 5) : w;
      if (c.hay.includes(w)) s += 3;
      else if (c.hay.includes(stem)) s += 2;
    }
    if (CORE_IDS.includes(c.id)) s += 0.5;
    return { c, s, i };
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const line = (c: ChatCommand) => `${c.id} | ${c.label.replace(/\s+/g, ' ').slice(0, 90)} | ${c.group}${c.sensitive ? ' | ⚠ confirmation' : ''}${c.ok ? '' : ` | ✗ ${c.why}`}`;
  const lines: string[] = [];
  let size = 0;
  for (const { c } of scored) {
    const l = line(c);
    if (size + l.length + 1 > maxChars - 160) break;
    lines.push(l); size += l.length + 1;
  }
  const total = scored.length;
  const summary = () => {
    const rest = total - lines.length;
    if (rest <= 0) return '';
    const groups: Record<string, number> = {};
    for (const { c } of scored.slice(lines.length)) groups[c.group] = (groups[c.group] || 0) + 1;
    const g = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ');
    return `… ${rest} autres commandes non listées ici (${g}) : si l'artiste en cite une, demande-lui de la redire avec ses mots.`;
  };
  // Le résumé final compte dans la limite : on retire des lignes tant qu'il ne tient pas.
  const join = () => [...lines, summary()].filter(Boolean).join('\n');
  while (lines.length && join().length > maxChars) lines.pop();
  return join().slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// État du projet résumé
// ---------------------------------------------------------------------------

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
const dbOf = (g: number) => { const d = gainToDb(g); return Number.isFinite(d) ? r1(d) : -99; };

/** Pistes numérotées comme à l'écran (« la piste 3 ») : sans les retours d'effets ni le master. */
export function numberedTracks(st: Pick<DAWState, 'tracks'>): Track[] {
  return st.tracks.filter(t => t.type !== TrackType.SEND && t.id !== 'master');
}

const EQ_DEFAULT_FREQS = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];

/** Réglages principaux d'un effet, en unités d'ingé (dB, Hz, ms, ratio). */
export function pluginEssentials(p: PluginInstance): Record<string, any> {
  const q = p.params || {};
  const num = (k: string) => (typeof q[k] === 'number' && Number.isFinite(q[k]) ? q[k] : undefined);
  switch (p.type) {
    case 'COMPRESSOR': return { ratio: num('ratio'), thrDb: num('threshold'), attMs: num('attack') !== undefined ? r1(q.attack * 1000) : undefined, relMs: num('release') !== undefined ? Math.round(q.release * 1000) : undefined, makeupDb: num('makeupGain') !== undefined ? dbOf(q.makeupGain) : undefined };
    case 'PROEQ12': {
      const bands: any[] = Array.isArray(q.bands) ? q.bands : [];
      const hp = bands.find(b => b && b.type === 'highpass' && b.isEnabled !== false);
      const lp = bands.find(b => b && b.type === 'lowpass' && b.isEnabled !== false);
      const bells = bands.filter(b => b && b.isEnabled !== false && b.type !== 'highpass' && b.type !== 'lowpass' && Math.abs(Number(b.gain) || 0) >= 0.1)
        .map(b => `${Math.round(b.frequency)}Hz ${b.gain > 0 ? '+' : ''}${r1(b.gain)}dB`);
      return { hpfHz: hp ? Math.round(hp.frequency) : undefined, lpfHz: lp ? Math.round(lp.frequency) : undefined, bells: bells.length ? bells : undefined };
    }
    case 'DEESSER': return { freqHz: num('frequency'), thrDb: num('threshold') };
    case 'AUTOTUNE': return { speed: num('speed'), humanize: num('humanize'), scale: q.scale };
    case 'REVERB': return { decayS: num('decay'), preDelayMs: num('preDelay') !== undefined ? Math.round(q.preDelay * 1000) : undefined, mix: num('mix') };
    case 'DELAY': return { division: q.division, feedback: num('feedback'), mix: num('mix') };
    case 'VOCALSATURATOR': return { drive: num('drive'), mix: num('mix'), mode: q.mode };
    default: {
      const spec = ANALOG_SPECS[p.type];
      if (spec) {
        const o: Record<string, any> = {};
        for (const s of spec.specs.slice(0, 5)) if (num(s.id) !== undefined) o[s.id] = r1(q[s.id]);
        return o;
      }
      const o: Record<string, any> = {};
      for (const [k, v] of Object.entries(q)) {
        if (Object.keys(o).length >= 4) break;
        if (k !== 'isEnabled' && typeof v === 'number' && Number.isFinite(v)) o[k] = r2(v);
      }
      return o;
    }
  }
}

const clean = (o: Record<string, any>) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === false) delete o[k]; return o; };

export interface ChatStateExtras {
  currentTime?: number;
  mode?: 'simple' | 'avancé';
  device?: 'téléphone' | 'ordinateur';
  sessionPart?: string | null;
  mixLevels?: unknown;
  bridgeVst?: boolean;
}

/**
 * Résumé du projet pour le modèle, borné à `maxChars` de JSON. Au-delà de
 * CHAT_LIMITS.bigSession pistes, seules les voix, les bus et la piste sélectionnée
 * gardent leur détail ; les autres pistes sont listées en une ligne.
 */
export function summarizeStateForChat(st: DAWState, extra: ChatStateExtras = {}, maxChars: number = CHAT_LIMITS.stateChars): Record<string, any> {
  const numbered = numberedTracks(st);
  const numOf = new Map(numbered.map((t, i) => [t.id, i + 1]));
  const big = st.tracks.length >= CHAT_LIMITS.bigSession;
  const detailFor = (t: Track) => !big || t.id === st.selectedTrackId || t.type === TrackType.BUS || t.type === TrackType.SEND || t.id === 'instrumental' || isVoiceTrack(t);

  const full = (t: Track, level: 0 | 1 | 2) => clean({
    n: numOf.get(t.id),
    id: t.id,
    name: t.name,
    type: t.type,
    role: getVocalRole(t) !== 'other' ? getVocalRole(t) : undefined,
    // Lot 8 : preset voix posé et positions du One Knob (0-100).
    voicePreset: t.voiceChain?.presetId || undefined,
    oneKnob: t.voiceChain?.amounts && Object.values(t.voiceChain.amounts).some(v => (v || 0) > 0)
      ? Object.fromEntries(Object.entries(t.voiceChain.amounts).filter(([, v]) => (v || 0) > 0).map(([k, v]) => [k, Math.round((v || 0) * 100)])) : undefined,
    volDb: dbOf(t.volume),
    pan: t.pan ? r2(t.pan) : undefined,
    muted: t.isMuted || undefined,
    solo: t.isSolo || undefined,
    armed: t.isTrackArmed || undefined,
    frozen: t.isFrozen || undefined,
    out: t.outputTrackId && t.outputTrackId !== 'master' ? t.outputTrackId : undefined,
    sends: level < 2 && t.sends?.length ? t.sends.map(s => clean({ id: s.id, lvl: r2(s.level), off: !s.isEnabled || undefined })) : undefined,
    fx: t.plugins?.length ? t.plugins.map(p => level === 0 ? clean({ type: p.type, off: !p.isEnabled || undefined, ...pluginEssentials(p) }) : p.type + (p.isEnabled ? '' : ' (bypass)')) : undefined,
    clips: t.clips?.length || undefined,
    auto: level === 0 ? (t.automationLanes || []).filter(l => l.points?.length).map(l => l.parameterName) : undefined,
  });

  const base = clean({
    name: st.name,
    bpm: st.bpm,
    sig: st.timeSignature ? `${st.timeSignature.numerator}/${st.timeSignature.denominator}` : undefined,
    key: st.projectKey !== undefined ? { root: st.projectKey, scale: st.projectScale } : undefined,
    playing: st.isPlaying || undefined,
    recording: st.isRecording || undefined,
    time: extra.currentTime !== undefined ? r2(extra.currentTime) : undefined,
    loop: st.isLoopActive ? [r2(st.loopStart), r2(st.loopEnd)] : undefined,
    view: st.currentView,
    selectedTrackId: st.selectedTrackId || undefined,
    mixStyle: st.vocalMixStyle || undefined,
    mode: extra.mode,
    device: extra.device,
    sessionPart: extra.sessionPart || undefined,
    vstBridge: extra.bridgeVst || undefined,
    markers: (st.markers || []).slice(0, 20).map(m => ({ id: m.id, name: m.name, t: r1(m.time) })),
    groups: (st.trackGroups || []).slice(0, 10).map(g => ({ id: g.id, name: g.name, tracks: g.trackIds })),
    trackCount: st.tracks.length,
  });
  if (!base.markers?.length) delete base.markers;
  if (!base.groups?.length) delete base.groups;

  const build = (level: 0 | 1 | 2, withLevels: boolean) => {
    const detailed = st.tracks.filter(detailFor);
    const others = st.tracks.filter(t => !detailFor(t));
    const out: Record<string, any> = { ...base, tracks: detailed.map(t => full(t, level)) };
    if (others.length) {
      out.summarized = true;
      out.otherTracks = others.map(t => `${numOf.get(t.id) ?? '-'}:${t.id}:${t.name}:${t.type}`);
    }
    if (withLevels && extra.mixLevels) out.mixLevels = extra.mixLevels;
    return out;
  };
  // Du plus détaillé au plus court, jusqu'à tenir dans la limite.
  for (const [lvl, lv] of [[0, true], [0, false], [1, false], [2, false]] as const) {
    const o = build(lvl, lv);
    if (JSON.stringify(o).length <= maxChars) return o;
  }
  const o = build(2, false);
  while (o.tracks.length > 1 && JSON.stringify(o).length > maxChars) o.tracks.pop();
  if (Array.isArray(o.otherTracks)) while (o.otherTracks.length && JSON.stringify(o).length > maxChars) o.otherTracks.pop();
  o.truncated = true;
  return o;
}

// ---------------------------------------------------------------------------
// Validation des appels d'outils
// ---------------------------------------------------------------------------

/** Actions exécutées par App.tsx (executeAIAction) et le pont VST (services/NovaVstMix). */
export const KNOWN_ACTIONS = new Set([
  'SET_VOLUME', 'SET_PAN', 'MUTE_TRACK', 'SOLO_TRACK', 'RENAME_TRACK', 'ADD_TRACK', 'CREATE_TRACK', 'DELETE_TRACK', 'DUPLICATE_TRACK',
  'UPDATE_TRACK', 'UPDATE_PLUGIN', 'SET_PLUGIN_PARAM', 'BYPASS_PLUGIN', 'OPEN_PLUGIN', 'CLOSE_PLUGIN', 'RESET_FX', 'SET_SEND_LEVEL',
  'PLAY', 'STOP', 'RECORD', 'SEEK', 'COMP_TAKE', 'AUTO_COMP', 'KEEP_TAKE_ASIDE', 'OPEN_TAKE_HOME', 'SET_PUNCH', 'GOTO_SECTION', 'SET_LOOP', 'SET_BPM',
  'MUTE_CLIP', 'SPLIT_CLIP', 'NORMALIZE_CLIP', 'PREPARE_REC', 'CLEAN_MIX', 'REMOVE_PLUGIN', 'MOVE_PLUGIN', 'COPY_PLUGIN',
  'SET_TRACK_OUTPUT', 'ARM_TRACK', 'FREEZE_TRACK', 'ADD_MARKER', 'DELETE_MARKER', 'GOTO_MARKER', 'SET_METRONOME', 'SET_TIME_SIGNATURE',
  'CREATE_GROUP', 'DELETE_GROUP', 'UPDATE_GROUP', 'DELETE_CLIP', 'DUPLICATE_CLIP', 'RENAME_CLIP', 'MOVE_CLIP', 'SET_CLIP_GAIN',
  'SET_CLIP_FADE', 'SET_AUTOMATION', 'CLEAR_AUTOMATION', 'LOAD_BEAT', 'SET_VIEW', 'TOGGLE_LOOP', 'SET_PROJECT_KEY', 'UNDO', 'REDO',
  'SAVE_PROJECT', 'OPEN_EXPORT', 'APPLY_MIX_STYLE', 'OPEN_LYRICS', 'OPEN_SHARE', 'ADD_DRUMS', 'OPEN_DRUMS', 'REMOVE_DRUMS',
  'LOAD_DAILY_CHALLENGE', 'OPEN_MIX_STYLES', 'REMOVE_SILENCE', 'CLEAN_SILENCE', 'BREATHS', 'SET_BREATH_AUTO', 'SET_AUTO_CLEAN',
  'PREPARE_PART', 'ANALYZE_MIX', 'OPEN_STUDIO_OFFER', 'HIGHLIGHT', 'SELECT_TRACK',
  // Lot 8 : chaîne voix (utils/voiceChatActions) — Décris ton son, presets voix, One Knob.
  'DESCRIBE_SOUND', 'APPLY_VOICE_PRESET', 'ONE_KNOB',
  'VST_MIX', 'VST_LIST', 'VST_SHOW_PARAMS', 'VST_SET_PARAM', 'VST_REMOVE', 'VST_MOVE',
  // Commande de la palette Ctrl+K, par son id.
  'RUN_COMMAND',
]);

/** Confirmation obligatoire : ce qui va se passer, à l'infinitif (affiché au-dessus de « Oui, fais-le »). */
const CONFIRM_ACTIONS: Record<string, string> = {
  DELETE_TRACK: 'Supprimer une piste', DELETE_CLIP: 'Supprimer un clip', RESET_FX: 'Retirer des effets', CLEAR_AUTOMATION: "Effacer de l'automation",
  DELETE_MARKER: 'Supprimer un repère', DELETE_GROUP: 'Supprimer un groupe', REMOVE_DRUMS: 'Retirer la batterie', VST_REMOVE: 'Retirer un plugin du PC',
  REMOVE_PLUGIN: 'Retirer un effet', OPEN_EXPORT: "Ouvrir l'export (payant selon ton offre, prix affiché dans la fenêtre)", OPEN_SHARE: 'Partager en dehors du studio',
  OPEN_STUDIO_OFFER: 'Ouvrir une page d’achat ou de réservation du studio', CLEAN_MIX: 'Remettre tous les volumes et pans à zéro', LOAD_BEAT: 'Remplacer le beat',
  LOAD_DAILY_CHALLENGE: 'Remplacer le beat par celui du défi du jour',
};

/** Le chat ne paie jamais : ces actions sont refusées d'office. */
const PAYMENT_ACTIONS = /^(PAY|PURCHASE|BUY|CHECKOUT|UNLOCK|CHARGE)/;

const CHAT_PLUGINS = new Set(['AUTOTUNE', 'PROEQ12', 'COMPRESSOR', 'VOCALSATURATOR', 'REVERB', 'DELAY', 'DOUBLER', 'STEREOSPREADER', 'DEESSER',
  'DENOISER', 'CHORUS', 'FLANGER', 'LIMITER', 'HARMONIZER', 'VOICESHIFT', 'TIMEFX', 'DJFILTER', 'LOFI', 'GATEFX', 'GATE',
  'OPTO_VINTAGE', 'FET76', 'LEVELER2A', 'VOXSTRIP', 'MASTERTRANSIENT']);

export const PLUGIN_LABELS: Record<string, string> = {
  COMPRESSOR: 'Compresseur', PROEQ12: 'EQ', DEESSER: 'De-esser', AUTOTUNE: 'Auto-Tune', REVERB: 'Réverbe', DELAY: 'Délai',
  VOCALSATURATOR: 'Saturation', DOUBLER: 'Doubleur', STEREOSPREADER: 'Élargisseur stéréo', DENOISER: 'Gate de bruit', CHORUS: 'Chorus',
  FLANGER: 'Flanger', LIMITER: 'Limiteur', HARMONIZER: 'Harmoniseur', VOICESHIFT: 'Voix grave / aiguë', TIMEFX: 'Tape stop',
  DJFILTER: 'Filtre DJ', LOFI: 'Lo-fi', GATEFX: 'Gate rythmique', GATE: 'Gate', OPTO_VINTAGE: 'Opto Vintage', FET76: 'FET 76',
  LEVELER2A: 'Leveler 2A', VOXSTRIP: 'Vox Strip', MASTERTRANSIENT: 'Transitoires master',
};

/** Bornes des effets NOVA « historiques » (les autres viennent de leurs fiches : analogiques, V21). */
const BOUNDS: Record<string, Record<string, [number, number]>> = {
  COMPRESSOR: { threshold: [-60, 0], ratio: [1, 20], knee: [0, 40], attack: [0.0001, 1], release: [0.005, 3], makeupGain: [0, 8] },
  DEESSER: { threshold: [-60, 0], frequency: [2000, 16000], q: [0.1, 10], reduction: [0, 1], relThreshold: [-30, 0] },
  AUTOTUNE: { speed: [0, 1], humanize: [0, 1], mix: [0, 1], rootKey: [0, 11] },
  REVERB: { decay: [0.1, 12], preDelay: [0, 0.5], damping: [0, 1], mix: [0, 1], size: [0, 1] },
  DELAY: { feedback: [0, 0.95], mix: [0, 1], feedbackLP: [200, 20000], feedbackHP: [20, 2000] },
  VOCALSATURATOR: { drive: [0, 100], mix: [0, 1], tone: [-1, 1], eqLow: [-12, 12], eqMid: [-12, 12], eqHigh: [-12, 12], outputGain: [0, 2] },
  DOUBLER: { detune: [0, 1], width: [0, 1], gainL: [0, 1], gainR: [0, 1] },
  STEREOSPREADER: { width: [0, 2], haasDelay: [0, 0.04], lowBypass: [0, 1] },
  DENOISER: { threshold: [-90, 0], range: [-80, 0], attack: [0.0005, 0.1], hold: [0, 1], release: [0.01, 2], scFreq: [50, 10000] },
  CHORUS: { rate: [0.05, 10], depth: [0, 1], spread: [0, 1], mix: [0, 1] },
  FLANGER: { rate: [0.05, 10], depth: [0, 1], feedback: [0, 0.95], manual: [0, 1], mix: [0, 1] },
  PROEQ12: { masterGain: [0, 4] },
};
const DELAY_DIVISIONS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/2.', '1/4.', '1/8.', '1/16.', '1/2T', '1/4T', '1/8T', '1/16T'];

/** Compresseurs soumis à la règle maison « voix en 2:1 ». */
const RATIO_2_ON_VOICE = new Set(['COMPRESSOR', 'OPTO_VINTAGE', 'FET76']);

export interface ChatCheckContext {
  state: DAWState;
  commands: ChatCommand[];
  /** Réglages par défaut d'un effet (createDefaultPlugins), pour compléter l'EQ. */
  pluginDefaults?: (type: string) => Record<string, any> | undefined;
}

export interface CheckedCall {
  action: AIAction;
  /** Compte rendu lisible (« Compresseur ajouté sur Lead : 2:1, seuil −18 dB »). */
  label: string;
  /** Raison de demander une confirmation (absente = exécution directe). */
  confirm?: string;
  /** Ajustements faits par la validation (valeur bornée, règle maison…). */
  notes: string[];
}

export interface RejectedCall { action: string; label: string; reason: string }

const MINUS = '−';
const fmtNum = (v: number, d = 1) => {
  const x = Math.round(v * 10 ** d) / 10 ** d;
  return (x < 0 ? MINUS : '') + String(Math.abs(x)).replace('.', ',');
};
export const fmtHz = (hz: number) => (hz >= 1000 ? `${fmtNum(hz / 1000, hz % 1000 ? 1 : 0)} kHz` : `${Math.round(hz)} Hz`);
const fmtDb = (db: number) => `${db > 0 ? '+' : ''}${fmtNum(db)} dB`;
const fmtPan = (p: number) => (Math.abs(p) < 0.01 ? 'centre' : `${Math.round(Math.abs(p) * 100)} % ${p < 0 ? 'G' : 'D'}`);

function clampNum(v: any, [a, b]: [number, number], notes: string[], what: string): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const x = Math.max(a, Math.min(b, n));
  if (x !== n) notes.push(`${what} ramené à ${fmtNum(x, 3)} (bornes ${fmtNum(a, 3)} à ${fmtNum(b, 3)})`);
  return x;
}

/** Piste par id, par nom (casse ignorée) ou par numéro (« 3 », « piste 3 »). */
export function resolveTrack(st: DAWState, ref: any): Track | undefined {
  if (ref === undefined || ref === null || ref === '') return undefined;
  const s = String(ref).trim();
  const byId = st.tracks.find(t => t.id === s);
  if (byId) return byId;
  const n = normText(s);
  const byName = st.tracks.find(t => normText(t.name) === n);
  if (byName) return byName;
  const num = /^(?:piste\s*)?(\d{1,3})$/.exec(n);
  if (num) return numberedTracks(st)[parseInt(num[1], 10) - 1];
  return undefined;
}

/** Paramètres d'un effet : bornés selon sa fiche, raccourcis d'ingé traduits (EQ, dB, ms). */
export function normalizePluginParams(type: string, params: Record<string, any>, current: Record<string, any> | undefined, notes: string[], touched: number[] = []): Record<string, any> {
  const p: Record<string, any> = { ...(params || {}) };
  const out: Record<string, any> = {};
  // Raccourcis en unités d'ingé.
  if (type === 'COMPRESSOR') {
    if (p.attackMs !== undefined) { p.attack = Number(p.attackMs) / 1000; delete p.attackMs; }
    if (p.releaseMs !== undefined) { p.release = Number(p.releaseMs) / 1000; delete p.releaseMs; }
    if (p.makeupDb !== undefined) { p.makeupGain = dbToGain(Number(p.makeupDb)); delete p.makeupDb; }
    if (p.thresholdDb !== undefined) { p.threshold = p.thresholdDb; delete p.thresholdDb; }
  }
  if (type === 'PROEQ12') {
    const hpf = p.hpf ?? p.lowCut ?? p.highpass; const lpf = p.lpf ?? p.highCut ?? p.lowpass;
    const bells = Array.isArray(p.bells) ? p.bells : p.bell ? [p.bell] : [];
    delete p.hpf; delete p.lowCut; delete p.highpass; delete p.lpf; delete p.highCut; delete p.lowpass; delete p.bells; delete p.bell;
    if (hpf !== undefined || lpf !== undefined || bells.length) {
      const src: any[] = Array.isArray(current?.bands) ? current!.bands : EQ_DEFAULT_FREQS.map((f, i) => ({ id: i, type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking', frequency: f, gain: 0, q: 1, isEnabled: true, isSolo: false }));
      const bands = src.map(b => ({ ...b }));
      if (hpf !== undefined) {
        const hz = hpf === false || hpf === 0 ? 0 : clampNum(hpf, [20, 1000], notes, 'Coupe-bas');
        const i = bands.findIndex(b => b.type === 'highpass'); const k = i >= 0 ? i : 0;
        bands[k] = hz ? { ...bands[k], type: 'highpass', frequency: hz, isEnabled: true } : { ...bands[k], isEnabled: false };
        touched.push(k);
      }
      if (lpf !== undefined) {
        const hz = lpf === false || lpf === 0 ? 0 : clampNum(lpf, [1000, 22000], notes, 'Coupe-haut');
        const i = bands.findIndex(b => b.type === 'lowpass'); const k = i >= 0 ? i : bands.length - 1;
        bands[k] = hz ? { ...bands[k], type: 'lowpass', frequency: hz, isEnabled: true } : { ...bands[k], isEnabled: false };
        touched.push(k);
      }
      for (const bell of bells.slice(0, 6)) {
        const f = clampNum(bell?.freq ?? bell?.frequency, [20, 20000], notes, 'Fréquence');
        if (f === undefined) continue;
        const peaks = bands.map((b, i) => ({ b, i })).filter(x => x.b.type !== 'highpass' && x.b.type !== 'lowpass');
        if (!peaks.length) continue;
        const near = peaks.reduce((a, x) => (Math.abs(Math.log(x.b.frequency / f)) < Math.abs(Math.log(a.b.frequency / f)) ? x : a));
        touched.push(near.i);
        bands[near.i] = { ...near.b, type: 'peaking', frequency: f, gain: clampNum(bell.gain ?? bell.db ?? 0, [-18, 18], notes, 'Gain') ?? 0,
          q: clampNum(bell.q ?? near.b.q ?? 1, [0.1, 18], notes, 'Q') ?? 1, isEnabled: true };
      }
      out.bands = bands;
    }
  }
  if (type === 'DELAY' && p.division !== undefined) {
    const d = String(p.division);
    if (DELAY_DIVISIONS.includes(d)) out.division = d; else notes.push(`division « ${d} » inconnue, ignorée`);
    delete p.division;
  }
  // Bornes : fiche analogique, fiche V21, table maison, sinon nombre fini raisonnable.
  const analog = ANALOG_SPECS[type];
  const v21 = analog ? [] : v21Automatable(type);
  const table = BOUNDS[type] || {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'isEnabled') { out.isEnabled = !!v; continue; }
    if (k === 'bands' && type === 'PROEQ12') continue; // bandes brutes : passer par hpf / lpf / bells
    const spec = analog?.specs.find(s => s.id === k) || v21.find(s => s.id === k);
    const range: [number, number] | undefined = spec ? [spec.min, spec.max] : table[k];
    if (range) {
      let x = clampNum(v, range, notes, k);
      if (x === undefined) { notes.push(`réglage « ${k} » illisible, ignoré`); continue; }
      const choices = (analog?.specs.find(s => s.id === k) as any)?.choices as { v: number }[] | undefined;
      if (choices?.length) x = choices.reduce((best, c) => (Math.abs(c.v - x!) < Math.abs(best - x!) ? c.v : best), choices[0].v);
      out[k] = x;
    } else if (analog || v21.length || BOUNDS[type]) {
      notes.push(`réglage « ${k} » inconnu sur ${PLUGIN_LABELS[type] || type}, ignoré`);
    } else if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e5) out[k] = v;
    else if (typeof v === 'string' && v.length <= 40) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Bandes d'EQ modifiées (type, fréquence, gain, Q, marche) par rapport à l'EQ d'avant. */
function changedBands(before: any[] | undefined, after: any[], touched: number[] = []): any[] {
  if (!Array.isArray(before)) return after;
  return after.filter((b, i) => {
    if (touched.includes(i)) return true;
    const a = before[i];
    return !a || a.type !== b.type || a.frequency !== b.frequency || (a.gain || 0) !== (b.gain || 0) || (a.q ?? 1) !== (b.q ?? 1) || (a.isEnabled !== false) !== (b.isEnabled !== false);
  });
}

/** Résumé des réglages posés, pour le compte rendu. */
export function describeParams(type: string, params: Record<string, any>): string {
  const bits: string[] = [];
  const q = params || {};
  if (q.ratio !== undefined) bits.push(`${fmtNum(q.ratio)}:1`);
  if (q.threshold !== undefined) bits.push(`seuil ${fmtDb(q.threshold).replace('+', '')}`);
  if (type === 'COMPRESSOR' && q.attack !== undefined) bits.push(`attaque ${fmtNum(q.attack * 1000)} ms`);
  if (type === 'COMPRESSOR' && q.release !== undefined) bits.push(`relâchement ${Math.round(q.release * 1000)} ms`);
  if (type === 'COMPRESSOR' && q.makeupGain !== undefined) bits.push(`gain ${fmtDb(gainToDb(q.makeupGain))}`);
  if (Array.isArray(q.bands)) {
    const hp = q.bands.find((b: any) => b.type === 'highpass' && b.isEnabled !== false);
    const lp = q.bands.find((b: any) => b.type === 'lowpass' && b.isEnabled !== false);
    if (hp) bits.push(`coupe-bas ${fmtHz(hp.frequency)}`);
    if (lp) bits.push(`coupe-haut ${fmtHz(lp.frequency)}`);
    for (const b of q.bands) if (b.type === 'peaking' && b.isEnabled !== false && Math.abs(b.gain || 0) >= 0.1) bits.push(`${fmtHz(b.frequency)} ${fmtDb(b.gain)}`);
  }
  if (q.frequency !== undefined && type !== 'PROEQ12') bits.push(fmtHz(q.frequency));
  if (q.decay !== undefined) bits.push(`${fmtNum(q.decay)} s`);
  if (q.division !== undefined) bits.push(String(q.division));
  if (q.feedback !== undefined) bits.push(`réinjection ${Math.round(q.feedback * 100)} %`);
  if (q.speed !== undefined && type === 'AUTOTUNE') bits.push(`vitesse ${Math.round(q.speed * 100)} %`);
  if (q.drive !== undefined) bits.push(`drive ${fmtNum(q.drive)}`);
  if (q.peakReduction !== undefined) bits.push(`réduction ${fmtNum(q.peakReduction)}`);
  if (q.input !== undefined && (type === 'FET76' || type === 'VOXSTRIP')) bits.push(`entrée ${fmtNum(q.input)}`);
  if (q.compThresh !== undefined) bits.push(`compression ${fmtNum(q.compThresh)}`);
  if (q.mix !== undefined) bits.push(`mix ${q.mix <= 1 ? Math.round(q.mix * 100) : Math.round(q.mix)} %`);
  if (q.isEnabled === false) bits.push('contourné');
  return bits.slice(0, 6).join(', ');
}

/** Valide UN appel (action + payload) ; renvoie l'appel prêt à exécuter ou la raison du refus. */
function checkOne(raw: any, ctx: ChatCheckContext): CheckedCall | RejectedCall {
  const st = ctx.state;
  const name = typeof raw?.action === 'string' ? raw.action.trim().toUpperCase() : '';
  const desc = typeof raw?.description === 'string' ? raw.description.slice(0, 160) : undefined;
  const reject = (reason: string, label = desc || name || 'Action'): RejectedCall => ({ action: name || '?', label, reason });
  if (!name) return reject('appel sans nom d’action');
  if (PAYMENT_ACTIONS.test(name)) return reject('je ne lance jamais de paiement : c’est toi qui payes, dans la fenêtre prévue');
  if (!KNOWN_ACTIONS.has(name)) return reject(`action « ${name} » inconnue de NOVA`);
  const p: Record<string, any> = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? { ...raw.payload } : {};
  const notes: string[] = [];
  const ok = (label: string, confirm?: string): CheckedCall => ({ action: { action: name as any, payload: p, description: desc }, label, confirm, notes });

  // Piste visée (id, nom ou numéro) : remplacée par son id exact.
  let track: Track | undefined;
  const TRACK_OPTIONAL = new Set(['RESET_FX', 'CLEAN_SILENCE', 'REMOVE_SILENCE', 'VST_MIX', 'VST_SHOW_PARAMS', 'VST_SET_PARAM', 'VST_REMOVE', 'VST_MOVE', 'BREATHS', 'AUTO_COMP', 'COMP_TAKE', 'KEEP_TAKE_ASIDE']);
  if (p.trackId !== undefined) {
    track = resolveTrack(st, p.trackId);
    if (!track) return reject(`piste « ${p.trackId} » introuvable`);
    p.trackId = track.id;
  }
  const needsTrack = /^(SET_VOLUME|SET_PAN|MUTE_TRACK|SOLO_TRACK|RENAME_TRACK|DELETE_TRACK|DUPLICATE_TRACK|UPDATE_TRACK|UPDATE_PLUGIN|SET_PLUGIN_PARAM|BYPASS_PLUGIN|OPEN_PLUGIN|REMOVE_PLUGIN|MOVE_PLUGIN|SET_SEND_LEVEL|SET_TRACK_OUTPUT|ARM_TRACK|FREEZE_TRACK|SET_AUTOMATION|CLEAR_AUTOMATION|SELECT_TRACK|PREPARE_REC|MUTE_CLIP|SPLIT_CLIP|NORMALIZE_CLIP|DELETE_CLIP|DUPLICATE_CLIP|RENAME_CLIP|MOVE_CLIP|SET_CLIP_GAIN|SET_CLIP_FADE|DESCRIBE_SOUND|APPLY_VOICE_PRESET|ONE_KNOB)$/.test(name);
  if (needsTrack && !track && !TRACK_OPTIONAL.has(name)) return reject('aucune piste indiquée');
  if (p.clipId !== undefined) {
    if (!track || !track.clips.some(c => c.id === p.clipId)) return reject(`clip « ${p.clipId} » introuvable${track ? ` sur ${track.name}` : ''}`);
  }
  const tn = track?.name || '';
  const voice = !!track && isVoiceTrack(track);

  switch (name) {
    case 'RUN_COMMAND': {
      const id = String(p.id || p.commandId || '').trim();
      const cmd = ctx.commands.find(c => c.id === id);
      if (!cmd) return reject(`commande « ${id || '?'} » inconnue (elle n'est pas dans la palette Ctrl+K)`, desc || 'Commande demandée');
      if (cmd.blocked) return reject('je ne lance jamais de paiement : c’est toi qui payes, dans la fenêtre prévue', cmd.label);
      if (!cmd.ok) return reject(cmd.why || 'indisponible pour l’instant', cmd.label);
      p.id = cmd.id;
      return ok(cmd.label, cmd.sensitive ? `Lancer « ${cmd.label} »` : undefined);
    }
    case 'SET_VOLUME': {
      if (p.volumeDb !== undefined || p.db !== undefined) {
        const db = clampNum(p.volumeDb ?? p.db, [-60, 3.5], notes, 'Volume (dB)');
        if (db === undefined) return reject('volume illisible');
        p.volume = r2(dbToGain(db)); delete p.volumeDb; delete p.db;
      } else {
        const v = clampNum(p.volume, [0, 1.5], notes, 'Volume');
        if (v === undefined) return reject('volume illisible');
        p.volume = v;
      }
      return ok(`Volume de ${tn} : ${fmtDb(gainToDb(p.volume))}`);
    }
    case 'SET_PAN': {
      const v = clampNum(p.pan, [-1, 1], notes, 'Pan');
      if (v === undefined) return reject('pan illisible');
      p.pan = v;
      return ok(`Pan de ${tn} : ${fmtPan(v)}`);
    }
    case 'SET_SEND_LEVEL': {
      const send = track!.sends?.find(s => s.id === p.sendId) || track!.sends?.find(s => normText(s.id).includes(normText(String(p.sendId || ''))));
      if (!send) return reject(`pas d'envoi « ${p.sendId ?? '?'} » sur ${tn}`);
      p.sendId = send.id;
      if (p.levelDb !== undefined) { const db = clampNum(p.levelDb, [-60, 0], notes, 'Envoi (dB)'); if (db === undefined) return reject('niveau illisible'); p.level = r2(dbToGain(db)); delete p.levelDb; }
      const v = clampNum(p.level, [0, 1], notes, 'Envoi');
      if (v === undefined) return reject('niveau illisible');
      p.level = v;
      const sendName = st.tracks.find(t => t.id === send.id)?.name || send.id;
      return ok(`Envoi ${sendName} de ${tn} : ${Math.round(v * 100)} %`);
    }
    case 'UPDATE_PLUGIN': case 'SET_PLUGIN_PARAM': case 'BYPASS_PLUGIN': case 'OPEN_PLUGIN': case 'REMOVE_PLUGIN': case 'MOVE_PLUGIN': {
      const type = String(p.pluginType || p.type || '').toUpperCase();
      const existing = p.pluginId ? track!.plugins.find(x => x.id === p.pluginId) : track!.plugins.find(x => x.type === type);
      if (name === 'UPDATE_PLUGIN') {
        if (!CHAT_PLUGINS.has(type)) return reject(`effet « ${type || '?'} » inconnu de NOVA`);
        p.pluginType = type; delete p.type;
        const current = existing?.params || ctx.pluginDefaults?.(type);
        const touched: number[] = [];
        p.params = normalizePluginParams(type, p.params || {}, current, notes, touched);
        if (voice && RATIO_2_ON_VOICE.has(type) && p.params.ratio !== undefined && p.params.ratio !== 2) {
          notes.push(`ratio ${fmtNum(p.params.ratio)}:1 ramené à 2:1 (règle maison : compresseur voix toujours en 2:1, sur deux étages)`);
          p.params.ratio = 2;
        }
        if (voice && RATIO_2_ON_VOICE.has(type) && !existing && p.params.ratio === undefined) p.params.ratio = 2;
        // EQ : seulement les bandes touchées (pas le coupe-haut d'usine à 18 kHz qu'on n'a pas demandé).
        const what = describeParams(type, Array.isArray(p.params.bands) ? { ...p.params, bands: changedBands(current?.bands, p.params.bands, touched) } : p.params);
        const label = PLUGIN_LABELS[type] || type;
        const timeFx = (type === 'REVERB' || type === 'DELAY') && track!.type !== TrackType.SEND && track!.id !== 'master' && !existing;
        return ok(`${label} ${existing ? 'réglé' : timeFx ? 'en envoi' : 'ajouté'} sur ${tn}${what ? ` : ${what}` : ''}`);
      }
      if (!existing) return reject(`pas d'effet ${PLUGIN_LABELS[type] || type || '?'} sur ${tn}`);
      p.pluginType = existing.type; p.pluginId = existing.id;
      const label = PLUGIN_LABELS[existing.type] || existing.type;
      if (name === 'SET_PLUGIN_PARAM') {
        const param = String(p.param || '');
        const touched: number[] = [];
        const n = normalizePluginParams(existing.type, { [param]: p.value }, existing.params, notes, touched);
        const keys = Object.keys(n);
        if (!keys.length) return reject(`réglage « ${param} » inconnu sur ${label}`);
        // Raccourci traduit (hpf → bandes) : passer par UPDATE_PLUGIN.
        if (keys[0] !== param) {
          const lbl = `${label} réglé sur ${tn} : ${describeParams(existing.type, Array.isArray(n.bands) ? { ...n, bands: changedBands(existing.params?.bands, n.bands, touched) } : n)}`;
          return { action: { action: 'UPDATE_PLUGIN' as any, payload: { trackId: track!.id, pluginType: existing.type, params: n }, description: desc }, label: lbl, notes };
        }
        if (voice && RATIO_2_ON_VOICE.has(existing.type) && param === 'ratio' && n.ratio !== 2) { notes.push('ratio ramené à 2:1 (règle maison sur la voix)'); n.ratio = 2; }
        p.param = param; p.value = n[param];
        return ok(`${label} de ${tn} : ${describeParams(existing.type, n) || `${param} = ${p.value}`}`);
      }
      if (name === 'BYPASS_PLUGIN') return ok(`${label} de ${tn} ${p.isEnabled === false ? 'contourné' : p.isEnabled === true ? 'réactivé' : 'basculé'}`);
      if (name === 'OPEN_PLUGIN') return ok(`Fenêtre ${label} de ${tn} ouverte`);
      if (name === 'MOVE_PLUGIN') { p.toIndex = Math.max(0, Math.min(track!.plugins.length - 1, Math.round(Number(p.toIndex) || 0))); return ok(`${label} déplacé en position ${p.toIndex + 1} sur ${tn}`); }
      return ok(`${label} retiré de ${tn}`, `Retirer ${label} de ${tn}`);
    }
    case 'SET_AUTOMATION': {
      const param = String(p.parameter || 'volume');
      if (param !== 'volume' && param !== 'pan') return reject(`automation « ${param} » : seulement volume ou pan depuis le chat`);
      if (!Array.isArray(p.points) || !p.points.length) return reject('aucun point d’automation');
      const isPan = param === 'pan';
      p.points = p.points.slice(0, 256).map((pt: any) => {
        const time = clampNum(pt?.time, [0, 3600], notes, 'Temps') ?? 0;
        const value = !isPan && pt?.valueDb !== undefined ? r2(dbToGain(clampNum(pt.valueDb, [-60, 3.5], notes, 'Volume (dB)') ?? 0)) : clampNum(pt?.value, isPan ? [-1, 1] : [0, 1.5], notes, 'Valeur') ?? (isPan ? 0 : 1);
        return { time, value };
      });
      p.parameter = param;
      return ok(`Automation ${param === 'pan' ? 'de pan' : 'de volume'} écrite sur ${tn} (${p.points.length} points)`);
    }
    case 'SELECT_TRACK': return ok(`${tn} sélectionnée`);
    case 'SET_BPM': {
      const v = clampNum(p.bpm, [30, 300], notes, 'Tempo');
      if (v === undefined) return reject('tempo illisible');
      p.bpm = r2(v);
      return ok(`Tempo : ${fmtNum(v, 2)} BPM`);
    }
    case 'SEEK': { p.time = clampNum(p.time, [0, 36000], notes, 'Temps') ?? 0; return ok(`Tête de lecture à ${fmtNum(p.time, 2)} s`); }
    case 'SET_LOOP': {
      const a = clampNum(p.start, [0, 36000], notes, 'Début') ?? 0; const b = clampNum(p.end, [0, 36000], notes, 'Fin') ?? 0;
      if (b <= a) return reject('boucle vide (la fin doit être après le début)');
      p.start = a; p.end = b;
      return ok(`Boucle de ${fmtNum(a, 2)} s à ${fmtNum(b, 2)} s`);
    }
    case 'SET_VIEW': {
      const v = String(p.view || '').toUpperCase();
      if (!['ARRANGEMENT', 'MIXER', 'AUTOMATION'].includes(v)) return reject(`vue « ${p.view} » inconnue`);
      p.view = v;
      return ok(v === 'MIXER' ? 'Console de mixage affichée' : v === 'AUTOMATION' ? 'Éditeur d’automation affiché' : 'Fenêtre d’édition affichée');
    }
    case 'SET_TRACK_OUTPUT': {
      const out = p.outputTrackId === 'master' ? null : resolveTrack(st, p.outputTrackId);
      if (p.outputTrackId !== 'master' && (!out || (out.type !== TrackType.BUS && out.type !== TrackType.SEND))) return reject(`sortie « ${p.outputTrackId} » introuvable (un bus ou master)`);
      if (out?.id === track!.id) return reject('une piste ne peut pas sortir dans elle-même');
      p.outputTrackId = out ? out.id : 'master';
      return ok(`Sortie de ${tn} → ${out ? out.name : 'master'}`);
    }
    case 'PLAY': return ok('Lecture');
    case 'STOP': return ok('Stop');
    case 'RECORD': return ok('Enregistrement lancé');
    case 'UNDO': return ok('Dernière action annulée');
    case 'REDO': return ok('Action rétablie');
    case 'MUTE_TRACK': return ok(`${tn} ${p.isMuted === false ? 'réactivée' : 'en muet'}`);
    case 'SOLO_TRACK': return ok(`${tn} ${p.isSolo === false ? 'hors solo' : 'en solo'}`);
    case 'RENAME_TRACK': { if (!p.name) return reject('nouveau nom manquant'); p.name = String(p.name).slice(0, 40); return ok(`${tn} renommée « ${p.name} »`); }
    case 'CREATE_TRACK': case 'ADD_TRACK': return ok(`Piste ${p.name ? `« ${String(p.name).slice(0, 40)} » ` : ''}créée`);
    case 'DUPLICATE_TRACK': return ok(`${tn} dupliquée`);
    case 'DELETE_TRACK': {
      const n = numberedTracks(st).findIndex(t => t.id === track!.id) + 1;
      const clips = track!.clips.length;
      return ok(`Piste ${tn} supprimée`, `Supprimer la piste ${n > 0 ? `${n} ` : ''}(${tn})${clips ? ` et ${clips === 1 ? 'son clip' : `ses ${clips} clips`}` : ''}`);
    }
    case 'DELETE_CLIP': return ok(`Clip supprimé sur ${tn}`, `Supprimer un clip de ${tn}`);
    case 'RESET_FX': return ok(track ? `Effets retirés de ${tn}` : 'Effets retirés de toutes les pistes', track ? `Retirer tous les effets de ${tn}` : 'Retirer TOUS les effets du projet');
    case 'CLEAR_AUTOMATION': return ok(`Automation effacée sur ${tn}`, `Effacer l'automation de ${tn}`);
    case 'OPEN_EXPORT': {
      const fmt = typeof p.format === 'string' ? p.format.toUpperCase() : '';
      return ok(`Fenêtre d’export ouverte${fmt ? ` (${fmt} demandé)` : ''}`, `Ouvrir l'export${fmt ? ` en ${fmt}` : ''} (payant selon ton offre, prix affiché dans la fenêtre)`);
    }
    case 'APPLY_MIX_STYLE': return ok(`Style de mix « ${p.style || '?'} » appliqué`);
    case 'DESCRIBE_SOUND': {
      const text = String(p.text || p.description || '').slice(0, 160);
      if (!text.trim()) return reject('phrase manquante (« plus brillante, un peu d’écho »…)');
      const d = describeSound(text, { role: findVoicePreset(track!.voiceChain?.presetId)?.role || roleFromTrackName(tn), currentPresetId: track!.voiceChain?.presetId || null });
      if (!d.matched.length) return reject(`aucun mot de son reconnu dans « ${text} »`);
      p.text = text;
      return ok(`Décris ton son sur ${tn} : ${d.summary}`);
    }
    case 'APPLY_VOICE_PRESET': {
      const pr = findVoicePreset(String(p.preset || p.presetId || p.name || ''));
      if (!pr) return reject(`preset voix « ${p.preset || p.presetId || p.name || '?'} » inconnu`);
      if ((pr.role === 'bus') !== (track!.type === TrackType.BUS)) return reject(pr.role === 'bus' ? `« ${pr.name} » se pose sur un bus voix (règle maison), pas sur une piste` : `« ${pr.name} » se pose sur une piste voix, pas sur un bus`);
      p.preset = pr.id;
      return ok(`Preset voix « ${pr.name} » posé sur ${tn}`);
    }
    case 'ONE_KNOB': {
      const m = String(p.macro || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
      const id = MACRO_ORDER.find(x => x === m);
      if (!id) return reject(`macro « ${p.macro || '?'} » inconnue (présence, chaleur, brillance, compression, espace, autotune, largeur, saturation)`);
      const a = clampNum(p.amount ?? p.value, [0, 100], notes, 'Position (%)');
      if (a === undefined) return reject('position du bouton illisible (0 à 100)');
      p.macro = id; p.amount = a;
      return ok(`One Knob de ${tn} : ${macroDef(id).name} ${Math.round(a)} %`);
    }
    default: {
      const why = CONFIRM_ACTIONS[name];
      return ok(desc || name.toLowerCase().replace(/_/g, ' '), why);
    }
  }
}

export interface ChatPlan {
  /** Appels à exécuter tout de suite. */
  run: CheckedCall[];
  /** Appels sensibles : attendent « Oui, fais-le ». */
  ask: CheckedCall[];
  rejected: RejectedCall[];
}

/**
 * Valide la liste d'appels renvoyée par le modèle (ou par une commande locale) et la
 * répartit : exécution directe, confirmation, refus. `confirmed` : l'artiste a déjà dit oui.
 */
export function planChatCalls(raw: unknown, ctx: ChatCheckContext, opts: { confirmed?: boolean } = {}): ChatPlan {
  const list = Array.isArray(raw) ? raw : [];
  const plan: ChatPlan = { run: [], ask: [], rejected: [] };
  list.forEach((r, i) => {
    if (i >= CHAT_LIMITS.maxCalls) { if (i === CHAT_LIMITS.maxCalls) plan.rejected.push({ action: '…', label: `${list.length - i} action(s) de plus`, reason: `${CHAT_LIMITS.maxCalls} actions au plus par message` }); return; }
    const c = checkOne(r, ctx);
    if ('reason' in c) plan.rejected.push(c);
    else if (c.confirm && !opts.confirmed) plan.ask.push(c);
    else plan.run.push(c);
  });
  return plan;
}

/** Messages précédents compactés pour le modèle (les plus récents, dans la limite). */
export function compactHistory(msgs: { role: string; content: string }[], maxChars: number = CHAT_LIMITS.historyChars): { role: 'user' | 'assistant'; text: string }[] {
  const out: { role: 'user' | 'assistant'; text: string }[] = [];
  let size = 0;
  for (let i = msgs.length - 1; i >= 0 && out.length < 8; i--) {
    const m = msgs[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || !m.content) continue;
    const text = m.content.replace(/\s+/g, ' ').slice(0, 400);
    if (size + text.length > maxChars) break;
    size += text.length;
    out.unshift({ role: m.role as 'user' | 'assistant', text });
  }
  return out;
}
