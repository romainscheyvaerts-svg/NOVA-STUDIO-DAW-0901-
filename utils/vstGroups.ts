import type { BridgePlugin } from '../services/NovaBridge';

/**
 * Liste de l'onglet VST : un plugin = une ligne (module pur : tests/vstGroups.test.ts).
 *
 * Un shell Waves déplie chaque plugin en plusieurs variantes (« C6 Mono », « C6 Stereo »,
 * « RVerb Mono/Stereo », « H-Reverb 5.1 ») : 734 entrées pour ~260 plugins. Les variantes d'un
 * même plugin sont regroupées sur une ligne ; un clic pose la variante stéréo, les autres restent
 * proposées en petits boutons.
 */
export interface VstRow {
  /** Clé de la ligne (id du plugin, ou éditeur + nom du plugin). */
  key: string;
  /** Nom affiché (« C6 »). */
  name: string;
  /** Variante posée par un clic sur la ligne. */
  main: BridgePlugin;
  /** Toutes les variantes, stéréo d'abord (vide : plugin sans variante). */
  variants: BridgePlugin[];
}

const FMT = '(?:mono|stereo|quad|lcr|lcrs|\\d\\.\\d(?:\\.\\d)?)';
const FORMAT_SUFFIX = new RegExp(`\\s+${FMT}(?:\\s*/\\s*${FMT})?$`, 'i');

/** Nom du plugin sans son format de canaux : « C6 Stereo » → « C6 », « H-Reverb Mono/5.1 » → « H-Reverb ». */
export const vstFamily = (name: string): string => (name || '').replace(FORMAT_SUFFIX, '').trim() || name;

const RANK: Record<string, number> = { stereo: 0, 'mono/stereo': 1, mono: 2 };
const rankOf = (p: BridgePlugin, fam: string) => RANK[p.name.slice(fam.length).trim().toLowerCase()] ?? 3;

/** Libellé court d'une variante : « Stéréo », « Mono → stéréo », « Mono », « 5.1 »… */
export function variantLabel(p: BridgePlugin, family: string): string {
  const rest = (p.name.startsWith(family) ? p.name.slice(family.length) : p.name).trim();
  const low = rest.toLowerCase();
  if (low === 'stereo') return 'Stéréo';
  if (low === 'mono') return 'Mono';
  if (low === 'mono/stereo') return 'Mono → stéréo';
  return rest.replace(/\bStereo\b/g, 'stéréo') || p.name;
}

export function groupVstPlugins(plugins: BridgePlugin[]): VstRow[] {
  const rows: VstRow[] = [];
  const byFamily = new Map<string, VstRow>();
  for (const p of plugins) {
    if (!p.shell) {
      rows.push({ key: p.id, name: p.name, main: p, variants: [] });
      continue;
    }
    const fam = vstFamily(p.name);
    // Même plugin dans deux shells (versions Waves) ou en plusieurs formats : une seule ligne.
    const k = `${(p.vendor || '').toLowerCase()}|${p.category === 'Instrument' ? 'i' : 'e'}|${fam.toLowerCase()}`;
    const row = byFamily.get(k);
    if (row) { row.variants.push(p); continue; }
    const fresh: VstRow = { key: `fam:${k}`, name: fam, main: p, variants: [p] };
    byFamily.set(k, fresh);
    rows.push(fresh);
  }
  for (const row of byFamily.values()) {
    row.variants.sort((a, b) => rankOf(a, row.name) - rankOf(b, row.name) || a.name.localeCompare(b.name));
    row.main = row.variants[0];
    if (row.variants.length === 1) row.variants = []; // une seule variante : rien à choisir
  }
  return rows;
}
