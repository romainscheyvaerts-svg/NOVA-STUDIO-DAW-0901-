import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import {
  DEFAULT_GUEST_RIGHTS, GUEST_FORBIDDEN_KINDS, GUEST_REFUSED_SONG_FIELDS, GUEST_RIGHTS_KIND, guestCanDelete, guestCanEditContent, guestCanMix,
  guestOpVerdict, isLimitedGuest, sanitizeGuestRights,
} from '../utils/guestRights';
import { canSendContent, canSendMix, deleteAllowed, mixAllowed } from '../utils/collabContent';

/**
 * Droits de l'artiste invité dans la séance de l'ingé (utils/guestRights).
 *
 * Ce qui est vérifié ici est exactement ce que fait la RÉCEPTION chez l'ingé
 * (App.applyCollabOp) : une opération interdite envoyée par un artiste en mode
 * simple est refusée, même si elle vient d'une ancienne version de NOVA ou
 * d'un appareil trafiqué (l'envoi, lui, ne la propose même pas).
 */

const NINA = 'u:44444444-4444-4444-8444-444444444444';
const NINA_DEVICE = `${NINA}:dev1`;
const base = { isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, pan: 0, volume: 1, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0, clips: [] };
const t = (x: Omit<Partial<Track>, 'type'> & { id: string; name: string; type: any }): Track => ({ ...base, color: '#fff', ...x } as unknown as Track);

const beat = t({ id: 'instrumental', name: 'Beat', type: 'AUDIO' });
const voixLead = t({ id: 'voix', name: 'Voix lead', type: 'AUDIO' }); // préparée par l'ingé, sans propriétaire nommé
const bus = t({ id: 'bus-voix', name: 'Bus voix', type: 'BUS' });
const master = t({ id: 'master', name: 'Master', type: 'BUS' });
const maVoix = t({ id: 'voix-nina', name: 'Voix de Nina', type: 'AUDIO', collabOwner: 'artist', collabOwnerKey: NINA, collabOwnerName: 'Nina' });
const autreArtiste = t({ id: 'voix-sam', name: 'Voix de Sam', type: 'AUDIO', collabOwner: 'artist', collabOwnerKey: 'u:sam', collabOwnerName: 'Sam' });

const simple = { ...DEFAULT_GUEST_RIGHTS };
const v = (kind: string, op: Record<string, any>, existing?: Track, rights = simple) => guestOpVerdict(kind, op, { rights, authorKey: NINA_DEVICE, existing });

describe('droits de l’invité : valeur reçue', () => {
  it('mode simple par défaut, mix et repères à l’ingé', () => {
    expect(DEFAULT_GUEST_RIGHTS).toEqual({ limited: true, ownMix: false, markers: false, remote: false });
  });
  it('vérifie ce qui arrive (illisible : ignoré)', () => {
    expect(sanitizeGuestRights(null)).toBeNull();
    expect(sanitizeGuestRights({})).toBeNull();
    expect(sanitizeGuestRights({ limited: 'oui' })).toBeNull();
    expect(sanitizeGuestRights({ limited: true, ownMix: 1, markers: true, by: 'Max'.repeat(30), at: 5 }))
      .toEqual({ limited: true, ownMix: false, markers: true, remote: false, by: 'Max'.repeat(30).slice(0, 40), at: 5 });
  });
  it('seuls les artistes sont concernés', () => {
    expect(isLimitedGuest('artist', simple)).toBe(true);
    expect(isLimitedGuest('engineer', simple)).toBe(false);
    expect(isLimitedGuest('beatmaker', simple)).toBe(false);
    expect(isLimitedGuest('artist', { limited: false })).toBe(false);
    expect(isLimitedGuest('artist', undefined)).toBe(false);
  });
});

describe('réception chez l’ingé : ce qu’un artiste en mode simple ne peut PAS faire', () => {
  it('toucher au mix de la séance (beat, voix lead, bus, master, la voix d’un autre)', () => {
    for (const tr of [beat, voixLead, bus, master, autreArtiste]) {
      expect(v('mix', { trackId: tr.id, fields: { volume: 0 } }, tr).ok).toBe(false);
    }
    // Avant (règle des artistes) : le beat, le bus et la voix lead étaient permis.
    const artist = { role: 'artist' as const, memberKey: NINA_DEVICE };
    expect(mixAllowed(beat, artist)).toBe(true);
    expect(mixAllowed(voixLead, artist)).toBe(true);
    expect(mixAllowed(bus, artist)).toBe(true);
  });
  it('régler sa propre voix : seulement si l’ingé le permet', () => {
    expect(v('mix', { trackId: maVoix.id, fields: { volume: 0.5 } }, maVoix).ok).toBe(false);
    expect(v('mix', { trackId: maVoix.id, fields: { volume: 0.5 } }, maVoix, { ...simple, ownMix: true }).ok).toBe(true);
    // ownMix n'ouvre jamais le mix des autres pistes.
    expect(v('mix', { trackId: beat.id, fields: { volume: 0 } }, beat, { ...simple, ownMix: true }).ok).toBe(false);
  });
  it('supprimer ou réécrire les pistes de l’ingé (et celles d’un autre artiste)', () => {
    for (const tr of [voixLead, beat, bus, autreArtiste]) {
      expect(v('track_del', { trackId: tr.id }, tr).ok).toBe(false);
      expect(v('content', { trackId: tr.id, cv: 2, changed: [], removed: ['p1'], content: { clips: [] } }, tr).ok).toBe(false);
    }
    // Avant : un artiste pouvait supprimer la « Voix lead » préparée par l'ingé (piste de voix sans propriétaire).
    expect(deleteAllowed(voixLead, { role: 'artist', memberKey: NINA_DEVICE })).toBe(true);
  });
  it('créer autre chose qu’une piste de voix à son nom', () => {
    const neuf = (content: Record<string, unknown>) => v('content', { trackId: 'x', cv: 2, content }, undefined);
    expect(neuf({ type: 'AUDIO', collabOwner: 'artist', collabOwnerKey: NINA }).ok).toBe(true);
    expect(neuf({ type: 'MIDI', collabOwner: 'artist', collabOwnerKey: NINA }).ok).toBe(false);
    expect(neuf({ type: 'BUS', collabOwner: 'artist', collabOwnerKey: NINA }).ok).toBe(false);
    expect(neuf({ type: 'AUDIO', collabOwner: 'artist', collabOwnerKey: 'u:quelquun' }).ok).toBe(false);
    expect(neuf({ type: 'AUDIO', collabOwner: 'engineer', collabOwnerKey: NINA }).ok).toBe(false);
  });
  it('tempo, ordre des pistes, groupes, accords, beat, temps, verrou, écoute guidée, notes, revendication, gel, droits', () => {
    for (const kind of ['tempo', 'order', 'groups', 'chords', 'beatswap', 'timeop', 'lock', 'listen', 'notes', 'own', 'freeze', GUEST_RIGHTS_KIND]) {
      expect(GUEST_FORBIDDEN_KINDS.has(kind)).toBe(true);
      expect(v(kind, { trackId: 'voix', bpm: 140 }, voixLead).ok).toBe(false);
    }
  });
  it('playlists de piste (Pro Tools) : un invité ne bascule ni ne supprime celles de l’ingé ; les siennes oui ; mode libre : oui', () => {
    // Les playlists voyagent dans l'opération « content » (playlist active + autres playlists).
    const switchOp = (tr: Track) => ({ trackId: tr.id, cv: 2, changed: ['c9'], removed: ['p1', 'p2', 'p3'], meta: true,
      content: { type: 'AUDIO', clips: [], activePlaylistId: 'pl-2', playlists: [{ id: 'pl-1', name: 'Voix lead', clips: [] }, { id: 'pl-2', name: 'Voix lead.02', clips: [] }] } });
    const deleteOp = (tr: Track) => ({ trackId: tr.id, cv: 2, changed: [], removed: [], meta: true, content: { type: 'AUDIO', clips: [], playlists: [{ id: 'pl-1', name: 'Voix lead', clips: [] }] } });
    for (const tr of [voixLead, beat, autreArtiste]) {
      expect(v('content', switchOp(tr), tr).ok).toBe(false);
      expect(v('content', deleteOp(tr), tr).ok).toBe(false);
      expect(v('content', switchOp(tr), tr, { limited: false }).ok).toBe(true);
    }
    expect(v('content', switchOp(maVoix), maVoix).ok).toBe(true);
    expect(v('content', deleteOp(maVoix), maVoix).ok).toBe(true);
  });
  it('tonalité et arrangements : refusés ; les paroles passent seules', () => {
    expect(v('song', { fields: { projectKey: 3 } }).ok).toBe(false);
    expect(v('song', { fields: { arrangements: [] } }).ok).toBe(false);
    expect(v('song', { fields: { lyrics: 'couplet' } })).toEqual({ ok: true });
    const mixed = v('song', { fields: { lyrics: 'couplet', projectScale: 'MINOR' }, _id: 'x' });
    expect(mixed.ok).toBe(true);
    expect(mixed.op).toEqual({ fields: { lyrics: 'couplet' }, _id: 'x' });
  });
  it('fréquence d’échantillonnage du projet : refusée (seule ou avec les paroles, qui passent seules)', () => {
    expect(GUEST_REFUSED_SONG_FIELDS).toContain('sampleRate');
    const seule = v('song', { fields: { sampleRate: 96000 } });
    expect(seule.ok).toBe(false);
    expect(seule.reason).toMatch(/fréquence d’échantillonnage/);
    const avec = v('song', { fields: { lyrics: 'refrain', sampleRate: 44100 } });
    expect(avec).toEqual({ ok: true, op: { fields: { lyrics: 'refrain' } } });
    // Hors mode simple (ou ingé) : permise.
    expect(v('song', { fields: { sampleRate: 96000 } }, undefined, { limited: false }).ok).toBe(true);
  });
  it('repères : seulement si l’ingé le permet', () => {
    expect(v('markers', { upsert: [{ id: 'm', time: 1 }] }).ok).toBe(false);
    expect(v('markers', { upsert: [{ id: 'm', time: 1 }] }, undefined, { ...simple, markers: true }).ok).toBe(true);
  });
});

describe('ce qu’un artiste en mode simple PEUT faire', () => {
  it('enregistrer et éditer SES prises, supprimer SA piste', () => {
    expect(v('content', { trackId: maVoix.id, cv: 2, changed: ['c1'], removed: [], content: { clips: [] } }, maVoix).ok).toBe(true);
    expect(v('track_del', { trackId: maVoix.id }, maVoix).ok).toBe(true);
  });
  it('discuter, verrou d’enregistrement, audio et VST pilotés par l’ingé', () => {
    for (const kind of ['chat', 'rec', 'vst_preview', 'vst_preview_state', 'vst_param_ack', 'vst_params', 'vst_catalog', 'ri_peer', 'transport']) {
      expect(v(kind, { trackId: maVoix.id }, maVoix).ok).toBe(true);
    }
  });
  it('hors mode simple : rien ne change (séance d’un artiste, mode libre)', () => {
    for (const kind of ['mix', 'tempo', 'order', 'track_del', 'content', 'song']) {
      expect(v(kind, { trackId: beat.id, fields: { volume: 0 } }, beat, { limited: false }).ok).toBe(true);
      expect(guestOpVerdict(kind, {}, { rights: undefined, authorKey: NINA_DEVICE, existing: beat }).ok).toBe(true);
    }
  });
});

describe('les mêmes règles à l’envoi et dans l’interface', () => {
  it('mix, prises, suppression : ses pistes seulement', () => {
    for (const tr of [beat, voixLead, bus, master, autreArtiste]) {
      expect(guestCanMix(tr, NINA, simple)).toBe(false);
      expect(guestCanEditContent(tr, NINA, simple)).toBe(false);
      expect(guestCanDelete(tr, NINA, simple)).toBe(false);
    }
    expect(guestCanEditContent(maVoix, NINA, simple)).toBe(true);
    expect(guestCanDelete(maVoix, NINA, simple)).toBe(true);
    expect(guestCanMix(maVoix, NINA, simple)).toBe(false);
    expect(guestCanMix(maVoix, NINA, { ...simple, ownMix: true })).toBe(true);
    // Les règles générales restent vraies (le mode simple s'y ajoute).
    expect(canSendMix(maVoix, { role: 'artist', key: NINA })).toBe(true);
    expect(canSendContent(maVoix, { role: 'artist', key: NINA })).toBe(true);
  });
  it('fuzz : aucune opération d’un invité ne touche une piste qui n’est pas la sienne', () => {
    const tracks = [beat, voixLead, bus, master, autreArtiste, maVoix];
    const kinds = ['mix', 'content', 'track_del', 'tempo', 'order', 'markers', 'song', 'chords', 'groups', 'timeop', 'chat', 'rec', 'lock', 'own'];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const tr = tracks[rnd(tracks.length)];
      const kind = kinds[rnd(kinds.length)];
      const rights = { limited: true, ownMix: rnd(2) === 1, markers: rnd(2) === 1 };
      const r = v(kind, { trackId: tr.id, fields: { volume: rnd(10) / 10, lyrics: 'x' }, content: { type: 'AUDIO', collabOwner: 'artist', collabOwnerKey: NINA } }, tr, rights);
      if (r.ok && ['mix', 'content', 'track_del'].includes(kind)) expect(tr.collabOwnerKey).toBe(NINA);
    }
  });
});
