import React, { useState } from 'react';
import { keyName, planSummary } from '../utils/beatSwap';
import type { BeatInfo } from '../utils/beatSwap';
import type { R23Api } from '../hooks/useR23';

/**
 * R23 · « Remplacer l'instru… » : on garde les voix, on change de beat.
 * Étapes : choisir le beat (store ou fichier) → écoute des deux beats (tempo,
 * tonalité, premier temps) → plan, alertes et réglages → rendu des voix →
 * carte de résultat (Avant / Après, « Revenir à l'ancien beat »).
 * Téléphone : version simple (le plan, les alertes, un bouton).
 */
const r1 = (v: number) => (Math.round(v * 10) / 10).toString().replace('.', ',');
const from = (f?: string) => (f === 'catalogue' ? 'annoncé par le store' : f === 'projet' ? 'du projet' : f === 'écoute' ? 'détecté à l’écoute' : '');

const BeatCard: React.FC<{ label: string; info: BeatInfo | null; accent?: boolean; testid: string }> = ({ label, info, accent, testid }) => (
  <div data-testid={testid} className={`flex-1 min-w-0 rounded-xl border px-3 py-2 ${accent ? 'border-nv-accent/60 bg-nv-accent/10' : 'border-nv-line bg-nv-well'}`}>
    <p className="text-[10px] font-bold uppercase tracking-wide text-nv-muted">{label}</p>
    {info ? (
      <>
        <p className="truncate text-[12px] font-bold text-nv-ink" title={info.title}>{info.title || 'Beat'}</p>
        <p className="text-[12px] text-nv-ink"><b className="tabular-nums">{r1(info.bpm)} BPM</b> <span className="text-[10px] text-nv-muted" title="D'où vient le tempo">{from(info.bpmFrom)}</span></p>
        <p className="text-[12px] text-nv-ink"><b>{keyName(info.key)}</b> <span className="text-[10px] text-nv-muted">{from(info.keyFrom)}</span></p>
        <p className="text-[10px] text-nv-muted" title="Premier temps fort du beat (le « 1 » de la première mesure) : c'est lui qui aligne tes voix.">1er temps à <span className="tabular-nums">{info.downbeat.toFixed(3).replace('.', ',')} s</span></p>
      </>
    ) : <p className="text-[11px] text-nv-muted">…</p>}
  </div>
);

export const BeatSwapDialog: React.FC<{ api: R23Api; compact?: boolean; onChooseFile: (f: File) => void }> = ({ api, compact, onChooseFile }) => {
  const s = api.swap;
  const [fine, setFine] = useState(false);
  if (!s) return null;
  if (s.phase === 'store') {
    return (
      <div role="status" data-testid="beatswap-waiting" className="fixed left-1/2 -translate-x-1/2 top-16 z-[560] max-w-[calc(100vw-16px)] rounded-2xl border border-nv-accent/60 bg-nv-panel px-3 py-2 shadow-2xl flex items-center gap-2">
        <i className="fas fa-random text-nv-accent" />
        <p className="text-[12px] text-nv-ink">Choisis le nouveau beat dans le store (« Essayer ») : tes voix seront recalées dessus.</p>
        <button type="button" onClick={api.closeSwap} className="nova-hit-tactile h-8 shrink-0 rounded-lg bg-nv-well px-2.5 text-[11px] font-bold text-nv-ink">Annuler</button>
      </div>
    );
  }
  const p = s.plan;
  const fileRef = React.createRef<HTMLInputElement>();
  const busy = s.phase === 'analyzing' || s.phase === 'rendering';
  const offset = s.opts.offsetMs || 0;
  const shift = s.opts.beatShift || 0;
  return (
    <div className="fixed inset-0 z-[760] flex items-end sm:items-center justify-center bg-black/50 p-2 sm:p-3" onMouseDown={e => { if (e.target === e.currentTarget && !busy) api.closeSwap(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="beatswap-title" data-testid="beat-swap-dialog"
        className={`w-full ${compact ? 'max-w-[440px]' : 'max-w-[560px]'} max-h-[92vh] overflow-y-auto rounded-2xl border border-nv-line bg-nv-panel p-4 shadow-2xl flex flex-col gap-3`}>
        <div className="flex items-center gap-2">
          <i className="fas fa-random text-nv-accent" />
          <h2 id="beatswap-title" className="flex-1 text-[15px] font-bold text-nv-ink">Changer de beat, garder ta voix</h2>
          <button type="button" onClick={api.closeSwap} aria-label="Fermer" disabled={s.phase === 'rendering'} className="nova-hit-tactile w-9 h-9 rounded-lg text-nv-muted hover:text-nv-ink disabled:opacity-30"><i className="fas fa-times" /></button>
        </div>

        {s.phase === 'choose' && (
          <>
            <p className="text-[12px] leading-snug text-nv-muted">Choisis le nouveau beat : tes voix passent dessus, recalées sur son tempo et transposées dans sa tonalité. Ton projet ne change qu’à la fin (une seule annulation pour revenir).</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" data-testid="beatswap-store" onClick={api.waitStore} title="Ouvre le store : le beat que tu choisis remplace l'instru (tes voix sont gardées)."
                className="nova-hit-tactile h-12 flex-1 rounded-xl bg-nv-accent text-[13px] font-bold text-black"><i className="fas fa-store mr-2" />Choisir dans le store</button>
              <button type="button" data-testid="beatswap-file" onClick={() => fileRef.current?.click()} title="Un beat de ton ordinateur (WAV, MP3, AIFF, FLAC…)."
                className="nova-hit-tactile h-12 flex-1 rounded-xl border border-nv-line bg-nv-well text-[13px] font-bold text-nv-ink"><i className="fas fa-folder-open mr-2" />Un fichier de ton ordi</button>
              <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a" className="hidden" data-testid="beatswap-file-input"
                onChange={e => { const f = e.target.files?.[0]; if (f) onChooseFile(f); e.target.value = ''; }} />
            </div>
            <p className="text-[11px] text-nv-muted"><i className="fas fa-lightbulb mr-1 text-amber-400" />Astuce : tu peux aussi glisser un beat sur la piste BEAT.</p>
          </>
        )}

        {s.phase === 'analyzing' && (
          <div className="flex items-center gap-3 rounded-xl bg-nv-well px-3 py-4" role="status" data-testid="beatswap-analyzing">
            <i className="fas fa-circle-notch fa-spin text-nv-accent" />
            <p className="text-[12px] text-nv-ink">J’écoute les deux beats : tempo, tonalité et premier temps…</p>
          </div>
        )}

        {(s.phase === 'ready' || s.phase === 'rendering') && p && (
          <>
            <div className="flex gap-2">
              <BeatCard label="Ancien beat" info={s.oldInfo} testid="beatswap-old" />
              <div className="self-center text-nv-muted"><i className="fas fa-arrow-right" /></div>
              <BeatCard label="Nouveau beat" info={s.newInfo} accent testid="beatswap-new" />
            </div>
            <p data-testid="beatswap-plan" className="rounded-xl bg-nv-well px-3 py-2 text-[12px] leading-snug text-nv-ink">
              <b>Tes voix ({s.voices} clip{s.voices > 1 ? 's' : ''}) :</b> {planSummary(p)}. Le premier temps de l’ancien beat tombe sur celui du nouveau ; repères et accords suivent.
            </p>
            {p.warnings.map((w, i) => (
              <p key={i} role="alert" data-testid="beatswap-warning" className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12px] leading-snug text-amber-200">
                <i className="fas fa-exclamation-triangle mr-1.5" />{w}
              </p>
            ))}
            {!compact || fine ? (
              <div className="flex flex-col gap-2 rounded-xl border border-nv-line px-3 py-2.5">
                <label className="flex items-center gap-2 text-[12px] text-nv-ink" title="Étirement non destructif (l'original est gardé) : chaque attaque tombe à sa place sur la grille du nouveau beat.">
                  <input type="checkbox" checked={p.retime} onChange={e => api.setOptions({ retime: e.target.checked })} data-testid="beatswap-retime" className="accent-cyan-500 w-4 h-4" />
                  Recaler les voix sur le nouveau tempo
                </label>
                <label className="flex items-center gap-2 text-[12px] text-nv-ink" title="Transposition PSOLA, formants gardés : la voix garde son timbre (pas d'effet « chipmunk »).">
                  <input type="checkbox" checked={p.transpose && !!p.fromKey && !!p.toKey} disabled={!p.fromKey || !p.toKey} onChange={e => api.setOptions({ transpose: e.target.checked })} data-testid="beatswap-transpose" className="accent-cyan-500 w-4 h-4" />
                  Transposer les voix dans la tonalité du beat
                </label>
                {p.transpose && p.altSemitones !== null && (
                  <div role="radiogroup" aria-label="Sens de la transposition" className="flex gap-1 rounded-xl bg-nv-well p-1">
                    {[p.semitones, p.altSemitones].sort((a, b) => Math.abs(a) - Math.abs(b)).map(v => (
                      <button key={v} type="button" role="radio" aria-checked={p.semitones === v} data-testid={`beatswap-st-${v}`} onClick={() => api.setOptions({ semitones: v })}
                        title={Math.abs(v) <= 6 ? 'Le plus court : la voix bouge le moins (le plus naturel).' : 'L’autre sens : plus loin, à réserver à un effet voulu.'}
                        className={`nova-hit-tactile flex-1 h-8 rounded-lg text-[12px] font-bold ${p.semitones === v ? 'bg-nv-accent text-black' : 'text-nv-muted hover:text-nv-ink'}`}>
                        {v > 0 ? '+' : '−'}{Math.abs(v)} demi-ton{Math.abs(v) > 1 ? 's' : ''}{Math.abs(v) <= 6 ? ' (le plus court)' : ''}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-bold text-nv-muted" title="Si le premier temps a été mal deviné, décale tes voix d'un temps entier.">Premier temps</span>
                  <button type="button" onClick={() => api.setOptions({ beatShift: shift - 1 })} data-testid="beatswap-shift-minus" title="Voix un temps plus tôt" className="nova-hit-tactile h-8 rounded-lg bg-nv-well px-2.5 text-[11px] font-bold text-nv-ink">◀ 1 temps</button>
                  <span className="tabular-nums text-[11px] text-nv-ink min-w-[54px] text-center">{shift ? `${shift > 0 ? '+' : '−'}${Math.abs(shift)} temps` : 'auto'}</span>
                  <button type="button" onClick={() => api.setOptions({ beatShift: shift + 1 })} data-testid="beatswap-shift-plus" title="Voix un temps plus tard" className="nova-hit-tactile h-8 rounded-lg bg-nv-well px-2.5 text-[11px] font-bold text-nv-ink">1 temps ▶</button>
                </div>
                <label className="flex items-center gap-2 text-[11px] text-nv-muted" title="Réglage fin du calage (en millisecondes) : + = voix plus tard.">
                  <span className="font-bold">Réglage fin</span>
                  <input type="range" min={-120} max={120} step={1} value={offset} onChange={e => api.setOptions({ offsetMs: Number(e.target.value) })} data-testid="beatswap-offset" className="flex-1 accent-cyan-500" />
                  <span className="tabular-nums w-14 text-right text-nv-ink">{offset > 0 ? '+' : offset < 0 ? '−' : ''}{Math.abs(offset)} ms</span>
                </label>
              </div>
            ) : (
              <button type="button" onClick={() => setFine(true)} className="nova-hit-tactile h-9 rounded-xl bg-nv-well text-[12px] font-bold text-nv-muted">Réglages (tempo, tonalité, calage)</button>
            )}
            {s.phase === 'rendering' && s.progress && (
              <div role="status" data-testid="beatswap-progress" className="flex flex-col gap-1.5 rounded-xl bg-nv-well px-3 py-2">
                <p className="text-[12px] text-nv-ink"><i className="fas fa-circle-notch fa-spin mr-2 text-nv-accent" />Je recale tes voix : {s.progress.i}/{s.progress.n} {s.progress.name ? `(« ${s.progress.name} »)` : ''}</p>
                <div className="h-1.5 rounded-full bg-nv-line overflow-hidden"><div className="h-full bg-nv-accent transition-all" style={{ width: `${Math.round((s.progress.i / Math.max(1, s.progress.n)) * 100)}%` }} /></div>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={api.closeSwap} className="nova-hit-tactile h-11 flex-1 rounded-xl bg-nv-well text-[12px] font-bold text-nv-ink">{s.phase === 'rendering' ? 'Arrêter' : 'Annuler'}</button>
              <button type="button" onClick={() => void api.confirmSwap()} disabled={s.phase === 'rendering'} data-testid="beatswap-go"
                title="Ton projet change en une seule étape : Ctrl+Z (ou « Revenir à l'ancien beat ») remet tout comme avant."
                className="nova-hit-tactile h-11 flex-[2] rounded-xl bg-nv-accent text-[13px] font-bold text-black disabled:opacity-50">Remplacer l’instru</button>
            </div>
          </>
        )}

        {s.phase === 'error' && (
          <>
            <p role="alert" className="rounded-xl border border-red-500/50 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{s.error}</p>
            <div className="flex gap-2">
              <button type="button" onClick={api.closeSwap} className="nova-hit-tactile h-10 flex-1 rounded-xl bg-nv-well text-[12px] font-bold text-nv-ink">Fermer</button>
              {s.source && <button type="button" onClick={() => void api.chooseSource(s.source!)} className="nova-hit-tactile h-10 flex-1 rounded-xl bg-nv-accent text-[12px] font-bold text-black">Réessayer</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/** Après le changement : Avant / Après (annuler / rétablir), revenir, garder. */
export const BeatSwapResultCard: React.FC<{ api: R23Api; compact?: boolean }> = ({ api, compact }) => {
  const r = api.result;
  if (!r) return null;
  return (
    <div role="dialog" aria-label="Nouveau beat posé" data-testid="beat-swap-result"
      className={`fixed z-[545] ${compact ? 'inset-x-2 bottom-[calc(8.5rem+env(safe-area-inset-bottom))]' : 'right-4 bottom-24 w-[400px]'} rounded-2xl border border-nv-accent/50 bg-nv-panel p-3 shadow-2xl flex flex-col gap-2`}>
      <p className="text-[13px] font-bold text-nv-ink"><i className="fas fa-random mr-1.5 text-nv-accent" />Nouveau beat : « {r.title} »</p>
      <p className="text-[11px] leading-snug text-nv-muted">{planSummary(r.plan)}</p>
      <div role="radiogroup" aria-label="Écouter" className="flex gap-1 rounded-xl bg-nv-well p-1">
        {(['before', 'after'] as const).map(w => (
          <button key={w} type="button" role="radio" aria-checked={r.showing === w} data-testid={`beatswap-show-${w}`} onClick={() => api.showSwap(w)}
            title={w === 'before' ? 'Écoute l’ancien beat avec tes voix d’origine' : 'Écoute le nouveau beat avec tes voix recalées'}
            className={`nova-hit-tactile flex-1 h-9 rounded-lg text-[12px] font-bold ${r.showing === w ? 'bg-nv-accent text-black' : 'text-nv-muted hover:text-nv-ink'}`}>{w === 'before' ? 'Avant' : 'Après'}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={api.revertSwap} data-testid="beatswap-revert" title="Une seule annulation : l'ancien beat, tes voix d'origine, le tempo et la tonalité reviennent."
          className="nova-hit-tactile h-10 flex-1 rounded-xl border border-nv-line bg-nv-well text-[12px] font-bold text-nv-ink">Revenir à l’ancien beat</button>
        <button type="button" onClick={api.keepSwap} data-testid="beatswap-keep" className="nova-hit-tactile h-10 flex-1 rounded-xl bg-nv-accent text-[12px] font-bold text-black">Garder le nouveau</button>
      </div>
    </div>
  );
};
