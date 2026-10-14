import { describe, expect, it } from 'vitest';
import { runVoiceChatAction, lufsOfSource } from '../utils/voiceChatActions';
import { planChatCalls, KNOWN_ACTIONS } from '../utils/chatTools';
import { TrackType, type DAWState, type Track } from '../types';

const t = (over: Partial<Track> = {}): Track => ({
  id: 'lead', name: 'Lead', type: TrackType.AUDIO, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...over,
} as Track);
const all = [t(), t({ id: 'send-delay', name: 'Écho', type: TrackType.SEND }), t({ id: 'send-verb-short', name: 'Réverbe', type: TrackType.SEND })];

describe('chat (Nova ingé son) : chaîne voix', () => {
  it('DESCRIBE_SOUND applique la phrase et rend un compte rendu', () => {
    const r = runVoiceChatAction('DESCRIBE_SOUND', { text: 'trap, plus brillante, un peu d’écho' }, all[0], { allTracks: all });
    expect(r.track?.voiceChain?.presetId).toBe('trap-lead');
    expect(r.message).toMatch(/Brillance 60 %/);
  });
  it('APPLY_VOICE_PRESET et ONE_KNOB', () => {
    const a = runVoiceChatAction('APPLY_VOICE_PRESET', { preset: 'Drill lead' }, all[0], { allTracks: all });
    expect(a.track?.voiceChain?.presetId).toBe('drill-lead');
    const b = runVoiceChatAction('ONE_KNOB', { macro: 'Présence', amount: 40 }, a.track!, { allTracks: all });
    expect(b.track?.voiceChain?.amounts?.presence).toBeCloseTo(0.4);
    expect(runVoiceChatAction('ONE_KNOB', { macro: 'volume', amount: 1 }, all[0], { allTracks: all }).track).toBeNull();
    expect(runVoiceChatAction('APPLY_VOICE_PRESET', { preset: 'inexistant' }, all[0], { allTracks: all }).track).toBeNull();
    // Règle maison : FET 76 / Leveler 2A sur un bus, jamais sur une piste.
    expect(runVoiceChatAction('APPLY_VOICE_PRESET', { preset: 'bus-voix-maison' }, all[0], { allTracks: all }).message).toMatch(/bus voix, pas sur une piste/);
    const bus = t({ id: 'bv', name: 'Bus voix', type: TrackType.BUS });
    const rb = runVoiceChatAction('APPLY_VOICE_PRESET', { preset: 'bus-voix-maison' }, bus, { allTracks: [...all, bus] });
    expect(rb.track?.plugins.map(p => p.type)).toEqual(['FET76', 'LEVELER2A']);
  });
  it('validation du chat : actions connues, piste obligatoire, preset et macro vérifiés', () => {
    for (const a of ['DESCRIBE_SOUND', 'APPLY_VOICE_PRESET', 'ONE_KNOB']) expect(KNOWN_ACTIONS.has(a)).toBe(true);
    const ctx = { state: { tracks: all } as unknown as DAWState, commands: [] };
    const plan = planChatCalls([
      { action: 'DESCRIBE_SOUND', payload: { trackId: 'Lead', text: 'plus chaude' } },
      { action: 'APPLY_VOICE_PRESET', payload: { trackId: 'Lead', preset: 'rnb-doux-lead' } },
      { action: 'ONE_KNOB', payload: { trackId: 'Lead', macro: 'espace', amount: 30 } },
      { action: 'DESCRIBE_SOUND', payload: { text: 'plus chaude' } },
      { action: 'APPLY_VOICE_PRESET', payload: { trackId: 'Lead', preset: 'licorne' } },
    ], ctx as any);
    expect(plan.run.map(c => c.label)).toEqual([
      'Décris ton son sur Lead : preset « Trap lead » · Chaleur 60 %',
      'Preset voix « R&B doux » posé sur Lead',
      'One Knob de Lead : Espace 30 %',
    ]);
    expect(plan.rejected.map(r => r.reason)).toEqual(['aucune piste indiquée', 'preset voix « licorne » inconnu']);
  });
  it('niveau d’une source du moteur (mono)', () => {
    const x = new Float32Array(48000).map((_, i) => 0.1 * Math.sin(i / 7));
    expect(lufsOfSource({ channels: [x, x], sampleRate: 48000 })).toBeLessThan(-10);
    expect(lufsOfSource(null)).toBeNull();
  });
});
