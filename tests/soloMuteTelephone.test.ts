import { describe, expect, it } from 'vitest';
import { Track, TrackType } from '../types';
import { soloMuteMenu } from '../utils/soloMute';

const mk = (id: string, over: Partial<Track> = {}): Track => ({
  id, name: id, type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...over,
});
const session = (over: Record<string, Partial<Track>> = {}) => [
  mk('master', { type: TrackType.BUS, outputTrackId: '' }),
  mk('beat', { name: 'Beat', ...over.beat }),
  mk('lead', { name: 'Voix lead', ...over.lead }),
  mk('back', { name: 'Backs', ...over.back }),
];

describe('console du téléphone : appui long sur S / M (équivalent d’Alt+clic et de Ctrl+clic)', () => {
  it('S, rien en solo : tout en solo + solo safe (pas d’« effacer »)', () => {
    const m = soloMuteMenu(session(), 'lead', 'solo');
    expect(m.map(a => [a.kind, a.on])).toEqual([['soloAll', true], ['soloSafe', true]]);
    expect(m[1].label).toBe('Solo safe : toujours audible');
  });

  it('S, 2 pistes en solo : « Effacer tous les solos (2 pistes) »', () => {
    const m = soloMuteMenu(session({ lead: { isSolo: true }, back: { isSolo: true } }), 'lead', 'solo');
    expect(m.find(a => a.kind === 'soloAll' && !a.on)?.label).toBe('Effacer tous les solos (2 pistes)');
  });

  it('S, toutes en solo (hors solo safe) : plus de « tout en solo »', () => {
    const m = soloMuteMenu(session({ beat: { soloSafe: true }, lead: { isSolo: true }, back: { isSolo: true } }), 'beat', 'solo');
    expect(m.some(a => a.kind === 'soloAll' && a.on)).toBe(false);
    expect(m.find(a => a.kind === 'soloSafe')).toMatchObject({ on: false, label: 'Retirer le solo safe' });
  });

  it('M : couper tout / rendre le son, le master jamais compté', () => {
    expect(soloMuteMenu(session(), 'beat', 'mute').map(a => [a.kind, a.on])).toEqual([['muteAll', true]]);
    const m = soloMuteMenu(session({ beat: { isMuted: true } }), 'beat', 'mute');
    expect(m.map(a => a.label)).toEqual(['Couper toutes les pistes', 'Rendre le son à toutes les pistes (1 muette)']);
    const all = soloMuteMenu(session({ beat: { isMuted: true }, lead: { isMuted: true }, back: { isMuted: true } }), 'beat', 'mute');
    expect(all.map(a => a.label)).toEqual(['Rendre le son à toutes les pistes (3 muettes)']);
  });

  it('master ou piste inconnue : pas de menu', () => {
    expect(soloMuteMenu(session(), 'master', 'solo')).toEqual([]);
    expect(soloMuteMenu(session(), 'nope', 'mute')).toEqual([]);
  });
});
