import React, { useEffect, useRef, useState } from 'react';
import type { Clip, Track } from '../types';
import type { CorrectStyle } from '../utils/pitchCorrect';
import { correctClipsBatch, pitchBatchReason, PitchBatchResult } from '../utils/pitchBatch';
import { keyLabelFr, NOTE_NAMES_FR, SCALE_CHOICES } from '../utils/scales';

/**
 * « Justesse : corriger tout (n clips) » : la correction du bouton « Corriger
 * tout dans la gamme » de l'éditeur, sur toute une sélection de clips, avec
 * le dosage et le style. Un seul « Appliquer » = une seule annulation (Ctrl+Z).
 */
interface Props {
  open: boolean;
  targets: { trackId: string; clipId: string }[];
  tracks: Track[];
  projectKey?: number;
  projectScale?: string;
  /** Applique tous les changements en UN setState. */
  onApply: (patches: PitchBatchResult['patches'], message: string) => void;
  onClose: () => void;
}

async function getCtx(): Promise<BaseAudioContext | null> {
  try {
    const { audioEngine } = await import('../engine/AudioEngine');
    if (!audioEngine.ctx) await audioEngine.init();
    return audioEngine.ctx;
  } catch { return null; }
}

const PitchBatchDialog: React.FC<Props> = ({ open, targets, tracks, projectKey, projectScale, onApply, onClose }) => {
  const [amount, setAmount] = useState(80);
  const [style, setStyle] = useState<CorrectStyle>('naturel');
  const projectKnown = typeof projectKey === 'number' && !!projectScale;
  const [root, setRoot] = useState<number | ''>(projectKnown ? projectKey! : '');
  const [scale, setScale] = useState<string>(projectScale || 'MINOR');
  const [busy, setBusy] = useState<{ done: number; total: number; label: string } | null>(null);
  const [error, setError] = useState('');
  const cancelRef = useRef(false);

  // À chaque ouverture : gamme du projet (connue seulement une fois le projet chargé).
  useEffect(() => {
    if (!open) return;
    cancelRef.current = false; setBusy(null); setError('');
    setRoot(projectKnown ? projectKey! : '');
    setScale(projectScale || 'MINOR');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => { cancelRef.current = true; }, []);
  if (!open) return null;

  const items = targets.map(t => {
    const track = tracks.find(x => x.id === t.trackId);
    const clip = track?.clips.find(c => c.id === t.clipId);
    return clip && track ? { trackId: t.trackId, clip, track, reason: pitchBatchReason(clip) } : null;
  }).filter(Boolean) as { trackId: string; clip: Clip; track: Track; reason: string | null }[];
  const ok = items.filter(i => !i.reason);
  const close = () => { cancelRef.current = true; onClose(); };

  const run = async () => {
    setError('');
    const ctx = await getCtx();
    if (!ctx) { setError("Le moteur audio n'a pas démarré : lance la lecture une fois puis réessaie."); return; }
    setBusy({ done: 0, total: 1, label: 'Je prépare…' });
    try {
      const res = await correctClipsBatch(ctx, ok.map(i => ({ trackId: i.trackId, clip: i.clip })), {
        amount: amount / 100, style, key: root === '' ? undefined : { root, scale },
        onProgress: (done, total, label) => setBusy({ done, total, label }),
        cancelled: () => cancelRef.current,
      });
      if (cancelRef.current) return;
      if (!res.patches.length) {
        setBusy(null);
        setError(res.skipped.length ? `Rien à corriger : ${res.skipped.map(s => `« ${s.name} » (${s.reason})`).join(', ')}.` : 'Rien à corriger.');
        return;
      }
      const n = res.patches.length;
      const skipped = [...items.filter(i => i.reason).map(i => `« ${i.clip.name} » (${i.reason})`), ...res.skipped.map(s => `« ${s.name} » (${s.reason})`)];
      const keyTxt = res.key && typeof res.key.root === 'number' ? ` en ${keyLabelFr(res.key.root, res.key.scale)}${(res.key as any).guessed ? ' (devinée)' : ''}` : '';
      onApply(res.patches, `🎯 Justesse corrigée sur ${n} clip${n > 1 ? 's' : ''}${keyTxt}, ${amount} % ${style === 'robot' ? 'robot' : 'naturel'} : les prises d'origine sont gardées (Ctrl+Z pour tout annuler).${skipped.length ? ` Laissés tels quels : ${skipped.join(', ')}.` : ''}`);
      onClose();
    } catch (e: any) {
      setBusy(null);
      setError(`Correction impossible : ${e?.message || e}`);
    }
  };

  const pct = busy ? Math.round((busy.done / Math.max(1, busy.total)) * 100) : 0;
  return (
    <div className="fixed inset-0 z-[720] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="pitch-batch-title" onClick={busy ? undefined : close}>
      <div className="w-full max-w-lg rounded-t-2xl border border-white/10 bg-[#121418] p-5 shadow-2xl sm:rounded-2xl" onClick={e => e.stopPropagation()} data-testid="pitch-batch">
        <div className="mb-3 flex items-start gap-3">
          <div className="mr-auto min-w-0">
            <h2 id="pitch-batch-title" className="text-[16px] font-black text-white">🎯 Justesse : corriger tout ({ok.length} clip{ok.length > 1 ? 's' : ''})</h2>
            <p className="mt-0.5 text-[11.5px] text-slate-400">Chaque note revient vers la note de la gamme la plus proche, comme « Corriger tout » dans l’éditeur. Tes retouches à la main sont gardées, les prises d’origine aussi.</p>
          </div>
          <button type="button" onClick={close} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-lg bg-white/5 text-slate-300">✕</button>
        </div>
        <ul className="mb-3 max-h-32 space-y-1 overflow-y-auto text-[12px]" data-testid="pitch-batch-list">
          {items.map(i => (
            <li key={i.clip.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: i.clip.color || i.track.color }} />
              <span className="mr-auto min-w-0 truncate text-white">{i.track.name} · {i.clip.name}</span>
              {i.reason ? <span className="text-amber-300/90">ignoré : {i.reason}</span> : i.clip.pitchEdit ? <span className="text-cyan-300/80">déjà corrigé : refait</span> : null}
            </li>
          ))}
        </ul>
        <label className="flex items-center gap-3" title="0 % : rien ne bouge · 100 % : chaque note pile sur la gamme">
          <span className="w-20 text-[12px] font-bold text-slate-200">Dosage</span>
          <input type="range" min={5} max={100} step={5} value={amount} disabled={!!busy} onChange={e => setAmount(Number(e.target.value))}
            aria-label="Dosage de la correction" data-testid="pitch-batch-amount" className="flex-1 accent-cyan-400" style={{ minHeight: 32 }} />
          <span className="w-12 text-right font-mono text-[13px] font-black text-cyan-300">{amount} %</span>
        </label>
        <div className="mt-3 flex items-center gap-3">
          <span className="w-20 text-[12px] font-bold text-slate-200">Style</span>
          <div role="radiogroup" aria-label="Style de correction" className="flex flex-1 overflow-hidden rounded-lg border border-white/10">
            {([['naturel', 'Naturel', 'Garde la vie de ta voix : glissades, vibrato'], ['robot', 'Robot', 'Notes droites, sauts nets : l’effet Auto-Tune du rap']] as const).map(([id, label, hint]) => (
              <button key={id} type="button" role="radio" aria-checked={style === id} title={hint} disabled={!!busy} data-testid={`pitch-batch-style-${id}`}
                onClick={() => setStyle(id)}
                className={`min-h-[44px] flex-1 px-3 text-[12px] font-black ${style === id ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{label}</button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-slate-300">
          <span className="w-20 font-bold text-slate-200">Gamme</span>
          <select aria-label="Tonique" value={root === '' ? '' : String(root)} disabled={!!busy} onChange={e => setRoot(e.target.value === '' ? '' : Number(e.target.value))}
            className="min-h-[40px] rounded-md border border-white/10 bg-black/40 px-2 text-white">
            <option value="">devinée d’après ta voix</option>
            {NOTE_NAMES_FR.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
          {root !== '' && (
            <select aria-label="Gamme" value={scale} disabled={!!busy} onChange={e => setScale(e.target.value)} className="min-h-[40px] rounded-md border border-white/10 bg-black/40 px-2 text-white">
              {SCALE_CHOICES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          )}
          {projectKnown && root === projectKey && scale === projectScale && <span className="text-[11px] text-slate-500">celle du projet</span>}
        </div>
        {busy && (
          <div className="mt-4" role="status" data-testid="pitch-batch-progress">
            <div className="mb-1 text-[12px] text-slate-300"><i className="fas fa-circle-notch fa-spin mr-2 text-cyan-300" aria-hidden />{busy.label}</div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${pct}%` }} /></div>
          </div>
        )}
        {error && <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200" role="alert">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={close} className="h-11 rounded-lg bg-white/5 px-4 text-[12px] font-bold text-slate-300">{busy ? 'Arrêter' : 'Annuler'}</button>
          <button type="button" disabled={!!busy || !ok.length} onClick={() => void run()} data-testid="pitch-batch-apply"
            className="h-11 rounded-lg bg-cyan-500 px-4 text-[12px] font-black text-black disabled:cursor-not-allowed disabled:opacity-40">
            Corriger {ok.length} clip{ok.length > 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PitchBatchDialog;
