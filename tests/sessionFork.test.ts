import { describe, expect, it } from 'vitest';
import {
  audioFingerprint, copiesText, copyName, forkErrorCode, forkErrorView, forkUrl, parseForkToken, prepareForkCopy, withoutForkToken,
} from '../utils/sessionFork';
import { exportKeyOf } from '../utils/exportRights';

const TOKEN = 'AbCdEfGhJkLmNpQrStUvWxYz23456789';

describe('Lot 9a · lien « Faire sa version »', () => {
  it('le jeton voyage dans le fragment (#copie=…), jamais dans la requête', () => {
    const url = forkUrl(TOKEN, 'https://nova.example/');
    expect(url).toBe(`https://nova.example/#copie=${TOKEN}`);
    expect(new URL(url).search).toBe('');
    expect(parseForkToken(new URL(url).hash)).toBe(TOKEN);
    expect(parseForkToken('#copie=trop-court')).toBeNull();
    expect(parseForkToken('')).toBeNull();
    expect(withoutForkToken(`https://nova.example/?x=1#copie=${TOKEN}`)).toBe('https://nova.example/?x=1');
    expect(withoutForkToken(`https://nova.example/#a=1&copie=${TOKEN}`)).toBe('https://nova.example/#a=1');
  });

  it('la copie est un projet À SOI : nouvel id, sa propre clé d’export, plus rien de la collaboration de l’hôte', () => {
    const host: any = {
      id: 'cloud-abcdefghijkl', name: 'Beat de Max', exportKey: 'exp-paye-par-max', bpm: 140, chords: [{ t: 0, name: 'Am' }],
      lyrics: 'refrain', markers: [{ id: 'm', time: 4 }],
      collabHost: { role: 'beatmaker', name: 'Max' }, collabGuestRights: { limited: true }, collabSeq: 12, collabTimeOps: ['x'],
      remoteInge: { link: 'l', role: 'artist' }, timelineComments: [{ id: 'c' }], mixVersions: [{ id: 'v' }],
      tracks: [{ id: 'drums', clips: [{ id: 'c1' }], collabOwner: 'beatmaker', collabOwnerKey: 'u:max', collabOwnerName: 'Max', collabOwnerColor: '#f00', remote: { x: 1 } }],
    };
    const c: any = prepareForkCopy(host, { name: host.name, now: 1700000000000, exportKey: 'exp-neuve' });
    expect(c.id).toBe('proj-1700000000000');
    expect(c.name).toBe('Ma version · Beat de Max');
    expect(exportKeyOf(c)).toBe('exp-neuve'); // n'hérite pas de l'export payé par l'hôte
    expect(c.bpm).toBe(140);
    expect(c.chords).toEqual(host.chords);
    expect(c.lyrics).toBe('refrain');
    for (const k of ['collabHost', 'collabGuestRights', 'collabSeq', 'collabTimeOps', 'remoteInge', 'timelineComments', 'mixVersions']) expect(c[k]).toBeUndefined();
    expect(c.tracks[0]).toEqual({ id: 'drums', clips: [{ id: 'c1' }] });
    // L'original n'est pas touché.
    expect(host.id).toBe('cloud-abcdefghijkl');
    expect(host.tracks[0].collabOwner).toBe('beatmaker');
    // Sans clé fournie : une clé neuve.
    expect(prepareForkCopy(host, { name: 'x' }).exportKey).toMatch(/^exp-/);
    expect(copyName('Ma version · Beat')).toBe('Ma version · Beat');
  });

  it('messages clairs et empreinte', () => {
    expect(forkErrorCode(410, 'revoked')).toBe('revoked');
    expect(forkErrorCode(401, undefined)).toBe('login');
    expect(forkErrorCode(404, undefined)).toBe('unknown');
    expect(forkErrorCode(undefined, undefined)).toBe('network');
    expect(forkErrorView('revoked').title).toMatch(/désactivé/);
    expect(forkErrorView('login').text).toMatch(/gratuit/);
    expect(forkErrorView('network').retry).toBe(true);
    expect(copiesText(0)).toMatch(/aucune/);
    expect(copiesText(1)).toBe('1 copie');
    expect(copiesText(7)).toBe('7 copies');
    expect(audioFingerprint({ b: '2', a: '1' })).toBe('a:1|b:2');
  });
});
