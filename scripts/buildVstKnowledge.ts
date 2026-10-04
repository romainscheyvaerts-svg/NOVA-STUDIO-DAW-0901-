/**
 * Génère data/vst-knowledge/plugins.json à partir de l'introspection RÉELLE des
 * plugins de ce PC (D:\1 WORK\CONTENU\nova-autotune\scripts\introspect_all.py :
 * un fichier JSON par plugin, paramètres lus par le pont, aucune fenêtre visible).
 *
 *   npx vite-node scripts/buildVstKnowledge.ts [dossier_introspection]
 *
 * Pour chaque plugin : catégorie et type de compresseur (utils/vstKnowledge.ts),
 * rôles des paramètres (seuil, ratio, mix…) avec leurs plages et valeurs texte, bandes
 * d'égaliseur, latence, statut (ok / fenêtre de licence-démo / ne se charge pas).
 * Seuls des paramètres réellement lus sont écrits : aucun nom inventé.
 */
import fs from 'fs';
import path from 'path';
import { classifyPlugin, CATEGORY_ROLES, paramRoles } from '../utils/vstKnowledge';
import { toVstParams, VstParam } from '../utils/autotuneVst';
import { eqBands } from '../utils/mixPlanner';

const DIR = process.argv[2] || 'D:/1 WORK/CONTENU/nova-autotune/introspection';
const OUT = path.resolve(__dirname, '../data/vst-knowledge/plugins.json');

interface Raw { path: string; plugin_name?: string | null; ok?: boolean; name?: string; vendor?: string; latency?: number; params?: any[]; windows?: string[]; error?: string; retry?: boolean }

const index: Record<string, { name: string; vendor?: string; path: string; plugin_name?: string | null; status: string }> =
  JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));

const slim = (p: VstParam) => {
  const o: any = { name: p.name, text: p.text };
  if (p.displayName && p.displayName !== p.name) o.displayName = p.displayName;
  if (p.range && p.range.some(x => x !== null)) o.range = p.range;
  if (p.values && p.values.length && p.values.length <= 40) o.values = p.values;
  if (p.isBoolean) o.isBoolean = true;
  return o;
};

const entries: any[] = [];
const seen = new Set<string>();
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  let raw: Raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; } // lecture interrompue
  const idx = index[f.replace('.json', '')];
  const scanName = idx?.name || path.basename(raw.path).replace(/\.vst3$/i, '');
  const name = raw.name || scanName;
  const vendor = raw.vendor || idx?.vendor || '';
  const dedupe = `${name.toLowerCase()}|${vendor.toLowerCase()}`;
  const params = toVstParams(raw.params || []);
  const cls = classifyPlugin(name, vendor, params);
  const status = raw.ok ? (raw.windows && raw.windows.length ? 'window' : 'ok') : 'error';
  const e: any = {
    key: `${raw.path}#${raw.plugin_name || scanName}`, scanName, name, vendor, path: raw.path, pluginName: raw.plugin_name || null,
    category: cls.category, ...(cls.compType ? { compType: cls.compType } : {}), classifiedBy: cls.by,
    status, ...(status !== 'ok' ? { reason: status === 'window' ? `fenêtre : ${raw.windows!.join(' | ').slice(0, 120)}` : String(raw.error || '').split('\n')[0].slice(0, 160) } : {}),
    latency: raw.latency ?? null, paramCount: params.length,
  };
  if (raw.ok) {
    const cat = cls.category === 'channel-strip' ? 'compressor' : cls.category;
    const roles = paramRoles(cat, params);
    e.roles = roles;
    const keep = new Set<string>(Object.values(roles) as string[]);
    if (cls.category === 'eq' || eqBands(params).length) {
      const bands = eqBands(params);
      e.bands = bands.length;
      for (const b of bands.slice(0, 8)) for (const p of [b.used, b.enabled, b.freq, b.gain, b.q, b.shape]) if (p) keep.add(p.name);
    }
    e.params = params.filter(p => keep.has(p.name)).map(slim);
    void CATEGORY_ROLES;
  }
  if (seen.has(dedupe) && raw.ok) continue; // même plugin à deux endroits
  seen.add(dedupe);
  entries.push(e);
}
entries.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  source: 'introspection réelle du pont VST (pedalboard) sur le PC du studio',
  plugins: entries,
}, null, 1));
// Extrait figé pour les tests unitaires (tests/mixPlanner.test.ts) : quelques plugins réels.
const SAMPLE = [/^Pro-Q 4$/, /Pro-C 3$/, /Pro-DS$/, /^Decapitator$/, /^Tube-Tech CL 1B/, /^Comp VCA-65$/, /^ValhallaVintageVerb$/, /^ValhallaDelay$/, /^EchoBoy$/, /Saturn 2$/, /^Comp DIODE-609$/, /^VerbSuite Classics$/, /^Bettermaker Bus Compressor/, /distressor/i, /Pro-L 2$/];
const sample = entries.filter(e => e.status === 'ok' && SAMPLE.some(re => re.test(e.name) || re.test(e.scanName)));
fs.writeFileSync(path.resolve(__dirname, '../tests/fixtures/vst-knowledge.sample.json'), JSON.stringify({ plugins: sample }, null, 1));
console.log(`extrait de test : ${sample.map(e => e.name).join(', ')}`);

const by: Record<string, number> = {};
for (const e of entries) by[`${e.category}${e.status === 'ok' ? '' : ' (non dispo)'}`] = (by[`${e.category}${e.status === 'ok' ? '' : ' (non dispo)'}`] || 0) + 1;
console.log(`${entries.length} plugins →`, OUT);
console.log(by);
