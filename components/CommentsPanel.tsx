import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CollabRole } from '../types';
import type { TimelineCommentsApi } from '../hooks/useTimelineComments';
import { commentCounts, CommentFilter, filterComments, fmtTime, posLabel, TimelineComment, visibleReplies } from '../utils/timelineComments';
import { fmtDate, MixVersion, nextVersionN, versionState, versionStatusLine } from '../utils/mixVersions';

/**
 * Chantier 11 · « Retours » : commentaires horodatés sur la timeline et
 * versions du mix envoyées / validées (le « Frame.io de la musique »).
 *
 *  - variant « side » : panneau à droite du studio (plein écran au téléphone) ;
 *  - variant « inline » : une carte dans l'écran de l'artiste invité
 *    (components/GuestStudio), au doigt.
 * Toute la logique est dans hooks/useTimelineComments.
 */

const ROLE_SHORT: Record<CollabRole, string> = { artist: 'artiste', engineer: 'ingé', beatmaker: 'beatmaker' };

/** « 1:12 », « 72 », « 1:12,5 » → secondes (null : illisible). */
export function parseTime(s: string): number | null {
  const v = s.trim().replace(',', '.');
  if (!v) return null;
  const m = v.match(/^(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/);
  if (m) { const sec = parseFloat(m[2]); return sec < 60 ? parseInt(m[1], 10) * 60 + sec : null; }
  if (/^\d+(?:\.\d+)?$/.test(v)) return parseFloat(v);
  return null;
}

const ago = (ms: number) => {
  const d = Math.max(0, Date.now() - ms);
  if (d < 60_000) return "à l'instant";
  if (d < 3_600_000) return `il y a ${Math.floor(d / 60_000)} min`;
  if (d < 86_400_000) return `il y a ${Math.floor(d / 3_600_000)} h`;
  return `le ${fmtDate(ms)}`;
};

export interface CommentsPanelProps {
  api: TimelineCommentsApi;
  variant: 'side' | 'inline';
  role: CollabRole | null;
  /** Nom de l'ingé (textes de l'artiste). */
  engineerName?: string | null;
  position: () => number;
  selection?: () => { start: number; end: number } | null;
  colorOf?: (authorKey: string) => string | undefined;
  /** Fermer (variant « side »). */
  onClose?: () => void;
  /** Au téléphone : plus grandes cibles. */
  touch?: boolean;
}

const CommentsPanel: React.FC<CommentsPanelProps> = ({ api, variant, role, engineerName, position, selection, colorOf, onClose, touch }) => {
  const [filter, setFilter] = useState<CommentFilter>('open');
  const counts = commentCounts(api.comments);
  const shown = filterComments(api.comments, filter);
  const big = touch || variant === 'inline';
  const btn = big ? 'min-h-11 rounded-xl px-3 text-[13px] font-bold' : 'min-h-8 rounded-lg px-2.5 text-[11px] font-bold';
  const listRef = useRef<HTMLDivElement>(null);
  const isArtist = role === 'artist';
  const canSend = role === 'engineer' || role === null;
  const eng = engineerName || "l'ingé";

  // Commentaire mis en avant (clic sur une puce de la règle) : visible dans la liste.
  useEffect(() => {
    if (!api.focusId) return;
    const c = api.comments.find(x => x.id === api.focusId);
    if (c) setFilter(c.archived.v ? 'archived' : c.status.v.s === 'resolved' ? 'resolved' : 'open');
    const id = window.setTimeout(() => listRef.current?.querySelector(`[data-id="${CSS.escape(api.focusId!)}"]`)?.scrollIntoView({ block: 'nearest' }), 50);
    return () => window.clearTimeout(id);
  }, [api.focusId]);

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex shrink-0 gap-1 ${variant === 'side' ? 'px-3 pt-2' : ''}`} role="tablist" aria-label="Retours">
        {(['comments', 'versions'] as const).map(t => (
          <button key={t} type="button" role="tab" aria-selected={api.tab === t} data-testid={`reviews-tab-${t}`} onClick={() => api.setTab(t)}
            className={`${btn} flex-1 ${api.tab === t ? 'bg-amber-400 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>
            {t === 'comments' ? `💬 Commentaires${counts.open ? ` · ${counts.open}` : ''}` : `📨 Versions${api.versions.length ? ` · ${api.versions.length}` : ''}`}
          </button>
        ))}
      </div>
      {api.busy && <p role="status" data-testid="reviews-busy" className="mx-3 mt-2 rounded-xl bg-cyan-500/15 px-3 py-2 text-[12px] font-bold text-cyan-100">⏳ {api.busy}</p>}
      <div ref={listRef} className={`min-h-0 flex-1 space-y-3 overflow-y-auto ${variant === 'side' ? 'p-3' : 'pt-3'}`}>
        {api.tab === 'comments' ? (
          <>
            <Composer api={api} position={position} selection={selection} big={big} />
            <div className="flex gap-1" role="radiogroup" aria-label="Quels commentaires">
              {([['open', 'Ouverts'], ['resolved', 'Résolus'], ['archived', 'Archivés']] as const).map(([f, label]) => (
                <button key={f} type="button" role="radio" aria-checked={filter === f} data-testid={`comments-filter-${f}`} onClick={() => setFilter(f)}
                  className={`${btn} flex-1 ${filter === f ? 'bg-white text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{label} · {counts[f]}</button>
              ))}
            </div>
            {shown.length === 0 ? (
              <p data-testid="comments-empty" className="rounded-2xl border border-dashed border-white/15 p-4 text-center text-[13px] text-slate-400">
                {filter === 'open' ? (api.comments.length ? 'Plus rien à régler : tous les commentaires sont résolus. 🎉' : 'Pas encore de commentaire. Écoute, mets sur pause là où ça ne va pas, et écris-le : il arrive tout de suite chez l’autre, au bon endroit.')
                  : filter === 'resolved' ? 'Aucun commentaire résolu pour l’instant.' : 'Rien aux archives.'}
              </p>
            ) : (
              <ul className="space-y-2" data-testid="comments-list">
                {shown.map(c => <CommentItem key={c.id} c={c} api={api} big={big} color={colorOf?.(c.authorKey)} focused={api.focusId === c.id} />)}
              </ul>
            )}
          </>
        ) : (
          <>
            {canSend && <SendVersion api={api} big={big} />}
            {api.versions.length === 0 ? (
              <p data-testid="versions-empty" className="rounded-2xl border border-dashed border-white/15 p-4 text-center text-[13px] text-slate-400">
                {canSend ? 'Pas encore de version envoyée. Quand ton mix est prêt, envoie-le : l’artiste l’écoute et le valide d’un toucher.'
                  : `${eng} ne t'a pas encore envoyé de version de son mix. Elle apparaîtra ici : tu pourras l'écouter, la valider ou demander des retouches.`}
              </p>
            ) : (
              <>
                <ul className="space-y-2" data-testid="versions-list">
                  {[...api.versions].reverse().map(v => <VersionItem key={v.id} v={v} api={api} big={big} isArtist={isArtist} />)}
                </ul>
                <section data-testid="version-history" className="rounded-2xl bg-white/[0.03] p-3">
                  <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-400">Historique</h3>
                  <ol className="mt-1 space-y-1 text-[12px] text-slate-200">
                    {api.versions.map(v => <li key={v.id} data-testid="version-history-line" data-state={versionState(v)}>{versionStatusLine(v)}</li>)}
                  </ol>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );

  if (variant === 'inline') {
    return (
      <section data-testid="reviews-inline" className="flex flex-col rounded-3xl border border-amber-400/25 bg-amber-400/[0.04] p-4" aria-labelledby="reviews-t">
        <h2 id="reviews-t" className="mb-2 text-[15px] font-black">💬 Tes retours à {eng}</h2>
        {body}
      </section>
    );
  }
  return (
    <aside data-testid="reviews-panel" aria-labelledby="reviews-title"
      className="fixed inset-0 z-[540] flex flex-col bg-nv-surface text-white shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[380px] sm:border-l sm:border-white/10">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <h2 id="reviews-title" className="min-w-0 flex-1 text-[14px] font-black">Retours · commentaires et versions</h2>
        <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 rounded-xl bg-white/10 text-[16px] font-black hover:bg-white/20">✕</button>
      </header>
      {body}
    </aside>
  );
};

// ─── Poser un commentaire ─────────────────────────────────────────────────────

const Composer: React.FC<{ api: TimelineCommentsApi; position: () => number; selection?: () => { start: number; end: number } | null; big: boolean }> = ({ api, position, selection, big }) => {
  const [text, setText] = useState('');
  const [timeTxt, setTimeTxt] = useState(() => fmtTime(position()).replace(',', '.'));
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Position de lecture reprise tant qu'on n'a rien écrit (le commentaire tombe là où on a mis pause).
  const touched = useRef(false);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (touched.current) return;
      setTimeTxt(fmtTime(position()).replace(',', '.'));
      const sel = selection?.() || null;
      setRange(sel && sel.end - sel.start > 0.05 ? sel : null);
    }, 400);
    return () => window.clearInterval(id);
  }, [position, selection]);
  const submit = () => {
    const t = range ? range.start : parseTime(timeTxt);
    if (t === null) { setError('Heure illisible : écris par exemple 1:12.'); return; }
    if (!text.trim()) { setError('Écris ton commentaire (ex. : le « s » siffle).'); return; }
    api.add({ time: t, end: range ? range.end : null, text });
    setText(''); setError(null); touched.current = false;
  };
  const h = big ? 'min-h-11 text-[15px]' : 'min-h-9 text-[13px]';
  return (
    <div data-testid="comment-composer" className="space-y-2 rounded-2xl border border-amber-400/30 bg-amber-400/[0.06] p-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-amber-100">
        {range ? (
          <span data-testid="comment-range">Sur la plage {fmtTime(range.start)} → {fmtTime(range.end)}
            <button type="button" onClick={() => { touched.current = true; setRange(null); }} className="ml-2 underline">un instant seulement</button></span>
        ) : (
          <label className="flex items-center gap-2">Commenter à
            <input data-testid="comment-time" value={timeTxt} inputMode="decimal" aria-label="Moment du commentaire (minutes:secondes)"
              onChange={e => { touched.current = true; setTimeTxt(e.target.value); }} onKeyDown={e => e.stopPropagation()}
              className={`${h} w-20 rounded-lg border border-white/15 bg-black/40 px-2 text-center font-mono text-white`} />
          </label>
        )}
        {touched.current && <button type="button" onClick={() => { touched.current = false; setTimeTxt(fmtTime(position()).replace(',', '.')); }} className="text-[12px] font-semibold text-slate-300 underline">reprendre la position de lecture</button>}
      </div>
      <textarea data-testid="comment-text" value={text} rows={2} aria-label="Ton commentaire"
        onChange={e => { setText(e.target.value); if (!touched.current) touched.current = true; }}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
        placeholder="Ex. : le « s » siffle, la voix est trop basse au refrain…"
        className={`w-full rounded-xl border border-white/10 bg-black/40 p-2 ${big ? 'text-[15px]' : 'text-[13px]'} leading-snug text-white`} />
      {error && <p role="alert" className="text-[12px] font-bold text-red-200">{error}</p>}
      <button type="button" data-testid="comment-add" onClick={submit} disabled={!text.trim()}
        className={`${big ? 'min-h-12 text-[15px]' : 'min-h-9 text-[13px]'} w-full rounded-xl bg-amber-400 font-black text-black disabled:opacity-40`}>
        💬 Poser le commentaire{range ? '' : ` à ${(() => { const t = parseTime(timeTxt); return t === null ? '…' : fmtTime(t); })()}`}
      </button>
    </div>
  );
};

// ─── Un commentaire ───────────────────────────────────────────────────────────

const CommentItem: React.FC<{ c: TimelineComment; api: TimelineCommentsApi; big: boolean; color?: string; focused: boolean }> = ({ c, api, big, color, focused }) => {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const resolved = c.status.v.s === 'resolved';
  const btn = big ? 'min-h-11 rounded-xl px-3 text-[13px] font-bold' : 'min-h-8 rounded-lg px-2.5 text-[11px] font-bold';
  const replies = visibleReplies(c);
  const send = () => { if (text.trim()) { api.reply(c.id, text); setText(''); setReplying(false); } };
  return (
    <li data-testid="comment-item" data-id={c.id} data-status={c.status.v.s} data-archived={c.archived.v ? '1' : '0'}
      className={`rounded-2xl border p-3 ${focused ? 'border-amber-300 bg-amber-400/10' : resolved ? 'border-emerald-400/25 bg-emerald-500/[0.06]' : 'border-white/10 bg-white/[0.03]'}`}>
      <div className="flex items-start gap-2">
        <button type="button" data-testid="comment-goto" onClick={() => api.goTo(c.id)} title="Aller à ce moment"
          className={`${big ? 'min-h-11 text-[14px]' : 'min-h-8 text-[12px]'} shrink-0 rounded-lg bg-amber-400/90 px-2 font-mono font-black text-black`}>▶ {posLabel(c)}</button>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => api.goTo(c.id)}>
          <p className="text-[12px] text-slate-400"><b style={{ color: color || undefined }} className="text-slate-100">{c.authorName}</b>{c.role ? ` · ${ROLE_SHORT[c.role]}` : ''} · {ago(c.createdAt)}
            {resolved && <span className="ml-1 rounded bg-emerald-400 px-1.5 text-[10px] font-black text-black">résolu{c.status.v.by ? ` par ${c.status.v.by}` : ''}</span>}</p>
          <p data-testid="comment-text-view" className={`whitespace-pre-wrap break-words ${big ? 'text-[15px]' : 'text-[13px]'} ${resolved ? 'text-slate-300' : 'text-white'}`}>{c.text.v || '…'}</p>
        </div>
      </div>
      {replies.length > 0 && (
        <ul className="mt-2 space-y-1 border-l-2 border-white/10 pl-3" data-testid="comment-replies">
          {replies.map(r => (
            <li key={r.id} data-testid="comment-reply" className={big ? 'text-[14px]' : 'text-[12px]'}><b className="text-slate-200">{r.authorName}</b> <span className="text-slate-400">· {ago(r.createdAt)}</span><br /><span className="whitespace-pre-wrap break-words text-slate-100">{r.text.v}</span></li>
          ))}
        </ul>
      )}
      {replying && (
        <div className="mt-2 flex gap-2">
          <input autoFocus value={text} onChange={e => setText(e.target.value)} data-testid="comment-reply-input" aria-label="Ta réponse"
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') send(); if (e.key === 'Escape') setReplying(false); }}
            placeholder="Ta réponse…" className={`${big ? 'min-h-11 text-[15px]' : 'min-h-8 text-[13px]'} min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-2 text-white`} />
          <button type="button" data-testid="comment-reply-send" onClick={send} disabled={!text.trim()} className={`${btn} bg-cyan-500 text-black disabled:opacity-40`}>Envoyer</button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {!replying && !c.archived.v && <button type="button" data-testid="comment-reply-open" onClick={() => setReplying(true)} className={`${btn} bg-white/10`}>↩ Répondre</button>}
        {!c.archived.v && (resolved
          ? <button type="button" data-testid="comment-reopen" onClick={() => api.resolve(c.id, false)} className={`${btn} bg-white/10`}>Rouvrir</button>
          : <button type="button" data-testid="comment-resolve" onClick={() => api.resolve(c.id, true)} className={`${btn} bg-emerald-500/80 text-black`}>✓ Résolu</button>)}
        {c.archived.v
          ? <button type="button" data-testid="comment-unarchive" onClick={() => api.archive(c.id, false)} className={`${btn} bg-white/10`}>📤 Sortir des archives</button>
          : resolved && <button type="button" data-testid="comment-archive" onClick={() => api.archive(c.id, true)} className={`${btn} bg-white/10 text-slate-200`}>🗄️ Archiver</button>}
      </div>
    </li>
  );
};

// ─── Versions ─────────────────────────────────────────────────────────────────

const SendVersion: React.FC<{ api: TimelineCommentsApi; big: boolean }> = ({ api, big }) => {
  const n = nextVersionN(api.versions);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [withAudio, setWithAudio] = useState(true);
  const h = big ? 'min-h-11 text-[15px]' : 'min-h-9 text-[13px]';
  return (
    <div data-testid="version-composer" className="space-y-2 rounded-2xl border border-cyan-400/30 bg-cyan-400/[0.06] p-3">
      <p className="text-[13px] font-black text-cyan-100">Envoyer la version {n} à l'artiste</p>
      <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.stopPropagation()} placeholder={`Version ${n}`} data-testid="version-name" aria-label="Nom de la version"
        className={`${h} w-full rounded-xl border border-white/10 bg-black/40 px-2 text-white`} />
      <textarea value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.stopPropagation()} rows={2} data-testid="version-note" aria-label="Ce qui a changé"
        placeholder="Ce qui a changé (ex. : voix plus devant, « s » adoucis à 1:12)" className={`w-full rounded-xl border border-white/10 bg-black/40 p-2 ${big ? 'text-[15px]' : 'text-[13px]'} text-white`} />
      <label className="flex min-h-9 items-center gap-2 text-[12px] text-slate-200">
        <input type="checkbox" checked={withAudio} onChange={e => setWithAudio(e.target.checked)} data-testid="version-with-audio" className="h-4 w-4" />
        Joindre le son du mix (bounce) : l'artiste écoute exactement cette version
      </label>
      <button type="button" data-testid="version-send" disabled={!!api.busy}
        onClick={() => { void api.sendNewVersion({ name: name || undefined, note, withAudio }).then(v => { if (v) { setName(''); setNote(''); } }); }}
        className={`${big ? 'min-h-12 text-[15px]' : 'min-h-9 text-[13px]'} w-full rounded-xl bg-cyan-500 font-black text-black disabled:opacity-40`}>📨 Envoyer la version {n}</button>
    </div>
  );
};

const VersionItem: React.FC<{ v: MixVersion; api: TimelineCommentsApi; big: boolean; isArtist: boolean }> = ({ v, api, big, isArtist }) => {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const st = versionState(v);
  const btn = big ? 'min-h-11 rounded-xl px-3 text-[13px] font-black' : 'min-h-8 rounded-lg px-2.5 text-[11px] font-black';
  const playing = api.playingId === v.id;
  const pill = st === 'approved' ? 'bg-emerald-400 text-black' : st === 'changes' ? 'bg-amber-400 text-black' : 'bg-white/15 text-slate-100';
  const label = useMemo(() => (st === 'approved' ? '✅ Validée' : st === 'changes' ? '✎ Retouches demandées' : '⏳ En attente'), [st]);
  return (
    <li data-testid="version-item" data-n={v.n} data-state={st} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className={`${big ? 'text-[15px]' : 'text-[13px]'} font-black`}>{v.name}</p>
          <p className="text-[12px] text-slate-400">envoyée par {v.sentBy} le {fmtDate(v.sentAt)}{v.audio ? ` · ${fmtTime(v.audio.duration)}` : ' · sans fichier son'}</p>
        </div>
        <span data-testid="version-state" className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-black ${pill}`}>{label}</span>
      </div>
      {v.note && <p className="mt-1 whitespace-pre-wrap text-[13px] text-slate-200">« {v.note} »</p>}
      {v.decision.v && <p data-testid="version-decision" className="mt-1 text-[12px] font-bold text-slate-200">{versionStatusLine(v)}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {v.audio && (
          <button type="button" data-testid="version-play" aria-pressed={playing} onClick={() => { if (playing) api.stopVersion(); else void api.playVersion(v.id); }}
            className={`${btn} ${playing ? 'bg-sky-400 text-black' : 'bg-white/10'}`}>{playing ? '■ Stop' : '▶ Écouter'}</button>
        )}
        {isArtist && !asking && (
          <>
            <button type="button" data-testid="version-approve" disabled={st === 'approved'} onClick={() => api.decideVersion(v.id, 'approved')} className={`${btn} bg-emerald-500 text-black disabled:opacity-40`}>✓ Valider</button>
            <button type="button" data-testid="version-changes" onClick={() => setAsking(true)} className={`${btn} bg-amber-400/90 text-black`}>✎ Demander des retouches</button>
          </>
        )}
      </div>
      {asking && (
        <div className="mt-2 space-y-2">
          <textarea autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.stopPropagation()} rows={2} data-testid="version-changes-text" aria-label="Ce qu'il faut retoucher"
            placeholder="Ce qu'il faut retoucher (ex. : la voix est trop basse au refrain)" className={`w-full rounded-xl border border-white/10 bg-black/40 p-2 ${big ? 'text-[15px]' : 'text-[13px]'} text-white`} />
          <div className="flex gap-2">
            <button type="button" data-testid="version-changes-send" disabled={!text.trim()} onClick={() => { api.decideVersion(v.id, 'changes', text); setAsking(false); setText(''); }} className={`${btn} flex-1 bg-amber-400 text-black disabled:opacity-40`}>Envoyer la demande</button>
            <button type="button" onClick={() => setAsking(false)} className={`${btn} bg-white/10`}>Annuler</button>
          </div>
        </div>
      )}
    </li>
  );
};

// ─── Puces sur la règle temporelle ───────────────────────────────────────────

export const CommentPins: React.FC<{ comments: TimelineComment[]; zoomH: number; scrollLeft: number; width: number; onOpen: (id: string) => void; focusId?: string | null }> = ({ comments, zoomH, scrollLeft, width, onOpen, focusId }) => (
  <>
    {comments.filter(c => !c.archived.v).map(c => {
      const x = c.pos.v.t * zoomH - scrollLeft;
      const xe = c.pos.v.end !== null ? c.pos.v.end * zoomH - scrollLeft : null;
      if (x > width + 20 || (xe ?? x) < -20) return null;
      const resolved = c.status.v.s === 'resolved';
      const tone = resolved ? '#34d399' : '#fbbf24';
      return (
        <React.Fragment key={c.id}>
          {xe !== null && <div aria-hidden className="pointer-events-none absolute bottom-0 h-1.5 rounded-full" style={{ left: x, width: Math.max(2, xe - x), backgroundColor: tone, opacity: 0.55 }} />}
          <button type="button" data-testid="comment-pin" data-id={c.id} data-t={c.pos.v.t} data-x={Math.round(x * 100) / 100} data-zoom={zoomH} data-status={c.status.v.s}
            onClick={(e) => { e.stopPropagation(); onOpen(c.id); }} onPointerDown={e => e.stopPropagation()}
            title={`${posLabel(c)} · ${c.authorName} : ${c.text.v}${resolved ? ' (résolu)' : ''}`} aria-label={`Commentaire à ${posLabel(c)} de ${c.authorName} : ${c.text.v}`}
            className={`pointer-events-auto absolute bottom-0.5 flex h-4 min-w-4 -translate-x-1/2 items-center justify-center rounded-full border text-[10px] font-black leading-none shadow ${focusId === c.id ? 'ring-2 ring-white' : ''}`}
            style={{ left: x, backgroundColor: tone, borderColor: 'rgba(0,0,0,.4)', color: '#000' }}>
            {resolved ? '✓' : '💬'}
          </button>
        </React.Fragment>
      );
    })}
  </>
);

export default CommentsPanel;
