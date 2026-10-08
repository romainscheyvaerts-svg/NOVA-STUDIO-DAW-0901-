import { describe, expect, it, vi } from 'vitest';

/**
 * Justesse (V19) en collaboration : le clip corrigé voyage comme un clip audio
 * normal (son corrigé envoyé, champs du clip passés tels quels). La prise
 * d'origine reste chez celui qui a corrigé ; chez l'autre, l'éditeur repart
 * du son corrigé et « revenir à l'original » n'est simplement pas proposé.
 */
vi.mock('../services/supabase', () => ({ catalogSupabase: { channel: () => ({}), removeChannel: async () => 'ok' } }));
vi.mock('../services/SessionCloud', () => ({ call: async () => ({}), sha1: async () => 'hash', CHUNK: 1024 * 1024 }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { contentBufferIds, contentOf } from '../services/Collab';
import { editingSource, revertClipPatch } from '../utils/pitchEdit';
import { makeClip, makeTrack } from './helpers/fixtures';

describe('clip corrigé en collaboration', () => {
  const corrected = makeClip({
    id: 'c1', name: 'Prise 1 (justesse)', bufferId: 'justesse-c1-1', start: 4, offset: 0.25, duration: 2,
    pitchEdit: { version: 1, sourceBufferId: 'rec-1', regionStart: 0.75, edits: [{ t0: 1, t1: 1.4, shift: -0.4, drift: 0, vibrato: 1 }], amount: 1, style: 'naturel' },
  });
  const voice = makeTrack({ id: 'track-rec-main', name: 'Voix', clips: [corrected] });

  it('le son envoyé est le son corrigé, et la prise d’origine (l’autre peut revenir à l’original)', () => {
    // Collaboration pro : la prise d'origine voyage aussi (déjà en ligne la plupart du temps :
    // c'était la prise, ses morceaux ne repartent pas), sinon l'ingé qui corrige laisse
    // l'artiste sans « revenir à l'original ».
    expect(contentBufferIds(voice)).toEqual(['justesse-c1-1', 'rec-1']);
  });

  it('le clip voyage avec ses champs (position, nom, justesse)', () => {
    const wire = contentOf(voice) as any;
    const c = wire.clips[0];
    expect(c).toMatchObject({ id: 'c1', bufferId: 'justesse-c1-1', start: 4, offset: 0.25, duration: 2, name: 'Prise 1 (justesse)' });
    expect(c.pitchEdit.edits).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(wire)).clips[0].pitchEdit.regionStart).toBe(0.75);
  });

  it('chez l’autre (sans la prise d’origine) : retouche depuis le son corrigé, pas de retour à l’original', () => {
    const remoteHas = (id: string) => id === 'justesse-c1-1';
    expect(editingSource(corrected, remoteHas)).toEqual({ bufferId: 'justesse-c1-1', offset: 0.25, fromOriginal: false });
    expect(revertClipPatch(corrected, remoteHas)).toBeNull();
  });
});
