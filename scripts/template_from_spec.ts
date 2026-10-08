/**
 * Fiche de session (JSON « nova-template-spec ») → modèle NOVA (.novatemplate),
 * CONTRÔLÉ sur le pont VST du PC : chaque plugin est chargé discrètement (aucune
 * fenêtre), chaque réglage est envoyé PUIS RELU, l'état complet du plugin est
 * capturé dans le modèle, et un rapport dit ce qui a été appliqué ou non.
 *
 * Usage (depuis le dossier de NOVA) :
 *   npx vite-node scripts/template_from_spec.ts -- <fiche.json> [options]
 * Options :
 *   --out <fichier.novatemplate>   modèle produit (défaut : templates/<nom>.novatemplate)
 *   --report <fichier>             rapport (.md ; un .json est écrit à côté)
 *   --id <id>                      identifiant du modèle (garde le même id d'une génération à l'autre)
 *   --activate-all                 active tous les effets (y compris ceux désactivés dans Pro Tools)
 *   --port <n>                     port du pont (défaut : NOVA_BRIDGE_PORT ou 8765)
 *   --no-bridge                    sans le pont : résolution par la base de connaissance seulement
 *   --no-state                     ne pas capturer l'état binaire des plugins
 *   --skip <a,b>                   plugins à ne pas charger (connus pour faire planter le pont)
 *   --timeout <s>                  délai max de chargement d'un plugin (défaut 180 s)
 *   --dump-params <fichier.json>   écrit les réglages réels (nom, plage, valeurs) de chaque plugin chargé
 *   --compare <ancien rapport.json> ajoute un tableau avant / après par plugin
 *
 * Si le pont s'arrête pendant un chargement (plugin qui plante), le plugin est
 * noté « fait planter le pont », le script attend que le pont redémarre (un
 * superviseur doit le relancer) et passe au suivant.
 *
 * Pièges connus : Pro-C 3 n'accepte que ses textes exacts (« 2.00:1 ») ; le pont
 * prend alors la valeur la plus proche de la liste. Un plugin qui demande une
 * licence est fermé par le pont (chargement discret) et signalé.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTemplateFromSpec, KnownParam, KnowledgeEntry, TemplateSpec,
} from '../utils/templateSpec';
import { matchParam, ParamMatchHow, settingFor, unexposedReason } from '../utils/vstParamAlias';
import { serializeTemplate, templateSlug } from '../utils/sessionTemplate';
import { compact, VstCandidate } from '../utils/vstMatch';

// ─── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2).filter(a => a !== '--');
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const specPath = argv.find((a, i) => !a.startsWith('--') && !['--out', '--report', '--id', '--port', '--skip', '--timeout', '--dump-params', '--compare'].includes(argv[i - 1]));
if (!specPath) {
  console.error('Usage : npx vite-node scripts/template_from_spec.ts -- <fiche.json> [--out f] [--report f] [--activate-all] [--port n] [--no-bridge]');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(opt('--port') || process.env.NOVA_BRIDGE_PORT || 8765);
const SKIP = (opt('--skip') || '').split(',').map(x => compact(x)).filter(Boolean);
const LOAD_TIMEOUT = Number(opt('--timeout') || 180) * 1000;

// ─── Petit client du pont (WebSocket JSON, réponses par req_id) ────────────────

class Bridge {
  private ws!: WebSocket;
  url = '';
  get open() { return !!this.ws && this.ws.readyState === 1; }
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  async connect(url: string, timeoutMs = 5000) {
    this.url = url;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error(`Pont VST injoignable (${url})`)); }, timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error(`Pont VST injoignable (${url})`)); };
      ws.onclose = () => {
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Le pont s’est arrêté'), { bridgeDown: true })); this.pending.delete(id); }
      };
      ws.onmessage = ev => {
        if (typeof ev.data !== 'string') return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const p = msg.req_id !== undefined ? this.pending.get(msg.req_id) : undefined;
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.req_id);
        if (msg.success === false || msg.error) {
          const e = new Error(msg.error || 'Échec') as Error & { licenseRequired?: boolean; unstable?: boolean };
          e.licenseRequired = !!msg.license_required;
          e.unstable = !!msg.unstable;
          p.reject(e);
        } else p.resolve(msg);
      };
      this.ws = ws;
    });
  }
  request(msg: Record<string, any>, timeoutMs = 30000): Promise<any> {
    const req_id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req_id); reject(new Error(`Le pont ne répond pas (${msg.action})`)); }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...msg, req_id }));
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
  /** Attend que le pont réponde de nouveau (relancé par un superviseur). */
  async reconnect(maxMs = 180000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try { await this.connect(this.url, 4000); await this.request({ action: 'HELLO' }, 5000); return true; } catch { await new Promise(r => setTimeout(r, 3000)); }
    }
    return false;
  }
}

// ─── Comparaison réglage demandé / relu ───────────────────────────────────────

const num = (s: unknown): number | null => {
  const m = String(s ?? '').replace(',', '.').match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

type Verdict = 'appliqué' | 'proche' | 'refusé' | 'introuvable' | 'non contrôlé' | 'non exposé';

const verdictOf = (sent: { text?: string; real?: number }, ok: boolean, readText: string): Verdict => {
  if (!ok) return 'refusé';
  if (sent.text !== undefined) {
    if (compact(sent.text) === compact(readText)) return 'appliqué';
    // Unité affichée en plus (« -Inf » / « -Inf dB », « 8 kHz » / « 8000 Hz » : nombre comparé plus bas).
    const noUnit = (x: string) => compact(x.replace(/\s*(db|dbfs|hz|khz|ms|s|%|deg|cents?)\s*$/i, ''));
    if (noUnit(sent.text) === noUnit(readText)) return 'appliqué';
    if (/inf/i.test(sent.text) && /inf/i.test(readText) && /^-/.test(sent.text.trim()) === /^-/.test(readText.trim())) return 'appliqué';
    const a = num(sent.text); const b = num(readText);
    // Le plugin peut afficher en kHz ce qu'on a envoyé en Hz (« 1500.0 » relu « 1.5 kHz »).
    const near = (x: number, y: number) => Math.abs(x - y) <= Math.max(0.02 * Math.abs(x), 0.05);
    if (a !== null && b !== null && (near(a, b) || near(a, b * 1000) || near(a, b / 1000))) return 'appliqué';
    // Interrupteurs : « On » demandé, « True » / « Enabled » relu.
    if (/^(on|true|oui|enabled|used)$/i.test(sent.text) && /^(on|true|enabled|used|active)$/i.test(readText.trim())) return 'appliqué';
    if (/^(off|false|non|disabled)$/i.test(sent.text) && /^(off|false|disabled|not bypassed|inactive)$/i.test(readText.trim())) return 'appliqué';
    return 'proche';
  }
  const b = num(readText);
  if (sent.real !== undefined && b !== null) {
    // Le texte relu peut être dans une autre unité d'affichage (kHz) : on compare aussi ×1000.
    const close = (x: number) => Math.abs(sent.real! - x) <= Math.max(0.02 * Math.abs(sent.real!), 0.05);
    if (close(b) || close(b * 1000) || close(b / 1000)) return 'appliqué';
  }
  return 'proche';
};

// ─── Programme ────────────────────────────────────────────────────────────────

const main = async () => {
  const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf-8')) as TemplateSpec;
  const kbFile = path.join(ROOT, 'data', 'vst-knowledge', 'plugins.json');
  const knowledge: KnowledgeEntry[] = fs.existsSync(kbFile) ? (JSON.parse(fs.readFileSync(kbFile, 'utf-8')).plugins || []) : [];

  let bridge: Bridge | null = null;
  let plugins: VstCandidate[] | undefined;
  let bridgeInfo = 'non utilisé (--no-bridge)';
  if (!flag('--no-bridge')) {
    const b = new Bridge();
    try {
      await b.connect(`ws://127.0.0.1:${PORT}`);
      const hello = await b.request({ action: 'HELLO' }, 5000);
      const list = await b.request({ action: 'GET_PLUGIN_LIST', rescan: false }, 60000);
      plugins = (list.plugins || []).map((p: any) => ({
        name: p.name, vendor: p.vendor || '', path: p.path, pluginName: p.plugin_name ?? null,
        isInstrument: typeof p.is_instrument === 'boolean' ? p.is_instrument : null,
        unavailable: p.license === 'activation' || p.scan_status === 'crash' || p.scan_status === 'hang' || !!p.unstable,
      }));
      bridge = b;
      bridgeInfo = `connecté (port ${PORT}, version ${hello.version ?? '?'}, ${plugins!.length} plugins)`;
      if (!hello.params_text && Number(hello.version) < 7) throw new Error('Pont trop ancien (version 7 requise pour les réglages en texte)');
    } catch (e: any) {
      bridgeInfo = `indisponible : ${e?.message || e}`;
      b.close();
      bridge = null;
      plugins = undefined;
    }
  }

  const { template, report } = buildTemplateFromSpec(spec, { plugins, knowledge, activateAll: flag('--activate-all'), id: opt('--id') });

  const dumped: Record<string, { path: string; pluginName: string | null; params: KnownParam[] }> = {};
  /** absent : pas sur ce PC ; licence ; instable ; remplacement : remplaçant d'un plugin absent ; chargé. */
  type LineKind = 'chargé' | 'absent' | 'licence' | 'instable' | 'remplacement' | 'exclu' | 'nova' | 'erreur';
  interface Line { track: string; plugin: string; loaded: string; kind: LineKind; replacement?: { from: string; to: string; kind: string; inactive: boolean; note: string }; params: { asked: string; value: string; key: string | null; how?: ParamMatchHow; sent?: any; read?: string; verdict: Verdict; error?: string }[]; state: boolean }
  const lines: Line[] = [];
  let slot = 0;
  for (const ins of report.inserts) {
    const tr = template.session.tracks.find(t => t.plugins.some(p => p.id === ins.pluginId))!;
    const pl = tr.plugins.find(p => p.id === ins.pluginId)!;
    if (ins.builtin && ins.replacement) {
      lines.push({ track: ins.track, plugin: `${ins.plugin} → ${ins.replacement.to}`, loaded: `${ins.plugin} manquant : remplacé par ${ins.replacement.to}${ins.replacement.inactive ? ' (laissé inactif)' : ''} — ${ins.replacement.note}`, kind: 'remplacement', replacement: ins.replacement, params: [], state: false });
      continue;
    }
    if (ins.builtin) { lines.push({ track: ins.track, plugin: `${ins.plugin} (effet NOVA)`, loaded: 'effet intégré', kind: 'nova', params: [], state: false }); continue; }
    const line: Line = { track: ins.track, plugin: ins.plugin + (ins.match && ins.match.plugin.name !== ins.plugin ? ` → ${ins.match.plugin.name}` : ''), loaded: '', kind: ins.replacement ? 'remplacement' : 'chargé', ...(ins.replacement ? { replacement: ins.replacement } : {}), params: [], state: false };
    lines.push(line);
    if (ins.excluded) { line.loaded = 'exclu (règle du studio)'; line.kind = 'exclu'; continue; }
    if (!ins.match) { line.loaded = 'absent de ce PC'; line.kind = 'absent'; line.params = ins.params.map(p => ({ asked: p.asked, value: p.value, key: p.key, verdict: 'introuvable' as Verdict })); continue; }
    if (SKIP.includes(compact(ins.plugin)) || SKIP.includes(compact(ins.match.plugin.name))) {
      line.loaded = `trouvé (${ins.match.kind}), non chargé : fait planter le pont (--skip)`;
      line.kind = 'instable';
      line.params = ins.params.map(p => ({ asked: p.asked, value: p.value, key: p.key, verdict: 'non contrôlé' as Verdict }));
      continue;
    }
    if (bridge && !bridge.open && !(await bridge.reconnect())) bridge = null;
    if (!bridge) { line.loaded = `trouvé (${ins.match.kind}), non contrôlé : pont absent`; line.params = ins.params.map(p => ({ asked: p.asked, value: p.value, key: p.key, verdict: 'non contrôlé' as Verdict })); continue; }
    const slotId = `tplcheck-${process.pid}-${++slot}`;
    try {
      const res = await bridge.request({
        action: 'LOAD_PLUGIN', slot_id: slotId, path: ins.match.plugin.path, plugin_name: ins.match.plugin.pluginName || null,
        sample_rate: 48000, state: pl.params.stateB64 || null, quiet: true,
      }, LOAD_TIMEOUT);
      line.loaded = ins.replacement
        ? `${ins.plugin} manquant : remplacé par ${res.name || ins.match.plugin.name}${ins.replacement.inactive ? ' (laissé inactif)' : ''} — ${ins.replacement.note}`
        : `chargé : ${res.name || ins.match.plugin.name}${ins.match.note ? ` (${ins.match.note})` : ''}`;
      const live: KnownParam[] = ((await bridge.request({ action: 'GET_PARAMS', slot_id: slotId }, 120000)).parameters || []);
      const dumpKey = `${ins.match.plugin.name}`;
      if (!dumped[dumpKey]) dumped[dumpKey] = { path: ins.match.plugin.path, pluginName: ins.match.plugin.pluginName || null, params: live };
      const label = ins.match.plugin.pluginName || ins.match.plugin.name;
      const siblings: Record<string, string> = Object.fromEntries(ins.params.map(p => [p.asked, p.value]));
      type Item = { asked: string; value: string; key: string | null; how?: ParamMatchHow; setting?: { name: string; text?: string; real?: number }; extra: { name: string; text?: string; real?: number }[]; unexposed?: string | null };
      const items: Item[] = ins.params.map(p => {
        const m = matchParam(p.asked, live, label);
        if (!m) return { asked: p.asked, value: p.value, key: null, extra: [], unexposed: unexposedReason(p.asked, label) };
        const conv = (k: string) => settingFor(live.find(x => x.name === k), k, p.value, m.convert, siblings);
        return { asked: p.asked, value: p.value, key: m.key, how: m.how, setting: conv(m.key), extra: (m.also || []).map(conv) };
      });
      const toSend = items.flatMap(x => (x.setting ? [x.setting, ...x.extra] : []));
      const set = toSend.length ? await bridge.request({ action: 'SET_PARAMS', slot_id: slotId, params: toSend }, 120000) : { results: [] };
      const results: any[] = set.results || [];
      for (const it of items) {
        if (!it.setting && it.unexposed) { line.params.push({ asked: it.asked, value: it.value, key: null, verdict: 'non exposé', error: it.unexposed }); continue; }
        if (!it.setting) { line.params.push({ asked: it.asked, value: it.value, key: null, verdict: 'introuvable', error: 'réglage inconnu du plugin' }); continue; }
        const r = results.find(x => x.name === it.setting!.name);
        const read = String(r?.text ?? '');
        line.params.push({ asked: it.asked, value: it.value, key: it.setting.name, how: it.how, sent: it.setting, read, verdict: verdictOf(it.setting, !!r?.ok, read), ...(r?.error ? { error: r.error } : {}) });
      }
      // Modèle : réglages aux vraies clés du plugin (ceux qu'il a acceptés), état capturé.
      pl.params.novaSettings = items.filter(x => x.setting).flatMap(x => [x.setting!, ...x.extra]).filter(st => results.find(r => r.name === st.name)?.ok);
      if (!flag('--no-state')) {
        const st = await bridge.request({ action: 'GET_STATE', slot_id: slotId }, 60000).catch(() => null);
        if (st?.state) { pl.params.stateB64 = st.state; line.state = true; }
      }
    } catch (e: any) {
      line.kind = e?.licenseRequired || /n'est pas activé|licence/i.test(String(e?.message || '')) ? 'licence' : e?.unstable || e?.bridgeDown ? 'instable' : 'erreur';
      line.loaded = e?.licenseRequired ? 'licence ou démo : chargement refusé (fenêtre fermée par le pont)'
        : e?.unstable ? 'plugin instable sur le pont : isolé (essai dans un processus jetable), le pont continue'
          : e?.bridgeDown ? 'fait planter le pont (le pont s’est arrêté pendant le chargement)' : `chargement impossible : ${e?.message || e}`;
      line.params = ins.params.map(p => ({ asked: p.asked, value: p.value, key: p.key, verdict: 'introuvable' as Verdict }));
    } finally {
      if (bridge.open) await bridge.request({ action: 'UNLOAD_PLUGIN', slot_id: slotId }, 30000).catch(() => null);
      else if (!(await bridge.reconnect())) bridge = null;
    }
  }
  bridge?.close();
  if (opt('--dump-params')) fs.writeFileSync(path.resolve(opt('--dump-params')!), JSON.stringify(dumped, null, 1), 'utf-8');

  // ─── Sorties ─────────────────────────────────────────────────────────────────
  const out = path.resolve(opt('--out') || path.join(ROOT, 'templates', `${templateSlug(template.name)}.novatemplate`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, serializeTemplate(template) + '\n', 'utf-8');

  const count = (v: Verdict) => lines.reduce((n, l) => n + l.params.filter(p => p.verdict === v).length, 0);
  const md: string[] = [];
  md.push(`# Rapport : ${template.name}`, '');
  md.push(`- Fiche : ${path.resolve(specPath)}`, `- Modèle produit : ${out}`, `- Pont VST : ${bridgeInfo}`, `- Généré le ${new Date().toLocaleString('fr-BE')}`);
  md.push(`- Réglages : ${count('appliqué')} appliqués et relus, ${count('proche')} proches (valeur relue différente), ${count('refusé')} refusés, ${count('introuvable')} introuvables, ${count('non contrôlé')} non contrôlés (pont absent)`);
  // Réglages LISIBLES : ceux des plugins chargés (hors absents, licences, instables, remplaçants) ;
  // les potards estimés « ≈ » ne sont pas dans la fiche (readings) : jamais comptés.
  const loadedParams = lines.filter(l => l.kind === 'chargé').flatMap(l => l.params);
  const unexposed = loadedParams.filter(p => p.verdict === 'non exposé');
  const readable = loadedParams.filter(p => p.verdict !== 'non exposé');
  const ok = readable.filter(p => p.verdict === 'appliqué').length;
  const pct = readable.length ? Math.round((1000 * ok) / readable.length) / 10 : 0;
  const pctAll = loadedParams.length ? Math.round((1000 * ok) / loadedParams.length) / 10 : 0;
  md.push(`- Réglages lisibles (plugins chargés, hors absents / licences / instables / remplaçants) : ${ok} / ${readable.length} appliqués et relus identiques (${pct} %)`);
  md.push(`- Réglages lus mais non exposés en VST3 (mode d'affichage, programme, voyant ambigu… : voir la table d'alias) : ${unexposed.length} — en les comptant : ${ok} / ${loadedParams.length} (${pctAll} %)`);
  const repl = lines.filter(l => l.replacement);
  if (repl.length) md.push(`- Remplacements : ${repl.length} (${[...new Set(repl.map(l => `${l.replacement!.from} → ${l.replacement!.to}`))].join(' ; ')})`);
  md.push(`- Effets : ${flag('--activate-all') ? 'tous activés (--activate-all), sauf les remplaçants laissés inactifs' : 'actifs / inactifs comme dans la fiche'}`, '');
  const old = opt('--compare') && fs.existsSync(path.resolve(opt('--compare')!)) ? JSON.parse(fs.readFileSync(path.resolve(opt('--compare')!), 'utf-8')) : null;
  if (old?.lines) {
    // Avant / après, par plugin d'ORIGINE (nom de la fiche, sans « → … »).
    const base = (pl: string) => pl.split(' → ')[0].replace(/ \(effet NOVA\)$/, '');
    type Tally = { a: number; r: number; i: number; n: number; state: string };
    const tally = (ls: any[]) => {
      const m = new Map<string, Tally>();
      for (const l of ls) {
        const k = base(l.plugin);
        const t = m.get(k) || { a: 0, r: 0, i: 0, n: 0, state: '' };
        for (const p of l.params || []) { if (p.verdict === 'appliqué') t.a++; else if (p.verdict === 'refusé') t.r++; else if (p.verdict === 'introuvable') t.i++; else t.n++; }
        t.state = t.state || String(l.loaded || '').split(' :')[0].split(' (')[0].split(' — ')[0];
        m.set(k, t);
      }
      return m;
    };
    const A = tally(old.lines); const B = tally(lines);
    const tot = (m: Map<string, Tally>) => [...m.values()].reduce((x, t) => ({ a: x.a + t.a, r: x.r + t.r, i: x.i + t.i, n: x.n + t.n }), { a: 0, r: 0, i: 0, n: 0 });
    const ta = tot(A); const tb = tot(B);
    md.push('## Avant / après', '', `- Avant : ${ta.a} appliqués, ${ta.r} refusés, ${ta.i} introuvables, ${ta.n} non contrôlés.`, `- Après : ${tb.a} appliqués, ${tb.r} refusés, ${tb.i} introuvables, ${tb.n} non exposés en VST3 ou non contrôlés.`, '',
      '| Plugin | Avant (appl. / ref. / introuv.) | Après (appl. / ref. / introuv.) | État après |', '|---|---|---|---|');
    for (const k of [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x.localeCompare(y))) {
      const a = A.get(k); const b = B.get(k);
      const f = (t?: Tally) => (t ? `${t.a} / ${t.r} / ${t.i}${t.n ? ` (+${t.n} n.c.)` : ''}` : '—');
      md.push(`| ${k} | ${f(a)} | ${f(b)} | ${b?.state || '—'} |`);
    }
    md.push('');
  }
  if (report.warnings.length) { md.push('## Avertissements', ...report.warnings.map(w => `- ${w}`), ''); }
  md.push('## Règles de mix du studio', report.mixRules.length ? report.mixRules.map(w => `- ⚠️ ${w}`).join('\n') : '- ✅ Conforme (compression voix 2:1 sur deux étages de types différents, ni Slate hors MetaTune / VerbSuite Classics, ni SSL).', '');
  md.push('## Plugins et réglages');
  for (const l of lines) {
    md.push('', `### ${l.track} · ${l.plugin}`, `${l.loaded}${l.state ? ' · état capturé' : ''}`);
    if (l.params.length) {
      md.push('', '| Réglage | Demandé | Envoyé | Relu | Résultat |', '|---|---|---|---|---|');
      for (const p of l.params) md.push(`| ${p.asked}${p.key && p.key !== p.asked ? ` (\`${p.key}\`)` : ''} | ${p.value} | ${p.sent ? (p.sent.text ?? p.sent.real) : '—'} | ${p.read ?? '—'} | ${p.verdict}${p.error ? ` : ${p.error}` : ''} |`);
    }
  }
  const reportPath = path.resolve(opt('--report') || out.replace(/\.novatemplate$/, '.rapport.md'));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, md.join('\n') + '\n', 'utf-8');
  fs.writeFileSync(reportPath.replace(/\.md$/, '') + '.json', JSON.stringify({ bridge: bridgeInfo, warnings: report.warnings, mixRules: report.mixRules, readable: { applied: ok, total: readable.length, pct, unexposed: unexposed.length, pctWithUnexposed: pctAll }, lines }, null, 2), 'utf-8');
  console.log(`Modèle : ${out}\nRapport : ${reportPath}\nPont : ${bridgeInfo}\nRéglages : ${count('appliqué')} appliqués, ${count('proche')} proches, ${count('refusé')} refusés, ${count('introuvable')} introuvables\nLisibles : ${ok} / ${readable.length} (${pct} %)`);
};

main().catch(e => { console.error(e?.stack || e); process.exit(1); });
