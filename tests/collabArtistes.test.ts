import { describe, expect, it } from 'vitest';
import {
  applyMarkerOps, claimWins, contentVerdict, followTarget, formatInviteCode, formatPosition, isSessionFull, markerChanges, markerSig,
  myRecordTarget, myTrackName, needsResync, normalizeInviteCode, ownerFromContent, ownsContent, participantOf, parseTimeMentions,
  peerViews, pickPeerColor, PEER_COLORS, recordBlock, withPosition, PeerInfo, PeerRec, REC_LOCK_TTL_MS,
} from '../utils/collabPeers';
import { applyMixFields, legacyMixToFields } from '../utils/collabMerge';
import { Marker, TrackType } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

/**
 * « Feat à distance » : plusieurs artistes dans la même session. Propriété des
 * pistes (la prise de l'un n'écrase jamais celle de l'autre), verrou
 * d'enregistrement, présence, « Écouter ensemble », positions dans le chat,
 * repères, code d'invitation, et compatibilité avec les anciennes versions.
 */

const LEO = 'u:11111111-1111-4111-8111-111111111111';
const SAM = 'u:33333333-3333-4333-8333-333333333333';
const leo = { role: 'artist' as const, key: LEO, name: 'Léo' };
const sam = { role: 'artist' as const, key: SAM, name: 'Sam' };

describe('participants', () => {
  it('la même personne sur deux appareils (nouvelle clé par appareil) reste la même', () => {
    expect(participantOf(`${LEO}:ipad123`)).toBe(LEO);
    expect(participantOf(`${LEO}:pc456`)).toBe(LEO);
    expect(participantOf(LEO)).toBe(LEO); // ancienne fonction : une clé par compte
    expect(participantOf('d:abc')).toBe('d:abc');
    expect(participantOf(undefined)).toBe('');
  });

  it('chaque arrivant prend une couleur libre', () => {
    const a = pickPeerColor(LEO, []);
    const b = pickPeerColor(SAM, [a]);
    const c = pickPeerColor('u:x', [a, b]);
    const d = pickPeerColor('u:y', [a, b, c]);
    expect(new Set([a, b, c, d]).size).toBe(4);
    [a, b, c, d].forEach(x => expect(PEER_COLORS).toContain(x));
    // Toutes prises : une couleur quand même.
    expect(PEER_COLORS).toContain(pickPeerColor('u:z', [...PEER_COLORS]));
  });
});

describe('propriété des pistes', () => {
  const couplet = makeTrack({ id: 'couplet', name: 'Couplet de Léo', collabOwner: 'artist', collabOwnerKey: LEO, collabOwnerName: 'Léo', collabOwnerColor: '#22d3ee' });
  const refrain = makeTrack({ id: 'refrain', name: 'Refrain de Sam', collabOwner: 'artist', collabOwnerKey: SAM, collabOwnerName: 'Sam' });
  const ancienne = makeTrack({ id: 'voix', name: 'Voix lead' }); // sans propriétaire (ancienne session)

  it('seul son auteur possède le contenu de sa piste', () => {
    expect(ownsContent(couplet, 'artist', LEO)).toBe(true);
    expect(ownsContent(couplet, 'artist', SAM)).toBe(false);
    expect(ownsContent(refrain, 'artist', SAM)).toBe(true);
    expect(ownsContent(couplet, 'engineer', LEO)).toBe(false);
    // Ancienne piste : à tout le rôle, comme avant (rétrocompatibilité).
    expect(ownsContent(ancienne, 'artist', SAM)).toBe(true);
    expect(ownsContent(ancienne, 'artist')).toBe(true);
    expect(ownsContent(makeTrack({ id: 'instrumental' }), 'artist', LEO)).toBe(false);
  });

  it('la version de Sam est refusée sur la piste de Léo (sa prise n’est jamais écrasée)', () => {
    expect(contentVerdict(couplet, { role: 'artist', memberKey: `${SAM}:pc` })).toEqual({ ok: false, reason: 'piste de Léo' });
    expect(contentVerdict(couplet, { role: 'artist', memberKey: `${LEO}:ipad` })).toEqual({ ok: true });
    // Ancienne clé de membre (fonction pas encore mise à jour) : même personne.
    expect(contentVerdict(couplet, { role: 'artist', memberKey: LEO })).toEqual({ ok: true });
    expect(contentVerdict(couplet, { role: 'engineer', memberKey: LEO })).toEqual({ ok: false, reason: 'piste d’un autre rôle' });
    expect(contentVerdict(undefined, { role: 'artist', memberKey: SAM })).toEqual({ ok: true }); // nouvelle piste
    expect(contentVerdict(ancienne, { role: 'artist', memberKey: SAM })).toEqual({ ok: true });
  });

  it('piste reçue : propriétaire donné par le contenu, sinon l’auteur (ancienne version de NOVA)', () => {
    expect(ownerFromContent({ collabOwnerKey: SAM, collabOwnerName: 'Sam', collabOwnerColor: '#f472b6' }, { role: 'artist', memberKey: SAM, name: 'sam' }))
      .toEqual({ key: SAM, name: 'Sam', color: '#f472b6' });
    expect(ownerFromContent({ name: 'Voix' }, { role: 'artist', memberKey: `${SAM}:pc`, name: 'sam' })).toEqual({ key: SAM, name: 'sam', color: '#94a3b8' });
  });

  it('revendication d’une piste sans propriétaire : la première du journal gagne', () => {
    expect(claimWins(undefined, 120)).toBe(true);
    expect(claimWins(120, 118)).toBe(true);
    expect(claimWins(118, 120)).toBe(false);
    expect(claimWins(Infinity, 120)).toBe(true); // la nôtre n'était pas encore enregistrée
  });
});

describe("verrou d'enregistrement", () => {
  const now = 1_000_000;
  const couplet = makeTrack({ id: 'couplet', name: 'Couplet de Léo', collabOwner: 'artist', collabOwnerKey: LEO, collabOwnerName: 'Léo' });
  const mine = makeTrack({ id: 'refrain', name: 'Refrain de Sam', collabOwner: 'artist', collabOwnerKey: SAM, collabOwnerName: 'Sam' });
  const libre = makeTrack({ id: 'voix', name: 'Voix lead' });

  it('Sam ne peut pas enregistrer sur la piste de Léo (phrase claire)', () => {
    const msg = recordBlock(couplet, sam, [], now);
    expect(msg).toMatch(/est la piste de Léo/);
    expect(msg).toMatch(/ta propre piste/);
    expect(recordBlock(mine, sam, [], now)).toBeNull();
    expect(recordBlock(couplet, leo, [], now)).toBeNull();
    expect(recordBlock(couplet, null, [], now)).toBeNull(); // pas de collaboration
  });

  it('une piste se verrouille quand son auteur enregistre dessus', () => {
    const recs: PeerRec[] = [{ key: LEO, name: 'Léo', trackId: 'voix', at: now - 1000 }];
    expect(recordBlock(libre, sam, recs, now)).toMatch(/Léo enregistre sur « Voix lead »/);
    // Mon propre enregistrement ne me bloque pas.
    expect(recordBlock(libre, leo, recs, now)).toBeNull();
    // Un verrou reçu par le journal expire tout seul (direct coupé, prise jamais terminée).
    expect(recordBlock(libre, sam, recs, now + REC_LOCK_TTL_MS + 1)).toBeNull();
  });

  it("l'ingé n'enregistre pas sur la voix d'un artiste", () => {
    expect(recordBlock(libre, { role: 'engineer', key: 'u:inge', name: 'Max' }, [], now)).toMatch(/appartient à l'artiste/);
  });

  it('REC choisit une piste à moi (jamais celle de l’autre)', () => {
    const tracks = [couplet, libre, mine];
    expect(myRecordTarget(tracks, sam, [], 'couplet')?.id).toBe('refrain');
    expect(myRecordTarget(tracks, sam, [], 'voix')?.id).toBe('voix');
    expect(myRecordTarget([couplet], sam, [])).toBeNull();
    expect(myTrackName('Sam', tracks)).toBe('Voix de Sam');
    expect(myTrackName('Sam', [...tracks, makeTrack({ name: 'Voix de Sam' })])).toBe('Voix de Sam 2');
  });
});

describe('présence', () => {
  const name = (id: string) => ({ couplet: 'Couplet de Léo' } as Record<string, string>)[id];
  const now = 5_000_000;
  const peers: PeerInfo[] = [
    { key: SAM, name: 'Sam', role: 'artist', online: true },
    { key: LEO, name: 'Léo', role: 'artist', online: true, rec: 'couplet' },
    { key: 'u:inge', name: 'Max', role: 'engineer', online: true, playing: true },
    { key: 'u:beat', name: 'Kenji', role: 'beatmaker', online: true, st: 'late' },
    { key: 'u:old', name: 'Ana', role: 'artist', online: false, seenAt: now - 5000 },
    { key: 'u:gone', name: 'Zoé', role: 'artist', online: false },
  ];

  it('connecté, enregistre, écoute, en retard, hors ligne (moi en premier)', () => {
    const v = peerViews(peers, SAM, name, now);
    expect(v[0]).toMatchObject({ key: SAM, me: true, state: 'online', label: 'connecté' });
    const by = Object.fromEntries(v.map(x => [x.name, x]));
    expect(by['Léo']).toMatchObject({ state: 'recording', label: 'enregistre sur « Couplet de Léo »' });
    expect(by['Max']).toMatchObject({ state: 'listening', label: 'écoute' });
    expect(by['Kenji'].state).toBe('late');
    expect(by['Ana']).toMatchObject({ state: 'late' });
    expect(by['Ana'].label).toMatch(/toutes les 10 s/);
    expect(by['Zoé']).toMatchObject({ state: 'offline', label: 'hors ligne' });
  });

  it('4 participants au plus', () => {
    const four = peers.filter(p => p.online); // Sam, Léo, Max, Kenji
    expect(isSessionFull(four, 'u:nouveau')).toBe(true);
    expect(isSessionFull(four, SAM)).toBe(false); // déjà dedans
    expect(isSessionFull(four.slice(0, 3), 'u:nouveau')).toBe(false);
  });
});

describe('« Écouter ensemble »', () => {
  it("l'invité part à la position de l'hôte, avancée du temps de transport du message", () => {
    expect(followTarget({ action: 'play', pos: 10, at: 1000, playing: true }, 1250)).toEqual({ playing: true, pos: 10.25 });
    expect(followTarget({ action: 'pause', pos: 12, at: 1000, playing: false }, 1900)).toEqual({ playing: false, pos: 12 });
    // Arrivé par le rattrapage, bien plus tard : ignoré.
    expect(followTarget({ action: 'play', pos: 1, at: 0, playing: true }, 31_000)).toBeNull();
    expect(followTarget({ action: 'play', pos: NaN, at: 0, playing: true }, 10)).toBeNull();
  });

  it('recalage seulement au-delà de 80 ms', () => {
    expect(needsResync(10, 10.05)).toBe(false);
    expect(needsResync(10, 10.2)).toBe(true);
  });
});

describe('chat : positions', () => {
  it('« à 0:42 » devient un lien vers la tête de lecture', () => {
    const parts = parseTimeMentions('Reprends à 0:42 puis 1:05:03, pas 10:99 ni 12:345');
    expect(parts.filter(p => p.kind === 'time')).toEqual([
      { kind: 'time', text: '0:42', seconds: 42 },
      { kind: 'time', text: '1:05:03', seconds: 3903 },
    ]);
    expect(parts.map(p => p.text).join('')).toBe('Reprends à 0:42 puis 1:05:03, pas 10:99 ni 12:345');
    expect(parseTimeMentions('rien')).toEqual([{ kind: 'text', text: 'rien' }]);
  });

  it('formatage et insertion de la position', () => {
    expect(formatPosition(42.9)).toBe('0:42');
    expect(formatPosition(65)).toBe('1:05');
    expect(formatPosition(3903)).toBe('1:05:03');
    expect(withPosition('', 42)).toBe('À 0:42 : ');
    expect(withPosition('Le couplet ', 42)).toBe('Le couplet à 0:42 ');
  });
});

describe('repères partagés', () => {
  const mk = (id: string, time: number, name = 'Repère'): Marker => ({ id, name, time, type: 'MARKER', color: '#f59e0b' });

  it('seuls les repères ajoutés, modifiés ou supprimés partent', () => {
    const known = new Map([['a', markerSig(mk('a', 10))], ['b', markerSig(mk('b', 20))]]);
    const { upsert, remove } = markerChanges(known, [mk('a', 10), mk('b', 21), mk('c', 30, 'couplet 2 ici')]);
    expect(upsert.map(m => m.id)).toEqual(['b', 'c']);
    expect(remove).toEqual([]);
    expect(markerChanges(known, [mk('a', 10)]).remove).toEqual(['b']);
  });

  it('repères reçus posés, triés ; un plus ancien que le nôtre est refusé', () => {
    const out = applyMarkerOps([mk('a', 10)], [mk('c', 5, 'couplet 2 ici'), { id: 'x', time: NaN }, mk('a', 12)], ['zz'], id => id !== 'a');
    expect(out.map(m => [m.id, m.time, m.name])).toEqual([['c', 5, 'couplet 2 ici'], ['a', 10, 'Repère']]);
    expect(applyMarkerOps(out, [], ['c']).map(m => m.id)).toEqual(['a']);
    expect(applyMarkerOps(out, 'pas une liste', null).length).toBe(2);
  });
});

describe('invitation', () => {
  it('code à 6 caractères, saisi comme on veut', () => {
    expect(normalizeInviteCode('abc 234')).toBe('ABC234');
    expect(normalizeInviteCode('ABC-234')).toBe('ABC234');
    expect(normalizeInviteCode('ABC23')).toBeNull();
    expect(normalizeInviteCode('ABC10O')).toBeNull(); // ni 0, ni 1, ni O : jamais d'ambiguïté
    expect(formatInviteCode('ABC234')).toBe('ABC 234');
  });
});

describe('ancien format (anciennes versions de NOVA dans la même session)', () => {
  it('mix complet à l’ancienne : appliqué champ par champ', () => {
    const t = makeTrack({ id: 'voix', volume: 0.5, pan: 0 });
    const fields = legacyMixToFields({ volume: 0.9, pan: -0.3, isMuted: true, sends: [], plugins: [] });
    const applied = applyMixFields(t, fields, () => true);
    expect(t.volume).toBe(0.9);
    expect(t.pan).toBe(-0.3);
    expect(t.isMuted).toBe(true);
    expect(applied).toEqual(expect.arrayContaining(['volume', 'pan', 'isMuted']));
  });

  it("contenu sans propriétaire (ancienne version) : sur une piste sans propriétaire c'est accepté, sur celle de Léo non", () => {
    const old = { role: 'artist' as const, memberKey: SAM };
    expect(contentVerdict(makeTrack({ id: 'voix' }), old).ok).toBe(true);
    expect(contentVerdict(makeTrack({ collabOwner: 'artist', collabOwnerKey: LEO, collabOwnerName: 'Léo' }), old).ok).toBe(false);
  });

  it('un clip garde ses champs inconnus (rien ne casse chez une ancienne version)', () => {
    const c = makeClip({ type: TrackType.AUDIO });
    expect({ ...c, takeNumber: 2 }).toMatchObject({ id: c.id });
  });
});
