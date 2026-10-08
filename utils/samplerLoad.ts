import { audioBufferRegistry } from './audioBufferRegistry';
import { MelodicSamplerSettings, samplerBufferKey, sampleZones, SamplerZone } from './melodicSampler';
import { instrumentBaseUrl, loadInstrumentManifest } from './instrumentPresets';
import type { LoadedZone } from '../engine/MelodicSamplerNode';

/**
 * Côté navigateur : sons prêts à jouer d'un sampler (R18) ou d'un instrument
 * multi-échantillons (R20). Les fichiers d'un instrument sont téléchargés à
 * la demande (jamais dans le bundle), décodés une seule fois et gardés en
 * cache ; un AudioBuffer se joue aussi dans le contexte de l'export.
 */

const decoded = new Map<string, Promise<AudioBuffer>>();

function decodeUrl(url: string, ctx: BaseAudioContext): Promise<AudioBuffer> {
  let p = decoded.get(url);
  if (!p) {
    p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`son introuvable (${r.status})`);
      return r.arrayBuffer();
    }).then(data => ctx.decodeAudioData(data));
    decoded.set(url, p);
    p.catch(() => decoded.delete(url));
  }
  return p;
}

/** Empreinte de ce qui change les sons chargés (pas l'enveloppe ni le filtre). */
export const samplerSoundSig = (s: MelodicSamplerSettings | undefined): string => !s ? '' : JSON.stringify([
  s.instrument || '', s.sampleId || '', s.rootKey, s.fineTune, s.start || 0,
  s.loop ? [s.loopStart, s.loopEnd] : 0, s.slices || 0, s.sliceBase ?? 0,
]);

/** Zones prêtes à jouer. Sample perso absent du registre (pas encore reçu) : aucune zone. */
export async function loadSamplerZones(s: MelodicSamplerSettings, ctx: BaseAudioContext): Promise<LoadedZone[]> {
  if (s.instrument) {
    const m = await loadInstrumentManifest(s.instrument);
    const base = instrumentBaseUrl(s.instrument);
    const zones = await Promise.all(m.zones.map(async (z: SamplerZone) => {
      try { return { ...z, buffer: await decodeUrl(base + z.file, ctx) }; } catch { return null; }
    }));
    return zones.filter(Boolean) as LoadedZone[];
  }
  if (s.sampleId) {
    const buffer = audioBufferRegistry.get(samplerBufferKey(s.sampleId));
    if (!buffer) return [];
    return sampleZones(s, buffer.duration).map(z => ({ ...z, buffer }));
  }
  return [];
}

/** Préchauffe un instrument (pré-écoute dans le sélecteur). */
export function preloadInstrument(id: string, ctx: BaseAudioContext): Promise<unknown> {
  return loadSamplerZones({ instrument: id } as MelodicSamplerSettings, ctx).catch(() => []);
}
