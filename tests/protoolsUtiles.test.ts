import { describe, expect, it, vi } from 'vitest';
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));
import { Clip, Track, TrackType } from '../types';
import {
  muteClickKind, setAllMute, setAllSolo, soloClickKind, soloMuteStatus, soloSilencedIds, toggleField, toggleSoloSafe, withoutSoloSafe,
} from '../utils/soloMute';
import { anchorOf, dragRefusal, enforceClipLocks, lockViolated, refusalText, toggleClipLock, trustedUpdate, isTrustedUpdate } from '../utils/clipLock';
import { planStems } from '../utils/stemPlan';
import { selectTrackClipIds, tracksOfSelection } from '../hooks/useArrangementCommands';
import { KEYMAP } from '../utils/keymap';
import { keymapActions, searchActions } from '../utils/commandPalette';
import { KEYMAP_PRESETS, keymapConflicts, resolvePreset } from '../utils/keymapStore';

const clip = (id: string, over: Partial<Clip> = {}): Clip =>
  ({ id, name: id, start: 0, duration: 4, offset: 0, fadeIn: 0, fadeOut: 0, color: '#fff', type: TrackType.AUDIO, bufferId: `b-${id}`, ...over });
const mk = (id: string, over: Partial<Track> = {}): Track => ({
  id, name: id, type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [clip(`c-${id}`)], plugins: [], automationLanes: [], totalLatency: 0, ...over,
});
const isSource = (t: Track) => t.type === TrackType.AUDIO || t.type === TrackType.MIDI;

function session(): Track[] {
  return [
    mk('master', { type: TrackType.BUS, clips: [], outputTrackId: '' }),
    mk('beat', { name: 'Beat' }),
    mk('lead', { name: 'Voix lead', outputTrackId: 'busv', sends: [{ id: 'verb', level: 0.3, isEnabled: true }] }),
    mk('back', { name: 'Backs', outputTrackId: 'busv' }),
    mk('clic', { name: 'Clic de référence' }),
    mk('busv', { name: 'Bus voix', type: TrackType.BUS, clips: [] }),
    mk('verb', { name: 'Reverb', type: TrackType.SEND, clips: [] }),
  ];
}

describe('solo safe et solos (moteur : lecture = export)', () => {
  it('solo de la lead : beat, backs et clic coupés ; bus et retours jamais', () => {
    const t = session().map(x => (x.id === 'lead' ? { ...x, isSolo: true } : x));
    expect([...soloSilencedIds(t, isSource)].sort()).toEqual(['back', 'beat', 'clic']);
  });
  it('solo safe : la piste reste audible quand une autre est en solo', () => {
    const t = session().map(x => (x.id === 'lead' ? { ...x, isSolo: true } : x.id === 'clic' ? { ...x, soloSafe: true } : x));
    expect([...soloSilencedIds(t, isSource)].sort()).toEqual(['back', 'beat']);
  });
  it('solo safe sur un bus : ce qui l’alimente n’en devient pas audible', () => {
    const t = session().map(x => (x.id === 'beat' ? { ...x, isSolo: true } : x.id === 'busv' ? { ...x, soloSafe: true } : x));
    expect([...soloSilencedIds(t, isSource)].sort()).toEqual(['back', 'clic', 'lead']);
  });
  it('sans solo : rien n’est coupé, même avec des pistes solo safe', () => {
    const t = session().map(x => (x.id === 'clic' ? { ...x, soloSafe: true } : x));
    expect(soloSilencedIds(t, isSource).size).toBe(0);
  });
  it('stems : le solo safe est retiré, chaque stem ne contient que ses pistes', () => {
    const t = session().map(x => (x.id === 'clic' ? { ...x, soloSafe: true } : x));
    const plan = planStems(t, { grouping: 'tracks', returns: 'in-stems', withMasterFx: true });
    const lead = plan.find(p => p.label === 'Voix lead')!;
    expect(lead.tracks.some(x => x.soloSafe)).toBe(false);
    expect(soloSilencedIds(lead.tracks, isSource).has('clic')).toBe(true);
    expect(withoutSoloSafe({ ...t[4] })).not.toHaveProperty('soloSafe');
  });
});

describe('Alt+clic, Ctrl+clic, Maj+S / Maj+M', () => {
  it('Alt+clic sur un Solo allumé : tous les solos effacés ; le master n’est jamais touché', () => {
    const t = session().map(x => (['lead', 'back'].includes(x.id) ? { ...x, isSolo: true } : x));
    const out = setAllSolo(t, false);
    expect(out.filter(x => x.isSolo)).toHaveLength(0);
    expect(out[0]).toBe(t[0]);                       // master : même référence
    expect(out.find(x => x.id === 'beat')).toBe(t.find(x => x.id === 'beat')); // pistes inchangées : même référence
    expect(setAllSolo(out, false)).toBe(out);        // rien à faire : même tableau
  });
  it('Alt+clic sur un Solo éteint : toutes en solo, sauf les pistes solo safe', () => {
    const t = session().map(x => (x.id === 'clic' ? { ...x, soloSafe: true } : x));
    const out = setAllSolo(t, true);
    expect(out.filter(x => x.isSolo).map(x => x.id)).toEqual(['beat', 'lead', 'back', 'busv', 'verb']);
  });
  it('Alt+clic sur un Mute : toutes les pistes (sauf le master), dans les deux sens', () => {
    const t = setAllMute(session(), true);
    expect(t.filter(x => x.isMuted).map(x => x.id)).toEqual(['beat', 'lead', 'back', 'clic', 'busv', 'verb']);
    expect(soloMuteStatus(t).muted).toHaveLength(6);
    expect(setAllMute(t, false).some(x => x.isMuted)).toBe(false);
  });
  it('solo safe : bascule sur la sélection, refusé sur le master', () => {
    const r = toggleSoloSafe(session(), ['clic', 'beat']);
    expect(r.on).toBe(true);
    expect(r.tracks.filter(x => x.soloSafe).map(x => x.id)).toEqual(['beat', 'clic']);
    const back = toggleSoloSafe(r.tracks, ['clic', 'beat']);
    expect(back.on).toBe(false);
    expect(back.tracks.some(x => 'soloSafe' in x)).toBe(false);
    const m = toggleSoloSafe(session(), ['master']);
    expect(m.tracks).toEqual(session());
  });
  it('Maj+S : si une piste sélectionnée n’est pas en solo, toutes le deviennent ; sinon toutes repassent', () => {
    let t = session().map(x => (x.id === 'lead' ? { ...x, isSolo: true } : x));
    let r = toggleField(t, ['lead', 'back'], 'isSolo');
    expect(r.on).toBe(true);
    expect(r.tracks.filter(x => x.isSolo).map(x => x.id)).toEqual(['lead', 'back']);
    t = r.tracks;
    r = toggleField(t, ['lead', 'back'], 'isSolo');
    expect(r.on).toBe(false);
    expect(r.tracks.some(x => x.isSolo)).toBe(false);
    expect(toggleField(t, ['master'], 'isMuted').count).toBe(0);
  });
  it('modificateurs : Alt = toutes, Ctrl (ou Cmd) = solo safe, Maj+Ctrl = groupes (pas un solo safe)', () => {
    expect(soloClickKind({ altKey: true })).toBe('all');
    expect(soloClickKind({ ctrlKey: true })).toBe('safe');
    expect(soloClickKind({ metaKey: true })).toBe('safe');
    expect(soloClickKind({ ctrlKey: true, shiftKey: true })).toBe('toggle');
    expect(soloClickKind({})).toBe('toggle');
    expect(muteClickKind({ altKey: true })).toBe('all');
    expect(muteClickKind({})).toBe('toggle');
  });
});

describe('verrou de clip (Edit Lock / Time Lock)', () => {
  const base = () => [
    mk('lead', { clips: [clip('a', { start: 0, duration: 2, lock: 'edit' }), clip('b', { start: 3, duration: 2 })] }),
    mk('beat', { clips: [clip('k', { start: 1, duration: 4, offset: 0.5, lock: 'time' })] }),
  ];
  const withClip = (t: Track[], trackId: string, clipId: string, f: (c: Clip) => Clip | null): Track[] =>
    t.map(x => (x.id !== trackId ? x : { ...x, clips: x.clips.map(c => (c.id === clipId ? f(c) : c)).filter(Boolean) as Clip[] }));

  it('verrou d’édition : déplacer, rogner, retoucher ou supprimer est refusé pour la piste', () => {
    const prev = base();
    for (const f of [
      (c: Clip) => ({ ...c, start: 1 }),
      (c: Clip) => ({ ...c, duration: 1 }),
      (c: Clip) => ({ ...c, gain: 0.5 }),
      (c: Clip) => ({ ...c, fadeIn: 0.1 }),
      (c: Clip) => ({ ...c, isMuted: true }),
      () => null,
    ]) {
      const next = withClip(prev, 'lead', 'a', f);
      const g = enforceClipLocks(prev, next);
      expect(g.refused).toHaveLength(1);
      expect(g.tracks[0].clips).toBe(prev[0].clips);
    }
  });
  it('les autres pistes gardent leur modification ; renommer, colorer ou déverrouiller passent', () => {
    const prev = base();
    let next = withClip(withClip(prev, 'lead', 'a', c => ({ ...c, start: 9 })), 'beat', 'k', c => ({ ...c, gain: 0.7 }));
    const g = enforceClipLocks(prev, next);
    expect(g.refused.map(r => r.trackId)).toEqual(['lead']);
    expect(g.tracks[1]).toBe(next[1]);
    expect(refusalText(g.refused)).toMatch(/verrouillé.*Ctrl\+L/);
    next = withClip(prev, 'lead', 'a', c => ({ ...c, name: 'Couplet 1', color: '#123456' }));
    expect(enforceClipLocks(prev, next).tracks).toBe(next);
    next = withClip(prev, 'lead', 'a', c => { const { lock: _l, ...r } = c; return { ...r, start: 5 }; });
    expect(enforceClipLocks(prev, next).refused).toHaveLength(0);
    // Un clip libre de la même piste se modifie normalement.
    next = withClip(prev, 'lead', 'b', c => ({ ...c, start: 6 }));
    expect(enforceClipLocks(prev, next).tracks).toBe(next);
  });
  it('verrou de position : rogner (le son reste calé) passe, déplacer non, supprimer oui', () => {
    const prev = base();
    const trim = withClip(prev, 'beat', 'k', c => ({ ...c, start: 2, offset: 1.5, duration: 3, fadeIn: 0.05 }));
    expect(anchorOf(trim[1].clips[0])).toBe(anchorOf(prev[1].clips[0]));
    expect(enforceClipLocks(prev, trim).refused).toHaveLength(0);
    const move = withClip(prev, 'beat', 'k', c => ({ ...c, start: 2 }));
    expect(enforceClipLocks(prev, move).refused[0]).toMatchObject({ lock: 'time', clipName: 'k' });
    const del = withClip(prev, 'beat', 'k', () => null);
    expect(enforceClipLocks(prev, del).refused).toHaveLength(0);
    expect(lockViolated(prev[1].clips[0], undefined)).toBe(false);
  });
  it('découpe d’un clip verrouillé refusée (pas de morceau en double) ; une prise nouvelle n’est jamais perdue', () => {
    const prev = base();
    // Découpe : le clip garde son id (plus court) et un morceau neuf (même son) apparaît.
    const split = prev.map(x => (x.id !== 'lead' ? x : { ...x, clips: [{ ...x.clips[0], duration: 1 }, clip('a2', { start: 1, duration: 1, bufferId: 'b-a', lock: 'edit' }), x.clips[1]] }));
    const g = enforceClipLocks(prev, split);
    expect(g.refused).toHaveLength(1);
    expect(g.tracks[0].clips.map(c => c.id)).toEqual(['a', 'b']);
    expect(g.tracks[0].clips[0].duration).toBe(2);
    // Prise enregistrée par-dessus (comp) : le clip verrouillé est remis, la prise reste.
    const take = prev.map(x => (x.id !== 'lead' ? x : { ...x, clips: [{ ...x.clips[0], isMuted: true }, x.clips[1], clip('take-7', { start: 0.5, duration: 3, bufferId: 'rec-7' })] }));
    const g2 = enforceClipLocks(prev, take);
    expect(g2.refused).toHaveLength(1);
    expect(g2.tracks[0].clips.map(c => c.id)).toEqual(['a', 'b', 'take-7']);
    expect(g2.tracks[0].clips[0].isMuted).toBeUndefined();
  });
  it('rien de verrouillé ou rien de changé : même référence, aucun coût', () => {
    const t = base();
    expect(enforceClipLocks(t, t).tracks).toBe(t);
    const free = t.map(x => ({ ...x, clips: x.clips.map(c => { const { lock: _l, ...r } = c; return r as Clip; }) }));
    const moved = withClip(free, 'lead', 'a', c => ({ ...c, start: 7 }));
    expect(enforceClipLocks(free, moved).tracks).toBe(moved);
  });
  it('poser / retirer un verrou sur une sélection (mixte : tous le prennent)', () => {
    const r = toggleClipLock(base(), ['a', 'b'], 'edit');
    expect(r.on).toBe(true);
    expect(r.tracks[0].clips.map(c => c.lock)).toEqual(['edit', 'edit']);
    const off = toggleClipLock(r.tracks, ['a', 'b'], 'edit');
    expect(off.tracks[0].clips.some(c => 'lock' in c)).toBe(false);
    // Passer de « position » à « édition » est un changement de verrou (permis).
    const sw = toggleClipLock(base(), ['k'], 'edit');
    expect(enforceClipLocks(base(), sw.tracks).refused).toHaveLength(0);
  });
  it('gestes à la souris : refus expliqués ; opération reçue marquée', () => {
    expect(dragRefusal(clip('x', { lock: 'edit' }), 'edit')).toMatch(/Ctrl\+L/);
    expect(dragRefusal(clip('x', { lock: 'time' }), 'edit')).toBeNull();
    expect(dragRefusal(clip('x', { lock: 'time' }), 'move')).toMatch(/Alt\+Maj\+L/);
    expect(dragRefusal(clip('x'), 'move')).toBeNull();
    const f = trustedUpdate((s: number) => s + 1);
    expect(isTrustedUpdate(f)).toBe(true);
    expect(isTrustedUpdate((s: number) => s)).toBe(false);
  });
});

describe('sélectionner tous les clips de la piste', () => {
  it('pistes des clips sélectionnés, sinon la piste active', () => {
    const t = [mk('a', { clips: [clip('a1'), clip('a2', { start: 5 })] }), mk('b', { clips: [clip('b1')] })];
    expect(tracksOfSelection(t, new Set(['a2']), 'b')).toEqual(['a']);
    expect(tracksOfSelection(t, new Set(), 'b')).toEqual(['b']);
    expect([...selectTrackClipIds(t, ['a'])]).toEqual(['a1', 'a2']);
  });
});

describe('raccourcis et palette (Ctrl+K)', () => {
  const ids = ['pt.clearSolos', 'pt.clearMutes', 'pt.soloSelected', 'pt.muteSelected', 'pt.soloSafe', 'pt.clearClipIndicators', 'pt.clipLock', 'pt.clipTimeLock', 'pt.selectTrackClips'];
  it('chaque commande est dans la table, avec son équivalent Pro Tools', () => {
    for (const id of ids) {
      const d = KEYMAP.find(x => x.id === id);
      expect(d, id).toBeTruthy();
      expect(d!.pt, id).toBeTruthy();
      expect(d!.command, id).toBeTruthy();
    }
  });
  it('aucun conflit de touches, dans aucun préréglage (NOVA, Pro Tools, FL, Live)', () => {
    for (const p of KEYMAP_PRESETS) expect(keymapConflicts(resolvePreset(p)), p.id).toEqual([]);
  });
  it('trouvables en français dans la palette, en premier', () => {
    const acts = keymapActions(new Set());
    const first = (q: string) => searchActions(q, acts)[0]?.id;
    expect(first('effacer solos')).toBe('pt.clearSolos');
    expect(first('effacer mutes')).toBe('pt.clearMutes');
    expect(first('solo safe')).toBe('pt.soloSafe');
    expect(first('diodes saturation')).toBe('pt.clearClipIndicators');
    expect(first('verrouiller clips')).toBe('pt.clipLock');
    expect(first('verrouiller position')).toBe('pt.clipTimeLock');
    expect(first('tous les clips de la piste')).toBe('pt.selectTrackClips');
    expect(first('solo pistes selectionnees')).toBe('pt.soloSelected');
    expect(first('muet pistes selectionnees')).toBe('pt.muteSelected');
  });
});
