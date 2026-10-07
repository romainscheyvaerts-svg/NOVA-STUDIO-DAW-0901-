/**
 * Essai RÉEL : plugins UAD (UADx) chargés et réglés par le pont VST.
 *   NOVA_BRIDGE_LIVE=1 npx vitest run tests/live/uadBridge
 */
import { describe, expect, it } from 'vitest';
import { LiveBridge } from './bridgeClient';

const LIVE = process.env.NOVA_BRIDGE_LIVE === '1';
const DIR = 'C:/Program Files/Common Files/VST3/';
const UAD = ['uaudio_176', 'uaudio_teletronix_la-2a_gray', 'uaudio_distressor', 'uaudio_pure_plate'];

describe.skipIf(!LIVE)('UAD via le pont (réel)', () => {
  it('chargés, réglés, relus, et le son passe', async () => {
    const b = new LiveBridge();
    await b.open();
    const rapport: any[] = [];
    try {
      for (const nom of UAD) {
        const slot = `uad-${nom}`;
        const t0 = Date.now();
        await b.request({ action: 'LOAD_PLUGIN', slot_id: slot, path: `${DIR}${nom}.vst3`, sample_rate: 48000 }, 180000);
        const ligne: any = { plugin: nom, chargement_ms: Date.now() - t0 };
        if (nom === 'uaudio_176' || nom === 'uaudio_distressor') {
          const set = await b.request({ action: 'SET_PARAMS', slot_id: slot, params: [{ name: 'ratio', text: '2:1' }] });
          ligne.ratio_relu = set.results?.[0]?.text;
        }
        const sine = new Float32Array(48000); for (let i = 0; i < sine.length; i++) sine[i] = 0.25 * Math.sin(2 * Math.PI * 220 * i / 48000);
        const [l] = await b.render(slot, sine, 48000, 0.5);
        ligne.niveau_sortie = Math.max(...Array.from(l.subarray(4800, 48000)).map(Math.abs));
        rapport.push(ligne);
        await b.request({ action: 'UNLOAD_PLUGIN', slot_id: slot }).catch(() => {});
      }
    } finally { b.close(); }
    console.log(JSON.stringify(rapport, null, 1));
    for (const r of rapport) expect(r.niveau_sortie).toBeGreaterThan(0.01);
    for (const r of rapport.filter(x => x.ratio_relu !== undefined)) expect(String(r.ratio_relu)).toMatch(/^2(\.0+)?(:1)?/);
  }, 900000);
});
