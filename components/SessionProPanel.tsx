import React, { useEffect, useMemo, useState } from 'react';
import type { DAWState } from '../types';
import ClipsList from './ClipsList';
import { applyR21, applyR21Silent, openImportSession, r21Bus, R21Tab, sessionPanelStore } from '../utils/r21Bus';
import { NOTE_LABELS, noteValue, PROJECT_NOTE_FIELDS, ProjectNoteField, withNote, withTrackComment } from '../utils/sessionNotes';
import {
  addMutedRange, ARRANGEMENT_PRESETS, arrangementSections, arrangementSummary, moveSection, newArrangement, removeMutedRange,
  renderArrangement, resolveArrangement, SongArrangement, toggleMutedClips, upsertArrangement,
} from '../utils/arrangements';
import { editSelectionStore } from '../utils/editSelection';
import { recoveryStore, isNamedVersion, VersionMeta } from '../utils/recoveryStore';
import { compareVersions, diffLines, nextVersionNumber, versionName } from '../utils/projectVersions';

/**
 * R21 · Panneau « Session » : notes (projet et pistes), liste des clips,
 * arrangements, versions nommées ; bouton « Importer depuis une session ».
 * Téléphone : version simple (notes et versions).
 */
const TABS: { id: R21Tab; label: string; icon: string; title: string }[] = [
  { id: 'notes', label: 'Notes', icon: 'fa-sticky-note', title: 'Notes de projet et commentaires de piste (Pro Tools : Comments, Project Notes)' },
  { id: 'clips', label: 'Clips', icon: 'fa-th-list', title: 'Liste des clips de la session (Pro Tools : Clips List ; Logic : Project Audio Browser)' },
  { id: 'arrangements', label: 'Arrangements', icon: 'fa-random', title: 'Arrangements multiples : clean, explicite, radio edit (Logic : Arrangement Alternatives)' },
  { id: 'versions', label: 'Versions', icon: 'fa-code-branch', title: 'Versions nommées v2, v3… (Pro Tools : Save As New Version ; Logic : Project Alternatives)' },
];

const btn = 'nova-hit-tactile h-9 rounded-lg border border-nv-line px-3 text-[12px] font-bold text-nv-ink hover:bg-nv-accent/15 disabled:opacity-40';
const btnMain = 'nova-hit-tactile h-10 rounded-lg bg-nv-accent px-3 text-[12px] font-black text-black disabled:opacity-40';
const field = 'w-full rounded-lg border border-nv-line bg-nv-bg px-2 text-[12px] text-nv-ink';
const fmtWhen = (ts: number) => new Date(ts).toLocaleString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtLen = (sec: number) => { const m = Math.floor(sec / 60); const r = sec - m * 60; return `${m}:${r.toFixed(1).padStart(4, '0').replace('.', ',')}`; };

// ─── Notes ──────────────────────────────────────────────────────────────────────

const NoteEditor: React.FC<{ state: DAWState; f: ProjectNoteField }> = ({ state, f }) => {
  const value = noteValue(state, f);
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  // Reçu d'un collaborateur pendant qu'on ne tape pas : affiché.
  useEffect(() => { if (!focused) setText(value); }, [value, focused]);
  useEffect(() => {
    if (text === value) return;
    const t = window.setTimeout(() => applyR21Silent(s => withNote(s, f, text)), 400);
    return () => window.clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea value={text} onChange={e => setText(e.target.value)} onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); if (text !== value) applyR21Silent(s => withNote(s, f, text)); }}
      placeholder={NOTE_LABELS[f].placeholder} aria-label={NOTE_LABELS[f].label} data-testid={`note-${f}`}
      className={`${field} min-h-[140px] flex-1 resize-none py-2 leading-relaxed`} />
  );
};

const CommentRow: React.FC<{ id: string; name: string; color: string; comment: string }> = ({ id, name, color, comment }) => {
  const [text, setText] = useState(comment);
  useEffect(() => setText(comment), [comment]);
  const commit = () => { if (text !== comment) applyR21(s => ({ ...s, tracks: s.tracks.map(t => (t.id === id ? withTrackComment(t, text) : t)) })); };
  return (
    <label className="flex items-center gap-2">
      <span className="h-6 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="w-24 shrink-0 truncate text-[11px] font-bold text-nv-ink" title={name}>{name}</span>
      <input value={text} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        placeholder="Micro, consigne…" aria-label={`Commentaire de ${name}`} data-testid={`comment-${id}`} maxLength={500}
        className={`${field} h-8 min-w-0 flex-1`} />
    </label>
  );
};

const NotesTab: React.FC<{ state: DAWState; compact?: boolean }> = ({ state, compact }) => {
  const [f, setF] = useState<ProjectNoteField>('mix');
  const tracks = state.tracks.filter(t => t.id !== 'master');
  const pn = state.projectNotes;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      <section className="flex flex-col gap-2">
        <div className="flex gap-1 overflow-x-auto rounded-xl bg-nv-well p-1" role="tablist" aria-label="Notes du projet">
          {PROJECT_NOTE_FIELDS.map(k => (
            <button key={k} type="button" role="tab" aria-selected={f === k} onClick={() => setF(k)} title={NOTE_LABELS[k].hint} data-testid={`note-tab-${k}`}
              className={`nova-hit-tactile h-8 shrink-0 flex-1 rounded-lg px-2 text-[11px] font-bold ${f === k ? 'bg-nv-accent text-black' : 'text-nv-muted hover:text-nv-ink'}`}>
              {NOTE_LABELS[k].label}{noteValue(state, k).trim() ? ' •' : ''}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-nv-muted">{NOTE_LABELS[f].hint}</p>
        <NoteEditor key={f} state={state} f={f} />
        {pn?.updatedAt && f !== 'lyrics' ? <p className="text-[10px] text-nv-muted">Modifié {fmtWhen(pn.updatedAt)}{pn.updatedBy ? ` par ${pn.updatedBy}` : ''} · voyage avec le projet et en collaboration</p> : null}
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[11px] font-black uppercase tracking-wider text-nv-muted" title="Pro Tools : vue Commentaires (console et fenêtre d'édition)">Commentaires des pistes</h3>
        {!tracks.length && <p className="text-[12px] text-nv-muted">Aucune piste.</p>}
        {tracks.slice(0, compact ? 30 : 200).map(t => <CommentRow key={t.id} id={t.id} name={t.name} color={t.color} comment={t.comment || ''} />)}
      </section>
    </div>
  );
};

// ─── Arrangements ───────────────────────────────────────────────────────────────

const ArrangementEditor: React.FC<{ state: DAWState; a: SongArrangement }> = ({ state, a }) => {
  const set = (next: SongArrangement, label?: string) => applyR21(s => ({ ...s, arrangements: upsertArrangement(s.arrangements, next) }), label);
  const all = useMemo(() => arrangementSections(state), [state.tracks, state.markers]);
  const r = useMemo(() => resolveArrangement(state, a), [state.tracks, state.markers, a]);
  const [name, setName] = useState(a.name);
  useEffect(() => setName(a.name), [a.name]);
  const [addId, setAddId] = useState('');
  const trackName = (id: string) => state.tracks.find(t => t.id === id)?.name || 'piste';
  const clipName = (id: string) => { for (const t of state.tracks) { const c = t.clips.find(x => x.id === id); if (c) return `${c.name} (${t.name})`; } return 'clip disparu'; };
  const byId = new Map(all.map(x => [x.id, x]));
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-nv-line bg-nv-well/40 p-3" data-testid={`arrangement-editor-${a.id}`}>
      <label className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-[11px] font-bold text-nv-muted">Nom</span>
        <input value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== a.name && set({ ...a, name: name.trim().slice(0, 60) })}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label="Nom de l'arrangement" className={`${field} h-8`} />
      </label>
      <div>
        <p className="mb-1 text-[11px] font-bold text-nv-muted">Ordre des sections · {fmtLen(r.length)}</p>
        <ol className="space-y-1" data-testid="arrangement-sections">
          {a.sections.map((id, i) => {
            const x = byId.get(id);
            return (
              <li key={`${id}-${i}`} className="flex items-center gap-1.5 rounded-lg border border-nv-line bg-nv-bg px-2 py-1">
                <span className="w-5 text-right text-[10px] text-nv-muted">{i + 1}</span>
                <span className="h-4 w-1.5 rounded-full" style={{ backgroundColor: x?.color || '#64748b' }} />
                <span className={`min-w-0 flex-1 truncate text-[12px] font-bold ${x ? 'text-nv-ink' : 'text-nv-muted line-through'}`}>{x ? x.name : 'section disparue'}</span>
                {x && <span className="text-[10px] tabular-nums text-nv-muted">{fmtLen(x.end - x.start)}</span>}
                <button type="button" aria-label="Monter" disabled={i === 0} onClick={() => set(moveSection(a, i, i - 1))} className="nova-hit-tactile h-7 w-7 rounded text-nv-muted hover:text-nv-ink disabled:opacity-30"><i className="fas fa-chevron-up text-[10px]" /></button>
                <button type="button" aria-label="Descendre" disabled={i === a.sections.length - 1} onClick={() => set(moveSection(a, i, i + 1))} className="nova-hit-tactile h-7 w-7 rounded text-nv-muted hover:text-nv-ink disabled:opacity-30"><i className="fas fa-chevron-down text-[10px]" /></button>
                <button type="button" aria-label="Retirer la section" onClick={() => set({ ...a, sections: a.sections.filter((_, k) => k !== i) })} className="nova-hit-tactile h-7 w-7 rounded text-nv-muted hover:text-red-400"><i className="fas fa-times text-[10px]" /></button>
              </li>
            );
          })}
        </ol>
        <div className="mt-1.5 flex gap-1.5">
          <select value={addId} onChange={e => setAddId(e.target.value)} aria-label="Section à ajouter" className={`${field} h-8 flex-1`}>
            <option value="">Ajouter une section…</option>
            {all.map(x => <option key={x.id} value={x.id}>{x.name} ({fmtLen(x.end - x.start)})</option>)}
          </select>
          <button type="button" className={btn} disabled={!addId} onClick={() => { set({ ...a, sections: [...a.sections, addId] }); setAddId(''); }}>Ajouter</button>
        </div>
      </div>
      <div>
        <p className="mb-1 text-[11px] font-bold text-nv-muted" title="Version clean : coupe un gros mot (sélection de plage) ou un clip entier, seulement dans cet arrangement">Passages coupés dans cet arrangement</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={btn} data-testid="arrangement-mute-range"
            title="Coupe la plage sélectionnée (outil Sélecteur) sur ses pistes, avec un fondu de 5 ms : la timeline ne change pas"
            onClick={() => {
              const t = editSelectionStore.get().time;
              if (!t) { r21Bus.emit({ kind: 'notify', text: '⚠️ Sélectionne d\'abord le passage (outil Sélecteur, sur la piste voix).' }); return; }
              set(addMutedRange(a, t.start, t.end, t.trackIds.filter(id => id !== 'master')), `✂️ Passage coupé dans « ${a.name} » (${(t.end - t.start).toFixed(2).replace('.', ',')} s).`);
            }}>Couper la sélection</button>
          <button type="button" className={btn} data-testid="arrangement-mute-clips"
            title="Coupe les clips sélectionnés dans cet arrangement (re-cliquer les rétablit)"
            onClick={() => {
              const ids = editSelectionStore.get().clipIds;
              if (!ids.length) { r21Bus.emit({ kind: 'notify', text: '⚠️ Sélectionne d\'abord un ou plusieurs clips.' }); return; }
              set(toggleMutedClips(a, ids));
            }}>Couper les clips sélectionnés</button>
        </div>
        {(a.mutedRanges || []).length + a.mutedClipIds.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {(a.mutedRanges || []).map((m, i) => (
              <li key={`r${i}`} className="flex items-center gap-2 text-[11px] text-nv-ink">
                <i className="fas fa-volume-mute text-amber-400" /><span className="flex-1 truncate">{trackName(m.trackId)} : {m.start.toFixed(2).replace('.', ',')} → {m.end.toFixed(2).replace('.', ',')} s</span>
                <button type="button" aria-label="Rétablir ce passage" onClick={() => set(removeMutedRange(a, i))} className="nova-hit-tactile h-7 rounded px-2 text-nv-muted hover:text-nv-ink">Rétablir</button>
              </li>
            ))}
            {a.mutedClipIds.map(id => (
              <li key={id} className="flex items-center gap-2 text-[11px] text-nv-ink">
                <i className="fas fa-volume-mute text-amber-400" /><span className="flex-1 truncate">{clipName(id)}</span>
                <button type="button" aria-label="Rétablir ce clip" onClick={() => set(toggleMutedClips(a, [id]))} className="nova-hit-tactile h-7 rounded px-2 text-nv-muted hover:text-nv-ink">Rétablir</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-nv-line pt-2">
        <button type="button" className={btnMain} data-testid="arrangement-export" onClick={() => r21Bus.emit({ kind: 'exportArrangement', id: a.id })}
          title="Ouvre la fenêtre Exporter sur cet arrangement">Exporter cet arrangement</button>
        <button type="button" className={btn} data-testid="arrangement-apply"
          title="Remplace la timeline par cet arrangement (sections dans l'ordre, passages coupés). Une seule annulation : Ctrl+Z revient."
          onClick={() => applyR21(s => ({ ...renderArrangement(s, a).state, arrangements: s.arrangements }), `🎼 Arrangement « ${a.name} » posé sur la timeline — Ctrl+Z pour revenir.`)}>Poser sur la timeline</button>
        <button type="button" className={btn} onClick={() => applyR21(s => { const c = newArrangement(s, `${a.name} (copie)`, a); return { ...s, arrangements: upsertArrangement(s.arrangements, c) }; })}>Dupliquer</button>
        <button type="button" className={`${btn} hover:text-red-400`} onClick={() => applyR21(s => ({ ...s, arrangements: (s.arrangements || []).filter(x => x.id !== a.id) }), `🗑️ Arrangement « ${a.name} » supprimé — Ctrl+Z pour le remettre.`)}>Supprimer</button>
      </div>
    </div>
  );
};

const ArrangementsTab: React.FC<{ state: DAWState }> = ({ state }) => {
  const list = state.arrangements || [];
  const [openId, setOpenId] = useState<string | null>(list[0]?.id || null);
  const [custom, setCustom] = useState('');
  const sections = arrangementSections(state);
  const create = (name: string) => {
    const a = newArrangement(state, name);
    applyR21(s => ({ ...s, arrangements: upsertArrangement(s.arrangements, a) }), `🎼 Arrangement « ${a.name} » créé : l'ordre de la timeline. Change l'ordre ou coupe des passages.`);
    setOpenId(a.id);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1" data-testid="arrangements-tab">
      {!sections.length ? (
        <p className="rounded-xl border border-dashed border-nv-line p-3 text-[12px] text-nv-muted">Pose d'abord des repères (Couplet, Refrain…) : les sections de la piste Arrangement viennent des repères.</p>
      ) : (
        <p className="text-[11px] text-nv-muted">Plusieurs versions du même morceau : clean / explicite, radio edit, version longue. La timeline ne change pas ; chaque arrangement s'exporte à part.</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {ARRANGEMENT_PRESETS.filter(n => !list.some(a => a.name === n)).map(n => (
          <button key={n} type="button" className={btn} disabled={!sections.length} onClick={() => create(n)} data-testid={`arrangement-new-${n}`}>+ {n}</button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input value={custom} onChange={e => setCustom(e.target.value)} placeholder="Autre nom…" aria-label="Nom du nouvel arrangement" className={`${field} h-9 flex-1`} />
        <button type="button" className={btn} disabled={!sections.length || !custom.trim()} onClick={() => { create(custom); setCustom(''); }}>Créer</button>
      </div>
      <ul className="space-y-2">
        {list.map(a => (
          <li key={a.id} className="space-y-1.5">
            <button type="button" onClick={() => setOpenId(id => (id === a.id ? null : a.id))} aria-expanded={openId === a.id} data-testid={`arrangement-${a.name}`}
              className="flex w-full items-center gap-2 rounded-xl border border-nv-line bg-nv-well/60 p-2 text-left">
              <span className="h-6 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: a.color || '#22d3ee' }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-black text-nv-ink">{a.name}</span>
                <span className="block truncate text-[11px] text-nv-muted">{arrangementSummary(state, a)}</span>
              </span>
              <i className={`fas fa-chevron-${openId === a.id ? 'up' : 'down'} text-[10px] text-nv-muted`} />
            </button>
            {openId === a.id && <ArrangementEditor state={state} a={a} />}
          </li>
        ))}
      </ul>
    </div>
  );
};

// ─── Versions ───────────────────────────────────────────────────────────────────

const VersionsTab: React.FC<{ state: DAWState; compact?: boolean }> = ({ state }) => {
  const [list, setList] = useState<VersionMeta[] | null>(null);
  const [comment, setComment] = useState('');
  const [diff, setDiff] = useState<{ id: number; lines: string[] } | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const reload = () => { recoveryStore().listVersions(state.id).then(l => setList(l.filter(isNamedVersion))).catch(() => setList([])); };
  useEffect(() => { reload(); const t = window.setTimeout(reload, 1200); return () => window.clearTimeout(t); }, [state.id, state.sessionVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = nextVersionNumber(state, list || []);
  const compare = async (v: VersionMeta) => {
    const rec = await recoveryStore().loadVersion(v.id).catch(() => null);
    if (!rec) { setDiff({ id: v.id, lines: ['Version illisible.'] }); return; }
    try {
      const old = JSON.parse(rec.record.json) as DAWState;
      setDiff({ id: v.id, lines: diffLines(compareVersions(old, state)) });
    } catch { setDiff({ id: v.id, lines: ['Version illisible.'] }); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1" data-testid="versions-tab">
      <section className="flex flex-col gap-2 rounded-xl border border-nv-line bg-nv-well/40 p-3">
        <p className="text-[12px] font-bold text-nv-ink">Enregistrer comme nouvelle version</p>
        <p className="text-[11px] text-nv-muted">Pro Tools : Save As New Version. Le projet devient « {versionName(state.name, n)} » ; la version reste dans l'historique de l'appareil, jamais effacée.</p>
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Commentaire (ex. : mix validé par l'artiste)" aria-label="Commentaire de la version"
          data-testid="version-comment" maxLength={400} className={`${field} h-9`} />
        <button type="button" className={btnMain} data-testid="version-save"
          onClick={() => { r21Bus.emit({ kind: 'saveVersion', comment }); setComment(''); window.setTimeout(reload, 900); }}>
          🔖 Enregistrer la v{n}
        </button>
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[11px] font-black uppercase tracking-wider text-nv-muted">Versions nommées</h3>
        {list === null && <p className="text-[12px] text-nv-muted">Chargement…</p>}
        {list && !list.length && <p className="text-[12px] text-nv-muted">Aucune version nommée pour ce projet.</p>}
        {(list || []).map(v => (
          <div key={v.id} className="rounded-xl border border-nv-line bg-nv-bg p-2.5" data-testid="named-version">
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded-md bg-nv-accent/20 px-1.5 py-0.5 text-[11px] font-black text-nv-ink">v{v.versionNumber || '?'}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-bold text-nv-ink">{v.name}</p>
                <p className="text-[11px] text-nv-muted">{fmtWhen(v.savedAt)} · {v.tracks} piste{v.tracks > 1 ? 's' : ''}</p>
                {editing?.id === v.id ? (
                  <input autoFocus value={editing.text} onChange={e => setEditing({ id: v.id, text: e.target.value })} aria-label="Commentaire" maxLength={400}
                    onBlur={() => { void recoveryStore().annotate(v.id, { comment: editing.text.trim() }).then(reload); setEditing(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} className={`${field} mt-1 h-8`} />
                ) : (
                  <button type="button" onClick={() => setEditing({ id: v.id, text: v.comment || '' })} className="mt-0.5 block text-left text-[12px] italic text-nv-ink/80 hover:underline" title="Modifier le commentaire">
                    {v.comment ? `« ${v.comment} »` : '+ commentaire'}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {confirmId === v.id ? (
                <>
                  <span className="w-full text-[11px] text-nv-muted">Ta version actuelle est gardée dans l'historique avant la restauration.</span>
                  <button type="button" className={btnMain} data-testid="version-restore-confirm"
                    onClick={() => { r21Bus.emit({ kind: 'restoreVersion', id: v.id, label: `Version v${v.versionNumber} restaurée${v.comment ? ` (« ${v.comment} »)` : ''} — ta version d'avant reste dans l'historique` }); setConfirmId(null); }}>Restaurer la v{v.versionNumber}</button>
                  <button type="button" className={btn} onClick={() => setConfirmId(null)}>Annuler</button>
                </>
              ) : (
                <>
                  <button type="button" className={btn} data-testid="version-restore" onClick={() => setConfirmId(v.id)}>Restaurer</button>
                  <button type="button" className={btn} data-testid="version-compare" onClick={() => (diff?.id === v.id ? setDiff(null) : void compare(v))}
                    title="Ce qui a changé entre cette version et le projet ouvert">Comparer</button>
                </>
              )}
            </div>
            {diff?.id === v.id && (
              <ul className="mt-2 space-y-0.5 rounded-lg bg-nv-well/60 p-2 text-[11px] text-nv-ink" data-testid="version-diff">
                <li className="text-nv-muted">Depuis la v{v.versionNumber} :</li>
                {diff.lines.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            )}
          </div>
        ))}
        <button type="button" className={`${btn} mt-1`} onClick={() => r21Bus.emit({ kind: 'openVersions' })} data-testid="versions-all"
          title="Toutes les sauvegardes automatiques de cet appareil (20 dernières + une par heure)">🕘 Tout l'historique (sauvegardes automatiques)</button>
      </section>
    </div>
  );
};

// ─── Panneau ────────────────────────────────────────────────────────────────────

const SessionProPanel: React.FC<{ state: DAWState; tab: R21Tab; phone?: boolean; className?: string }> = ({ state, tab, phone, className }) => {
  const tabs = phone ? TABS.filter(t => t.id === 'notes' || t.id === 'versions') : TABS;
  const cur = tabs.some(t => t.id === tab) ? tab : tabs[0].id;
  return (
    <aside role="dialog" aria-label="Session" data-testid="session-panel"
      className={`${className || ''} flex flex-col gap-3 rounded-2xl border border-nv-line bg-nv-panel p-3 shadow-2xl`}>
      <div className="flex items-center gap-2">
        <i className="fas fa-folder-open text-nv-accent" />
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-bold text-nv-ink">Session · {state.name}</h2>
        {!phone && (
          <button type="button" onClick={() => openImportSession()} className={btn} data-testid="session-import"
            title="Importer des pistes d'un autre projet, d'un modèle ou d'un projet récent (Pro Tools : Import Session Data, Alt+Maj+I)">
            <i className="fas fa-file-import mr-1.5 text-[11px]" />Importer
          </button>
        )}
        <button type="button" onClick={() => sessionPanelStore.set(null)} aria-label="Fermer" className="nova-hit-tactile h-9 w-9 shrink-0 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
      </div>
      <div className="flex gap-1 rounded-xl bg-nv-well p-1" role="tablist" aria-label="Session">
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={cur === t.id} onClick={() => sessionPanelStore.set(t.id)} title={t.title} data-testid={`session-tab-${t.id}`}
            className={`nova-hit-tactile h-9 min-w-0 flex-1 rounded-lg px-1 text-[11px] font-bold ${cur === t.id ? 'bg-nv-accent text-black' : 'text-nv-muted hover:text-nv-ink'}`}>
            <i className={`fas ${t.icon} mr-1 text-[10px]`} />{t.label}
          </button>
        ))}
      </div>
      {cur === 'notes' && <NotesTab state={state} compact={phone} />}
      {cur === 'clips' && <ClipsList state={state} />}
      {cur === 'arrangements' && <ArrangementsTab state={state} />}
      {cur === 'versions' && <VersionsTab state={state} compact={phone} />}
    </aside>
  );
};

export default SessionProPanel;
