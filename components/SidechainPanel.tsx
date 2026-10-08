import React, { useMemo, useState } from 'react';
import type { PluginInstance, Track } from '../types';
import {
  guessKeySource, keyFilterOf, keySourceLabel, keySourceOptions, KEY_HPF_OFF, KEY_LPF_OFF, setPluginKeySource,
  sidechainLoop, sidechainPresetsFor, supportsSidechain,
} from '../engine/sidechain';

/**
 * Barre « Clé (side-chain) » de la fenêtre d'un effet (R7) : comme le menu
 * « Key Input » de Pro Tools. Choix de la source (piste ou bus nommé), prise
 * avant / après fader, écoute de la clé ; repliés dessous : filtre de la clé
 * (passe-haut / passe-bas) et préréglages trap. Une boucle de routage est
 * refusée avec un message clair. Compacte : la fenêtre de l'effet reste à l'écran.
 */
interface Props {
  plugin: PluginInstance;
  track: Track;
  tracks: Track[];
  onUpdateTrack: (t: Track) => void;
  onUpdateParams: (p: Record<string, any>) => void;
  /** Après un préréglage : la fenêtre de l'effet repart des réglages à jour. */
  onReloaded?: () => void;
  compact?: boolean;
  /** VST du PC (R10) : la clé est-elle vraiment reçue par le plugin ? */
  vstKey?: 'ok' | 'none' | 'host' | null;
}

const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1).replace('.', ',')} kHz` : `${Math.round(v)} Hz`);
// Curseurs logarithmiques (0…1000) ↔ Hz.
const toPos = (f: number, lo: number, hi: number) => Math.round(1000 * Math.log(f / lo) / Math.log(hi / lo));
const fromPos = (p: number, lo: number, hi: number) => Math.round(lo * Math.pow(hi / lo, p / 1000));

/** Détails (filtre, préréglages) ouverts ou non : gardé d'une fenêtre à l'autre pendant la session. */
let detailsOpen = false;
/** Dernier message (préréglage appliqué…) par effet : survit au rechargement de la fenêtre. */
const notes = new Map<string, string>();

export const SidechainPanel: React.FC<Props> = ({ plugin, track, tracks, onUpdateTrack, onUpdateParams, onReloaded, compact, vstKey }) => {
  const [open, setOpen] = useState(detailsOpen);
  const setOpenPersist = (v: boolean) => { detailsOpen = v; setOpen(v); };
  const [error, setError] = useState<string | null>(null);
  const [note, setNoteState] = useState<string | null>(notes.get(plugin.id) || null);
  const setNote = (v: string | null) => { if (v) notes.set(plugin.id, v); else notes.delete(plugin.id); setNoteState(v); };
  const options = useMemo(() => keySourceOptions(tracks, track.id), [tracks, track.id]);
  if (!supportsSidechain(plugin.type)) return null;
  const ref = plugin.sidechainSourceId || '';
  const f = keyFilterOf(plugin.params);
  const tap = plugin.sidechainTap === 'post' ? 'post' : 'pre';
  const loop = ref ? sidechainLoop(tracks, track.id, ref, plugin.id) : null;
  const missing = !!ref && !options.some(o => o.ref === ref);
  const presets = sidechainPresetsFor(plugin.type);
  const isDeesser = plugin.type === 'DEESSER';
  const isVst = plugin.type === 'VST3';
  const title = isDeesser ? 'Écoute externe' : 'Clé (side-chain)';

  const apply = (next: string | null, nextTap?: 'pre' | 'post') => {
    const r = setPluginKeySource(tracks, track.id, plugin.id, next, nextTap);
    if ('error' in r) { setError(r.error); return false; }
    setError(null);
    const t = r.tracks.find(x => x.id === track.id);
    if (t) onUpdateTrack(t);
    return true;
  };

  const applyPreset = (id: string) => {
    const pr = presets.find(p => p.id === id);
    if (!pr) return;
    // Réglages ET clé en une seule mise à jour de la piste (une étape d'annulation).
    const merged: Track = { ...track, plugins: (track.plugins || []).map(p => (p.id === plugin.id ? { ...p, params: { ...(p.params || {}), ...pr.params } } : p)) };
    let next = tracks.map(t => (t.id === track.id ? merged : t));
    let msg: string;
    if (ref) msg = `« ${pr.name} » appliqué ; clé gardée : ${keySourceLabel(tracks, ref)}.`;
    else {
      const g = guessKeySource(tracks, track.id, pr);
      const r = g ? setPluginKeySource(next, track.id, plugin.id, g, pr.tap) : null;
      if (r && !('error' in r)) { next = r.tracks; msg = `« ${pr.name} » : clé = ${keySourceLabel(tracks, g!)} (trouvée d'après son nom). Change-la si besoin.`; }
      else msg = `« ${pr.name} » appliqué : choisis maintenant la clé dans la liste${r && 'error' in r ? ` (${keySourceLabel(tracks, g!)} ferait une boucle)` : ''}.`;
    }
    const t = next.find(x => x.id === track.id);
    if (t) onUpdateTrack(t);
    setError(null);
    setNote(msg);
    onReloaded?.();
  };

  const status = error ? { cls: 'text-red-300', text: error, alert: true }
    : loop ? { cls: 'text-red-300', text: `${loop.message} La clé est ignorée tant que la boucle existe.`, alert: true }
    : missing ? { cls: 'text-amber-300', text: `La source de la clé n'existe plus dans cette session (${plugin.sidechainSourceName || 'piste supprimée'}) : choisis-en une autre.`, alert: false }
    : note ? { cls: 'text-sky-200', text: note, alert: false }
    : isVst && ref && vstKey === 'host' ? { cls: 'text-amber-300', text: "Clé routée et calée sur la latence, mais le pont VST actuel ne sait pas encore la passer à l'entrée side-chain des VST3 : le plugin entend du silence en clé. Elle sera reçue avec l'hôte VST natif de Nova Studio (mise à jour à venir).", alert: false }
    : isVst && ref && vstKey === 'none' ? { cls: 'text-amber-300', text: "Ce plugin n'a pas d'entrée side-chain : la clé est ignorée.", alert: false }
    : isVst && ref && vstKey === 'ok' ? { cls: 'text-emerald-300', text: "Le plugin reçoit la clé. Dans sa fenêtre, choisis l'entrée side-chain « External » / « Ext. » si besoin.", alert: false }
    : null;
  const summary = ref ? `La détection écoute ${keySourceLabel(tracks, ref)} (${tap === 'pre' ? 'avant fader' : 'après fader'}), recalée sur la latence : identique à la lecture et à l'export.`
    : "Sans clé, l'effet écoute le son de sa propre piste.";

  return (
    <div data-nova-sidechain className={`w-0 min-w-full border-b border-white/10 bg-[#0b1220] text-white ${compact ? 'px-3 py-2' : 'px-8 pt-3 pb-2'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-sky-300" title={isDeesser
          ? "Écoute externe : la détection des « s » suit une autre piste ou un bus (ex. une copie de la voix sans effets)."
          : "Side-chain (Pro Tools : « Key Input ») : la détection écoute une autre piste ou un bus au lieu du son de la piste. Ex. la 808 s'efface sous le kick."}>
          <i className="fas fa-key" aria-hidden /> {title}
        </span>
        <select value={missing ? '' : ref} onChange={e => { setNote(null); apply(e.target.value || null); }} aria-label="Source de la clé" title={summary}
          data-nova-key-source className="h-8 max-w-[170px] rounded-lg border border-white/15 bg-black/50 px-2 text-[12px] text-white">
          <option value="">Aucune (son de la piste)</option>
          {options.some(o => o.kind === 'track') && (
            <optgroup label="Pistes">
              {options.filter(o => o.kind === 'track').map(o => <option key={o.ref} value={o.ref}>{o.label}</option>)}
            </optgroup>
          )}
          {options.some(o => o.kind === 'bus') && (
            <optgroup label="Bus nommés">
              {options.filter(o => o.kind === 'bus').map(o => <option key={o.ref} value={o.ref}>{o.label}</option>)}
            </optgroup>
          )}
        </select>
        {ref && (
          <div className="flex rounded-lg border border-white/15 overflow-hidden" role="radiogroup" aria-label="Prise de la clé">
            {(['pre', 'post'] as const).map(k => (
              <button key={k} type="button" role="radio" aria-checked={tap === k} onClick={() => apply(ref, k)}
                title={k === 'pre' ? 'Avant fader : la clé est prise après les effets de la source, avant son fader et son mute (un kick muet fait quand même pomper la 808 ; baisser le kick ne change pas le ducking).' : 'Après fader : la clé suit le fader et le mute de la source.'}
                className={`h-8 px-2 text-[11px] font-bold ${tap === k ? 'bg-sky-400 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>
                {k === 'pre' ? 'Avant fader' : 'Après fader'}
              </button>
            ))}
          </div>
        )}
        {ref && !isVst && (
          <button type="button" aria-pressed={f.listen} onClick={() => onUpdateParams({ keyListen: f.listen ? 0 : 1 })} data-nova-key-listen
            title="Écouter la clé (Pro Tools : « Key Listen ») : on entend la clé filtrée à la place du son, pour régler le filtre. Pense à le couper ensuite."
            className={`h-8 px-2 rounded-lg border text-[11px] font-bold ${f.listen ? 'bg-amber-400 text-black border-amber-300 animate-pulse' : 'bg-white/5 border-white/15 text-slate-200 hover:bg-white/10'}`}>
            <i className="fas fa-headphones mr-1" aria-hidden />{f.listen ? 'Écoute de la clé' : 'Écouter'}
          </button>
        )}
        {(ref || presets.length > 0) && (
          <button type="button" aria-expanded={open} onClick={() => setOpenPersist(!open)} data-nova-key-more
            title={ref ? 'Filtre de la clé (passe-haut / passe-bas) et préréglages trap' : 'Préréglages trap : 808 sous le kick, voix qui creuse le beat, pompe'}
            className="h-8 px-2 rounded-lg border border-white/15 bg-white/5 text-[11px] font-bold text-slate-200 hover:bg-white/10">
            {ref ? 'Filtre & préréglages' : 'Préréglages trap'} <i className={`fas fa-chevron-${open ? 'up' : 'down'} ml-1 text-[9px]`} aria-hidden />
          </button>
        )}
      </div>

      {open && ref && (
        <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <label className="block" title="Passe-haut de la clé : coupe le bas de la clé (ex. 40 Hz sur un kick, 150 Hz sur une voix). Tout à gauche = coupé.">
            <span className="flex justify-between text-[10px] text-slate-400"><span>Clé : passe-haut</span><b className="font-mono text-slate-200">{f.hpf <= KEY_HPF_OFF ? 'coupé' : hz(f.hpf)}</b></span>
            <input type="range" min={0} max={1000} value={toPos(f.hpf, 20, 2000)} aria-label="Passe-haut de la clé"
              onChange={e => onUpdateParams({ keyHpf: fromPos(+e.target.value, 20, 2000) })} className="w-full h-5 accent-sky-400" />
          </label>
          <label className="block" title="Passe-bas de la clé : coupe le haut de la clé (ex. 200 Hz pour ne garder que le corps du kick). Tout à droite = coupé.">
            <span className="flex justify-between text-[10px] text-slate-400"><span>Clé : passe-bas</span><b className="font-mono text-slate-200">{f.lpf >= KEY_LPF_OFF ? 'coupé' : hz(f.lpf)}</b></span>
            <input type="range" min={0} max={1000} value={toPos(f.lpf, 100, 20000)} aria-label="Passe-bas de la clé"
              onChange={e => onUpdateParams({ keyLpf: fromPos(+e.target.value, 100, 20000) })} className="w-full h-5 accent-sky-400" />
          </label>
        </div>
      )}

      {open && presets.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {presets.map(p => (
            <button key={p.id} type="button" onClick={() => applyPreset(p.id)} title={p.hint} data-nova-sc-preset={p.id}
              className="h-8 px-2.5 rounded-lg border border-sky-400/30 bg-sky-400/10 text-[11px] font-bold text-sky-200 hover:bg-sky-400/20">{p.name}</button>
          ))}
        </div>
      )}

      {(status || open) && (
        <p className={`mt-1 text-[11px] leading-snug ${status ? status.cls : 'text-slate-400'}`} aria-live="polite" role={status?.alert ? 'alert' : undefined}
          {...(status?.alert ? { 'data-nova-key-error': '' } : {})}>
          {status?.alert && <i className="fas fa-triangle-exclamation mr-1" aria-hidden />}{status ? status.text : summary}
        </p>
      )}
    </div>
  );
};

export default SidechainPanel;
