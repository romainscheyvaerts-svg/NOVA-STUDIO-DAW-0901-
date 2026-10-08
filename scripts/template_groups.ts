/**
 * R12 · Groupes Pro Tools d'une fiche (« groups », VCA « group ») reportés dans
 * le modèle livré, SANS le reconstruire (le modèle a été relu sur le pont VST :
 * on ne touche qu'aux groupes, aux champs groupId / groupIds des pistes et au
 * vcaGroupId des VCA).
 *
 * Usage : npx vite-node scripts/template_groups.ts templates/specs/romain-lennon-depart.spec.json templates/romain-lennon-depart.novatemplate
 */
import fs from 'fs';
import { groupNameKey, groupsFromSpec, syncGroupFields } from '../utils/editGroups';
import type { Track } from '../types';

const [specPath, tplPath] = process.argv.slice(2);
if (!specPath || !tplPath) { console.error('usage : template_groups.ts <fiche.spec.json> <modele.novatemplate>'); process.exit(1); }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
const raw = fs.readFileSync(tplPath, 'utf-8');
const crlf = raw.includes('\r\n');
const tpl = JSON.parse(raw);
const tracks = tpl.session.tracks as Track[];
const byName = (n: string) => tracks.find(t => groupNameKey(t.name) === groupNameKey(n) && !(t.folder?.kind === 'basic'))?.id;
const groups = groupsFromSpec(spec.groups, byName);
const missing: string[] = [];
for (const g of spec.groups || []) for (const m of g.members || []) if (!byName(m)) missing.push(`${g.name} › ${m}`);
let synced = syncGroupFields(tracks, groups).map(t => {
  if (!t.isVca) return t;
  const st = (spec.tracks as any[]).find(x => x.kind === 'vca' && groupNameKey(x.name) === groupNameKey(t.name));
  const g = st?.group ? groups.find(x => groupNameKey(x.name) === groupNameKey(st.group)) : undefined;
  const n = { ...t };
  if (g) n.vcaGroupId = g.id; else delete n.vcaGroupId;
  return n;
});
tpl.session.tracks = synced;
tpl.session.trackGroups = groups;
const out = JSON.stringify(tpl, null, 2);
fs.writeFileSync(tplPath, (crlf ? out.replace(/\n/g, '\r\n') : out) + (crlf ? '\r\n' : '\n'));
console.log(`${groups.length} groupes : ${groups.map(g => `${g.name} (${g.trackIds.length})`).join(', ')}`);
console.log(`VCA liés : ${synced.filter(t => t.isVca && t.vcaGroupId).map(t => `${t.name.trim()} → ${groups.find(g => g.id === t.vcaGroupId)?.name}`).join(', ')}`);
if (missing.length) console.log(`Introuvables : ${missing.join(', ')}`);
synced = [];
