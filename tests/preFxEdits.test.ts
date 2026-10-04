import { describe, expect, it } from 'vitest';
import { Clip, Track } from '../types';
import { anchorClipsToRender, frozenPlayback } from '../utils/freeze';
import {
  authorsOf, canRevert, countPreFxEdits, describeOps, makeFreezeBase, mergePreFx, planOf, preFxOps, PRE_VOLUME,
  replayPreFx, revertToBase, stampJournal, summaryLine,
} from '../utils/preFxEdits';
import { makeClip, makeTrack } from './helpers/fixtures';

// --- Montage d'une piste gelée « comme au studio » ---------------------------------

const RENDER = 'frozen-voix-1';

/** Voix : 3 phrases d'une même prise (buffer « rec »), gelée avec photo. */
function frozenVoice(): Track {
  const clips = [
    makeClip({ id: 'p1', name: 'Phrase 1', bufferId: 'rec', start: 1, offset: 0, duration: 2, fadeIn: 0.01 }),
    makeClip({ id: 'p2', name: 'Phrase 2', bufferId: 'rec', start: 4, offset: 3, duration: 2 }),
    makeClip({ id: 'p3', name: 'Phrase 3', bufferId: 'rec', start: 7, offset: 6, duration: 2, gain: 0.9 }),
  ];
  const anchors = anchorClipsToRender(clips, RENDER);
  const t = makeTrack({
    id: 'voix', name: 'Voix lead', isFrozen: true, frozenAuto: true,
    frozenClip: makeClip({ id: RENDER, bufferId: RENDER, start: 0, duration: 12 }),
    frozenPluginSig: 'sig', frozenUpToPluginIndex: 0,
    clips: clips.map(c => ({ ...c, freezeRef: anchors.get(c.id) })),
  });
  t.freezeBase = makeFreezeBase(t, RENDER, "l'ingé", 1000);
  return t;
}

/** Découpe comme le DAW : deux clips, la photo (freezeRef) suit les deux moitiés. */
const split = (clips: Clip[], id: string, at: number): Clip[] => clips.flatMap(c => {
  if (c.id !== id || at <= c.start || at >= c.start + c.duration) return [c];
  const left = at - c.start;
  return [
    { ...c, duration: left, fadeOut: 0 },
    { ...c, id: `${c.id}-b`, start: at, offset: (c.offset || 0) + left, duration: c.duration - left, fadeIn: 0 },
  ];
});
const patch = (clips: Clip[], id: string, p: Partial<Clip>) => clips.map(c => (c.id === id ? { ...c, ...p } : c));
const drop = (clips: Clip[], id: string) => clips.filter(c => c.id !== id);
const norm = (clips: Clip[]) => clips
  .map(c => ({ id: c.id, start: +c.start.toFixed(6), offset: +(c.offset || 0).toFixed(6), duration: +c.duration.toFixed(6), gain: c.gain ?? 1, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, muted: !!c.isMuted, buf: c.bufferId }))
  .sort((a, b) => a.start - b.start);

describe('photo du gel et opérations', () => {
  it('rien d\'édité : aucune opération', () => {
    const t = frozenVoice();
    expect(t.freezeBase!.clips.map(c => c.id)).toEqual(['p1', 'p2', 'p3']);
    expect(preFxOps(t)).toEqual([]);
  });

  it('couper, enlever un passage, supprimer, déplacer, gain, fondus, mute, volume avant effets', () => {
    const t = frozenVoice();
    let c = t.clips;
    c = split(c, 'p1', 2);                       // coupe à 2 s
    c = split(c, 'p2', 5); c = drop(c, 'p2-b');  // enlève la fin de la phrase 2
    c = drop(c, 'p3');                           // supprime la phrase 3
    c = patch(c, 'p1-b', { start: 2.5, gain: 0.5, fadeOut: 0.4 }); // déplace + volume + fondu
    c = patch(c, 'p1', { isMuted: true });
    const lanes = [{ id: 'l', parameterName: PRE_VOLUME, points: [{ id: 'a', time: 1, value: 1 }, { id: 'b', time: 2, value: 0.3 }], color: '#fff', isExpanded: true, min: 0, max: 1.5 }];
    const ops = preFxOps({ ...t, clips: c, automationLanes: lanes });
    const kinds = ops.map(o => o.kind).sort();
    expect(kinds).toEqual(['delete', 'fade', 'gain', 'move', 'mute', 'remove', 'split', 'volume'].sort());
    expect(ops.find(o => o.kind === 'delete')).toMatchObject({ baseClipId: 'p3', at: 7, end: 9 });
    expect(ops.find(o => o.kind === 'remove')).toMatchObject({ baseClipId: 'p2', at: 5, end: 6 });
    expect(ops.find(o => o.kind === 'gain')!.detail).toBe('-6 dB');
    expect(countPreFxEdits(ops)).toBe(8);
    expect(describeOps(ops)).toContain('1 clip supprimé');
  });

  it('nouvelle prise ajoutée : « add », pas une édition pré-effet', () => {
    const t = frozenVoice();
    const ops = preFxOps({ ...t, clips: [...t.clips, makeClip({ id: 'new', bufferId: 'rec2', start: 10 })] });
    expect(ops.map(o => o.kind)).toEqual(['add']);
    expect(countPreFxEdits(ops)).toBe(0);
  });

  it('les très courts fondus anti-clic des découpes ne comptent pas', () => {
    const t = frozenVoice();
    const c = patch(split(t.clips, 'p2', 5), 'p2-b', { fadeIn: 0.005 });
    expect(preFxOps({ ...t, clips: c }).map(o => o.kind)).toEqual(['split']);
  });
});

describe('rejeu des éditions sur l\'audio sec', () => {
  const edited = () => {
    const t = frozenVoice();
    let c = split(t.clips, 'p1', 2);
    c = split(c, 'p2', 5); c = drop(c, 'p2-b'); c = drop(c, 'p3');
    c = patch(c, 'p1-b', { start: 2.5, gain: 0.5, fadeOut: 0.4 });
    c = [...c, makeClip({ id: 'new', bufferId: 'rec2', start: 10 })];
    return { t, c };
  };

  it('rejouer le plan redonne exactement les clips édités', () => {
    const { t, c } = edited();
    const { plan, extras } = planOf(t.freezeBase!, c);
    expect(norm(replayPreFx(t.freezeBase!, plan, extras))).toEqual(norm(c));
  });

  it('idempotent : rejouer deux fois ne change rien', () => {
    const { t, c } = edited();
    const once = (() => { const { plan, extras } = planOf(t.freezeBase!, c); return replayPreFx(t.freezeBase!, plan, extras); })();
    const { plan, extras } = planOf(t.freezeBase!, once);
    const twice = replayPreFx(t.freezeBase!, plan, extras);
    expect(norm(twice)).toEqual(norm(once));
    expect(preFxOps({ ...t, clips: twice })).toEqual(preFxOps({ ...t, clips: once }));
  });

  it('le rejeu relit l\'audio SEC (même son, offset dans la source), ancré sur la photo', () => {
    const { t, c } = edited();
    const { plan, extras } = planOf(t.freezeBase!, c);
    const out = replayPreFx(t.freezeBase!, plan, extras).filter(x => x.id !== 'new');
    expect(out.every(x => x.bufferId === 'rec' && x.freezeRef?.renderId === RENDER)).toBe(true);
    expect(out.find(x => x.id === 'p1-b')).toMatchObject({ offset: 1, duration: 1, start: 2.5 });
  });

  it('revenir à la version d\'avant : la photo, nouvelles prises gardées, même un clip supprimé', () => {
    const { t, c } = edited();
    expect(canRevert(t.freezeBase!, c)).toBe(true);
    const back = revertToBase(t.freezeBase!, c);
    expect(norm(back.filter(x => x.id !== 'new'))).toEqual(norm(frozenVoice().clips));
    expect(back.some(x => x.id === 'new')).toBe(true);
    expect(preFxOps({ ...t, clips: back }).map(o => o.kind)).toEqual(['add']);
  });

  it('la lecture gelée suit les éditions : un clip supprimé n\'a plus de tranche', () => {
    const { t, c } = edited();
    const slices = frozenPlayback({ ...t, clips: c }).render;
    expect(slices.some(s => s.id.startsWith('p3'))).toBe(false);
    expect(slices.every(s => s.bufferId === RENDER)).toBe(true);
  });
});

describe('journal et résumé', () => {
  it('auteurs : une édition connue garde son auteur, une nouvelle prend l\'auteur actuel', () => {
    const t = frozenVoice();
    const t1 = { ...t, clips: split(t.clips, 'p1', 2) };
    t1.preFxJournal = stampJournal(t1, "L'AMG", 10);
    const t2 = { ...t1, clips: drop(t1.clips, 'p3') };
    const j = stampJournal(t2, 'Romain', 20)!;
    expect(j.ops.find(o => o.kind === 'split')).toMatchObject({ by: "L'AMG", ts: 10 });
    expect(j.ops.find(o => o.kind === 'delete')).toMatchObject({ by: 'Romain', ts: 20 });
    expect(authorsOf(j.ops)).toEqual(["L'AMG", 'Romain']);
    expect(stampJournal(t, 'x')).toBeUndefined();
  });

  it('phrase du résumé', () => {
    expect(summaryLine(12, ["L'AMG"])).toBe("12 éditions de L'AMG réappliquées avant les effets");
    expect(summaryLine(1, [])).toBe('1 édition réappliquée avant les effets');
    expect(summaryLine(3, ['A', 'B'])).toBe('3 éditions de A et B réappliquées avant les effets');
  });
});

describe('fusion de deux versions (ingé / artiste) et conflits', () => {
  it('chacun sur un passage différent : les deux éditions sont gardées', () => {
    const t = frozenVoice();
    const mine = patch(t.clips, 'p1', { gain: 0.5 });          // ingé : volume phrase 1
    const theirs = drop(t.clips, 'p3');                        // artiste : supprime phrase 3
    const m = mergePreFx(t.freezeBase!, mine, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.takenTheirs).toBe(1);
    expect(norm(m.clips).map(c => c.id)).toEqual(['p1', 'p2']);
    expect(m.clips.find(c => c.id === 'p1')!.gain).toBe(0.5);
  });

  it('les deux sur la même phrase : conflit expliqué, la version de l\'ingé est gardée', () => {
    const t = frozenVoice();
    const mine = patch(t.clips, 'p2', { fadeOut: 0.5 });
    const theirs = drop(t.clips, 'p2');
    const m = mergePreFx(t.freezeBase!, mine, theirs);
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0]).toMatchObject({ baseClipId: 'p2', name: 'Phrase 2', mine: '1 fondu', theirs: '1 clip supprimé', at: 4 });
    expect(m.clips.find(c => c.id === 'p2')!.fadeOut).toBe(0.5);
  });

  it('même édition des deux côtés : pas de conflit ; nouvelles prises des deux côtés gardées', () => {
    const t = frozenVoice();
    const mine = [...drop(t.clips, 'p3'), makeClip({ id: 'n1', bufferId: 'x', start: 12 })];
    const theirs = [...drop(t.clips, 'p3'), makeClip({ id: 'n2', bufferId: 'y', start: 14 })];
    const m = mergePreFx(t.freezeBase!, mine, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.clips.map(c => c.id).sort()).toEqual(['n1', 'n2', 'p1', 'p2']);
  });
});

// --- Équivalence pré-effet, échantillon par échantillon -------------------------------
//
// Mini moteur : clips -> mixage (gain, fondus linéaires) -> effets (compresseur
// puis reverb). Référence = l'artiste fait ses éditions sur le PC AVANT les
// effets. Le rejeu doit donner exactement la même chose ; éditer le rendu
// gelé (après effets) laisse au contraire des queues de reverb orphelines.

const SR = 1000;
const voice = (() => { // 10 s de « voix » : 3 phrases de bruit tonal, silence entre
  const a = new Float32Array(10 * SR);
  for (let i = 0; i < a.length; i++) {
    const t = i / SR;
    const on = (t < 2) || (t >= 3 && t < 5) || (t >= 6 && t < 8);
    a[i] = on ? Math.sin(2 * Math.PI * 50 * t) * 0.8 : 0;
  }
  return a;
})();

function mix(clips: Clip[], len = 16 * SR): Float32Array {
  const out = new Float32Array(len);
  for (const c of clips) {
    if (c.isMuted) continue;
    const n = Math.round(c.duration * SR);
    for (let i = 0; i < n; i++) {
      const src = Math.round(((c.offset || 0)) * SR) + i;
      const dst = Math.round(c.start * SR) + i;
      if (dst < 0 || dst >= len || src >= voice.length) continue;
      const tt = i / SR;
      let g = c.gain ?? 1;
      if (c.fadeIn && tt < c.fadeIn) g *= tt / c.fadeIn;
      if (c.fadeOut && tt > c.duration - c.fadeOut) g *= Math.max(0, (c.duration - tt) / c.fadeOut);
      out[dst] += voice[src] * g;
    }
  }
  return out;
}
/** Compresseur (non linéaire) puis reverb (queue de 2 s). */
function fx(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    env = Math.max(Math.abs(x[i]), env * 0.995);
    const g = env > 0.4 ? 0.4 / env : 1;
    y[i] = x[i] * g;
  }
  const out = new Float32Array(x.length);
  const d = Math.round(0.05 * SR);
  for (let i = 0; i < y.length; i++) out[i] = y[i] + (i >= d ? out[i - d] * 0.85 : 0) * 1;
  return out;
}
const rms = (a: Float32Array, t0: number, t1: number) => {
  let s = 0; const i0 = Math.round(t0 * SR), i1 = Math.round(t1 * SR);
  for (let i = i0; i < i1; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
};

describe('équivalence pré-effet (rejeu au dégel)', () => {
  it('le rejeu sur l\'audio sec puis les effets = éditions faites sur le PC avant les effets', () => {
    const t = frozenVoice();
    let c = split(t.clips, 'p2', 5); c = drop(c, 'p2-b'); c = drop(c, 'p3');
    c = patch(c, 'p1', { fadeOut: 1, gain: 0.6 });
    const reference = fx(mix(c));                                    // fait sur le PC, avant les effets
    const { plan, extras } = planOf(t.freezeBase!, c);
    const replayed = fx(mix(replayPreFx(t.freezeBase!, plan, extras))); // rejoué au dégel
    let maxDiff = 0;
    for (let i = 0; i < reference.length; i++) maxDiff = Math.max(maxDiff, Math.abs(reference[i] - replayed[i]));
    expect(maxDiff).toBe(0);
  });

  it('voix supprimée : plus de queue de reverb ; éditer le rendu (après effets) en laissait une', () => {
    const t = frozenVoice();
    const c = drop(t.clips, 'p3');                    // phrase 3 (7–9 s) supprimée sur la tablette
    const { plan, extras } = planOf(t.freezeBase!, c);
    const pre = fx(mix(replayPreFx(t.freezeBase!, plan, extras)));
    // Post-effet naïf : on efface la phrase dans le rendu gelé, sa reverb continue après 9 s.
    const render = fx(mix(t.clips));
    const post = render.slice(); for (let i = 7 * SR; i < 9 * SR; i++) post[i] = 0;
    expect(rms(pre, 9, 11)).toBeLessThan(1e-3);
    expect(rms(post, 9, 11)).toBeGreaterThan(0.02);
    expect(rms(post, 9, 11)).toBeGreaterThan(rms(pre, 9, 11) * 20);
  });

  it('fondu de sortie : la reverb s\'éteint avec la voix (avant effets) au lieu d\'être coupée net', () => {
    const t = frozenVoice();
    const c = patch(t.clips, 'p2', { fadeOut: 1.5 });
    const { plan, extras } = planOf(t.freezeBase!, c);
    const pre = fx(mix(replayPreFx(t.freezeBase!, plan, extras)));
    const render = fx(mix(t.clips));
    // Post-effet : fondu appliqué sur le rendu (voix + reverb), puis la queue « gelée » reprend telle quelle.
    const post = render.slice();
    for (let i = Math.round(4.5 * SR); i < 6 * SR; i++) post[i] *= Math.max(0, (6 * SR - i) / (1.5 * SR));
    // Juste après la phrase : pré-effet, la queue suit le fondu (faible) ; post-effet, elle revient pleine.
    expect(rms(pre, 6, 6.04)).toBeLessThan(rms(post, 6, 6.04) * 0.5);
  });
});
