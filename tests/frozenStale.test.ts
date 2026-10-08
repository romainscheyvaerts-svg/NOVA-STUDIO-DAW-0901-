import { describe, expect, it, vi } from 'vitest';
import { anchorClipsToRender, clipContentSig, freezeDrift, freezeDriftKey, freezeOutdated, freezeSignature, frozenPlayback, pluginsSignature } from '../utils/freeze';
import { correctedClipPatch, revertClipPatch } from '../utils/pitchEdit';
import { araClipPatch, araRevertPatch } from '../utils/araEdit';
import { editingElastic, elasticPatch, renderPlan, withSemitones } from '../utils/clipTranspose';
import { splitClipAt, replaceWithConsolidated } from '../utils/timeSelection';
import { makeFreezeBase } from '../utils/preFxEdits';
import { makeClip, makeTrack } from './helpers/fixtures';
import type { Clip, PluginInstance, PluginType, Track } from '../types';

vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

// Importé après les mocks (le moteur audio n'est pas chargé).
const { applyFreezeResult } = await import('../services/VstFreeze');
const { planFrozenRefresh, canRefreezeHere } = await import('../hooks/useFrozenRefresh');

const plug = (id: string, type = 'COMPRESSOR'): PluginInstance => ({ id, name: id, type: type as PluginType, isEnabled: true, params: { t: 1 }, latency: 0 });
const has = () => true;
let renders = 0;

/** Gèle la piste comme le fait l'appli (applyFreezeResult : ancres, empreintes, photo). */
function freeze(t: Track): Track {
  const id = `fz${++renders}`;
  const clip = makeClip({ id, bufferId: `${id}-buf`, start: 0, duration: 60 });
  const upTo = (t.plugins || []).length - 1;
  const out: Track = { ...t, isFrozen: true, clips: (t.clips || []).map(c => ({ ...c })) };
  applyFreezeResult(out, {
    clip, upTo, clipIds: (t.clips || []).map(c => c.id), sig: freezeSignature(t.clips || [], t.plugins || [], upTo),
    pluginSig: pluginsSignature(t.plugins || [], upTo), anchors: anchorClipsToRender(t.clips || [], id),
  });
  return out;
}

const lead = (plugins: PluginInstance[] = [plug('comp')], extra: Partial<Clip> = {}) => freeze(makeTrack({
  id: 'lead', name: 'LEAD', plugins,
  clips: [makeClip({ id: 'c', bufferId: 'rec', start: 10, offset: 2, duration: 6, gain: 1, ...extra }), makeClip({ id: 'd', bufferId: 'rec2', start: 20, offset: 0, duration: 4 })],
}));
const edit = (t: Track, id: string, patch: Partial<Clip> | ((c: Clip) => Partial<Clip>)): Track => ({
  ...t, clips: t.clips.map(c => (c.id === id ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)),
});
const kinds = (t: Track) => {
  const d = freezeDrift(t);
  return d ? { content: d.content, approx: d.approx, live: d.live } : null;
};

describe('rendu gelé périmé : une empreinte du son de chaque clip, comparée en continu', () => {
  it('juste après le gel : rien à refaire ; le clip garde l’empreinte de son son', () => {
    const t = lead();
    expect(freezeDrift(t)).toBeNull();
    expect(freezeDriftKey(t)).toBeNull();
    expect(t.clips[0].freezeRef!.content).toBe(clipContentSig(t.clips[0]));
  });

  it('déplacer un clip : la tranche suit exactement, rien à refaire', () => {
    expect(freezeDrift(edit(lead(), 'c', { start: 14 }))).toBeNull();
  });

  it('justesse V19 (nouveau son) : le son a changé', () => {
    const t = lead();
    const after = edit(t, 'c', c => correctedClipPatch(c, { newBufferId: 'justesse-1', sourceBufferId: 'rec', sourceOffset: 2, regionStart: 1.75, edits: [] }));
    expect(kinds(after)).toEqual({ content: ['c'], approx: [], live: [] });
    // La lecture joue encore l'ancien rendu à cet endroit : seul un regel corrige.
    expect(frozenPlayback(after).render.find(s => s.id.startsWith('c'))!.bufferId).toBe(t.frozenClip!.bufferId);
  });

  it('justesse puis « Revenir à l’original » sur une piste gelée APRÈS la correction : le son a changé', () => {
    const corrected = edit(makeTrack({ id: 'x', clips: [makeClip({ id: 'c', bufferId: 'rec', start: 10, offset: 2, duration: 6 })] }), 'c',
      c => correctedClipPatch(c, { newBufferId: 'justesse-1', sourceBufferId: 'rec', sourceOffset: 2, regionStart: 1.75, edits: [] }));
    const t = freeze(corrected);
    expect(freezeDrift(t)).toBeNull();
    const back = edit(t, 'c', c => revertClipPatch(c, has)!);
    expect(back.clips[0].bufferId).toBe('rec');
    expect(kinds(back)!.content).toEqual(['c']);
  });

  it('Melodyne / VocAlign (ARA) et alignement NOVA : nouveau son rendu, puis retour à l’original', () => {
    const t = lead();
    const opts = { mode: 'edit' as const, newBufferId: 'ara-1', sourceBufferId: 'rec', sourceOffset: 2, regionStart: 1, persistentId: 'p' };
    const mel = edit(t, 'c', c => araClipPatch(c, { plugin: 'melodyne', ...opts }));
    expect(kinds(mel)!.content).toEqual(['c']);
    // L'alignement NOVA (utils/vocalAlign) passe par le même chemin, avec le plugin « vocalign ».
    const nova = edit(t, 'c', c => araClipPatch(c, { plugin: 'vocalign', ...opts, mode: 'align' as never }));
    expect(kinds(nova)!.content).toEqual(['c']);
    // Gelée après la retouche, puis retour à l'original.
    const t2 = freeze(mel);
    expect(freezeDrift(t2)).toBeNull();
    expect(kinds(edit(t2, 'c', c => araRevertPatch(c, has)!))!.content).toEqual(['c']);
  });

  it('inverser, changer le calage, réactiver un clip muet au gel : le son a changé', () => {
    expect(kinds(edit(lead(), 'c', { isReversed: true }))!.content).toEqual(['c']);
    expect(kinds(edit(lead(), 'c', { warp: { enabled: true, mode: 'COMPLEX' as never, preservePitch: true, originalBpm: 90 } }))!.content).toEqual(['c']);
    const muted = lead(undefined, { isMuted: true });
    expect(freezeDrift(muted)).toBeNull();
    expect(kinds(edit(muted, 'c', { isMuted: false }))!.content).toEqual(['c']);
    // Muter un clip rendu : la tranche se tait, c'est exact.
    expect(freezeDrift(edit(lead(), 'c', { isMuted: true }))).toBeNull();
  });

  it('respirations : retirées → son changé ; ajoutées → suivies (à peu près)', () => {
    const e = [{ start: 3.2, end: 3.6, gainDb: -15, fade: 0.01 }];
    const withB = lead(undefined, { breaths: e });
    expect(kinds(edit(withB, 'c', { breaths: undefined }))!.content).toEqual(['c']);
    expect(kinds(edit(lead(), 'c', { breaths: e }))!.approx).toEqual(['c']);
  });

  it('gain de clip et fondus : suivis par les tranches APRÈS les effets → à refaire (approx)', () => {
    expect(kinds(edit(lead(), 'c', { gain: 0.5 }))).toEqual({ content: [], approx: ['c'], live: [] });
    expect(kinds(edit(lead(), 'c', { fadeIn: 0.3 }))!.approx).toEqual(['c']);
    expect(kinds(edit(lead(), 'c', { fadeOut: 0.2, fadeOutCurve: 'EXPONENTIAL' as never }))!.approx).toEqual(['c']);
  });

  it('découpe (2 moitiés) : chacune garde son ancre, à refaire (coupe et queue d’effet)', () => {
    const t = lead();
    const [a, b] = splitClipAt(t.clips[0], 13, 'c2')!;
    const split: Track = { ...t, clips: [a, b, t.clips[1]] };
    expect(b.freezeRef!.renderId).toBe(t.frozenClip!.id);
    expect(kinds(split)).toEqual({ content: [], approx: ['c', 'c2'], live: [] });
    // Supprimer une moitié : l'autre reste exactement suivie (approx), rien en direct.
    expect(kinds({ ...t, clips: [a, t.clips[1]] })!.approx).toEqual(['c']);
  });

  it('Strip Silence (morceaux du même clip, fondus) : à refaire, sans son changé', () => {
    const t = lead();
    const c = t.clips[0];
    const pieces = [{ ...c, id: 'c-v0', duration: 2, fadeIn: 0.01, fadeOut: 0.04 }, { ...c, id: 'c-v1', start: 13, offset: 5, duration: 3, fadeIn: 0.01, fadeOut: 0.04 }];
    const d = kinds({ ...t, clips: [...pieces, t.clips[1]] })!;
    expect(d.content).toEqual([]);
    expect(d.approx).toEqual(['c-v0', 'c-v1']);
  });

  it('consolidation : un nouveau son posé à la place des clips rendus → son changé', () => {
    const t = lead();
    let n = 0;
    const cons = makeClip({ id: 'k', bufferId: 'consolide', start: 11, duration: 4 });
    const clips = replaceWithConsolidated(t.clips, 11, 15, cons, () => `g${++n}`);
    expect(kinds({ ...t, clips })!.content).toContain('k');
  });

  it('nouvelle prise ailleurs (hors des clips rendus) : jouée en direct, à refaire', () => {
    const t = lead();
    const d = kinds({ ...t, clips: [...t.clips, makeClip({ id: 'new', bufferId: 'take', start: 40, duration: 3 })] });
    expect(d).toEqual({ content: [], approx: [], live: ['new'] });
  });

  it('ancien modèle (un seul rendu) : toute modification d’un clip rendu = son changé', () => {
    const c = makeClip({ id: 'old', bufferId: 'b' });
    const base = makeTrack({ clips: [c], frozenClip: makeClip({ id: 'fzold', bufferId: 'x', duration: 30 }), isFrozen: true, frozenClipIds: ['old'], frozenSourceSig: freezeSignature([c], [], -1), frozenUpToPluginIndex: -1 });
    expect(freezeDrift(base)).toBeNull();
    expect(kinds({ ...base, clips: [{ ...c, gain: 0.5 }] })!.content).toEqual(['old']);
  });

  it('pistes qui ont leur propre circuit de rendu : jamais concernées', () => {
    const t = edit(lead(), 'c', { isReversed: true });
    expect(freezeDrift({ ...t, remote: { role: 'artist' } as never })).toBeNull();
    expect(freezeDrift({ ...t, livePreview: { renderId: 'x', from: 0, to: 1, at: 0 } })).toBeNull();
    expect(freezeDrift({ ...t, isFrozen: false })).toBeNull();
  });

  it('l’empreinte d’écart change à chaque nouvelle modification (traitée une seule fois chacune)', () => {
    const a = edit(lead(), 'c', { gain: 0.5 });
    const b = edit(a, 'c', { gain: 0.4 });
    expect(freezeDriftKey(a)).toBeTruthy();
    expect(freezeDriftKey(a)).not.toBe(freezeDriftKey(b));
    expect(freezeDriftKey(edit(lead(), 'c', { gain: 0.5 }))).not.toBe(freezeDriftKey(a)); // autre rendu
  });

  it('regel = une seule étape : l’état d’avant (Annuler) garde l’ancien rendu et reste à jour, le regel l’est aussi', () => {
    const before = lead();
    const edited = edit(before, 'c', c => correctedClipPatch(c, { newBufferId: 'justesse-2', sourceBufferId: 'rec', sourceOffset: 2, regionStart: 1.75, edits: [] }));
    expect(freezeOutdated(edited)).toBe(true);
    const refrozen = freeze(edited);
    expect(freezeOutdated(refrozen)).toBe(false);
    expect(refrozen.frozenClip!.id).not.toBe(before.frozenClip!.id);
    // Annuler ramène `before` tel quel : son rendu, ses ancres, rien à refaire.
    expect(freezeOutdated(before)).toBe(false);
    expect(frozenPlayback(before).render[0].bufferId).toBe(before.frozenClip!.bufferId);
    expect(makeFreezeBase(before, before.frozenClip!.id).clips.map(c => c.id)).toEqual(['c', 'd']);
  });
});

describe('que faire d’une piste gelée périmée (regel sûr, sinon prévenir)', () => {
  const ctx = { bridge: false, remoteArtist: false };
  const stale = (plugins: PluginInstance[]) => edit(lead(plugins), 'c', { isReversed: true });
  const approx = (plugins: PluginInstance[]) => edit(lead(plugins), 'c', { gain: 0.5 });

  it('effets natifs seulement : regel automatique', () => {
    expect(planFrozenRefresh([stale([plug('comp')])], ctx, new Map())).toEqual([expect.objectContaining({ id: 'lead', action: 'refreeze' })]);
    expect(planFrozenRefresh([approx([plug('comp')])], ctx, new Map())[0].action).toBe('refreeze');
  });

  it('VST dans le rendu sans le pont : notification (son changé) ou indicateur seul (gain…)', () => {
    const vst = [plug('comp'), plug('vst', 'VST3')];
    expect(planFrozenRefresh([stale(vst)], ctx, new Map())[0].action).toBe('notify');
    expect(planFrozenRefresh([approx(vst)], ctx, new Map())[0].action).toBe('mark');
    // Pont connecté : regel.
    expect(planFrozenRefresh([stale(vst)], { ...ctx, bridge: true }, new Map())[0].action).toBe('refreeze');
    // Gel automatique de l'ingé : jamais regelé ici (journal des éditions rejouées chez lui).
    expect(planFrozenRefresh([{ ...stale([plug('comp')]), frozenAuto: true }], ctx, new Map())[0].action).toBe('notify');
    // VST coupé : pas dans le rendu, regel possible.
    expect(canRefreezeHere(stale([{ ...plug('vst', 'VST3'), isEnabled: false }]), ctx)).toBe(true);
  });

  it('un état déjà traité (bloqué, échec) n’est pas repris ; un regel en cours non plus ; à jour : rien', () => {
    const t = stale([plug('vst', 'VST3')]);
    expect(planFrozenRefresh([t], ctx, new Map([['lead', freezeDriftKey(t)!]]))).toEqual([]);
    expect(planFrozenRefresh([stale([plug('comp')])], ctx, new Map(), new Set(['lead']))).toEqual([]);
    expect(planFrozenRefresh([lead()], ctx, new Map())).toEqual([]);
  });
});

describe('queues d’effet des tranches : jamais le son d’un voisin rendu', () => {
  const two = () => freeze(makeTrack({
    id: 'lead', plugins: [plug('comp')],
    clips: [makeClip({ id: 'a', bufferId: 'rec', start: 0, offset: 0, duration: 5 }), makeClip({ id: 'b', bufferId: 'rec', start: 5, offset: 5, duration: 2.5 })],
  }));

  it('clips collés rendus ensemble (découpe puis regel) : pas de queue par-dessus le voisin (son doublé)', () => {
    const slices = frozenPlayback(two()).render;
    expect(slices.find(c => c.id === 'a~fz')!.duration).toBeCloseTo(5, 6);
    // Le dernier garde sa queue d'effet (rien après lui).
    expect(slices.find(c => c.id === 'b~fz')!.duration).toBeCloseTo(2.5 + 1, 6);
  });

  it('voisin supprimé depuis le rendu : sa place se tait (pas de queue qui le rejoue), rendu à refaire', () => {
    const t = two();
    const del: Track = { ...t, clips: t.clips.filter(c => c.id !== 'b') };
    expect(frozenPlayback(del).render.find(c => c.id === 'a~fz')!.duration).toBeCloseTo(5, 6);
    expect(kinds(del)).toEqual({ content: [], approx: ['b'], live: [] });
  });

  it('clip seul : sa queue d’effet est gardée', () => {
    const t = freeze(makeTrack({ id: 'x', plugins: [plug('comp')], clips: [makeClip({ id: 'a', bufferId: 'rec', start: 0, duration: 5 })] }));
    expect(frozenPlayback(t).render[0].duration).toBeCloseTo(6, 6);
  });
});

describe('R13 · transposer / étirer un clip d’une piste gelée', () => {
  it('le gel est périmé (le son a changé), comme pour la justesse', () => {
    const t = lead();
    expect(freezeDrift(t)).toBeNull();
    const after = edit(t, 'c', c => {
      const info = withSemitones(editingElastic(c, has).info, 3);
      const plan = renderPlan(info, 44100, 44100 * 20);
      return elasticPatch(c, { newBufferId: 'el-c', info: { ...info, regionStart: plan.regionStart, regionEnd: plan.regionEnd, renderedOffset: plan.renderedOffset }, sourceBufferId: c.bufferId });
    });
    expect(after.clips.find(c => c.id === 'c')!.bufferId).toBe('el-c');
    expect(freezeDrift(after)?.content).toContain('c');
  });
});
