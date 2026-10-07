import React, { useMemo, useState } from 'react';
import type { Track } from '../types';
import type { VstCatalogEntry, VstParamAck, VstParamInfo, VstParamsReply } from '../services/LiveVstRemote';
import type { PreviewView } from '../services/LivePreview';

/**
 * Collaboration « En direct », côté ingé : les VST hébergés par le PC de
 * l'artiste. On lit leurs réglages, on les change ; le pont de l'artiste
 * applique et RELIT la valeur, affichée ici. On peut aussi poser un des VST
 * installés chez l'artiste sur une piste.
 *
 * Aperçu : l'ingé n'a pas ces VST. Le pont de l'artiste rend la piste ~1 s
 * après chaque réglage, l'aperçu joue ici à la place du son sans VST.
 */
interface Props {
  tracks: Track[];
  catalog: VstCatalogEntry[] | null;
  selectedTrackId: string | null;
  onRead: (trackId: string, pluginId: string) => Promise<VstParamsReply>;
  onSet: (trackId: string, pluginId: string, name: string, value: string) => Promise<VstParamAck>;
  onAdd: (entry: VstCatalogEntry, trackId: string) => void;
  /** Pistes qui passent par un VST de l'artiste, et l'état de leur aperçu. */
  previews?: { trackId: string; name: string; view: PreviewView | null }[];
  onRefreshPreview?: (trackId: string) => void;
}

const PREVIEW_TONE: Record<PreviewView['tone'], string> = { ok: 'text-emerald-300', busy: 'text-sky-300', warn: 'text-amber-300', error: 'text-red-300' };

const btn = 'h-9 rounded-xl px-3 text-[11px] font-black transition-colors disabled:opacity-40';

const LiveVstRemotePanel: React.FC<Props> = ({ tracks, catalog, selectedTrackId, onRead, onSet, onAdd, previews = [], onRefreshPreview }) => {
  const vsts = useMemo(() => tracks.flatMap(t => (t.plugins || []).filter(p => p.type === 'VST3' && p.params?.localPath).map(p => ({ t, p }))), [tracks]);
  const [pick, setPick] = useState('');
  const [params, setParams] = useState<VstParamInfo[] | null>(null);
  const [filter, setFilter] = useState('');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [readback, setReadback] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const cur = vsts.find(x => `${x.t.id}|${x.p.id}` === pick) || vsts[0];
  const target = tracks.find(t => t.id === selectedTrackId && t.type === 'AUDIO') || tracks.find(t => t.type === 'AUDIO' && t.id !== 'instrumental');

  const read = async () => {
    if (!cur) return;
    setBusy('Lecture chez l’artiste…'); setErr(null);
    try {
      const r = await onRead(cur.t.id, cur.p.id);
      if (!r.ok) setErr(r.error || 'Lecture impossible.'); else { setParams(r.parameters || []); setReadback({}); }
    } catch (e: any) { setErr(e?.message || 'Pas de réponse.'); } finally { setBusy(null); }
  };
  const set = async (name: string) => {
    if (!cur) return;
    const value = (edit[name] ?? '').trim();
    if (!value) return;
    setBusy(`Réglage de ${name}…`); setErr(null);
    try {
      const r = await onSet(cur.t.id, cur.p.id, name, value);
      const res = r.results.find(x => x.name === name);
      setReadback(b => ({ ...b, [name]: { ok: r.ok, text: r.ok ? `relu sur le plugin : ${res?.text ?? value}` : (res?.error || r.error || 'refusé') } }));
      if (r.ok && params) setParams(params.map(p => (p.name === name ? { ...p, text: res?.text ?? value } : p)));
    } catch (e: any) { setErr(e?.message || 'Pas de réponse.'); } finally { setBusy(null); }
  };
  const shown = (params || []).filter(p => !filter || `${p.displayName || ''} ${p.name}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 40);
  const cat = (catalog || []).filter(c => !q || `${c.name} ${c.vendor}`.toLowerCase().includes(q.toLowerCase())).slice(0, 30);

  return (
    <details data-testid="live-vst" className="border-b border-white/5 px-4 py-3" open={vsts.length > 0}>
      <summary className="cursor-pointer text-[11px] font-black uppercase tracking-wider text-slate-400">🎛️ VST du PC de l'artiste</summary>
      <div className="mt-2 space-y-2">
        {vsts.length === 0 && !catalog?.length && (
          <p className="text-[11px] text-slate-500">L'artiste n'a pas encore partagé ses VST : il doit ouvrir NOVA Studio pour Windows (pont VST connecté).</p>
        )}
        {previews.length > 0 && (
          <div data-testid="live-preview" className="space-y-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-2" aria-live="polite">
            <p className="text-[11px] font-bold text-white">🔊 Ce que tu entends</p>
            {previews.map(pv => (
              <div key={pv.trackId} data-testid={`live-preview-${pv.trackId}`} className="flex items-start gap-1.5">
                <p className={`flex-1 text-[11px] leading-snug ${pv.view ? PREVIEW_TONE[pv.view.tone] : 'text-slate-400'}`}>
                  <span className="font-bold text-slate-200">{pv.name} : </span>
                  {pv.view ? pv.view.label : "pas encore d'aperçu (tu entends la piste sans ses VST). Clique « Écouter son son »."}
                </p>
                <button type="button" onClick={() => onRefreshPreview?.(pv.trackId)} disabled={pv.view?.tone === 'busy'}
                  className={`${btn} h-8 shrink-0 ${pv.view?.retry ? 'bg-amber-400 text-black' : 'bg-white/10 text-white'}`}>
                  {pv.view?.retry ? 'Réessayer' : pv.view ? 'Actualiser' : 'Écouter son son'}
                </button>
              </div>
            ))}
            <p className="text-[10px] text-slate-500">Rendu par le PC de l'artiste (ses VST) ~1 s après chaque réglage, sur le passage que tu écoutes (ta boucle, sinon 30 s autour de la tête de lecture).</p>
          </div>
        )}
        {vsts.length > 0 && (
          <>
            <div className="flex gap-1.5">
              <select aria-label="Plugin à régler" value={cur ? `${cur.t.id}|${cur.p.id}` : ''} onChange={e => { setPick(e.target.value); setParams(null); }}
                className="h-9 flex-1 min-w-0 rounded-xl border border-white/10 bg-black/40 px-2 text-[12px] text-white">
                {vsts.map(x => <option key={x.p.id} value={`${x.t.id}|${x.p.id}`}>{x.t.name} · {x.p.params?.name || x.p.name}</option>)}
              </select>
              <button type="button" onClick={read} disabled={!!busy} className={`${btn} bg-white/10 text-white`}>Lire ses réglages</button>
            </div>
            {params && (
              <div className="space-y-1">
                <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Chercher un réglage (ratio, mix…)" aria-label="Chercher un réglage"
                  className="h-9 w-full rounded-xl border border-white/10 bg-black/40 px-2 text-[12px] text-white" />
                {shown.length === 0 && <p className="text-[11px] text-slate-500">Aucun réglage ne correspond.</p>}
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {shown.map(p => (
                    <div key={p.name} className="rounded-lg bg-white/[0.03] p-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="flex-1 truncate text-[11px] text-slate-200" title={p.name}>{p.displayName || p.name}</span>
                        <span className="text-[11px] text-cyan-300">{p.text}</span>
                      </div>
                      <div className="mt-1 flex gap-1">
                        {p.values?.length ? (
                          <select aria-label={`Valeur de ${p.displayName || p.name}`} value={edit[p.name] ?? ''} onChange={e => setEdit(v => ({ ...v, [p.name]: e.target.value }))}
                            className="h-8 flex-1 min-w-0 rounded-lg border border-white/10 bg-black/40 px-1 text-[11px] text-white">
                            <option value="">Choisir…</option>
                            {p.values.map(v => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : (
                          <input aria-label={`Valeur de ${p.displayName || p.name}`} value={edit[p.name] ?? ''} onChange={e => setEdit(v => ({ ...v, [p.name]: e.target.value }))}
                            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') void set(p.name); }} placeholder="Nouvelle valeur"
                            className="h-8 flex-1 min-w-0 rounded-lg border border-white/10 bg-black/40 px-2 text-[11px] text-white" />
                        )}
                        <button type="button" onClick={() => void set(p.name)} disabled={!!busy || !(edit[p.name] ?? '').trim()} className={`${btn} h-8 bg-cyan-500 text-black`}>Régler</button>
                      </div>
                      {readback[p.name] && <p className={`mt-0.5 text-[10px] ${readback[p.name].ok ? 'text-emerald-300' : 'text-amber-300'}`}>{readback[p.name].ok ? '✓ ' : '⚠️ '}{readback[p.name].text}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {busy && <p role="status" className="text-[11px] text-sky-300">{busy}</p>}
        {err && <p role="alert" className="text-[11px] text-amber-300">{err}</p>}
        {!!catalog?.length && (
          <details className="rounded-xl bg-white/[0.02] p-2">
            <summary className="cursor-pointer text-[11px] text-slate-300">Plugins installés chez l'artiste ({catalog.length})</summary>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Chercher (Pro-Q, compresseur…)" aria-label="Chercher un plugin de l'artiste"
              className="mt-1.5 h-9 w-full rounded-xl border border-white/10 bg-black/40 px-2 text-[12px] text-white" />
            <div className="mt-1 max-h-40 overflow-y-auto space-y-1">
              {cat.map(c => (
                <div key={`${c.path}|${c.pluginName || ''}`} className="flex items-center gap-1.5">
                  <span className="flex-1 truncate text-[11px] text-slate-200">{c.name}<span className="text-slate-500"> · {c.vendor || c.category}</span></span>
                  <button type="button" disabled={!target} onClick={() => target && onAdd(c, target.id)} className={`${btn} h-8 bg-white/10 text-white`}
                    title={target ? `Ajouter sur ${target.name}` : 'Sélectionne une piste'}>+ {target ? target.name.slice(0, 10) : 'piste'}</button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </details>
  );
};

export default LiveVstRemotePanel;
