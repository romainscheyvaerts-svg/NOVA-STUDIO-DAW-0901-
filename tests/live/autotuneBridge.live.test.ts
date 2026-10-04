/**
 * Essai RÉEL de l'autotune du PC à travers le pont VST (pas lancé par npm test).
 *
 *   1. démarrer le pont depuis les sources : python bridge-python/nova_bridge_server.py
 *   2. NOVA_BRIDGE_LIVE=1 NOVA_PROOF_DIR="D:/1 WORK/CONTENU/nova-autotune" npx vitest run tests/live
 *
 * Inventaire des plugins, détection des autotunes, chargement, réglage de la gamme
 * par la logique de l'appli (resolveAutotuneSettings) puis RELECTURE des valeurs
 * texte, mesure de la latence (faible latence / qualité), et passage du micro simulé
 * dans le slot en temps réel (blocs de 128) : sorties WAV analysées ensuite par
 * scripts/autotune_proof_analyse.py.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { LiveBridge, readWavMono, writeWavMono } from './bridgeClient';
import {
  detectAutotunes, isExcluded, parseKeyText, readbackMatches, resolveAutotuneSettings, toVstParams, vendorOf,
} from '../../utils/autotuneVst';

const LIVE = process.env.NOVA_BRIDGE_LIVE === '1';
const OUT = process.env.NOVA_PROOF_DIR || path.resolve('qa-out/autotune');
const MIC = process.env.NOVA_MIC_WAV || 'D:/1 WORK/CONTENU/nova-promo-2026-10-04/micro_fake.wav';
const KEYS = ['F# minor', 'B harmonic minor', 'C major'];
const SR = 48000;

const log = (file: string, data: unknown) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), typeof data === 'string' ? data : JSON.stringify(data, null, 1), 'utf8');
};

describe.skipIf(!LIVE)('autotune du PC à travers le pont (réel)', () => {
  it('inventaire, détection, gamme relue, latence, audio', async () => {
    const b = new LiveBridge();
    await b.open();
    const hello = await b.request({ action: 'HELLO' });
    expect(hello.version).toBeGreaterThanOrEqual(7);
    expect(hello.params_text).toBe(true);

    const list = await b.request({ action: 'GET_PLUGIN_LIST' }, 300000);
    const plugins = (list.plugins as any[]).map(p => ({
      id: String(p.id), name: p.name, vendor: p.vendor || '', path: p.path, pluginName: p.plugin_name ?? null,
      category: p.category, isInstrument: p.is_instrument, license: p.license ?? null, scanStatus: p.scan_status ?? null,
    }));
    log('inventaire_vst_complet.json', plugins);
    const lines = plugins
      .map(p => `${p.isInstrument ? 'INSTRU' : 'EFFET '} | ${vendorOf(p) || '?'} | ${p.name}${isExcluded(p) ? '   [EXCLU : licence absente (liste d’exclusion)]' : ''}${p.license ? `   [licence : ${p.license}]` : ''}`)
      .sort((a, b) => a.localeCompare(b));
    log('inventaire_vst_complet.txt', `${plugins.length} plugins VST3 vus par le pont\n\n${lines.join('\n')}\n`);

    const cands = detectAutotunes(plugins);
    log('autotunes_detectes.json', cands);
    const names = cands.map(c => c.name);
    expect(names[0]).toMatch(/Auto-Tune Pro/);
    expect(names.some(n => /MetaTune/.test(n))).toBe(true);

    const report: any[] = [];
    const mic = readWavMono(MIC);
    expect(mic.sr).toBe(SR);
    const dry = mic.data.subarray(0, SR * 12);
    writeWavMono(path.join(OUT, 'micro_sec_12s.wav'), SR, dry);

    for (const c of cands.filter(x => /Auto-Tune Pro|MetaTune/.test(x.name))) {
      const slot = `live-${c.family}`;
      const t0 = Date.now();
      const loaded = await b.request({ action: 'LOAD_PLUGIN', slot_id: slot, path: c.path, plugin_name: c.pluginName, sample_rate: SR, quiet: true }, 900000);
      const entry: any = { plugin: c.name, vendor: c.vendor, load_ms: Date.now() - t0, latency_at_load: loaded.latency_samples, keys: [] };
      report.push(entry);
      const raw = (await b.request({ action: 'GET_PARAMS', slot_id: slot })).parameters;
      log(`params_${c.family}.json`, raw);
      const params = toVstParams(raw);

      for (const lowLatency of [false, true]) {
        // Latence : qualité maximale puis faible latence (réglage par défaut).
        const r = resolveAutotuneSettings(c.name, params, { root: 0, scale: 'MAJOR', speed: 0.1, humanize: 0.2, mix: 1, lowLatency });
        const ll = r.settings.filter(s => /latency/.test(s.name));
        if (ll.length) {
          const res = await b.request({ action: 'SET_PARAMS', slot_id: slot, params: ll });
          entry[lowLatency ? 'latency_low' : 'latency_quality'] = { plugin_samples: res.plugin_latency_after, stream_samples: res.latency_samples, readback: res.results };
        } else {
          entry[lowLatency ? 'latency_low' : 'latency_quality'] = { plugin_samples: loaded.latency_samples, note: 'pas de mode faible latence dans ce plugin' };
        }
      }

      for (const k of KEYS) {
        const key = parseKeyText(k)!;
        const style = { speed: 0, humanize: 0, mix: 1 }; // trap : correction la plus franche (mesure claire)
        const r = resolveAutotuneSettings(c.name, params, { root: key.root, scale: key.scale, ...style, lowLatency: true });
        const res = await b.request({ action: 'SET_PARAMS', slot_id: slot, params: r.settings });
        const back = toVstParams((await b.request({ action: 'GET_PARAMS', slot_id: slot, names: r.verify.map(v => v.name) })).parameters);
        const checks = r.verify.map(v => {
          const got = back.find(p => p.name === v.name)?.text ?? '';
          return { name: v.name, expect: v.expect, readback: got, ok: readbackMatches(v.expect, got) };
        });
        const t1 = Date.now();
        const { out, rttMs } = await b.streamThrough(slot, dry);
        const lat = (b.events.filter(e => e.action === 'LATENCY' && e.slot_id === slot).pop()?.latency_samples) ?? res.latency_samples ?? 0;
        const aligned = out.subarray(Math.min(lat, out.length));
        const file = `sortie_${c.family}_${k.replace(/[^a-z0-9]+/gi, '_')}.wav`;
        writeWavMono(path.join(OUT, file), SR, aligned);
        rttMs.sort((a, z) => a - z);
        entry.keys.push({
          key: k, parsed: key, keyMethod: r.keyMethod, approximated: r.approximated,
          settings: r.settings, set_results: res.results, checks, file, stream_latency_samples: lat,
          stream_seconds: (Date.now() - t1) / 1000,
          rtt_ms: { median: rttMs[Math.floor(rttMs.length / 2)], p95: rttMs[Math.floor(rttMs.length * 0.95)], max: rttMs[rttMs.length - 1] },
        });
        log('preuve_autotune_pont.json', report);
      }
      await b.request({ action: 'UNLOAD_PLUGIN', slot_id: slot });
    }
    log('evenements_pont.json', b.events);
    b.close();
    const failed = report.flatMap(e => e.keys.flatMap((k: any) => k.checks.filter((x: any) => !x.ok).map((x: any) => `${e.plugin} ${k.key} ${x.name}`)));
    expect(failed).toEqual([]);
  }, 1800000);
});
