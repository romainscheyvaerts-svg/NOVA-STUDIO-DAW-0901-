import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState, PluginInstance, PluginType, Track } from '../types';
import { TrackType } from '../types';
import {
  ALL_PARTS, applyImport, ImportChoice, ImportPart, ImportReport, importSummary, PART_LABELS, PART_PRESETS, planImport, SameNameMode,
} from '../utils/sessionImport';
import { instantiateTemplate, SessionTemplate, TEMPLATE_FORMAT, TEMPLATE_VERSION } from '../utils/sessionTemplate';
import { listTemplates } from '../services/TemplateStore';
import { recoveryStore, VersionMeta } from '../utils/recoveryStore';
import { stateFromVersion } from '../utils/recoverySnapshot';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { applyR21, r21Bus } from '../utils/r21Bus';
import { novaBridge } from '../services/NovaBridge';

/**
 * R21 · « Importer depuis une session » (Pro Tools : File › Import › Session
 * Data, Alt+Maj+I). Source : un projet NOVA (.zip), un modèle (.novatemplate)
 * ou un projet ouvert récemment ; choix des pistes et de ce qu'on prend pour
 * chacune ; tempo ; pistes du même nom ; bus manquants ; VST absents signalés.
 */
type SourceKind = 'zip' | 'template' | 'recent';
interface Loaded { kind: SourceKind; name: string; state: DAWState; vstMessages: string[] }

const btn = 'nova-hit-tactile h-9 rounded-lg border border-nv-line px-3 text-[12px] font-bold text-nv-ink hover:bg-nv-accent/15 disabled:opacity-40';
const btnMain = 'nova-hit-tactile h-10 rounded-lg bg-nv-accent px-4 text-[13px] font-black text-black disabled:opacity-40';
const r2 = (v: number) => Math.round(v * 100) / 100;
const typeIcon = (t: TrackType) => (t === TrackType.MIDI ? 'fa-music' : t === TrackType.BUS ? 'fa-random' : t === TrackType.DRUM_RACK ? 'fa-drum' : 'fa-wave-square');

/** Plugins du PC (pont VST), comme pour les modèles. null : pont absent. */
async function bridgePlugins() {
  if (!novaBridge.isConnected()) return null;
  let p = novaBridge.getCachedPlugins();
  if (!p.length) p = await novaBridge.listPlugins().catch(() => novaBridge.getCachedPlugins());
  return p.map(x => ({ name: x.name, vendor: x.vendor, path: x.path, pluginName: x.pluginName ?? null, isInstrument: x.isInstrument ?? null }));
}

/** Les VST de la source vérifiés sur ce PC (remplacés / laissés inactifs / en attente du pont), comme un modèle. */
async function checkVst(state: DAWState, makeBuiltin?: (type: PluginType, o: Record<string, any>) => PluginInstance): Promise<{ state: DAWState; messages: string[] }> {
  if (!state.tracks.some(t => t.plugins?.some(p => p.type === 'VST3'))) return { state, messages: [] };
  const tpl: SessionTemplate = {
    format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, id: 'import', name: state.name, createdAt: 0, updatedAt: 0,
    session: { bpm: state.bpm, timeSignature: state.timeSignature, tracks: state.tracks as any, trackGroups: [] },
  };
  const r = instantiateTemplate(tpl, { plugins: await bridgePlugins(), missingVst: 'replace', makeBuiltin });
  // Les pistes gardent leurs clips et leur automation d'origine ; seuls les effets sont vérifiés.
  const tracks = state.tracks.map(t => { const c = r.state.tracks.find(x => x.id === t.id); return c ? { ...t, plugins: c.plugins } : t; });
  return { state: { ...state, tracks }, messages: r.report.messages };
}

const ImportSessionDialog: React.FC<{
  getState: () => DAWState;
  onClose: () => void;
  userEmail?: string | null;
  makeBuiltin?: (type: PluginType, o: Record<string, any>) => PluginInstance;
  /** Recalage au tempo des clips audio (R13), après l'import. */
  onStretch?: (reqs: { trackId: string; clipId: string }[], sourceBpm: number) => Promise<void>;
}> = ({ getState, onClose, userEmail, makeBuiltin, onStretch }) => {
  const [step, setStep] = useState<'source' | 'loading' | 'tracks' | 'done'>('source');
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [templates, setTemplates] = useState<SessionTemplate[] | null>(null);
  const [recents, setRecents] = useState<VersionMeta[] | null>(null);
  const [choice, setChoice] = useState<Record<string, ImportPart[]>>({});
  const [sameName, setSameName] = useState<SameNameMode>('add');
  const [matchTempo, setMatchTempo] = useState(true);
  const [result, setResult] = useState<{ report: ImportReport; vst: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cur = getState();

  useEffect(() => {
    void listTemplates(userEmail || null).then(setTemplates).catch(() => setTemplates([]));
    void recoveryStore().listVersions().then(list => {
      // Le plus récent de chaque projet, sauf le projet ouvert.
      const seen = new Set<string>();
      setRecents(list.filter(v => { if (v.projectId === cur.id || seen.has(v.projectId)) return false; seen.add(v.projectId); return true; }).slice(0, 12));
    }).catch(() => setRecents([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const take = async (kind: SourceKind, name: string, load: () => Promise<DAWState>) => {
    setStep('loading'); setError(null);
    try {
      const st = await load();
      const v = kind === 'template' ? { state: st, messages: [] as string[] } : await checkVst(st, makeBuiltin);
      setLoaded({ kind, name, state: v.state, vstMessages: kind === 'template' ? ((st as any).__vst || []) : v.messages });
      setChoice({});
      setMatchTempo(Math.abs((st.bpm || 120) - cur.bpm) > 1e-3);
      setStep('tracks');
    } catch (e: any) {
      setError(e?.message || 'Source illisible.');
      setStep('source');
    }
  };
  const fromZip = (f: File) => take('zip', f.name.replace(/\.novaproj\.zip$|\.zip$/i, ''), async () => {
    const { ProjectIO } = await import('../services/ProjectIO');
    return ProjectIO.loadProject(f, { bufferPrefix: `imp${Date.now().toString(36)}-` });
  });
  const fromTemplate = (t: SessionTemplate) => take('template', t.name, async () => {
    const r = instantiateTemplate(t, { plugins: await bridgePlugins(), missingVst: 'replace', makeBuiltin });
    return Object.assign(r.state, { __vst: r.report.messages }) as DAWState;
  });
  const fromRecent = (v: VersionMeta) => take('recent', v.name, async () => {
    const rec = await recoveryStore().loadVersion(v.id);
    if (!rec) throw new Error('Ce projet n\'est plus dans l\'historique de l\'appareil.');
    const r = stateFromVersion(rec.record, rec.audio, a => {
      const b = new AudioBuffer({ length: Math.max(1, a.length), numberOfChannels: a.channels.length || 1, sampleRate: a.sampleRate });
      a.channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      return b;
    }, (b, id) => { if (!audioBufferRegistry.has(id)) audioBufferRegistry.register(b, id); });
    return r.state;
  });

  const plan = useMemo(() => (loaded ? planImport(cur, loaded.state) : []), [loaded, cur.tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const choices: ImportChoice[] = plan.filter(p => choice[p.id]?.length).map(p => ({ sourceId: p.id, parts: choice[p.id] }));
  const preview = useMemo(() => (loaded && choices.length ? applyImport(cur, loaded.state, choices, { sameName, matchTempo }, b => `${b}-p`) : null),
    [loaded, JSON.stringify(choices), sameName, matchTempo, cur.tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const srcBpm = loaded?.state.bpm || 120;
  const tempoDiffers = Math.abs(srcBpm - cur.bpm) > 1e-3;

  const toggleTrack = (id: string) => setChoice(c => ({ ...c, [id]: c[id]?.length ? [] : [...ALL_PARTS] }));
  const togglePart = (id: string, p: ImportPart) => setChoice(c => {
    const now = new Set(c[id] || []);
    if (now.has(p)) now.delete(p); else now.add(p);
    return { ...c, [id]: ALL_PARTS.filter(x => now.has(x)) };
  });
  const presetAll = (parts: ImportPart[]) => setChoice(c => Object.fromEntries(plan.map(p => [p.id, c[p.id]?.length ? [...parts] : []])));

  const go = async () => {
    if (!loaded || !choices.length) return;
    setBusy('Import…');
    const stamp = Date.now().toString(36);
    let k = 0;
    const r = applyImport(getState(), loaded.state, choices, { sameName, matchTempo }, b => `${b.replace(/-imp\w+$/, '')}-imp${stamp}${(k++).toString(36)}`);
    applyR21(() => r.state);
    const vstNames = new Set(plan.filter(p => choice[p.id]?.length).flatMap(p => [p.name, ...p.dependsOn]));
    const vst = loaded.vstMessages.filter(m => [...vstNames].some(n => m.includes(n)));
    if (r.report.toStretch.length && onStretch) {
      setBusy(`Recalage au tempo de ${r.report.toStretch.length} clip${r.report.toStretch.length > 1 ? 's' : ''} audio…`);
      await new Promise(res => setTimeout(res, 50));
      try { await onStretch(r.report.toStretch, srcBpm); } catch (e: any) { r.report.messages.push(`Recalage au tempo impossible : ${e?.message || e}`); }
    }
    setBusy(null);
    setResult({ report: r.report, vst });
    setStep('done');
    r21Bus.emit({ kind: 'notify', text: `📥 Import depuis « ${loaded.name} » : ${importSummary(r.report)}. Ctrl+Z pour revenir.` });
  };

  const card = 'w-full rounded-xl border border-nv-line bg-nv-well/40 p-3 text-left hover:bg-nv-accent/10';
  return (
    <div className="fixed inset-0 z-[770] flex items-center justify-center bg-black/55 p-3" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="import-session-title" data-testid="import-session-dialog"
        className="flex max-h-[92vh] w-full max-w-[720px] flex-col gap-3 rounded-2xl border border-nv-line bg-nv-panel p-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <i className="fas fa-file-import text-nv-accent" />
          <h2 id="import-session-title" className="min-w-0 flex-1 truncate text-[15px] font-bold text-nv-ink" title="Pro Tools : File › Import › Session Data (Alt+Maj+I) ; Logic : Import › Logic Projects">
            Importer depuis une session{loaded ? ` · ${loaded.name}` : ''}
          </h2>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label="Fermer" className="nova-hit-tactile h-9 w-9 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
        </div>

        {step === 'source' && (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <p className="text-[12px] text-nv-muted">Prends des pistes d'un autre projet — avec leurs clips, leurs effets, leurs envois et leur automation — sans quitter celui-ci.</p>
            {error && <p role="alert" className="rounded-lg border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300">⚠️ {error}</p>}
            <button type="button" className={card} onClick={() => fileRef.current?.click()} data-testid="import-from-zip">
              <span className="block text-[13px] font-black text-nv-ink">📦 Un projet NOVA (.zip)</span>
              <span className="block text-[11px] text-nv-muted">Le fichier enregistré par « Sauvegarder » → « Fichier sur cet appareil ».</span>
            </button>
            <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" data-testid="import-zip-input"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void fromZip(f); }} />
            <div>
              <p className="mb-1 text-[11px] font-black uppercase tracking-wider text-nv-muted">Projets récents (cet appareil)</p>
              {recents === null && <p className="text-[12px] text-nv-muted">Chargement…</p>}
              {recents && !recents.length && <p className="text-[12px] text-nv-muted">Aucun autre projet récent sur cet appareil.</p>}
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {(recents || []).map(v => (
                  <button key={v.id} type="button" className={card} onClick={() => void fromRecent(v)}>
                    <span className="block truncate text-[12px] font-bold text-nv-ink">🕘 {v.name}</span>
                    <span className="block text-[11px] text-nv-muted">{new Date(v.savedAt).toLocaleString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {v.tracks} piste{v.tracks > 1 ? 's' : ''}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-black uppercase tracking-wider text-nv-muted">Modèles (.novatemplate)</p>
              {templates === null && <p className="text-[12px] text-nv-muted">Chargement…</p>}
              {templates && !templates.length && <p className="text-[12px] text-nv-muted">Aucun modèle.</p>}
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {(templates || []).slice(0, 12).map(t => (
                  <button key={t.id} type="button" className={card} onClick={() => void fromTemplate(t)}>
                    <span className="block truncate text-[12px] font-bold text-nv-ink">📐 {t.name}</span>
                    <span className="block text-[11px] text-nv-muted">{t.session.tracks.length} piste{t.session.tracks.length > 1 ? 's' : ''}{t.session.bpm ? ` · ${t.session.bpm} BPM` : ''}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 'loading' && <p className="p-6 text-center text-[13px] text-nv-muted" role="status"><i className="fas fa-circle-notch fa-spin mr-2" />Lecture de la source…</p>}

        {step === 'tracks' && loaded && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <button type="button" className={btn} onClick={() => setChoice(Object.fromEntries(plan.map(p => [p.id, [...ALL_PARTS]])))}>Tout cocher</button>
              <button type="button" className={btn} onClick={() => setChoice({})}>Rien</button>
              <span className="text-nv-muted">Pour les pistes cochées :</span>
              {PART_PRESETS.map(p => <button key={p.id} type="button" className={btn} onClick={() => presetAll(p.parts)} title={p.parts.map(x => PART_LABELS[x].label).join(', ')}>{p.label}</button>)}
            </div>
            <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1" data-testid="import-tracks">
              {plan.map(p => {
                const parts = choice[p.id] || [];
                const on = parts.length > 0;
                return (
                  <li key={p.id} className={`rounded-xl border p-2 ${on ? 'border-nv-accent/60 bg-nv-accent/10' : 'border-nv-line bg-nv-well/30'}`} data-testid="import-track" data-track-name={p.name}>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={on} onChange={() => toggleTrack(p.id)} aria-label={`Importer ${p.name}`} className="h-4 w-4" />
                      <span className="h-5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                      <i className={`fas ${typeIcon(p.type)} w-4 text-center text-[11px] text-nv-muted`} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-nv-ink">{p.name}</span>
                      <span className="shrink-0 text-[11px] text-nv-muted">{p.clips} clip{p.clips > 1 ? 's' : ''} · {p.plugins} effet{p.plugins > 1 ? 's' : ''}{p.sends ? ` · ${p.sends} envoi${p.sends > 1 ? 's' : ''}` : ''}</span>
                      {p.existingId && <span className="shrink-0 rounded bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-300" title="Une piste du projet porte déjà ce nom : voir « Pistes du même nom »">même nom</span>}
                    </label>
                    {on && (
                      <div className="mt-1.5 flex flex-wrap gap-1 pl-6" role="group" aria-label={`Ce qu'on importe de ${p.name}`}>
                        {ALL_PARTS.map(x => (
                          <button key={x} type="button" aria-pressed={parts.includes(x)} onClick={() => togglePart(p.id, x)} title={PART_LABELS[x].hint}
                            className={`nova-hit-tactile h-7 rounded-full border px-2.5 text-[11px] font-bold ${parts.includes(x) ? 'border-nv-accent bg-nv-accent/25 text-nv-ink' : 'border-nv-line text-nv-muted'}`}>
                            {parts.includes(x) ? '✓ ' : ''}{PART_LABELS[x].label}
                          </button>
                        ))}
                        {p.dependsOn.length > 0 && parts.includes('sends') && <span className="self-center text-[10px] text-nv-muted">→ {p.dependsOn.join(', ')}</span>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="grid grid-cols-1 gap-2 rounded-xl border border-nv-line bg-nv-well/40 p-2.5 text-[12px] sm:grid-cols-2">
              <div role="radiogroup" aria-label="Pistes du même nom" title="Pro Tools : Match Tracks / Import as New Track">
                <p className="mb-1 font-bold text-nv-muted">Pistes du même nom</p>
                {([['add', 'Ajouter (« LEAD 2 »)'], ['replace', 'Remplacer ce qui est coché']] as const).map(([m, label]) => (
                  <label key={m} className="mr-3 inline-flex items-center gap-1.5 text-nv-ink"><input type="radio" name="same-name" checked={sameName === m} onChange={() => setSameName(m)} />{label}</label>
                ))}
              </div>
              <label className={`flex items-start gap-2 ${tempoDiffers ? 'text-nv-ink' : 'text-nv-muted'}`} title="Pro Tools : Import Tempo/Meter Map. Positions recalées sur les mêmes mesures ; les clips audio sont étirés (R13), le MIDI et l'automation suivent.">
                <input type="checkbox" checked={matchTempo && tempoDiffers} disabled={!tempoDiffers} onChange={e => setMatchTempo(e.target.checked)} className="mt-0.5" />
                <span>Faire correspondre au tempo<span className="block text-[11px] text-nv-muted">Source {r2(srcBpm)} BPM · projet {r2(cur.bpm)} BPM{tempoDiffers ? '' : ' (identiques)'}</span></span>
              </label>
            </div>
            {preview && (
              <p className="text-[12px] text-nv-ink" data-testid="import-preview">
                {importSummary(preview.report)}
                {preview.report.busesCreated.length ? <span className="text-nv-muted"> · bus créés : {preview.report.busesCreated.join(', ')}</span> : null}
                {preview.report.replaced.length ? <span className="text-amber-300"> · remplacées : {preview.report.replaced.join(', ')}</span> : null}
              </p>
            )}
            {loaded.vstMessages.length > 0 && (
              <details className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2 text-[11px] text-nv-ink">
                <summary className="cursor-pointer font-bold">Plugins VST : {loaded.vstMessages.length} remarque{loaded.vstMessages.length > 1 ? 's' : ''}</summary>
                <ul className="mt-1 space-y-0.5">{loaded.vstMessages.slice(0, 20).map((m, i) => <li key={i}>• {m}</li>)}</ul>
              </details>
            )}
            <div className="flex gap-2">
              <button type="button" className={btn} onClick={() => { setLoaded(null); setStep('source'); }} disabled={!!busy}>← Autre source</button>
              <div className="flex-1" />
              <button type="button" className={btnMain} disabled={!choices.length || !!busy} onClick={() => void go()} data-testid="import-go">
                {busy || `Importer ${choices.length} piste${choices.length > 1 ? 's' : ''}`}
              </button>
            </div>
          </>
        )}

        {step === 'done' && result && (
          <div className="flex flex-col gap-2" data-testid="import-done">
            <p className="text-[14px] font-bold text-nv-ink">✅ {importSummary(result.report)}</p>
            <ul className="space-y-0.5 text-[12px] text-nv-ink">
              {result.report.added.length > 0 && <li>Ajoutées : {result.report.added.join(', ')}</li>}
              {result.report.replaced.length > 0 && <li>Remplacées : {result.report.replaced.join(', ')}</li>}
              {result.report.messages.map((m, i) => <li key={i}>{m}</li>)}
              {result.vst.map((m, i) => <li key={`v${i}`} className="text-amber-300">{m}</li>)}
            </ul>
            <p className="text-[11px] text-nv-muted">Ctrl+Z annule l'import.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => { setResult(null); setStep('tracks'); }}>Importer d'autres pistes</button>
              <button type="button" className={btnMain} onClick={onClose} data-testid="import-close">Fermer</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ImportSessionDialog;

