import React from 'react';
import { REASON_TIP } from '../utils/repunch';
import { r23Bus, redoSpotsStore, useRedoSpots, useSelectedSpot } from '../utils/r23Store';
import type { R23Api } from '../hooks/useR23';

/**
 * R23 · Repunch intelligent, l'interface :
 *  - RedoSpotsOverlay : les passages « à refaire » sur la timeline (bandeau
 *    rouge en bas de la piste, raisons en infobulle, « Refaire ») ;
 *  - RepunchCompareCard : après la prise, avant / après et choix ;
 *  - R23VoiceTools : les deux boutons du panneau voix (PC, tablette, téléphone).
 */
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;

export const RedoSpotsOverlay: React.FC<{
  rows: { trackId: string; top: number; height: number }[];
  zoomH: number; scrollLeft: number; width: number; coarse?: boolean;
}> = ({ rows, zoomH, scrollLeft, width, coarse }) => {
  const spots = useRedoSpots();
  const selected = useSelectedSpot();
  if (!spots.length) return null;
  const bandH = coarse ? 30 : 22;
  return (
    <>
      {spots.map(s => {
        const row = rows.find(r => r.trackId === s.trackId);
        if (!row) return null;
        const x = s.start * zoomH - scrollLeft, w = Math.max(14, (s.end - s.start) * zoomH);
        if (x > width || x + w < 0) return null;
        const top = row.top + row.height - bandH - 3;
        const tip = `À refaire (${fmt(s.start)} → ${fmt(s.end)}) — note ${s.score.total}/100\n` + s.reasons.map(r => `• ${REASON_TIP[r]}`).join('\n');
        const isSel = selected === s.id;
        return (
          <div key={s.id} data-testid="redo-spot" data-spot-id={s.id} data-start={s.start} data-end={s.end}
            style={{ position: 'absolute', left: x, top, width: w, height: bandH, pointerEvents: 'auto' }}
            className={`rounded-md border ${isSel ? 'border-red-300 bg-red-500/45' : 'border-red-400/70 bg-red-500/25'} flex items-center gap-1 px-1 overflow-visible`}
            title={tip} onClick={e => { e.stopPropagation(); redoSpotsStore.select(isSel ? null : s.id); }}>
            <i className="fas fa-redo text-[10px] text-red-200 shrink-0" />
            {w > 120 && <span className="truncate text-[10px] font-bold text-red-100">À refaire · {s.label}</span>}
            {w > 60 && (
              <button type="button" data-testid="redo-spot-go" onClick={e => { e.stopPropagation(); r23Bus.emit({ kind: 'redo', spotId: s.id }); }}
                title="Pose la zone de punch sur ce passage (avec pré-roll), arme la piste et lance l'enregistrement"
                className={`ml-auto shrink-0 rounded ${coarse ? 'h-6 px-2' : 'h-4 px-1.5'} bg-red-500 text-[10px] font-black text-white hover:bg-red-400`}>Refaire</button>
            )}
            {isSel && (
              <div role="dialog" aria-label="Passage à refaire" data-testid="redo-spot-pop" onClick={e => e.stopPropagation()}
                style={{ position: 'absolute', left: Math.max(-x, Math.min(0, width - x - 260)), ...(top < 150 ? { top: bandH + 4 } : { bottom: bandH + 4 }), minWidth: 240, zIndex: 5 }}
                className="rounded-xl border border-nv-line bg-nv-panel p-2.5 shadow-2xl flex flex-col gap-1.5">
                <p className="text-[12px] font-bold text-nv-ink">À refaire : {s.label}</p>
                <p className="text-[10px] text-nv-muted tabular-nums">{fmt(s.start)} → {fmt(s.end)} · justesse {s.score.pitch} · calage {s.score.timing} · niveau {s.score.level} · bruit {s.score.noise}</p>
                {s.reasons.map(r => <p key={r} className="text-[11px] leading-snug text-nv-ink">• {REASON_TIP[r]}</p>)}
                <div className="flex gap-1.5 pt-1">
                  <button type="button" onClick={() => r23Bus.emit({ kind: 'listenSpot', spotId: s.id })} className="nova-hit-tactile h-8 flex-1 rounded-lg bg-nv-well text-[11px] font-bold text-nv-ink"><i className="fas fa-play mr-1" />Écouter</button>
                  <button type="button" onClick={() => r23Bus.emit({ kind: 'redo', spotId: s.id })} className="nova-hit-tactile h-8 flex-[1.4] rounded-lg bg-red-500 text-[11px] font-bold text-white">Refaire ce passage</button>
                  <button type="button" onClick={() => r23Bus.emit({ kind: 'dismissSpot', spotId: s.id })} title="Ce passage me va : retirer le repère" className="nova-hit-tactile h-8 w-8 rounded-lg bg-nv-well text-[11px] text-nv-muted"><i className="fas fa-times" /></button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
};

export const RepunchCompareCard: React.FC<{ api: R23Api; compact?: boolean }> = ({ api, compact }) => {
  const c = api.compare;
  if (!c) return null;
  const tone = c.verdict.better === 'new' ? 'text-emerald-300' : c.verdict.better === 'old' ? 'text-amber-200' : 'text-nv-ink';
  return (
    <div role="dialog" aria-label="Passage refait : avant / après" data-testid="repunch-compare"
      className={`fixed z-[545] ${compact ? 'inset-x-2 bottom-[calc(8.5rem+env(safe-area-inset-bottom))]' : 'right-4 bottom-24 w-[400px]'} rounded-2xl border border-red-400/50 bg-nv-panel p-3 shadow-2xl flex flex-col gap-2`}>
      <p className="text-[13px] font-bold text-nv-ink"><i className="fas fa-redo mr-1.5 text-red-300" />Passage refait — « {c.trackName} »{c.others ? ` (+${c.others} piste${c.others > 1 ? 's' : ''})` : ''}</p>
      <div className="flex items-center gap-3 text-[12px] text-nv-ink">
        <span>Avant <b className="tabular-nums" data-testid="repunch-before">{c.before?.total ?? '—'}</b>/100</span>
        <i className="fas fa-arrow-right text-nv-muted" />
        <span>Après <b className="tabular-nums" data-testid="repunch-after">{c.after?.total ?? '—'}</b>/100</span>
      </div>
      <p className={`text-[11px] leading-snug ${tone}`} data-testid="repunch-verdict">{c.verdict.text}</p>
      <div role="radiogroup" aria-label="Écouter" className="flex gap-1 rounded-xl bg-nv-well p-1">
        {(['before', 'after'] as const).map(w => (
          <button key={w} type="button" role="radio" aria-checked={c.showing === w} data-testid={`repunch-show-${w}`} onClick={() => api.showCompare(w)}
            title={w === 'before' ? 'Écoute l’ancienne prise sur ce passage (lecture une mesure avant)' : 'Écoute la nouvelle prise'}
            className={`nova-hit-tactile flex-1 h-9 rounded-lg text-[12px] font-bold ${c.showing === w ? 'bg-nv-accent text-black' : 'text-nv-muted hover:text-nv-ink'}`}>{w === 'before' ? '▶ Ancienne' : '▶ Nouvelle'}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={api.keepOld} data-testid="repunch-keep-old" className="nova-hit-tactile h-10 flex-1 rounded-xl border border-nv-line bg-nv-well text-[12px] font-bold text-nv-ink">Reprendre l’ancienne</button>
        <button type="button" onClick={api.keepNew} data-testid="repunch-keep-new" className="nova-hit-tactile h-10 flex-1 rounded-xl bg-nv-accent text-[12px] font-bold text-black">Garder la nouvelle</button>
      </div>
    </div>
  );
};

/** Boutons du panneau voix (et du téléphone). */
export const R23VoiceTools: React.FC<{ onAfter?: () => void; hasVoice: boolean }> = ({ onAfter, hasVoice }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="r23-tools">
    <button type="button" data-testid="r23-swap" onClick={() => { r23Bus.emit({ kind: 'openSwap' }); onAfter?.(); }}
      title="Remplace l'instru : tes voix passent sur le nouveau beat, recalées sur son tempo et transposées dans sa tonalité."
      className="nova-hit-tactile min-h-[48px] rounded-xl border border-nv-accent/50 bg-nv-accent/10 px-3 py-2 text-left">
      <span className="block text-[13px] font-bold text-nv-ink"><i className="fas fa-random mr-1.5 text-nv-accent" />Changer de beat</span>
      <span className="block text-[11px] text-nv-muted">tu gardes ta voix</span>
    </button>
    <button type="button" data-testid="r23-find" disabled={!hasVoice} onClick={() => { r23Bus.emit({ kind: 'findSpots' }); onAfter?.(); }}
      title={hasVoice ? 'Repère les passages ratés (justesse, calage, niveau, saturation, bruit) et propose de les refaire.' : 'Enregistre d’abord une prise.'}
      className="nova-hit-tactile min-h-[48px] rounded-xl border border-red-400/50 bg-red-500/10 px-3 py-2 text-left disabled:opacity-40">
      <span className="block text-[13px] font-bold text-nv-ink"><i className="fas fa-redo mr-1.5 text-red-300" />Refaire un passage</span>
      <span className="block text-[11px] text-nv-muted">je te montre ce qui est raté</span>
    </button>
  </div>
);

/**
 * Téléphone (version simple) : la timeline du téléphone est réduite, les
 * passages à refaire sont listés dans une feuille en bas de l'écran.
 */
export const RedoSpotsSheet: React.FC = () => {
  const spots = useRedoSpots();
  if (!spots.length) return null;
  return (
    <div role="dialog" aria-label="Passages à refaire" data-testid="redo-spots-sheet"
      className="fixed inset-x-2 bottom-[calc(8.5rem+env(safe-area-inset-bottom))] z-[540] max-h-[45vh] overflow-y-auto rounded-2xl border border-red-400/50 bg-nv-panel p-3 shadow-2xl flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[13px] font-bold text-nv-ink"><i className="fas fa-redo mr-1.5 text-red-300" />{spots.length} passage{spots.length > 1 ? 's' : ''} à refaire</p>
        <button type="button" onClick={() => r23Bus.emit({ kind: 'clearSpots' })} aria-label="Fermer" className="nova-hit-tactile w-9 h-9 rounded-lg text-nv-muted"><i className="fas fa-times" /></button>
      </div>
      {spots.map(s => (
        <div key={s.id} data-testid="redo-spot-row" className="rounded-xl bg-nv-well px-2.5 py-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-bold text-nv-ink truncate">{s.label}</p>
            <p className="text-[10px] text-nv-muted tabular-nums">{fmt(s.start)} → {fmt(s.end)} · note {s.score.total}/100</p>
          </div>
          <button type="button" onClick={() => r23Bus.emit({ kind: 'listenSpot', spotId: s.id })} aria-label="Écouter ce passage" className="nova-hit-tactile w-10 h-10 rounded-lg bg-nv-panel text-nv-ink"><i className="fas fa-play" /></button>
          <button type="button" data-testid="redo-spot-row-go" onClick={() => r23Bus.emit({ kind: 'redo', spotId: s.id })} className="nova-hit-tactile h-10 px-3 rounded-lg bg-red-500 text-[12px] font-bold text-white">Refaire</button>
        </div>
      ))}
    </div>
  );
};
