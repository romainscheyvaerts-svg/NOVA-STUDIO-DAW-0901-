/**
 * AudioSuite (R6, Pro Tools « AudioSuite », Logic « Traitement de fichier »,
 * Ableton « Consolidate » après un effet, FL « Edison ») : un effet NOVA ou VST
 * appliqué à un clip seul, ou aux clips d'une plage, avec des poignées.
 *
 * Non destructif : le clip joue le son traité, la prise d'origine est gardée
 * (`Clip.audioSuite`). Plusieurs traitements s'empilent ; « Revenir à
 * l'original » remet la prise d'origine telle quelle (même son, même place).
 * Une ancienne version de NOVA ignore le champ et joue le son traité.
 *
 * Fonctions pures ; le rendu est dans services/Bounce.ts (processRegion).
 */
import { AudioSuiteInfo, Clip, PluginType, TrackType } from '../types';
import { idGenerator, splitClipsAt } from './timeSelection';

/** Poignées par défaut (s) : du son avant / après le clip passe dans l'effet (réverbe, attaque du compresseur). */
export const DEFAULT_HANDLE = 1;

export type AudioSuiteStep = AudioSuiteInfo['steps'][number];

/** Ce clip peut-il être traité ? (sinon : la raison, à afficher) */
export const audioSuiteBlock = (c: Clip): string | null => {
  if (c.type === TrackType.MIDI || c.notes) return 'AudioSuite traite l’audio : convertis d’abord le MIDI en audio (Commit ou Consolider avec effets).';
  if (!c.bufferId && !c.buffer) return 'Le son de ce clip n’est pas encore chargé.';
  if (c.isReversed) return 'Clip inversé : consolide-le d’abord (Alt+Maj+3), puis traite-le.';
  if (c.warp && c.warp.mode && c.warp.mode !== 'OFF') return 'Clip calé sur le tempo (warp) : consolide-le d’abord (Alt+Maj+3), puis traite-le.';
  if (c.pitchEdit || c.araEdit) return 'Clip retouché (justesse / Melodyne) : consolide-le d’abord (Alt+Maj+3) pour figer la retouche, puis traite-le.';
  return null;
};

/**
 * Partie du son à traiter (en secondes du son du clip) : le clip et ses
 * poignées, bornées au son disponible. `lead` : poignée réellement prise avant.
 */
export const audioSuiteRegion = (c: Pick<Clip, 'offset' | 'duration'>, bufferDuration: number, handle = DEFAULT_HANDLE): { from: number; to: number; lead: number } => {
  const off = c.offset || 0;
  const from = Math.max(0, off - Math.max(0, handle));
  const to = Math.min(bufferDuration, off + c.duration + Math.max(0, handle));
  return { from, to, lead: off - from };
};

const SUFFIX_RE = /\s*\((AudioSuite[^)]*)\)$/;

/**
 * Changements du clip une fois le son traité enregistré sous `newBufferId`
 * (il commence à `from` dans le son actuel du clip). La prise d'origine reste
 * celle d'avant le premier traitement.
 */
export const audioSuitePatch = (c: Clip, o: { newBufferId: string; from: number; step: AudioSuiteStep }): Partial<Clip> => {
  const prev = c.audioSuite;
  const steps = [...(prev?.steps || []), o.step];
  const baseName = prev?.sourceName ?? c.name.replace(SUFFIX_RE, '');
  const offset = Math.max(0, (c.offset || 0) - o.from);
  const regionStart = (prev?.regionStart || 0) + o.from;
  const info: AudioSuiteInfo = {
    version: 1,
    sourceBufferId: prev ? prev.sourceBufferId : c.bufferId,
    regionStart,
    // Retour exact (sans erreur d'arrondi) tant que le clip n'a pas été recoupé.
    sourceOffset: prev && prev.sourceOffset !== undefined && prev.processedOffset !== undefined && Math.abs((c.offset || 0) - prev.processedOffset) < 1e-9 ? prev.sourceOffset : (prev ? (c.offset || 0) + (prev.regionStart || 0) : (c.offset || 0)),
    processedOffset: offset,
    steps,
    sourceName: baseName,
    ...(prev ? (prev.sourceWarp ? { sourceWarp: prev.sourceWarp } : {}) : (c.warp ? { sourceWarp: c.warp } : {})),
  };
  return {
    bufferId: o.newBufferId,
    offset,
    name: `${baseName} (AudioSuite : ${steps.map(s => s.name).join(' + ')})`.slice(0, 80),
    audioSuite: info,
  };
};

/** « Revenir à l'original » : la prise d'origine, à la même place (null si elle n'est plus là : reçue en collaboration). */
export const audioSuiteRevertPatch = (c: Clip, hasBuffer: (id: string) => boolean): Partial<Clip> | null => {
  const a = c.audioSuite;
  if (!a?.sourceBufferId || !hasBuffer(a.sourceBufferId)) return null;
  const off = c.offset || 0;
  return {
    bufferId: a.sourceBufferId,
    offset: a.sourceOffset !== undefined && a.processedOffset !== undefined && Math.abs(off - a.processedOffset) < 1e-9 ? a.sourceOffset : off + a.regionStart,
    name: a.sourceName ?? c.name.replace(SUFFIX_RE, ''),
    audioSuite: undefined,
    ...(a.sourceWarp ? { warp: a.sourceWarp } : {}),
  };
};

/** Applique un patch (les clés à undefined sont retirées). */
export const patchClip = (c: Clip, patch: Partial<Clip>): Clip => {
  const out = { ...c } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete out[k]; else out[k] = v; }
  return out as unknown as Clip;
};

/**
 * Plage → clips à traiter : les clips audio audibles sont coupés aux bords de
 * la plage (une seule étape d'annulation avec le traitement). Renvoie la
 * nouvelle liste et les ids des clips du dedans.
 */
export const clipsForRange = (clips: Clip[], start: number, end: number): { clips: Clip[]; targetIds: string[] } => {
  const touched = clips.filter(c => !c.isMuted && c.type !== TrackType.MIDI && !c.notes && c.start < end && c.start + c.duration > start);
  if (!touched.length) return { clips, targetIds: [] };
  const others = clips.filter(c => !touched.includes(c));
  const split = splitClipsAt(touched, [start, end], idGenerator('as'));
  const targetIds = split.filter(c => c.start >= start - 1e-6 && c.start + c.duration <= end + 1e-6).map(c => c.id);
  return { clips: [...others, ...split], targetIds };
};

/** Nom d'un traitement (« Compresseur · Voix 2:1 »). */
export const stepLabel = (type: PluginType, name: string, preset?: string) => (preset ? `${name} · ${preset}` : name).slice(0, 40) || String(type);
