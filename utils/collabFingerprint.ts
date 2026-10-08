import type { DAWState, Track, Clip } from '../types';

/**
 * Empreinte de ce que la collaboration PARTAGE : deux participants qui ont
 * reçu les mêmes opérations doivent avoir exactement la même empreinte, piste
 * par piste. Sert :
 *  - aux tests (vitest et scénarios headless) : convergence prouvée après
 *    chaque étape ;
 *  - à l'indicateur de synchronisation du panneau Collaboration : chacun
 *    annonce son empreinte, un écart à horizon égal se voit (« désynchronisé »).
 *
 * Ce qui reste local n'y est PAS : solo, armement, hauteur des pistes, piste
 * sélectionnée, tête de lecture, boucle, métronome, aperçus et gels locaux,
 * buffers en mémoire, état interne des VST (relu par chaque pont).
 * Module pur.
 */

const r6 = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x ?? null);

/** Valeur canonique (clés triées, nombres arrondis, undefined retirés). */
export function canon(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'number') return r6(v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canon);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined) continue;
    out[k] = canon(x);
  }
  return out;
}

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

export const hashOf = (v: unknown): string => fnv(JSON.stringify(canon(v)));

/** Pistes qui voyagent (le beat non acheté, lui aussi : sa présence et son mix). */
export const isSharedTrack = (t: Track): boolean => !!t && typeof t.id === 'string';

const CLIP_LOCAL = new Set(['buffer', 'freezeRef', 'isFreezeSlice', 'audioRef', 'isOffline', 'isUnlicensed', 'color']);

/** Ce qui compte d'un clip (position, son, gain, fondus, éditions). */
export function clipShape(c: Clip): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (!CLIP_LOCAL.has(k) && v !== undefined) out[k] = v;
  return out;
}

const pluginShape = (p: any) => {
  const { stateB64: _s, ...params } = (p?.params || {}) as Record<string, unknown>;
  return { id: p?.id, type: p?.type, name: p?.name, on: p?.isEnabled !== false, inactive: !!p?.isInactive, params };
};

/** Champs partagés d'une piste, regroupés (pour dire QUOI diffère). */
export function trackParts(t: Track): Record<string, unknown> {
  const anyT = t as any;
  return {
    meta: {
      name: t.name, type: t.type, color: t.color, owner: t.collabOwner ?? null, ownerKey: t.collabOwnerKey ?? null,
      guide: t.isGuide ? (t.guideLevel ?? true) : null, comment: t.comment ?? null,
    },
    mix: {
      volume: t.volumeLock ? t.volumeLock.volume : t.volume, lock: t.volumeLock ? t.volumeLock.volume : null,
      pan: t.pan, mute: !!t.isMuted, out: t.outputTrackId, sends: t.sends || [],
      strip: { trim: t.inputTrimDb ?? 0, phase: !!t.phaseInvert, mono: !!t.monoSum, width: t.stereoWidth ?? 1 },
    },
    plugins: (t.plugins || []).map(pluginShape),
    automation: { mode: t.automationMode ?? null, lanes: (t.automationLanes || []).map(l => ({ id: l.id, p: l.parameterName, pts: (l.points || []).map(pt => ({ t: pt.time, v: pt.value, c: (pt as any).curveType ?? null })) })) },
    structure: {
      hidden: !!t.isHidden, inactive: !!t.isInactive, folder: t.folder ?? null, parent: t.parentFolderId ?? null, vca: !!t.isVca,
      vcaId: t.vcaId ?? null, vcaGroup: t.vcaGroupId ?? null, inBus: t.inputBusId ?? null, outBus: t.outputBusId ?? null, buses: t.ioBuses ?? null,
    },
    clips: [...(t.clips || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(clipShape),
    instrument: {
      drumMachine: anyT.drumMachine ?? null,
      drumPads: (t.drumPads || []).map(p => { const { buffer: _b, ...r } = p as any; return r; }),
      bass808: anyT.bass808 ?? null, novaSynth: anyT.novaSynth ?? null, sampler: anyT.melodicSampler ?? null,
      vst: t.vstInstrument ? { path: t.vstInstrument.path, name: (t.vstInstrument as any).name ?? null } : null,
    },
    takes: t.takeMeta ?? null,
    breath: t.breathKind ?? null,
  };
}

/** Empreinte de chaque piste et de chaque partie (une partie qui diffère = ce qui n'a pas voyagé). */
export interface TrackPrint { id: string; name: string; sig: string; parts: Record<string, string> }

export function trackPrint(t: Track): TrackPrint {
  const parts = trackParts(t);
  const sigs: Record<string, string> = {};
  for (const [k, v] of Object.entries(parts)) sigs[k] = hashOf(v);
  return { id: t.id, name: t.name, sig: hashOf(sigs), parts: sigs };
}

/** Parties communes à la session. */
export function songParts(s: Partial<DAWState>): Record<string, unknown> {
  return {
    tempo: { bpm: s.bpm, ts: s.timeSignature, events: s.tempoEvents || [] },
    markers: (s.markers || []).map(m => ({ id: m.id, name: m.name, t: m.time, type: (m as any).type ?? null, end: (m as any).endTime ?? null, color: m.color, n: (m as any).number ?? null })),
    chords: (s.chords || []).map(c => { const { by: _b, ...r } = c as any; return r; }),
    groups: { groups: s.trackGroups || [], settings: s.groupSettings ?? null },
    notes: s.projectNotes ?? null,
    arrangements: s.arrangements || [],
    key: { key: s.projectKey ?? null, scale: s.projectScale ?? null },
    order: (s.tracks || []).map(t => t.id),
  };
}

export interface SessionPrint { sig: string; song: Record<string, string>; tracks: TrackPrint[] }

export function sessionPrint(s: Partial<DAWState>): SessionPrint {
  const songP = songParts(s);
  const song: Record<string, string> = {};
  for (const [k, v] of Object.entries(songP)) song[k] = hashOf(v);
  const tracks = (s.tracks || []).filter(isSharedTrack).map(trackPrint).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { sig: hashOf({ song, tracks: tracks.map(t => [t.id, t.sig]) }), song, tracks };
}

/** Différences lisibles entre deux empreintes (« Voix lead : clips », « tempo »…). */
export function printDiff(a: SessionPrint, b: SessionPrint): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a.song), ...Object.keys(b.song)])) if (a.song[k] !== b.song[k]) out.push(`session : ${k}`);
  const bm = new Map(b.tracks.map(t => [t.id, t]));
  const am = new Map(a.tracks.map(t => [t.id, t]));
  for (const t of a.tracks) {
    const o = bm.get(t.id);
    if (!o) { out.push(`« ${t.name} » : absente chez l'autre`); continue; }
    if (o.sig === t.sig) continue;
    for (const k of Object.keys(t.parts)) if (t.parts[k] !== o.parts[k]) out.push(`« ${t.name} » : ${k}`);
  }
  for (const t of b.tracks) if (!am.has(t.id)) out.push(`« ${t.name} » : absente ici`);
  return out;
}
