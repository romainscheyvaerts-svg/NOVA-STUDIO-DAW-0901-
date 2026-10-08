// @vitest-environment jsdom
/**
 * Sauvegarde du projet (.zip NOVA) : la structure Pro Tools survit à l'aller-retour
 * (pistes masquées / inactives, dossiers, VCA, envois a-j avec pan et mute, bus
 * nommés, effets bypass / inactifs).
 */
import { describe, expect, it, vi } from 'vitest';
import { ProjectIO } from '../services/ProjectIO';
import { PluginInstance, Track, TrackType } from '../types';
import { makeState, makeTrack } from './helpers/fixtures';
import { createBus, createFolder, createVca, engineView, pluginState, setTrackInputBus } from '../utils/trackStructure';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

const fx = (id: string, extra: Partial<PluginInstance> = {}): PluginInstance => ({ id, name: id, type: 'COMPRESSOR', isEnabled: true, params: {}, latency: 0, ...extra });
const T = (id: string, extra: Partial<Track> = {}): Track => makeTrack({ id, name: id.toUpperCase(), sends: [], ...extra });

describe('ProjectIO : structure Pro Tools gardée', () => {
  it('save → load : masqué, inactif, dossiers, VCA, envois, bus, états des effets', async () => {
    let tracks: Track[] = [
      T('lead', { plugins: [fx('tune', { isEnabled: false }), fx('sat', { isInactive: true })], sends: [{ id: 'rv', level: 0.3, isEnabled: true, pan: 0.5, isMuted: true, slot: 4 }] }),
      T('backb', { isHidden: true, isInactive: true }),
      T('rv', { type: TrackType.SEND }),
      T('master', { type: TrackType.BUS, outputTrackId: '' }),
    ];
    tracks = createFolder(tracks, { id: 'vox', name: 'VOX', kind: 'routing', childIds: ['lead', 'backb'] });
    tracks = createVca(tracks, { id: 'vca', name: 'PRE ALL VOX', memberIds: ['lead'] });
    const b = createBus(tracks, 'RV');
    tracks = setTrackInputBus(b.tracks, 'rv', b.bus.id);
    const loaded = await ProjectIO.loadProject(new File([await ProjectIO.saveProject(makeState(tracks), [])], 'p.zip'));
    const by = new Map(loaded.tracks.map(t => [t.id, t]));
    expect(by.get('lead')!.plugins.map(pluginState)).toEqual(['bypass', 'inactive']);
    expect(by.get('lead')!.sends[0]).toMatchObject({ pan: 0.5, isMuted: true, slot: 4 });
    expect(by.get('backb')).toMatchObject({ isHidden: true, isInactive: true, parentFolderId: 'vox' });
    expect(by.get('vox')!.folder?.kind).toBe('routing');
    expect(by.get('vca')!.isVca).toBe(true);
    expect(by.get('lead')!.vcaId).toBe('vca');
    expect(by.get('master')!.ioBuses).toEqual([{ id: 'bus:rv', name: 'RV' }]);
    expect(by.get('rv')!.inputBusId).toBe('bus:rv');
    expect(engineView(loaded.tracks).excluded).toEqual(new Set(['backb', 'vca']));
  });
});
