import { describe, expect, it } from 'vitest';
import { checkBeatCall, keyFromText, parseBeatCommand } from '../utils/beatChat';
import { KNOWN_ACTIONS, planChatCalls } from '../utils/chatTools';
import { parseLocalCommand } from '../utils/novaCommands';
import { makeState, makeTrack } from './helpers/fixtures';

const st = makeState([makeTrack({ id: 'track-rec-main', name: 'REC' })]);

describe('chatbot : Démarrer un beat et Prolonger / Varier (lot 10)', () => {
  it('tonalité lue dans une phrase', () => {
    expect(keyFromText('en fa mineur')).toEqual({ root: 5, mode: 'minor' });
    expect(keyFromText('en F#m')).toEqual({ root: 6, mode: 'minor' });
    expect(keyFromText('beat en sol')).toEqual({ root: 7, mode: null });
    expect(keyFromText('la majeur')).toEqual({ root: 9, mode: 'major' });
    expect(keyFromText('en mi bémol majeur')).toEqual({ root: 3, mode: 'major' });
    expect(keyFromText('en effet c’est bien')).toBeNull();
  });

  it('phrases comprises sans IA', () => {
    const a = parseBeatCommand('Démarre un beat drill fr en fa mineur')!;
    expect(a.actions[0]).toMatchObject({ action: 'START_BEAT', payload: { genre: 'drill-fr', root: 5, mode: 'minor' } });
    expect(parseBeatCommand('lance une prod')!.actions[0]).toMatchObject({ action: 'RUN_COMMAND', payload: { id: 'pal.startBeat' } });
    expect(parseBeatCommand('prolonge le clip de 8 mesures')!.actions[0]).toMatchObject({ action: 'VARY_MIDI', payload: { mode: 'prolonger', bars: 8 } });
    expect(parseBeatCommand('varie la mélodie en inversion')!.actions[0]).toMatchObject({ action: 'VARY_MIDI', payload: { mode: 'varier', rule: 'inversion' } });
    expect(parseBeatCommand('monte la voix')).toBeNull();
    expect(parseLocalCommand('fais un beat trap', st)?.actions[0].action).toBe('START_BEAT');
  });

  it('validation : genre et règle vérifiés, payload normalisé', () => {
    for (const a of ['START_BEAT', 'VARY_MIDI']) expect(KNOWN_ACTIONS.has(a)).toBe(true);
    const p: any = { genre: 'Boom Bap', key: 'ré mineur' };
    expect(checkBeatCall('START_BEAT', p, st)).toMatchObject({ ok: true });
    expect(p).toMatchObject({ genre: 'boombap', root: 2, mode: 'minor' });
    expect(checkBeatCall('START_BEAT', { genre: 'valse' }, st).ok).toBe(false);
    const v: any = { mode: 'extend', rule: 'Déplacement', bars: 3 };
    expect(checkBeatCall('VARY_MIDI', v, st).ok).toBe(true);
    expect(v).toMatchObject({ mode: 'prolonger', rule: 'deplacement', bars: 4 });
    const plan = planChatCalls([
      { action: 'START_BEAT', payload: { genre: 'afro' } },
      { action: 'VARY_MIDI', payload: { mode: 'varier', rule: 'rythme' } },
      { action: 'START_BEAT', payload: { genre: 'polka' } },
    ], { state: st, commands: [] } as any);
    expect(plan.run.map(c => c.label)).toEqual(['Squelette Afro : batterie, accords et 808 (règles, sans IA)', 'Variation « rythme » du clip MIDI']);
    expect(plan.rejected.length).toBe(1);
  });
});
