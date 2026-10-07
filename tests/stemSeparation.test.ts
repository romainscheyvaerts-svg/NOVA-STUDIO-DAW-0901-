// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStemTracks, bufferChannels, clipSeparationBlocker, describeStemsError, insertStemTracks,
  installProgressLabel, stemTrackName, stemsAvailability, STEM_SETS, STEMS_TOOLTIP, STEMS_INSTALL_LABEL,
} from '../services/StemSeparation';
import { encodeType2Frame, novaBridge, StemsError } from '../services/NovaBridge';
import { TrackType } from '../types';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeTrack } from './helpers/fixtures';

describe('séparation de stems : logique', () => {
  it('nomme les pistes en français', () => {
    expect(STEM_SETS[4].map(stemTrackName)).toEqual(['Voix (stem)', 'Batterie (stem)', 'Basse (stem)', 'Autres (stem)']);
    expect(STEM_SETS[2].map(stemTrackName)).toEqual(['Voix (stem)', 'Instru (stem)']);
    expect(STEMS_TOOLTIP).toMatch(/Stem Splitter dans Logic/);
    expect(STEMS_TOOLTIP).toMatch(/FL Studio/);
    expect(STEMS_INSTALL_LABEL).toBe('Installer la séparation de stems (~2 Go, une fois)');
  });

  it('refuse les clips MIDI, vides ou trop courts', () => {
    expect(clipSeparationBlocker(makeClip({ type: TrackType.MIDI }), true)).toMatch(/MIDI/);
    expect(clipSeparationBlocker(makeClip({ type: TrackType.AUDIO }), false)).toMatch(/pas encore chargé/);
    expect(clipSeparationBlocker(makeClip({ type: TrackType.AUDIO, duration: 0.2 }), true)).toMatch(/trop court/);
    expect(clipSeparationBlocker(makeClip({ type: TrackType.AUDIO, duration: 30 }), true)).toBeNull();
  });

  it('dit si ça marche ici : web, appli à connecter, appli à mettre à jour, prêt', () => {
    expect(stemsAvailability({ status: 'idle' }, false)).toBe('web');
    expect(stemsAvailability({ status: 'unavailable' }, true)).toBe('connect');
    expect(stemsAvailability({ status: 'connected', stems: false }, true)).toBe('update');
    expect(stemsAvailability({ status: 'connected', stems: true }, true)).toBe('ok');
  });

  it('cale les stems exactement sur le clip d’origine (début, découpe, fondus, gain)', () => {
    const clip = makeClip({ id: 'c1', name: 'Beat', type: TrackType.AUDIO, start: 12.5, offset: 3.25, duration: 40,
      fadeIn: 0.1, fadeOut: 2, gain: 0.8, isReversed: false, fadeOutCurve: 'S_CURVE' as any });
    const track = makeTrack({ id: 'beat', outputTrackId: 'bus-1' });
    const tracks = buildStemTracks({ track, clip }, [{ key: 'vocals', bufferId: 'b-v' }, { key: 'instrumental', bufferId: 'b-i' }], 'u1');
    expect(tracks.map(t => t.name)).toEqual(['Voix (stem)', 'Instru (stem)']);
    for (const t of tracks) {
      expect(t.type).toBe(TrackType.AUDIO);
      expect(t.outputTrackId).toBe('bus-1');
      const c = t.clips[0];
      expect([c.start, c.offset, c.duration, c.fadeIn, c.fadeOut, c.gain]).toEqual([12.5, 3.25, 40, 0.1, 2, 0.8]);
      expect(c.fadeOutCurve).toBe('S_CURVE');
      expect(c.isMuted).toBe(false);
    }
    expect(tracks[0].clips[0].bufferId).toBe('b-v');
    expect(new Set(tracks.map(t => t.id)).size).toBe(2);
  });

  it('pose les pistes sous la piste du clip et coupe le clip d’origine', () => {
    const clip = makeClip({ id: 'c1', type: TrackType.AUDIO });
    const state = { tracks: [makeTrack({ id: 'a' }), makeTrack({ id: 'beat', clips: [clip] }), makeTrack({ id: 'z' })], selectedTrackId: 'a' };
    const stems = buildStemTracks({ track: state.tracks[1], clip }, STEM_SETS[4].map(k => ({ key: k, bufferId: k })), 'u2');
    expect(insertStemTracks(state, 'beat', 'c1', stems)).toBe(true);
    expect(state.tracks.map(t => t.id.startsWith('track-stem') ? t.name : t.id))
      .toEqual(['a', 'beat', 'Voix (stem)', 'Batterie (stem)', 'Basse (stem)', 'Autres (stem)', 'z']);
    expect(state.tracks[1].clips[0].isMuted).toBe(true);
    expect(state.selectedTrackId).toBe(stems[0].id);
    // Clip supprimé pendant le calcul : rien n'est posé.
    expect(insertStemTracks(state, 'beat', 'disparu', stems)).toBe(false);
  });

  it('prend 1 ou 2 canaux du buffer', () => {
    expect(bufferChannels(makeBuffer(1, 100, 44100) as any)).toHaveLength(1);
    expect(bufferChannels(makeBuffer(2, 100, 44100) as any)).toHaveLength(2);
  });

  it('formule les erreurs clairement', () => {
    expect(describeStemsError(new StemsError('x', 'cancelled'))).toBe('Séparation annulée.');
    expect(describeStemsError(new StemsError('x', 'not_installed'))).toMatch(/pas encore installée/);
    expect(describeStemsError(new Error('Pont VST non connecté'))).toMatch(/relance Nova Studio/);
    expect(describeStemsError(new Error('Pas assez de mémoire'))).toBe('Pas assez de mémoire');
    expect(installProgressLabel({ pct: 42.4, message: 'Téléchargement de PyTorch CPU' })).toBe('Téléchargement de PyTorch CPU · 42 %');
  });
});

// --- Protocole du pont (v8) avec un faux WebSocket ------------------------------------

class FakeWS {
  static last: FakeWS | null = null;
  static OPEN = 1;
  readyState = 1;
  binaryType = 'blob';
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(data: any) {
    this.sent.push(data);
    if (typeof data === 'string') {
      const m = JSON.parse(data);
      if (m.action === 'HELLO') this.reply({ action: 'HELLO', req_id: m.req_id, success: true, version: 8, stems: true });
      else if (m.action === 'GET_PLUGIN_LIST') this.reply({ action: m.action, req_id: m.req_id, success: true, plugins: [] });
      else if (m.action === 'STEMS_STATUS') this.reply({ action: m.action, req_id: m.req_id, success: true, installed: false, installing: false, install: null });
    }
  }
  reply(obj: any) { setTimeout(() => this.onmessage?.({ data: JSON.stringify(obj) }), 0); }
  binary(buf: ArrayBuffer) { this.onmessage?.({ data: buf }); }
  close() { this.onclose?.(); }
}

function parseFrame(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const jlen = dv.getUint32(4, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jlen)));
}

describe('séparation de stems : protocole du pont', () => {
  const realWS = (globalThis as any).WebSocket;
  const realWorker = (globalThis as any).Worker;
  beforeEach(() => {
    (globalThis as any).WebSocket = FakeWS as any;
    // Worker audio temps réel du pont : inutile ici (jsdom n'en a pas).
    (globalThis as any).Worker = class { postMessage() { /* */ } terminate() { /* */ } };
  });
  afterEach(() => { novaBridge.disconnect(); (globalThis as any).WebSocket = realWS; (globalThis as any).Worker = realWorker; });

  it('envoie le clip, suit la progression et rassemble les stems', async () => {
    expect(await novaBridge.connect()).toBe(true);
    expect(novaBridge.getBridgeState().stems).toBe(true);
    expect((await novaBridge.stemsStatus()).installed).toBe(false);

    const events: any[] = [];
    const off = novaBridge.onStemsEvent(e => events.push(e));
    const left = new Float32Array([0.1, 0.2, 0.3]);
    const right = new Float32Array([-0.1, -0.2, -0.3]);
    const p = novaBridge.separateStems({ jobId: 'job-1', channels: [left, right], sampleRate: 44100, stems: 2, project: 'Mon son', clip: 'Beat' });
    const ws = FakeWS.last!;
    const sent = ws.sent.find(x => x instanceof ArrayBuffer) as ArrayBuffer;
    const meta = parseFrame(sent);
    expect(meta).toMatchObject({ action: 'STEMS_SEPARATE', job_id: 'job-1', stems: 2, nch: 2, nframes: 3, sample_rate: 44100, clip: 'Beat' });

    ws.onmessage!({ data: JSON.stringify({ action: 'STEMS_EVENT', kind: 'separate', job_id: 'job-1', event: 'progress', pct: 50, message: 'Séparation en cours' }) });
    for (const [i, key] of ['vocals', 'instrumental'].entries()) {
      ws.binary(encodeType2Frame(JSON.stringify({ action: 'STEMS_STEM', req_id: meta.req_id, job_id: 'job-1', key, label: key === 'vocals' ? 'Voix' : 'Instru',
        index: i, count: 2, nch: 2, nframes: 3, sample_rate: 44100, path: `C:/x/${key}.wav` }), [left, right]));
    }
    ws.binary(encodeType2Frame(JSON.stringify({ action: 'STEMS_SEPARATE', req_id: meta.req_id, success: true, seconds: 1.5, device: 'cpu', outdir: 'C:/x' }), []));
    const res = await p;
    off();
    expect(events[0]).toMatchObject({ kind: 'separate', jobId: 'job-1', pct: 50 });
    expect(res.stems.map(s => s.key)).toEqual(['vocals', 'instrumental']);
    expect(Array.from(res.stems[1].channels[1])).toEqual(Array.from(right));
    expect(res.device).toBe('cpu');
  });

  it('rejette avec un code clair (module absent, annulé)', async () => {
    expect(await novaBridge.connect()).toBe(true);
    const ws = FakeWS.last!;
    for (const code of ['not_installed', 'cancelled'] as const) {
      const p = novaBridge.separateStems({ jobId: `j-${code}`, channels: [new Float32Array(4)], sampleRate: 44100, stems: 4 });
      const meta = parseFrame(ws.sent.filter(x => x instanceof ArrayBuffer).pop());
      ws.binary(encodeType2Frame(JSON.stringify({ action: 'STEMS_SEPARATE', req_id: meta.req_id, success: false, error: 'non', code }), []));
      await expect(p).rejects.toMatchObject({ code });
    }
  });

  it('sans pont : erreur « unavailable » (message web)', async () => {
    await expect(novaBridge.stemsStatus()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
