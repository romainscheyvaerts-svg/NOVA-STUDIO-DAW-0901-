import React, { useEffect, useState } from 'react';
import type { Track } from '../types';
import { KEPT_COLORS, KEPT_HEAD_H, KEPT_MAX_STARS, KEPT_TITLE, KeptLane, nextStars } from '../utils/keptTakes';
import { fmtTime } from '../utils/takes';
import { TAKE_LANE_H, TakeLanesApi } from './PlaylistLanes';

/**
 * 📌 Zone « Prises gardées » au-dessus d'une piste (utils/keptTakes).
 *
 * Partie gauche (colonne des en-têtes) : le titre de la zone (repliable,
 * « Vider » avec confirmation), puis une ligne par prise gardée : couleur,
 * écoute directe en solo, nom (renommable), note en étoiles, « Mettre sur la
 * piste », retirer (avec confirmation). Partie droite (au-dessus de la
 * timeline) : le bandeau de fin de prise (« 📌 Garder la Prise 4 ») et l'état
 * vide ; les lignes elles-mêmes sont les couloirs du comp (PlaylistLanes) :
 * on y balaie un passage pour le mettre dans la voix finale.
 * Tout est dans le flux de la piste : rien ne flotte par-dessus d'autres boutons.
 */

export interface KeptZoneApi {
  /** Zones repliées (absente : dépliée). */
  closed: Record<string, boolean>;
  onToggle: (trackId: string, open?: boolean) => void;
  /** n absent : la dernière prise de la piste. */
  onKeep: (trackId: string, n?: number | null) => boolean;
  onUnkeep: (trackId: string, n: number) => void;
  onClear: (trackId: string) => void;
  onRate: (trackId: string, n: number, stars: number) => void;
  onColor: (trackId: string, n: number, color: string | null) => void;
  /** Mettre sur la piste (la prise entière remplace ce qu'on entend). */
  onPut: (trackId: string, n: number) => void;
  /** Clip glissé vers le haut dans la playlist : il y ajoute sa ligne (il devient une prise s'il n'en est pas une). */
  onKeepClip: (trackId: string, clipId: string) => boolean;
}

/** Dernière prise de la piste, si elle n'est pas encore gardée (bandeau de fin de prise). */
export interface KeepCandidate { n: number; name: string }

const btn = 'nova-hit-tactile shrink-0 rounded-lg flex items-center justify-center text-[11px] transition-colors';

// ------------------------------------------------------------------ colonne des en-têtes

interface HeadersProps {
  track: Track;
  lanes: KeptLane[];
  open: boolean;
  api: KeptZoneApi;
  takeLanes: TakeLanesApi;
  /** Un clip est glissé au-dessus de la zone : elle s'allume. */
  dropHot?: boolean;
}

export const KeptZoneHeaders: React.FC<HeadersProps> = ({ track, lanes, open, api, takeLanes, dropHot }) => {
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRow, setConfirmRow] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => { if (!lanes.length) setConfirmClear(false); }, [lanes.length]);
  const commit = (n: number) => { takeLanes.onRename(track.id, n, draft); setEditing(null); };
  const count = lanes.length;
  return (
    <div data-kept-zone={track.id} data-kept-count={count} data-kept-open={open ? '1' : '0'}
      className={`border-b border-amber-400/30 ${dropHot ? 'bg-amber-400/20' : 'bg-amber-500/[0.06]'}`}>
      <div className="flex items-center gap-1 pl-2 pr-1" style={{ height: KEPT_HEAD_H }}>
        {confirmClear ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-amber-200">Vider les {count} prises gardées ?</span>
            <button type="button" data-testid="kept-clear-yes" onClick={() => { setConfirmClear(false); api.onClear(track.id); }}
              className="h-6 px-2 rounded-md bg-red-500 text-white text-[10px] font-black">Vider</button>
            <button type="button" data-testid="kept-clear-no" onClick={() => setConfirmClear(false)}
              className="h-6 px-2 rounded-md bg-white/10 text-slate-200 text-[10px] font-bold">Annuler</button>
          </>
        ) : (
          <>
            <button type="button" data-testid="kept-toggle" disabled={!count} aria-expanded={count ? open : undefined}
              onClick={() => api.onToggle(track.id)}
              title={count ? `${open ? 'Replier' : 'Déplier'} les prises gardées de « ${track.name} »` : 'Garde tes meilleures prises ici pour choisir à la fin'}
              className="min-w-0 flex-1 flex items-center gap-1.5 text-left disabled:cursor-default">
              <span aria-hidden className="text-[12px]">📌</span>
              <span className="truncate text-[11px] font-black text-amber-200">{KEPT_TITLE}{count ? ` (${count})` : ''}</span>
              {count > 0 && <i className={`fas ${open ? 'fa-chevron-up' : 'fa-chevron-down'} text-[8px] text-amber-200/80`} />}
            </button>
            {count > 0 && (
              <button type="button" data-testid="kept-clear" onClick={() => setConfirmClear(true)}
                aria-label="Vider la zone des prises gardées" title="Vider la zone (les prises restent dans leurs couloirs)"
                className={`${btn} w-6 h-6 bg-white/5 text-slate-400 hover:text-red-300 hover:bg-white/10`}>
                <i className="fas fa-trash-can text-[10px]" />
              </button>
            )}
          </>
        )}
      </div>
      {open && lanes.map(l => {
        const solo = takeLanes.audition?.trackId === track.id && takeLanes.audition.n === l.n;
        const used = l.used > 0.05;
        if (confirmRow === l.n) {
          return (
            <div key={l.n} data-kept-header={l.n} className="flex items-center gap-1 pl-2 pr-1 border-t border-white/5 bg-red-500/10" style={{ height: TAKE_LANE_H }}>
              <span className="min-w-0 flex-1 text-[11px] font-bold text-red-200 leading-tight">Retirer « {l.name} » de la zone ?<span className="block text-[9.5px] font-normal text-slate-400">Elle reste dans les couloirs de prises.</span></span>
              <button type="button" data-testid="kept-remove-yes" onClick={() => { setConfirmRow(null); api.onUnkeep(track.id, l.n); }}
                className="h-8 px-2 rounded-md bg-red-500 text-white text-[10px] font-black">Retirer</button>
              <button type="button" onClick={() => setConfirmRow(null)} className="h-8 px-2 rounded-md bg-white/10 text-slate-200 text-[10px] font-bold">Non</button>
            </div>
          );
        }
        return (
          <div key={l.n} data-kept-header={l.n} title={l.title}
            className={`flex items-center gap-1 pl-1 pr-1 border-t border-white/5 ${solo ? 'bg-amber-400/15' : ''}`}
            style={{ height: TAKE_LANE_H }}>
            <button type="button" aria-label={`Couleur de ${l.name}`} title="Changer la couleur de la ligne"
              onClick={() => { const i = KEPT_COLORS.indexOf(l.color); api.onColor(track.id, l.n, KEPT_COLORS[(i + 1) % KEPT_COLORS.length]); }}
              className="nova-hit-tactile w-2.5 self-stretch my-1 rounded-full shrink-0" style={{ background: l.color }} />
            <button type="button" data-testid="kept-play" aria-pressed={solo}
              aria-label={solo ? 'Revenir à ta voix finale' : `Écouter ${l.name} seule`}
              title={solo ? 'Revenir à ta voix finale (stop de l’écoute en solo)' : `Écouter ${l.name} seule, tout de suite`}
              onClick={() => takeLanes.onAudition(track.id, solo ? null : l.n)}
              className={`${btn} w-8 h-8 ${solo ? 'bg-amber-400 text-black' : 'bg-white/5 text-slate-200 hover:bg-white/10'}`}>
              <i className={`fas ${solo ? 'fa-stop' : 'fa-play'}`} />
            </button>
            <div className="min-w-0 flex-1 leading-tight">
              {editing === l.n ? (
                <input autoFocus value={draft} maxLength={40} aria-label={`Nouveau nom de ${l.name}`}
                  onChange={e => setDraft(e.target.value)} onBlur={() => commit(l.n)}
                  onKeyDown={e => { if (e.key === 'Enter') commit(l.n); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }}
                  className="w-full h-6 rounded-md bg-black/50 border border-amber-400/60 px-1.5 text-[11px] text-white outline-none" />
              ) : (
                <button type="button" data-testid="kept-name" onClick={() => { setDraft(l.meta?.name || l.name); setEditing(l.n); }}
                  title={`${l.title}\nTouche le nom pour le renommer`}
                  className={`block w-full truncate text-left text-[11px] font-bold ${used ? 'text-white' : 'text-slate-300'}`}>
                  {l.name}{used && <span className="ml-1 text-[9px] font-black text-emerald-300">· {Math.abs(l.used - l.duration) < 0.05 ? 'sur la piste' : 'en partie sur la piste'}</span>}
                </button>
              )}
              <span className="flex items-center gap-0.5">
                {Array.from({ length: KEPT_MAX_STARS }, (_, i) => i + 1).map(k => (
                  <button key={k} type="button" data-testid="kept-star" data-star={k}
                    aria-label={`${k} étoile${k > 1 ? 's' : ''} pour ${l.name}`} aria-pressed={l.stars >= k}
                    onClick={() => api.onRate(track.id, l.n, nextStars(l.stars, k))}
                    className={`nova-hit-tactile w-4 h-4 text-[12px] leading-none ${l.stars >= k ? 'text-amber-300' : 'text-slate-500 hover:text-amber-200'}`}>★</button>
                ))}
                <span className="ml-1 truncate text-[9.5px] text-slate-500">{fmtTime(l.duration)}</span>
              </span>
            </div>
            <button type="button" data-testid="kept-put" disabled={used && Math.abs(l.used - l.duration) < 0.05}
              aria-label={`Mettre ${l.name} sur la piste`} title={`Mettre ${l.name} sur la piste : c'est elle qu'on entend (Ctrl+Z pour revenir)`}
              onClick={() => api.onPut(track.id, l.n)}
              className={`${btn} h-8 px-1.5 gap-1 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-35 font-bold text-[10px]`}>
              <i className="fas fa-arrow-down-long text-[10px]" />Piste
            </button>
            <button type="button" data-testid="kept-remove" aria-label={`Retirer ${l.name} des prises gardées`} title="Retirer de la zone (la prise reste dans les couloirs)"
              onClick={() => setConfirmRow(l.n)}
              className={`${btn} w-7 h-8 bg-white/5 text-slate-400 hover:text-red-300 hover:bg-white/10`}>
              <i className="fas fa-xmark" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

// ------------------------------------------------------------------ bandeau au-dessus de la timeline

interface StripProps {
  track: Track;
  count: number;
  candidate: KeepCandidate | null;
  isRecording: boolean;
  api: KeptZoneApi;
  dropHot?: boolean;
  /** Un clip de prise est en train d'être glissé (on montre où le lâcher). */
  dragging?: boolean;
}

/** En-tête de la zone côté timeline : état vide, bandeau de fin de prise, aide au comp. */
export const KeptZoneStrip: React.FC<StripProps> = ({ track, count, candidate, isRecording, api, dropHot, dragging }) => {
  let text: string;
  if (dropHot) text = '📌 Lâche ici : une ligne de plus dans la playlist';
  else if (dragging) text = '📌 Glisse le clip ici (vers le haut) pour l’ajouter à la playlist';
  else if (isRecording) text = '🔴 Prise en cours… tu pourras la garder juste après.';
  else if (!count) text = 'Glisse une prise vers le haut ici pour garder tes meilleures prises : chacune ajoute une ligne';
  else if (candidate) text = `🎤 Dernière prise : ${candidate.name}`;
  else text = 'Écoute ▶, note ★, puis ⤓ Piste pour la prise entière — ou balaie un passage d’une ligne pour ton comp';
  return (
    <div data-kept-strip={track.id} className={`absolute left-0 right-0 flex items-center gap-2 px-2 border-b border-amber-400/30 ${dropHot ? 'bg-amber-400/25' : 'bg-amber-500/[0.06]'}`}
      style={{ height: KEPT_HEAD_H }}>
      <span className={`min-w-0 truncate text-[11px] ${count && !candidate && !dropHot ? 'text-slate-400' : 'font-bold text-amber-100'}`}>{text}</span>
      {candidate && !isRecording && !dragging && (
        <button type="button" data-testid="kept-keep-last" onClick={() => api.onKeep(track.id, candidate.n)}
          title={`Garder ${candidate.name} de côté pour choisir à la fin (Ctrl+Alt+P)`}
          className="nova-hit-tactile shrink-0 h-6 px-2.5 rounded-full bg-amber-400 text-black text-[11px] font-black pointer-events-auto hover:bg-amber-300">
          📌 Garder {candidate.name}
        </button>
      )}
      {isRecording && <DiscardTakeButton />}
    </div>
  );
};

/** Pendant la prise : la jeter (Ctrl+.), rien n'est gardé, retour au début (App : discardTakeRef). */
const DiscardTakeButton: React.FC<{ big?: boolean }> = ({ big }) => (
  <button type="button" data-testid="rec-discard" onClick={() => window.dispatchEvent(new CustomEvent('nova:discard-take'))}
    title="Jeter cette prise : rien n’est gardé, retour au début pour la refaire (Ctrl+.)"
    className={`nova-hit-tactile shrink-0 rounded-full bg-white/10 text-red-200 font-black pointer-events-auto hover:bg-red-500/30 ${big ? 'h-10 px-3 text-[13px]' : 'h-6 px-2.5 text-[11px]'}`}>
    🗑️ Jeter la prise
  </button>
);

// ------------------------------------------------------------------ téléphone : carte pleine largeur

interface CardProps {
  track: Track;
  lanes: KeptLane[];
  open: boolean;
  api: KeptZoneApi;
  candidate: KeepCandidate | null;
  isRecording: boolean;
  /** Prise écoutée en solo (null : la voix finale). */
  audition: { trackId: string; n: number } | null;
  onAudition: (trackId: string, n: number | null) => void;
  onRename: (trackId: string, n: number, name: string) => void;
}

/**
 * Téléphone : la zone devient une carte au-dessus des pistes (une colonne,
 * gros boutons au doigt). Le comp au balayage reste sur ordinateur / tablette ;
 * ici on écoute, on note, on met une prise entière sur la piste.
 */
export const KeptTakesCard: React.FC<CardProps> = ({ track, lanes, open, api, candidate, isRecording, audition, onAudition, onRename }) => {
  const [confirm, setConfirm] = useState<number | 'all' | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const count = lanes.length;
  const commit = (n: number) => { onRename(track.id, n, draft); setEditing(null); };
  return (
    <section data-kept-card={track.id} data-kept-count={count} aria-label={`Prises gardées de ${track.name}`}
      className="shrink-0 border-b border-amber-400/30 bg-amber-500/[0.07] px-3 py-2">
      <div className="flex items-center gap-2">
        <button type="button" data-testid="kept-toggle" disabled={!count} aria-expanded={count ? open : undefined} onClick={() => api.onToggle(track.id)}
          className="min-w-0 flex-1 flex items-center gap-2 text-left min-h-10">
          <span aria-hidden>📌</span>
          <span className="min-w-0 truncate text-[13px] font-black text-amber-200">{KEPT_TITLE}{count ? ` (${count})` : ''} · {track.name}</span>
          {count > 0 && <i className={`fas ${open ? 'fa-chevron-up' : 'fa-chevron-down'} text-[10px] text-amber-200/80`} />}
        </button>
        {candidate && !isRecording && (
          <button type="button" data-testid="kept-keep-last" onClick={() => api.onKeep(track.id, candidate.n)}
            className="shrink-0 h-10 px-3 rounded-full bg-amber-400 text-black text-[13px] font-black">📌 Garder {candidate.name}</button>
        )}
        {isRecording && <DiscardTakeButton big />}
      </div>
      {!count && <p className="mt-1 text-[12px] text-slate-400">{isRecording ? 'Prise en cours… tu pourras la garder juste après.' : 'Garde tes meilleures prises ici pour choisir à la fin.'}</p>}
      {open && count > 0 && (
        <ul className="mt-2 space-y-1.5 max-h-[38vh] overflow-y-auto">
          {lanes.map(l => {
            const solo = audition?.trackId === track.id && audition.n === l.n;
            const onTrack = l.used > 0.05 && Math.abs(l.used - l.duration) < 0.05;
            if (confirm === l.n) {
              return (
                <li key={l.n} data-kept-header={l.n} className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-400/30 p-2">
                  <span className="min-w-0 flex-1 text-[12px] font-bold text-red-200">Retirer « {l.name} » ? Elle reste dans les prises de la piste.</span>
                  <button type="button" data-testid="kept-remove-yes" onClick={() => { setConfirm(null); api.onUnkeep(track.id, l.n); }} className="h-10 px-3 rounded-lg bg-red-500 text-white text-[12px] font-black">Retirer</button>
                  <button type="button" onClick={() => setConfirm(null)} className="h-10 px-3 rounded-lg bg-white/10 text-[12px] font-bold">Non</button>
                </li>
              );
            }
            return (
              <li key={l.n} data-kept-header={l.n} className={`rounded-xl border p-2 ${solo ? 'border-amber-400/60 bg-amber-400/10' : 'border-white/10 bg-white/[0.03]'}`}
                style={{ borderLeft: `4px solid ${l.color}` }}>
                <div className="flex items-center gap-2">
                  <button type="button" data-testid="kept-play" aria-pressed={solo} aria-label={solo ? 'Revenir à ta voix finale' : `Écouter ${l.name} seule`}
                    onClick={() => onAudition(track.id, solo ? null : l.n)}
                    className={`shrink-0 w-11 h-11 rounded-xl text-[14px] ${solo ? 'bg-amber-400 text-black' : 'bg-white/10 text-white'}`}>
                    <i className={`fas ${solo ? 'fa-stop' : 'fa-play'}`} />
                  </button>
                  <div className="min-w-0 flex-1">
                    {editing === l.n ? (
                      <input autoFocus value={draft} maxLength={40} aria-label={`Nouveau nom de ${l.name}`} onChange={e => setDraft(e.target.value)} onBlur={() => commit(l.n)}
                        onKeyDown={e => { if (e.key === 'Enter') commit(l.n); if (e.key === 'Escape') setEditing(null); }}
                        className="w-full h-9 rounded-lg bg-black/40 border border-amber-400/60 px-2 text-[13px] text-white outline-none" />
                    ) : (
                      <button type="button" data-testid="kept-name" onClick={() => { setDraft(l.meta?.name || l.name); setEditing(l.n); }}
                        title="Touche le nom pour le renommer"
                        className="block w-full min-h-8 truncate text-left text-[13px] font-black text-white">{l.name}
                        <span className="ml-1 font-normal text-slate-400">· {fmtTime(l.duration)}</span>
                        {l.used > 0.05 && <span className="ml-1 text-[11px] font-black text-emerald-300">· {onTrack ? 'sur la piste' : 'en partie'}</span>}
                      </button>
                    )}
                    <span className="flex items-center gap-1">
                      {Array.from({ length: KEPT_MAX_STARS }, (_, i) => i + 1).map(k => (
                        <button key={k} type="button" data-testid="kept-star" data-star={k} aria-label={`${k} étoile${k > 1 ? 's' : ''} pour ${l.name}`} aria-pressed={l.stars >= k}
                          onClick={() => api.onRate(track.id, l.n, nextStars(l.stars, k))}
                          className={`nova-hit w-8 h-8 text-[18px] leading-none ${l.stars >= k ? 'text-amber-300' : 'text-slate-500'}`}>★</button>
                      ))}
                    </span>
                  </div>
                  <button type="button" data-testid="kept-put" disabled={onTrack} onClick={() => api.onPut(track.id, l.n)}
                    aria-label={`Mettre ${l.name} sur la piste`}
                    className="shrink-0 h-11 px-3 rounded-xl bg-emerald-500/20 text-emerald-200 text-[12px] font-black disabled:opacity-40">⤓ Piste</button>
                  <button type="button" data-testid="kept-remove" onClick={() => setConfirm(l.n)} aria-label={`Retirer ${l.name} des prises gardées`}
                    className="shrink-0 w-10 h-11 rounded-xl bg-white/5 text-slate-300"><i className="fas fa-xmark" /></button>
                </div>
              </li>
            );
          })}
          <li className="flex justify-end">
            {confirm === 'all' ? (
              <span className="flex items-center gap-2">
                <span className="text-[12px] font-bold text-red-200">Vider les {count} prises gardées ?</span>
                <button type="button" data-testid="kept-clear-yes" onClick={() => { setConfirm(null); api.onClear(track.id); }} className="h-10 px-3 rounded-lg bg-red-500 text-white text-[12px] font-black">Vider</button>
                <button type="button" onClick={() => setConfirm(null)} className="h-10 px-3 rounded-lg bg-white/10 text-[12px] font-bold">Annuler</button>
              </span>
            ) : (
              <button type="button" data-testid="kept-clear" onClick={() => setConfirm('all')} className="h-10 px-3 rounded-lg bg-white/5 text-[12px] font-bold text-slate-300">
                <i className="fas fa-trash-can mr-1.5 text-[11px]" />Vider la zone
              </button>
            )}
          </li>
        </ul>
      )}
    </section>
  );
};
