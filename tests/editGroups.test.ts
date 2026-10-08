import { describe, expect, it } from 'vitest';
import {
  ALL_GROUP_ID, applyGroupsOp, createGroup, deleteGroup, expandEditTracks, groupClipMates, groupsFromSpec, groupsOpOf, groupsSig,
  listGroups, mixLinkUpdates, sanitizeGroupsOp, setSuspended, syncGroupFields, toggleGroup, updateGroup, GroupCtx,
} from '../utils/editGroups';
import { engineView, vcaMembers } from '../utils/trackStructure';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import { DAWState, TrackGroup } from '../types';

function session(): DAWState {
  const lead = makeTrack({ id: 'lead', name: 'LEAD', clips: [makeClip({ id: 'c-lead', start: 2, duration: 4 })] });
  const dbl = makeTrack({ id: 'dbl', name: 'DOUBLE', clips: [makeClip({ id: 'c-dbl', start: 2.02, duration: 3.96 }), makeClip({ id: 'c-dbl2', start: 9, duration: 1 })] });
  const backs = makeTrack({ id: 'backs', name: 'BACKS', clips: [makeClip({ id: 'c-b', start: 3, duration: 2 })] });
  const beat = makeTrack({ id: 'beat', name: 'BEAT', clips: [makeClip({ id: 'c-beat', start: 0, duration: 16 })] });
  const vca = makeTrack({ id: 'vca', name: 'PRE ALL VOX', isVca: true, volume: 0.5, clips: [] });
  const master = makeTrack({ id: 'master', name: 'MASTER' });
  let s = makeState([lead, dbl, backs, beat, vca, master], { trackGroups: [] });
  s = createGroup(s, { name: 'VOX', kind: 'both', trackIds: ['lead', 'dbl', 'backs'] });
  return s;
}
const ctx = (s: DAWState): GroupCtx => ({ groups: s.trackGroups, settings: s.groupSettings, tracks: s.tracks });

describe('Groupes d\'édition (Pro Tools : Edit Group)', () => {
  it('sélectionner sur la lead sélectionne la double et les backs ; Maj+Ctrl inverse', () => {
    const s = session();
    expect(expandEditTracks(['lead'], ctx(s))).toEqual(['lead', 'dbl', 'backs']);
    expect(expandEditTracks(['lead'], ctx(s), true)).toEqual(['lead']);
    expect(expandEditTracks(['beat'], ctx(s))).toEqual(['beat']);
  });

  it('groupe inactif, suspendu, ou de mix seulement : pas d\'édition liée (Maj+Ctrl le réveille)', () => {
    const s = session();
    const gid = s.trackGroups[0].id;
    const off = toggleGroup(s, gid);
    expect(expandEditTracks(['lead'], ctx(off))).toEqual(['lead']);
    expect(expandEditTracks(['lead'], ctx(off), true)).toEqual(['lead', 'dbl', 'backs']);
    const sus = setSuspended(s, true);
    expect(expandEditTracks(['lead'], ctx(sus))).toEqual(['lead']);
    const mix = updateGroup(s, gid, { kind: 'mix' });
    expect(expandEditTracks(['lead'], ctx(mix))).toEqual(['lead']);
  });

  it('<TOUT> : inactif par défaut ; activé, il lie toutes les pistes', () => {
    const s = session();
    expect(listGroups(ctx(s))[0].id).toBe(ALL_GROUP_ID);
    expect(expandEditTracks(['beat'], ctx(s))).toEqual(['beat']);
    const all = toggleGroup(s, ALL_GROUP_ID);
    expect(all.groupSettings?.allActive).toBe(true);
    expect(expandEditTracks(['beat'], ctx(all))).toEqual(['lead', 'dbl', 'backs', 'beat']);
  });

  it('clips jumeaux : la double calée sur la lead et les backs de la phrase, pas le clip d\'ailleurs', () => {
    const s = session();
    const lead = s.tracks[0];
    const mates = groupClipMates('lead', lead.clips[0], ctx(s));
    expect(mates.map(m => m.clip.id).sort()).toEqual(['c-b', 'c-dbl']);
  });

  it('pistes masquées ou inactives : jamais éditées par le groupe', () => {
    let s = session();
    s = { ...s, tracks: s.tracks.map(t => (t.id === 'backs' ? { ...t, isHidden: true } : t)) };
    expect(expandEditTracks(['lead'], ctx(s))).toEqual(['lead', 'dbl']);
  });
});

describe('Groupes de mix (Pro Tools : Mix Group)', () => {
  it('volume relatif, muet recopié, pan non lié par défaut', () => {
    const s = session();
    const lead = s.tracks[0];
    const up = mixLinkUpdates(lead, { ...lead, volume: lead.volume * 0.5, isMuted: true, pan: 0.5 }, ctx(s));
    expect(up.map(t => t.id).sort()).toEqual(['backs', 'dbl']);
    up.forEach(t => { expect(t.volume).toBeCloseTo(0.4, 9); expect(t.isMuted).toBe(true); expect(t.pan).toBe(0); });
  });

  it('envois liés (niveau relatif) et mode d\'automation quand ils sont cochés', () => {
    let s = session();
    s = updateGroup(s, s.trackGroups[0].id, { linkedSends: true, linkedAutomation: true });
    const lead = s.tracks[0];
    const sends = lead.sends.map(x => (x.id === 'send-verb-short' ? { ...x, level: 0.2 } : x));
    const up = mixLinkUpdates(lead, { ...lead, sends, automationMode: 'latch' }, ctx(s));
    expect(up).toHaveLength(2);
    up.forEach(t => { expect(t.sends.find(x => x.id === 'send-verb-short')!.level).toBeCloseTo(0.2, 9); expect(t.automationMode).toBe('latch'); });
  });

  it('groupe d\'édition seul : la console n\'est pas liée', () => {
    let s = session();
    s = updateGroup(s, s.trackGroups[0].id, { kind: 'edit' });
    const lead = s.tracks[0];
    expect(mixLinkUpdates(lead, { ...lead, isMuted: true }, ctx(s))).toEqual([]);
  });
});

describe('Plusieurs groupes par piste, VCA par groupe', () => {
  it('une piste dans deux groupes : groupIds ; le VCA du groupe la pilote', () => {
    let s = session();
    s = createGroup(s, { name: 'LEADS', kind: 'edit', trackIds: ['lead', 'dbl'] });
    const lead = s.tracks.find(t => t.id === 'lead')!;
    expect(lead.groupId).toBe(s.trackGroups[0].id);
    expect(lead.groupIds).toEqual([s.trackGroups[0].id, s.trackGroups[1].id]);
    s = { ...s, tracks: s.tracks.map(t => (t.id === 'vca' ? { ...t, vcaGroupId: s.trackGroups[1].id } : t)) };
    const vca = s.tracks.find(t => t.id === 'vca')!;
    expect(vcaMembers(vca, s.tracks).map(t => t.id)).toEqual(['lead', 'dbl']);
    // VCA à 0,5 : le moteur joue la lead à 0,8 × 0,5.
    expect(engineView(s.tracks).byId.get('lead')!.volume).toBeCloseTo(0.4, 9);
    // Supprimer le groupe libère le VCA.
    const d = deleteGroup(s, s.trackGroups[1].id);
    expect(d.tracks.find(t => t.id === 'vca')!.vcaGroupId).toBeUndefined();
    expect(d.tracks.find(t => t.id === 'lead')!.groupIds).toBeUndefined();
  });

  it('syncGroupFields garde les objets inchangés', () => {
    const s = session();
    expect(syncGroupFields(s.tracks, s.trackGroups)).toBe(s.tracks);
  });
});

describe('Collaboration : les groupes voyagent en une opération', () => {
  it('aller-retour JSON, vérifié, appliqué chez l\'autre (champs dérivés recalculés)', () => {
    let a = session();
    a = setSuspended(toggleGroup(a, ALL_GROUP_ID), true);
    const wire = sanitizeGroupsOp(JSON.parse(JSON.stringify(groupsOpOf(a))))!;
    const b0 = makeState(session().tracks.map(t => { const n = { ...t }; delete n.groupId; return n; }), { trackGroups: [] });
    const b = applyGroupsOp(b0, wire);
    expect(groupsSig(b)).toBe(groupsSig(a));
    expect(b.tracks.find(t => t.id === 'dbl')!.groupId).toBe(a.trackGroups[0].id);
    expect(b.groupSettings).toEqual({ suspended: true, allActive: true });
  });
  it('rien d\'étranger ne passe', () => {
    const bad = sanitizeGroupsOp({ groups: [{ id: ALL_GROUP_ID, name: 'x', trackIds: [] }, { id: 'g', name: '<img>', color: 'red;', trackIds: ['a', 3], evil: 1, kind: 'x' }] })!;
    expect(bad.groups).toHaveLength(1);
    expect(bad.groups[0]).toEqual({ id: 'g', name: '<img>', color: '#94a3b8', trackIds: ['a'], isCollapsed: false, linkedVolume: false, linkedMute: false, linkedSolo: false, linkedPan: false } as TrackGroup);
    expect(sanitizeGroupsOp({ groups: 'x' })).toBeNull();
  });
});

describe('Modèle LENNON : groupes Pro Tools', () => {
  it('membres retrouvés par leur nom (espaces de fin tolérés), ids stables', () => {
    const names: Record<string, string> = { 'LEAD A': 't1', 'LEAD A 2': 't2', 'BACK B ': 't3' };
    const g = groupsFromSpec([{ name: 'PRE ALL VOX', members: ['LEAD A', 'LEAD A 2', 'BACK B', 'INCONNUE'], deduced: true }],
      n => Object.entries(names).find(([k]) => k.trim().toUpperCase() === n.trim().toUpperCase())?.[1]);
    expect(g[0]).toMatchObject({ id: 'grp-pre-all-vox', name: 'PRE ALL VOX', trackIds: ['t1', 't2', 't3'], kind: 'both', deduced: true });
  });
});

describe('Modèle LENNON livré : les VCA reprennent leurs membres par groupe', () => {
  it('4 groupes Pro Tools, VCA liés, membres pilotés par leur VCA', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { parseTemplate } = await import('../utils/sessionTemplate');
    const t = parseTemplate(fs.readFileSync(path.join(__dirname, '..', 'templates/romain-lennon-depart.novatemplate'), 'utf-8'));
    const groups = t.session.trackGroups;
    expect(groups.map(g => g.name)).toEqual(['PRE ALL VOX', 'FX ALL', 'BASS DRUM', 'INSTRUMENT']);
    const tracks = t.session.tracks as any[];
    const vca = (n: string) => tracks.find(x => x.isVca && x.name.trim() === n);
    expect(vca('PRE ALL VOX').vcaGroupId).toBe(groups[0].id);
    expect(vca('FX').vcaGroupId).toBe(groups[1].id);
    expect(vca('DRUMS AND BASS').vcaGroupId).toBe(groups[2].id);
    const members = vcaMembers(vca('PRE ALL VOX'), tracks).map(x => x.name.trim());
    expect(members).toEqual(expect.arrayContaining(['LEAD A BUS', 'BACK A BUS', 'ALL RFF']));
    expect(vcaMembers(vca('INSTRUMENT'), tracks).map(x => x.name.trim()).sort()).toEqual(['INSTRU', 'KEYS BUS']);
  });
});
