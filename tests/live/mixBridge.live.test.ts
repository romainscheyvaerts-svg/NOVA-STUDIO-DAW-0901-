/**
 * Essai RÉEL du mix piloté par Nova sur les plugins tiers du PC (pas lancé par npm test).
 *
 *   pont lancé depuis les sources (python bridge-python/nova_bridge_server.py), puis
 *   NOVA_BRIDGE_LIVE=1 NOVA_PROOF_DIR="D:/1 WORK/CONTENU/nova-autotune/mix" npx vitest run tests/live/mixBridge
 *
 * Pour chaque intention (« un mix neutre », « mix spatial et saturé avec beaucoup de
 * delay », « rends ma voix plus pro ») : plan du planificateur de l'appli sur les
 * plugins réellement installés (base data/vst-knowledge + liste du pont), chargement
 * discret de chaque plugin, réglages envoyés puis RELUS, rendu du micro simulé à travers
 * la chaîne voix → compresseur du bus voix, + retours reverb / délai dosés par les envois.
 * Sorties WAV et JSON ; mesures ebur128 / crêtes / queue / distorsion par
 * scripts/mix_proof_analyse.py (dans le dossier de preuves).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { LiveBridge, readWavMono } from './bridgeClient';
import { isExcluded, toVstParams } from '../../utils/autotuneVst';
import { parseMixIntent, describeIntent } from '../../utils/mixStyles';
import { estimateLoudDb, KnownPlugin, planVoiceMix, PlannedVst } from '../../utils/mixPlanner';
import { paramRoles } from '../../utils/vstKnowledge';

const LIVE = process.env.NOVA_BRIDGE_LIVE === '1';
const OUT = process.env.NOVA_PROOF_DIR || path.resolve('qa-out/mix');
const MIC = process.env.NOVA_MIC_WAV || 'D:/1 WORK/CONTENU/nova-promo-2026-10-04/micro_fake.wav';
const SR = 48000;
const INTENTS = (process.env.NOVA_INTENTS || 'un mix neutre|je veux un mix spatial et saturé avec beaucoup de delay|rends ma voix plus pro').split('|');

const writeWavStereo = (file: string, l: Float32Array, r: Float32Array) => {
  const n = l.length;
  const b = Buffer.alloc(44 + n * 8);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { b.writeFloatLE(l[i], 44 + i * 8); b.writeFloatLE(r[i], 48 + i * 8); }
  fs.writeFileSync(file, b);
};

const mono = (l: Float32Array, r: Float32Array) => { const m = new Float32Array(l.length); for (let i = 0; i < l.length; i++) m[i] = 0.5 * (l[i] + r[i]); return m; };

describe.skipIf(!LIVE)('mix Nova sur les VST du PC (réel)', () => {
  it('3 intentions : chaîne, réglages relus, rendus', async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const kb = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/vst-knowledge/plugins.json'), 'utf8')).plugins as any[];
    const b = new LiveBridge();
    await b.open();
    const list = (await b.request({ action: 'GET_PLUGIN_LIST' }, 300000)).plugins as any[];
    const onPc = new Set(list.map(p => `${p.path}#${p.plugin_name || p.name}`.toLowerCase()));
    const installed: KnownPlugin[] = kb
      .filter(e => e.status === 'ok' && !isExcluded({ name: e.name, vendor: e.vendor, path: e.path }) && (onPc.has(e.key.toLowerCase()) || /waveshell/i.test(e.path)))
      .map(e => ({ key: e.key, name: e.name, vendor: e.vendor, path: e.path, pluginName: e.pluginName, category: e.category, compType: e.compType, params: toVstParams(e.params || []), latency: e.latency, unavailable: null }));
    const dryAll = readWavMono(MIC).data;
    const dry = dryAll.subarray(0, SR * 12);
    writeWavStereo(path.join(OUT, 'sec.wav'), dry, dry);
    const loud = estimateLoudDb(dry, SR)!;
    const report: any[] = [];
    let k = 0;
    for (const text of INTENTS) {
      const intent = parseMixIntent(text);
      const plan = planVoiceMix({
        installed, dims: intent.dims, tweakOnly: intent.tweakOnly, tuneSpeed: intent.tuneSpeed, loudDb: loud, bpm: 120,
        voice: { id: 'voix', name: 'VOIX', plugins: [] }, bus: { id: 'bus-vox', name: 'BUS VOX', plugins: [] },
        sendTracks: [{ id: 'send-verb-short', name: 'VERB PRO', plugins: [] }, { id: 'send-verb-long', name: 'HALL SPACE', plugins: [] }, { id: 'send-delay', name: 'DELAY 1/4', plugins: [] }],
      });
      const entry: any = { demande: text, styles: describeIntent(intent), niveau_fort_db: loud, resume: plan.summary, avertissements: plan.warnings, chaines: [], erreurs: [] };
      // Charge + règle + relit chaque plugin du plan.
      const loadAndSet = async (v: PlannedVst, slot: string) => {
        const t0 = Date.now();
        const r = await b.request({ action: 'LOAD_PLUGIN', slot_id: slot, path: v.plugin.path, plugin_name: v.plugin.pluginName, sample_rate: SR, quiet: true }, 300000);
        const set = await b.request({ action: 'SET_PARAMS', slot_id: slot, params: v.settings.map(({ name, text, real }) => ({ name, text, real })) }, 120000);
        const ratioName = v.slot.startsWith('comp') ? paramRoles('compressor', v.plugin.params).ratio : undefined;
        return {
          emplacement: v.slot, plugin: v.plugin.name, editeur: v.plugin.vendor, chargement_ms: Date.now() - t0, latence_ech: set.latency_samples ?? r.latency_samples,
          dit: v.says, releve: set.results.map((x: any) => ({ param: x.name, valeur: x.text, ok: x.ok })),
          ratio_relu: ratioName ? set.results.find((x: any) => x.name === ratioName)?.text : undefined,
        };
      };
      const slots: string[] = [];
      try {
        const voice = plan.tracks[0];
        let l = dry, r = dry;
        for (const v of voice.vst) {
          const slot = `mix${k}-${v.slot}`; slots.push(slot);
          entry.chaines.push({ piste: 'voix', ...(await loadAndSet(v, slot)) });
          [l, r] = await b.render(slot, mono(l, r), SR, 0);
        }
        const bus = plan.tracks.find(t => t.trackId === 'bus-vox');
        for (const v of bus?.vst || []) {
          const slot = `mix${k}-bus-${v.slot}`; slots.push(slot);
          entry.chaines.push({ piste: 'bus voix', ...(await loadAndSet(v, slot)) });
          [l, r] = await b.render(slot, mono(l, r), SR, 0);
        }
        entry.builtin = plan.tracks.flatMap(t => t.builtin.map(x => ({ piste: t.trackName, effet_nova: x.type, pourquoi: x.reason })));
        // Retours : signal de la voix (après chaîne) → plugin 100 % mouillé → dosé par l'envoi.
        const TAIL = 4;
        const outL = new Float32Array(l.length + TAIL * SR); const outR = new Float32Array(l.length + TAIL * SR);
        outL.set(l); outR.set(r);
        for (const t of plan.tracks.filter(x => x.trackId.startsWith('send-'))) {
          const send = plan.sends.find(s => s.sendId === t.trackId)?.level ?? 0;
          for (const v of t.vst) {
            if (send <= 0) continue;
            const slot = `mix${k}-${t.trackId}`; slots.push(slot);
            entry.chaines.push({ piste: t.trackName, envoi: send, ...(await loadAndSet(v, slot)) });
            const [wl, wr] = await b.render(slot, mono(l, r), SR, TAIL);
            for (let i = 0; i < Math.min(wl.length, outL.length); i++) { outL[i] += send * wl[i]; outR[i] += send * wr[i]; }
          }
        }
        entry.envois = plan.sends;
        const file = `mix_${k}_${text.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.wav`;
        writeWavStereo(path.join(OUT, file), outL, outR);
        entry.fichier = file;
        // Saturation : distorsion mesurée sur un sinus 1 kHz à −12 dBFS.
        const sat = voice.vst.find(v => v.slot === 'sat');
        if (sat) {
          const sine = new Float32Array(SR); for (let i = 0; i < SR; i++) sine[i] = 0.25 * Math.sin(2 * Math.PI * 1000 * i / SR);
          const [sl] = await b.render(`mix${k}-sat`, sine, SR, 0);
          writeWavStereo(path.join(OUT, `sinus_sat_${k}.wav`), sl, sl);
          entry.sinus_saturation = `sinus_sat_${k}.wav`;
        }
      } catch (e: any) {
        entry.erreurs.push(String(e?.message || e));
      } finally {
        for (const s of slots) await b.request({ action: 'UNLOAD_PLUGIN', slot_id: s }).catch(() => null);
      }
      report.push(entry);
      fs.writeFileSync(path.join(OUT, 'preuve_mix.json'), JSON.stringify(report, null, 1));
      k++;
    }
    fs.writeFileSync(path.join(OUT, 'evenements_pont.json'), JSON.stringify(b.events, null, 1));
    b.close();
    // Règle maison : tout compresseur posé sur la voix / le bus voix est relu en 2:1.
    const ratios = report.flatMap(e => e.chaines.filter((c: any) => c.emplacement?.startsWith('comp')).map((c: any) => c.ratio_relu));
    for (const r of ratios) expect(Number((String(r).match(/\d+(\.\d+)?/) || ['NaN'])[0])).toBe(2);
    expect(report.every(e => e.erreurs.length === 0)).toBe(true);
  }, 3600000);
});
