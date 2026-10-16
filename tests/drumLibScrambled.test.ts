import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRUM_LIBRARY, libUrl } from '../utils/drumLibrary';
import { makeDrumMachineLib } from '../utils/drumKits';
import { libContainerUrl, loadDrumSound } from '../utils/drumSounds';
import { openKitContainer } from '../utils/drumKitCodec';

/**
 * Batterie du studio brouillée comme les kits (16/10/2026) : plus aucun WAV lisible servi, et les
 * projets existants (références « url:/drums/lib/<id>.wav ») se rechargent sans migration.
 */
const LIB = path.resolve(__dirname, '..', 'public', 'drums', 'lib');
const ids = [...new Set(Object.values(DRUM_LIBRARY).flatMap(c => Object.values(c).flat() as string[]))];

describe('batterie du studio : servie brouillée', () => {
  it('chaque son de la bibliothèque existe en conteneur .nks, aucun .wav ne reste', () => {
    const files = readdirSync(LIB);
    expect(files.filter(f => /\.wav$/i.test(f))).toEqual([]);
    for (const id of ids) expect(existsSync(path.join(LIB, `${id}.nks`)), id).toBe(true);
    expect(files.filter(f => f.endsWith('.nks')).length).toBe(ids.length);
  });

  it('les fichiers servis ne sont ni des WAV ni des FLAC lisibles ; déchiffrés, ce sont les WAV d’origine', async () => {
    for (const id of ids) {
      const blob = readFileSync(path.join(LIB, `${id}.nks`));
      expect(blob.subarray(0, 4).toString('latin1'), id).toBe('NVK1');
      expect(blob.includes(Buffer.from('RIFF')) && blob.indexOf('RIFF') < 64, id).toBe(false);
      const raw = new Uint8Array(await openKitContainer(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)));
      expect(Buffer.from(raw.subarray(0, 4)).toString('latin1'), id).toBe('RIFF');
      expect(Buffer.from(raw.subarray(8, 12)).toString('latin1'), id).toBe('WAVE');
    }
  });
});

describe('compatibilité des projets existants (aucune migration)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('les références gardent leur forme d’origine ; le chargeur les traduit vers le conteneur', () => {
    expect(libUrl('kick-31742016')).toBe('url:/drums/lib/kick-31742016.wav');
    expect(libContainerUrl('url:/drums/lib/kick-31742016.wav')).toBe('/drums/lib/kick-31742016.nks');
    expect(libContainerUrl('url:/drums/lib/kick-31742016.nks')).toBe('/drums/lib/kick-31742016.nks');
    expect(libContainerUrl('url:/samples/mon-son.wav')).toBeNull();
    expect(libContainerUrl('synth:kick-punch')).toBeNull();
    // Une batterie « Trap » d'avant le 16/10 : références .wav, inchangées.
    const dm = makeDrumMachineLib('trap');
    expect(dm.rows.some(r => /^url:\/drums\/lib\/[a-z]+-[0-9a-f]{8}\.wav$/.test(r.sound))).toBe(true);
  });

  it('un ancien projet (référence .wav) se recharge : on télécharge le .nks, jamais le .wav, et on décode le WAV d’origine', async () => {
    const id = ids[0];
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      const m = /^\/drums\/lib\/([a-z]+-[0-9a-f]{8}\.nks)$/.exec(url);
      if (!m || !existsSync(path.join(LIB, m[1]))) return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
      const b = readFileSync(path.join(LIB, m[1]));
      return new Response(b, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });
    const decoded: string[] = [];
    const ctx = {
      sampleRate: 48000,
      decodeAudioData: async (b: ArrayBuffer) => {
        decoded.push(Buffer.from(new Uint8Array(b).subarray(0, 4)).toString('latin1'));
        const d = Float32Array.from([0.5, -0.25, 0.1]);
        return { numberOfChannels: 1, length: 3, sampleRate: 48000, duration: 3 / 48000, getChannelData: () => d } as unknown as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    const buf = await loadDrumSound(`url:/drums/lib/${id}.wav`, ctx);
    expect(asked).toEqual([`/drums/lib/${id}.nks`]);
    expect(asked.some(u => u.endsWith('.wav'))).toBe(false);
    expect(decoded).toEqual(['RIFF']);
    expect(buf.numberOfChannels).toBe(1);
  });
});
