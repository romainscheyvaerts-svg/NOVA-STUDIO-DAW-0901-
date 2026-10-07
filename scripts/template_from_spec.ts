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
 *
 * Pièges connus : Pro-C 3 n'accepte que ses textes exacts (« 2.00:1 ») ; le pont
 * prend alors la valeur la plus proche de la liste. Un plugin qui demande une
 * licence est fermé par le pont (chargement discret) et signalé.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTemplateFromSpec, KnownParam, KnowledgeEntry, matchParamName, settingForParam, TemplateSpec,
} from '../utils/templateSpec';
import { serializeTemplate, templateSlug } from '../utils/sessionTemplate';
import { compact, VstCandidate } from '../utils/vstMatch';

// ─── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2).filter(a => a !== '--');
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const specPath = argv.find((a, i) => !a.startsWith('--') && !['--out', '--report', '--id', '--port'].includes(argv[i - 1]));
if (!specPath) {
  console.error('Usage : npx vite-node scripts/template_from_spec.ts -- <fiche.json> [--out f] [--report f] [--activate-all] [--port n] [--no-bridge]');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(opt('--port') || process.env.NOVA_BRIDGE_PORT || 8765);

// ─── Petit client du pont (WebSocket JSON, réponses par req_id) ────────────────

class Bridge {
  private ws!: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  async connect(url: string, timeoutMs = 5000) {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error(`Pont VST injoignable (${url})`)); }, timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error(`Pont VST injoignable (${url})`)); };
      ws.onmessage = ev => {
        if (typeof ev.data !== 'string') return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const p = msg.req_id !== undefined ? this.pending.get(msg.req_id) : undefined;
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.req_id);
        if (msg.success === false || msg.error) {
          const e = new Error(msg.error || 'Échec') as Error & { licenseRequired?: boolean };
          e.licenseRequired = !!msg.license_required;
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
}

// ─── Comparaison réglage demandé / relu ───────────────────────────────────────

const num = (s: unknown): number | null => {
  const m = String(s ?? '').replace(',', '.').match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

type Verdict = 'appliqué' | 'proche' | 'refusé' | 'introuvable' | 'non contrôlé';

const verdictOf = (sent: { text?: string; real?: number }, ok: boolean, readText: string): Verdict => {
  if (!ok) return 'refusé';
  if (sent.text !== undefined) {
    if (compact(sent.text) === compact(readText)) return 'appliqué';
    const a = num(sent.text); const b = num(readText);
    if (a !== null && b !== null && Math.abs(a - b) <= Math.max(0.02 * Math.abs(a), 0.05)) return 'appliqué';
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
        unavailable: p.license === 'activation' || p.scan_status === 'crash' || p.scan_status === 'hang',
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

  interface Line { track: string; plugin: string; loaded: string; params: { asked: string; value: string; key: string | null; sent?: any; read?: string; verdict: Verdict; error?: string }[]; state: boolean }
  const lines: Line[] = [];
  let slot = 0;
  for (const ins of report.inserts) {
    const tr = template.session.tracks.find(t => t.plugins.some(p => p.id === ins.pluginId))!;
    const pl = tr.plugins.find(p => p.id === ins.pluginId)!;
    if (ins.builtin) { lines.push({ track: ins.track, plugin: `${ins.plugin} (effet NOVA)`, loaded: 'effet intégré', params: [], state: false }); continue; }
    const line: Line = { track: ins.track, plugin: ins.plugin + (ins.match && ins.match.plugin.name !== ins.plugin ? ` → ${ins.match.plugin.name}` : ''), loaded: '', params: [], state: false };
    lines.push(line);
    if (ins.excluded) { line.loaded = 'exclu (règle du studio)'; continue; }
    if (!ins.match) { line.loaded = 'absent de ce PC'; line.params = ins.params.map(p => ({ asked: p.asked, value: p.value, key: p.key, verdict: 'introuvable' as Verdict })); continue; }
    if (!bridge) { line.loaded = `trouvé (${ins.match.kind}), non contrôlé : pont absent`; line.params = ins.params.map(p => ({ asked: p.asked, value: p.value, key: p.key, verdict: 'non contrôlé' as Verdict })); continue; }
    const slotId = `tplcheck-${process.pid}-${++slot}`;
    try {
      const res = await bridge.request({
        action: 'LOAD_PLUGIN', slot_id: slotId, path: ins.match.plugin.path, plugin_name: ins.match.plugin.pluginName || null,
        sample_rate: 48000, state: pl.params.stateB64 || null, quiet: true,
      }, 180000);
      line.loaded = `chargé : ${res.name || ins.match.plugin.name}${ins.match.note ? ` (${ins.match.note})` : ''}`;
      const live: KnownParam[] = ((await bridge.request({ action: 'GET_PARAMS', slot_id: slotId }, 120000)).parameters || []);
      const items: { asked: string; value: string; key: string | null; setting?: { name: string; text?: string; real?: number } }[] = ins.params.map(p => {
        const key = matchParamName(p.asked, live);
        return { asked: p.asked, value: p.value, key, setting: key ? settingForParam(live.find(x => x.name === key), key, p.value) : undefined };
      });
      const toSend = items.filter(x => x.setting).map(x => x.setting!);
      const set = toSend.length ? await bridge.request({ action: 'SET_PARAMS', slot_id: slotId, params: toSend }, 120000) : { results: [] };
      const results: any[] = set.results || [];
      for (const it of items) {
        if (!it.setting) { line.params.push({ asked: it.asked, value: it.value, key: null, verdict: 'introuvable', error: 'réglage inconnu du plugin' }); continue; }
        const r = results.find(x => x.name === it.setting!.name);
        const read = String(r?.text ?? '');
        line.params.push({ asked: it.asked, value: it.value, key: it.setting.name, sent: it.setting, read, verdict: verdictOf(it.setting, !!r?.ok, read), ...(r?.error ? { error: r.error } : {}) });
      }
      // Modèle : réglages aux vraies clés du plugin (ceux qu'il a acceptés), état capturé.
      pl.params.novaSettings = items.filter(x => x.setting && results.find(r => r.name === x.setting!.name)?.ok).map(x => x.setting);
      if (!flag('--no-state')) {
        const st = await bridge.request({ action: 'GET_STATE', slot_id: slotId }, 60000).catch(() => null);
        if (st?.state) { pl.params.stateB64 = st.state; line.state = true; }
      }
    } catch (e: any) {
      line.loaded = e?.licenseRequired ? 'licence ou démo : chargement refusé (fenêtre fermée par le pont)' : `chargement impossible : ${e?.message || e}`;
      line.params = ins.params.map(p => ({ asked: p.asked, value: p.value, key: p.key, verdict: 'introuvable' as Verdict }));
    } finally {
      await bridge.request({ action: 'UNLOAD_PLUGIN', slot_id: slotId }, 30000).catch(() => null);
    }
  }
  bridge?.close();

  // ─── Sorties ─────────────────────────────────────────────────────────────────
  const out = path.resolve(opt('--out') || path.join(ROOT, 'templates', `${templateSlug(template.name)}.novatemplate`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, serializeTemplate(template) + '\n', 'utf-8');

  const count = (v: Verdict) => lines.reduce((n, l) => n + l.params.filter(p => p.verdict === v).length, 0);
  const md: string[] = [];
  md.push(`# Rapport : ${template.name}`, '');
  md.push(`- Fiche : ${path.resolve(specPath)}`, `- Modèle produit : ${out}`, `- Pont VST : ${bridgeInfo}`, `- Généré le ${new Date().toLocaleString('fr-BE')}`);
  md.push(`- Réglages : ${count('appliqué')} appliqués et relus, ${count('proche')} proches (valeur relue différente), ${count('refusé')} refusés, ${count('introuvable')} introuvables, ${count('non contrôlé')} non contrôlés (pont absent)`);
  md.push(`- Effets : ${flag('--activate-all') ? 'tous activés (--activate-all)' : 'actifs / inactifs comme dans la fiche'}`, '');
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
  fs.writeFileSync(reportPath.replace(/\.md$/, '') + '.json', JSON.stringify({ bridge: bridgeInfo, warnings: report.warnings, mixRules: report.mixRules, lines }, null, 2), 'utf-8');
  console.log(`Modèle : ${out}\nRapport : ${reportPath}\nPont : ${bridgeInfo}\nRéglages : ${count('appliqué')} appliqués, ${count('proche')} proches, ${count('refusé')} refusés, ${count('introuvable')} introuvables`);
};

main().catch(e => { console.error(e?.stack || e); process.exit(1); });
