import type { MelodicSamplerSettings, SamplerZone } from './melodicSampler';

/**
 * R20 · Instruments multi-échantillons NOVA (Live : Sampler, Logic : Sampler,
 * FL : DirectWave) joués par le sampler mélodique : zones de notes et de
 * vélocité, round-robin, relâchement. Les sons sont des fichiers du site
 * (`public/instruments/<id>/`, Ogg Opus mono), téléchargés à la demande
 * seulement quand on choisit l'instrument ; jamais dans le bundle.
 *
 * Licences : seulement du domaine public ou du CC0, vérifié et noté dans
 * CONTENU/nova-r18/LICENCES_ECHANTILLONS.md (et dans chaque manifeste).
 */

export interface InstrumentPreset {
  id: string;
  name: string;
  emoji: string;
  /** Catégorie du sélecteur (comme le navigateur de Live). */
  category: 'Claviers' | 'Guitares' | 'Cordes' | 'Cloches' | 'Nappes';
  hint: string;
  /** Réglages du sampler pour cet instrument (enveloppe, mono…). */
  settings: Partial<MelodicSamplerSettings>;
}

export const INSTRUMENT_PRESETS: InstrumentPreset[] = [
  { id: 'piano', name: 'Piano', emoji: '🎹', category: 'Claviers', hint: 'Piano à queue, plusieurs couches de vélocité : joue doucement, il s\'adoucit.',
    settings: { attack: 0.002, decay: 1, sustain: 1, release: 0.45, velSens: 0.85 } },
  { id: 'rhodes', name: 'Rhodes', emoji: '🎛️', category: 'Claviers', hint: 'Piano électrique façon Rhodes : R&B, néo-soul, lo-fi.',
    settings: { attack: 0.002, decay: 1, sustain: 1, release: 0.35, velSens: 0.8 } },
  { id: 'guitare', name: 'Guitare', emoji: '🎸', category: 'Guitares', hint: 'Guitare acoustique en notes pincées : afro, pop, drill mélodique.',
    settings: { attack: 0.002, decay: 1, sustain: 1, release: 0.3, velSens: 0.75 } },
  { id: 'cordes', name: 'Cordes', emoji: '🎻', category: 'Cordes', hint: 'Cordes tenues (boucle) : nappes de drill, intros cinématiques.',
    settings: { attack: 0.12, decay: 1, sustain: 1, release: 0.6, velSens: 0.6 } },
  { id: 'cloches', name: 'Cloches', emoji: '🔔', category: 'Cloches', hint: 'Cloches et glockenspiel : mélodies trap / plugg.',
    settings: { attack: 0.001, decay: 1, sustain: 1, release: 0.8, velSens: 0.7 } },
  { id: 'pad', name: 'Nappe', emoji: '🌫️', category: 'Nappes', hint: 'Nappe douce qui tient (boucle) : fond d\'accords.',
    settings: { attack: 0.35, decay: 1, sustain: 1, release: 1.2, velSens: 0.4 } },
];

export const instrumentPreset = (id?: string) => INSTRUMENT_PRESETS.find(p => p.id === id);

export interface InstrumentManifest {
  id: string;
  name: string;
  version?: number;
  license?: string;
  source?: string;
  release?: number;
  zones: SamplerZone[];
}

const baseUrl = (): string => {
  try { return (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/'; } catch { return '/'; }
};
export const instrumentBaseUrl = (id: string) => `${baseUrl()}instruments/${id}/`;

const manifests = new Map<string, Promise<InstrumentManifest>>();

/** Manifeste d'un instrument (zones, licence), chargé une fois. */
export function loadInstrumentManifest(id: string): Promise<InstrumentManifest> {
  let p = manifests.get(id);
  if (!p) {
    p = fetch(`${instrumentBaseUrl(id)}manifest.json`).then(r => {
      if (!r.ok) throw new Error(`Instrument « ${id} » introuvable (${r.status})`);
      return r.json();
    }).then((m: InstrumentManifest) => ({ ...m, zones: (m.zones || []).filter(z => z && typeof z.file === 'string' && /^[\w.-]+$/.test(z.file)) }));
    manifests.set(id, p);
    p.catch(() => manifests.delete(id));
  }
  return p;
}

/** Réglages du sampler pour un instrument choisi (le relâchement du manifeste s'il en donne un). */
export function settingsForInstrument(id: string, manifestRelease?: number): Partial<MelodicSamplerSettings> {
  const p = instrumentPreset(id);
  return {
    ...(p?.settings || {}), instrument: id, sampleName: p?.name || id,
    ...(typeof manifestRelease === 'number' ? { release: manifestRelease } : {}),
    loop: false, mono: false, glide: 0, slices: undefined, sliceBase: undefined,
  };
}
