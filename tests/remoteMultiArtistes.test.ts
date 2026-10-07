import { describe, expect, it } from 'vitest';
import { TrackType } from '../types';
import {
  applyFxOnArtist, applySendOnEngineer, buildFxPayload, buildReturnPayload, buildSendPayload, engineerTrackFor, pairEngineer, remoteForMe,
} from '../utils/remoteInge';
import { makeClip, makeTrack } from './helpers/fixtures';

/**
 * « Ingé à distance » avec PLUSIEURS artistes sur le même lien : deux
 * artistes peuvent avoir une piste au même identifiant (« voix ») ; chez
 * l'ingé ce sont deux pistes distinctes (à leur nom), et le rendu de l'ingé
 * ne revient qu'à l'artiste concerné. Avant : la piste de Sam remplaçait celle
 * de Léo chez l'ingé, et le retour de Léo s'appliquait aussi chez Sam.
 */

const LEO = 'u:11111111-1111-4111-8111-111111111111';
const SAM = 'u:33333333-3333-4333-8333-333333333333';

const artistTrack = (name: string, take: string) => makeTrack({
  id: 'voix', name, clips: [makeClip({ id: `${take}-c`, name: 'Prise 1', start: 1, offset: 0, duration: 2, bufferId: take })],
  remote: { peerTrackId: 'voix' },
});

describe('ingé à distance : deux artistes, même identifiant de piste', () => {
  it('chez l’ingé : deux pistes distinctes, à leur nom', () => {
    const master = makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] });
    const eng = [master];
    const a = applySendOnEngineer(eng, buildSendPayload(artistTrack('Voix', 'leo-take'), 1), { key: `${LEO}:pc`, name: 'Léo' });
    const b = applySendOnEngineer(eng, buildSendPayload(artistTrack('Voix', 'sam-take'), 1), { key: `${SAM}:ipad`, name: 'Sam' });
    expect(a.created && b.created).toBe(true);
    expect(a.trackId).not.toBe(b.trackId);
    const ta = eng.find(t => t.id === a.trackId)!;
    const tb = eng.find(t => t.id === b.trackId)!;
    expect(ta.clips[0].bufferId).toBe('leo-take');
    expect(tb.clips[0].bufferId).toBe('sam-take'); // la prise de Sam n'a pas remplacé celle de Léo
    expect(ta.remote).toMatchObject({ peerTrackId: 'voix', peerKey: LEO });
    expect(tb.remote).toMatchObject({ peerTrackId: 'voix', peerKey: SAM });
    expect(ta.collabOwnerName).toBe('Léo');
    expect(tb.name).toBe('Voix · Sam'); // même nom : on précise de qui
    // Nouvelle version de Léo : sur SA piste.
    const a2 = applySendOnEngineer(eng, buildSendPayload(artistTrack('Voix', 'leo-take2'), 2), { key: `${LEO}:ipad`, name: 'Léo' });
    expect(a2).toEqual({ trackId: a.trackId, created: false });
    expect(eng.find(t => t.id === a.trackId)!.clips[0].bufferId).toBe('leo-take2');
    expect(eng.find(t => t.id === b.trackId)!.clips[0].bufferId).toBe('sam-take');
    expect(engineerTrackFor(eng, 'voix', SAM)?.id).toBe(b.trackId);
  });

  it('ancienne piste sans auteur (un seul artiste avant) : reprise par le premier, pas par le second', () => {
    const eng = [makeTrack({ id: 'voix', name: 'Voix', remote: { peerTrackId: 'voix', recvV: 1 } })];
    expect(engineerTrackFor(eng, 'voix', LEO)?.id).toBe('voix');
    applySendOnEngineer(eng, buildSendPayload(artistTrack('Voix', 'leo-take'), 2), { key: LEO, name: 'Léo' });
    expect(eng[0].remote?.peerKey).toBe(LEO);
    expect(engineerTrackFor(eng, 'voix', SAM)).toBeUndefined();
    // Ancien artiste (sans clé connue) : comme avant.
    expect(engineerTrackFor(eng, 'voix', undefined)?.id).toBe('voix');
  });

  it('le retour de l’ingé ne revient qu’à son artiste', () => {
    const eng = [makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] })];
    const b = applySendOnEngineer(eng, buildSendPayload(artistTrack('Voix', 'sam-take'), 1), { key: SAM, name: 'Sam' });
    const { payload } = buildReturnPayload(eng.find(t => t.id === b.trackId)!, eng, 'recording');
    expect(payload.trackId).toBe('voix');
    expect(payload.to).toBe(SAM);
    expect(remoteForMe(payload.to, `${SAM}:ipad`)).toBe(true);
    expect(remoteForMe(payload.to, `${LEO}:pc`)).toBe(false);
    expect(remoteForMe(undefined, LEO)).toBe(true); // ancien ingé : comme avant
  });

  it('les envois natifs (reverb de NOVA) : chacun ne reçoit que les siens', () => {
    const verb = makeTrack({ id: 'send-verb-short', name: 'VERB', type: TrackType.SEND, sends: [], plugins: [] });
    const master = makeTrack({ id: 'master', name: 'MASTER', type: TrackType.BUS, sends: [] });
    const eng = [verb, master];
    const a = applySendOnEngineer(eng, buildSendPayload(artistTrack('Voix', 'leo-take'), 1), { key: LEO, name: 'Léo' });
    const b = applySendOnEngineer(eng, buildSendPayload(artistTrack('Voix', 'sam-take'), 1), { key: SAM, name: 'Sam' });
    eng.find(t => t.id === a.trackId)!.sends = [{ id: 'send-verb-short', level: 0.6, isEnabled: true }];
    eng.find(t => t.id === b.trackId)!.sends = [{ id: 'send-verb-short', level: 0.1, isEnabled: true }];
    const fx = buildFxPayload(eng);
    expect(fx.tracks.map(x => [x.trackId, x.to])).toEqual([['voix', LEO], ['voix', SAM]]);
    const samSide = [artistTrack('Voix', 'sam-take')];
    applyFxOnArtist(samSide, fx, `${SAM}:ipad`);
    expect(samSide[0].sends.find(s => s.id.endsWith('send-verb-short'))?.level).toBe(0.1);
  });

  it('même ingé sur un autre appareil : toujours le même ingé (clé par appareil)', () => {
    expect(pairEngineer('u:max', 'u:max:pc')).toBe('same');
    expect(pairEngineer('u:max:pc', 'u:max:ipad')).toBe('same');
    expect(pairEngineer('u:max', 'u:autre')).toBe('other');
    expect(pairEngineer(undefined, 'u:max')).toBe('new');
  });
});
