/**
 * Rendus de R6, dans une seule fenêtre :
 *  - « Consolider » sur une plage : sans effets (clips seuls, Pro Tools
 *    « Consolidate Clip ») ou AVEC effets (bounce in place : Logic « Bounce in
 *    Place », Ableton « Bounce to New Track », FL « Consolidate ») ;
 *  - Commit d'une piste (Pro Tools 2020+ « Commit ») : la piste rendue remplace
 *    l'originale, gardée inactive et masquée (« Restaurer la piste d'origine ») ;
 *  - Imprimer un bus sur une nouvelle piste (Pro Tools : enregistrer un bus).
 * Même son qu'à la lecture (effets NOVA et VST du PC par le pont), latence
 * compensée, queue de réverbe en option. Une seule étape d'annulation.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { DAWState, Track } from '../types';
import { canCommit, canPrintBus, commitTracks, printBusTracks } from '../utils/commit';
import { DEFAULT_TAIL, renderBusPrint, renderCommitClip } from '../services/Bounce';
import { getEditCommands } from '../hooks/useEditCommands';
import { novaBridge } from '../services/NovaBridge';
import { pluginState, PLUGIN_STATE_LABEL } from '../utils/trackStructure';

export type BounceMode = 'commit' | 'range' | 'bus';

interface Props {
  open: boolean;
  mode: BounceMode;
  trackId?: string;
  range?: { start: number; end: number; trackIds: string[] };
  tracks: Track[];
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
}

const notify = (text: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: text })); } catch { /* hors navigateur */ } };
const fmt = (s: number) => `${s.toFixed(2).replace('.', ',')} s`;

const TAILS = [0, 2, 3, 5, 8];

const BounceDialog: React.FC<Props> = ({ open, mode, trackId, range, tracks, setState, onClose }) => {
  const track = useMemo(() => tracks.find(t => t.id === trackId), [tracks, trackId]);
  const [tail, setTail] = useState(DEFAULT_TAIL);
  const [withTail, setWithTail] = useState(true);
  const [upTo, setUpTo] = useState<number>(-2); // -2 : tous les effets
  const [muteBus, setMuteBus] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setError(null); setBusy(null); setUpTo(-2); } }, [open, mode, trackId]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);
  if (!open) return null;

  const t = withTail ? tail : 0;
  const plugins = track?.plugins || [];
  const vstNeeded = (mode === 'commit' ? plugins : []).some(p => p.type === 'VST3' && p.isEnabled && !p.isInactive) && !novaBridge.isConnected();

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(null); }
  };

  const doCommit = () => run(async () => {
    if (!track) return;
    setBusy(`Rendu de ${track.name} avec ses effets…`);
    const last = plugins.length - 1;
    const r = await renderCommitClip(track, { upTo: upTo === -2 ? last : upTo, tail: t, label: 'commit', session: tracks, onStep: m => setBusy(m) });
    const id = `track-commit-${Date.now().toString(36)}`;
    setState(prev => (prev.tracks.some(x => x.id === track.id) ? { ...prev, tracks: commitTracks(prev.tracks, track.id, { id, clip: r.clip, upTo: r.upTo, tail: t }) } : prev));
    notify(`✅ Commit de « ${track.name} » : nouvelle piste rendue avec ses effets. L'originale est gardée (inactive et masquée) : menu de la piste → « Restaurer la piste d'origine ». Ctrl+Z pour annuler.`);
    onClose();
  });

  const doPrint = () => run(async () => {
    if (!track) return;
    setBusy(`Impression de ${track.name}…`);
    const r = await renderBusPrint(tracks, track.id, { tail: t, onStep: m => setBusy(m) });
    const id = `track-print-${Date.now().toString(36)}`;
    setState(prev => (prev.tracks.some(x => x.id === track.id) ? { ...prev, tracks: printBusTracks(prev.tracks, track.id, { id, clip: r.clip, tail: t, muteBus }) } : prev));
    notify(`🖨️ « ${track.name} » imprimé sur une nouvelle piste${muteBus ? ' (le bus est coupé : le son ne double pas)' : ''}. Ctrl+Z pour annuler.`);
    onClose();
  });

  const doRange = (withEffects: boolean) => run(async () => {
    const cmd = getEditCommands();
    if (!cmd) throw new Error('Le studio n’est pas prêt.');
    setBusy(withEffects ? 'Rendu de la plage avec les effets…' : 'Consolidation…');
    const ok = await cmd.consolidateSelection(withEffects ? { withEffects: true, tail: t } : undefined);
    if (ok) onClose();
  });

  const btn = 'min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] px-4 rounded-xl text-[13px] font-bold transition-colors disabled:opacity-40';
  const title = mode === 'commit' ? `Commit · ${track?.name || ''}` : mode === 'bus' ? `Imprimer le bus · ${track?.name || ''}` : 'Consolider la plage';

  const tailRow = (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-nv-line p-2">
      <label className="flex min-h-[32px] cursor-pointer items-center gap-2 text-[12px]" title="Garde la fin de la réverbe / du délai après le dernier son (Pro Tools : « Add tail »)">
        <input type="checkbox" checked={withTail} onChange={e => setWithTail(e.target.checked)} className="accent-cyan-500" />
        Inclure la queue (réverbe, délai)
      </label>
      {withTail && (
        <select value={tail} onChange={e => setTail(Number(e.target.value))} aria-label="Durée de la queue"
          className="rounded-lg border border-nv-line bg-nv-well px-2 py-1 text-[12px] text-nv-ink">
          {TAILS.filter(x => x > 0).map(x => <option key={x} value={x}>{x} s</option>)}
        </select>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} data-testid={`bounce-dialog-${mode}`} onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-md space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[15px] font-black">{title}</h2>
          <button type="button" disabled={!!busy} onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>

        {mode === 'range' && range && (
          <>
            <p className="text-[12px] text-nv-muted">Plage de {fmt(range.end - range.start)} sur {range.trackIds.length} piste{range.trackIds.length > 1 ? 's' : ''}.</p>
            <button type="button" disabled={!!busy} onClick={() => void doRange(false)} data-testid="bounce-dry"
              title="Un seul clip par piste, clips seuls, sans effets (Pro Tools : Consolidate Clip, Alt+Maj+3)"
              className={`${btn} w-full border border-nv-line text-left hover:bg-nv-accent/10`}>
              <i className="fas fa-layer-group mr-2" />Sans effets <span className="font-normal text-nv-muted">· un seul clip, à la même place</span>
            </button>
            <div className="space-y-2 rounded-xl border border-cyan-500/30 p-2">
              <button type="button" disabled={!!busy} onClick={() => void doRange(true)} data-testid="bounce-wet"
                title="Rend la plage AVEC les effets de la piste sur une nouvelle piste, comme à la lecture (Logic : Bounce in Place · Ableton : Bounce to New Track · FL : Consolidate) ; les clips d'origine de la plage sont coupés"
                className={`${btn} w-full bg-cyan-500 text-left text-black hover:bg-cyan-400`}>
                <i className="fas fa-wand-magic-sparkles mr-2" />Avec effets <span className="font-normal opacity-80">· bounce in place</span>
              </button>
              {tailRow}
            </div>
          </>
        )}

        {mode === 'commit' && track && (
          <>
            {!canCommit(track) ? <p className="text-[12px] text-red-400">Commit : choisis une piste audio, MIDI ou d'instrument.</p> : (
              <>
                <p className="text-[12px] text-nv-muted">La piste est rendue avec ses effets (avant le fader : volume, pan, envois et sortie ne changent pas). L'originale reste dans la session, inactive et masquée : tu peux la restaurer à tout moment.</p>
                {plugins.length > 0 && (
                  <label className="block text-[12px]">
                    <span className="mb-1 block font-bold">Effets inclus</span>
                    <select value={upTo} onChange={e => setUpTo(Number(e.target.value))} data-testid="commit-upto"
                      title="Pro Tools : « Commit up to » — les effets suivants restent actifs sur la nouvelle piste"
                      className="w-full rounded-lg border border-nv-line bg-nv-well px-2 py-2 text-[12px] text-nv-ink">
                      <option value={-2}>Tous les effets ({plugins.length})</option>
                      {plugins.map((p, i) => i < plugins.length - 1 && (
                        <option key={p.id} value={i}>Jusqu'à {i + 1}. {p.params?.name || p.name}{pluginState(p) !== 'active' ? ` (${PLUGIN_STATE_LABEL[pluginState(p)]})` : ''} — les suivants restent actifs</option>
                      ))}
                    </select>
                  </label>
                )}
                {tailRow}
                {vstNeeded && <p role="alert" className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">Cette piste a des VST : connecte le pont (appli Windows Nova Studio), sinon le rendu gelé à jour est utilisé s'il existe.</p>}
                <button type="button" disabled={!!busy} onClick={() => void doCommit()} data-testid="commit-run"
                  title="Pro Tools 2020+ : Commit · Logic : Bounce in Place (remplacer) · Ableton : Freeze and Flatten"
                  className={`${btn} w-full bg-cyan-500 text-black hover:bg-cyan-400`}><i className="fas fa-check-double mr-2" />Commit</button>
              </>
            )}
          </>
        )}

        {mode === 'bus' && track && (
          <>
            {!canPrintBus(track) ? <p className="text-[12px] text-red-400">Choisis un bus, un retour d'effet ou un dossier de routage.</p> : (
              <>
                <p className="text-[12px] text-nv-muted">Le son exact du bus (après ses effets, son fader et son pan), aligné à l'échantillon, sur une nouvelle piste audio qui sort au même endroit.</p>
                {tailRow}
                <label className="flex min-h-[32px] cursor-pointer items-center gap-2 text-[12px]" title="Sinon le bus et sa copie imprimée jouent tous les deux (le son double)">
                  <input type="checkbox" checked={muteBus} onChange={e => setMuteBus(e.target.checked)} className="accent-cyan-500" />
                  Couper le bus après l'impression
                </label>
                <button type="button" disabled={!!busy} onClick={() => void doPrint()} data-testid="print-run"
                  title="Pro Tools : enregistrer un bus sur une piste audio (print) · Logic : Bounce in Place d'un aux · Ableton : Resample"
                  className={`${btn} w-full bg-cyan-500 text-black hover:bg-cyan-400`}><i className="fas fa-print mr-2" />Imprimer</button>
              </>
            )}
          </>
        )}

        {busy && <p role="status" className="text-[12px] text-nv-muted"><i className="fas fa-circle-notch animate-spin mr-2" />{busy}</p>}
        {error && <p role="alert" className="rounded-lg bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">{error}</p>}
      </div>
    </div>
  );
};

export default BounceDialog;
