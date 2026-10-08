import { useCallback, useEffect, useRef, useState } from 'react';
import type { DAWState } from '../types';
import { r21Bus, sessionPanelStore, setExportArrangement } from '../utils/r21Bus';
import { addToBin, CLIP_DRAG_TYPE, placeClip, removedClips } from '../utils/clipsList';
import { applyNotesFields, changedNotes, notesChangeLabel, notesFieldsOf, NotesFields, sanitizeNotesOp } from '../utils/sessionNotes';
import { cleanComment, nextVersionNumber, versionName } from '../utils/projectVersions';
import { recoveryStore } from '../utils/recoveryStore';
import type { LwwClock } from '../utils/collabMerge';

/**
 * R21 · Session pro, branchements de App (court). La logique est dans
 * utils/sessionImport, utils/projectVersions, utils/arrangements,
 * utils/sessionNotes et utils/clipsList ; ici seulement :
 *  - les commandes du bus R21 (panneau Session, import, modifications) ;
 *  - la réserve de la liste des clips (clips retirés de la timeline) ;
 *  - le glisser d'un clip de la liste vers une piste ;
 *  - « Enregistrer comme nouvelle version » : un point marqué dans l'historique
 *    de la sauvegarde automatique (pas un 2e historique) ;
 *  - les notes en collaboration (champ par champ, le plus récent gagne) ;
 *  - Alt+Maj+I : Importer depuis une session (Pro Tools : Import Session Data).
 */
export interface R21Deps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  /** Modification sans étape d'annulation. */
  setSilently: (fn: (prev: DAWState) => DAWState) => void;
  notify: (text: string) => void;
  /** Sauvegarde dans l'historique de l'appareil (version nommée : numéro + commentaire). */
  saveVersion: (extra: { versionNumber: number; comment?: string; state: DAWState }) => Promise<boolean>;
  openVersions: () => void;
  restoreVersion: (id: number, label: string) => void;
  openExport: () => void;
  /** Collaboration en cours : file d'envoi et nom (null : pas de collaboration). */
  collab: () => { queue: (key: string, kind: string, op: Record<string, unknown>) => void; name: string } | null;
  lww: () => LwwClock;
  /** Projet en cours de chargement / reprise : la réserve ne capture rien. */
  loading?: () => boolean;
}

export function useR21(state: DAWState, d: R21Deps) {
  const dRef = useRef(d);
  dRef.current = d;
  const [importOpen, setImportOpen] = useState(false);

  // ── Commandes du bus ───────────────────────────────────────────────────────
  useEffect(() => r21Bus.on(cmd => {
    const dd = dRef.current;
    switch (cmd.kind) {
      case 'panel': sessionPanelStore.set(cmd.tab); break;
      case 'import': setImportOpen(cmd.open); break;
      case 'apply':
        dd.setState(prev => { const n = cmd.apply(prev); return n === prev ? prev : n; });
        if (cmd.label) dd.notify(cmd.label);
        break;
      case 'silent': dd.setSilently(prev => { const n = cmd.apply(prev); return n === prev ? prev : n; }); break;
      case 'placeClip': {
        const s = dd.stateRef.current;
        const r = placeClip(s, cmd.key, cmd.trackId, cmd.time, `clip-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
        if (r.error || !r.clip) { dd.notify(`⚠️ ${r.error || 'Impossible de poser ce clip.'}`); break; }
        const clip = r.clip;
        dd.setState(prev => placeClip(prev, cmd.key, cmd.trackId, cmd.time, clip.id).state);
        const t = s.tracks.find(x => x.id === cmd.trackId);
        dd.notify(`📎 « ${clip.name} » posé sur « ${t?.name || 'la piste'} » à ${cmd.time.toFixed(2).replace('.', ',')} s — Ctrl+Z pour revenir.`);
        break;
      }
      case 'saveVersion': void saveNewVersion(cmd.comment); break;
      case 'openVersions': dd.openVersions(); break;
      case 'restoreVersion': dd.restoreVersion(cmd.id, cmd.label); break;
      case 'exportArrangement': setExportArrangement(cmd.id); dd.openExport(); break;
      case 'notify': dd.notify(cmd.text); break;
    }
  }), []);

  // ── Enregistrer comme nouvelle version (Pro Tools : Save As New Version) ──
  const savingRef = useRef(false);
  const saveNewVersion = useCallback(async (comment: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const dd = dRef.current;
    try {
      const s0 = dd.stateRef.current;
      let history: { projectId: string; versionNumber?: number }[] = [];
      try { history = await recoveryStore().listVersions(s0.id); } catch { /* historique indisponible */ }
      const n = nextVersionNumber(s0, history);
      const name = versionName(s0.name, n);
      const next: DAWState = { ...s0, name, sessionVersion: n };
      dd.setState(prev => ({ ...prev, name, sessionVersion: n }));
      const ok = await dd.saveVersion({ versionNumber: n, comment: cleanComment(comment), state: next });
      dd.notify(ok
        ? `🔖 « ${name} » enregistrée${comment.trim() ? ` (« ${cleanComment(comment).slice(0, 60)} »)` : ''}. Elle reste dans « Versions » : restaurer ou comparer à tout moment.`
        : `⚠️ Version v${n} : le projet est renommé « ${name} », mais l'historique de cet appareil est indisponible. Sauvegarde le fichier .zip pour la garder.`);
    } finally { savingRef.current = false; }
  }, []);

  // ── Liste des clips : la réserve garde les clips retirés de la timeline ────
  const prevRef = useRef<{ id: string; tracks: DAWState['tracks'] } | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { id: state.id, tracks: state.tracks };
    if (!prev || prev.id !== state.id || prev.tracks === state.tracks || dRef.current.loading?.()) return;
    const gone = removedClips(prev.tracks, state.tracks);
    // Projet remplacé d'un coup (version restaurée, session reprise) : ce n'est pas une suppression.
    const before = prev.tracks.reduce((n, t) => n + t.clips.length, 0);
    if (!gone.length || (gone.length > 12 && gone.length > before * 0.6)) return;
    dRef.current.setSilently(s => ({ ...s, clipBin: addToBin(s.clipBin, gone) }));
  }, [state.tracks, state.id]);

  // ── Glisser un clip de la liste sur une piste (ArrangementView) ────────────
  useEffect(() => {
    const onDrop = (e: Event) => {
      const det = (e as CustomEvent).detail as { key: string; trackId: string | null; time: number };
      if (!det?.key) return;
      if (!det.trackId) { dRef.current.notify('⚠️ Lâche le clip sur une piste.'); return; }
      r21Bus.emit({ kind: 'placeClip', key: det.key, trackId: det.trackId, time: det.time });
    };
    window.addEventListener('nova:clip-drop', onDrop);
    return () => window.removeEventListener('nova:clip-drop', onDrop);
  }, []);

  // ── Alt+Maj+I : importer depuis une session ────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.code !== 'KeyI') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      setImportOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Notes en collaboration ─────────────────────────────────────────────────
  const knownRef = useRef<NotesFields | null>(null);
  const pendingRef = useRef(new Set<string>());
  const collabOn = !!d.collab();
  useEffect(() => {
    if (!collabOn) { knownRef.current = null; pendingRef.current.clear(); return; }
    // À l'arrivée : l'état reçu sert de référence (rien n'est renvoyé).
    if (!knownRef.current) { knownRef.current = notesFieldsOf(dRef.current.stateRef.current); return; }
    const fields = notesFieldsOf(state);
    const changed = changedNotes(knownRef.current, fields);
    const keys = Object.keys(changed);
    if (!keys.length) return;
    keys.forEach(k => pendingRef.current.add(k));
    const t = window.setTimeout(() => {
      const c = dRef.current.collab();
      if (!c || !knownRef.current) return;
      const now = notesFieldsOf(dRef.current.stateRef.current);
      for (const k of keys) {
        if (now[k] === undefined || knownRef.current[k] === now[k]) { pendingRef.current.delete(k); continue; }
        knownRef.current[k] = now[k];
        c.queue(`notes:${k}`, 'notes', { fields: { [k]: now[k] } });
      }
    }, 600);
    return () => window.clearTimeout(t);
  }, [state.lyrics, state.projectNotes, state.tracks, collabOn]);

  /** Opération « notes » reçue d'un collaborateur. */
  const onRemoteNotes = useCallback((o: { op?: unknown; seq: number; author_name?: string; replay?: boolean }) => {
    const fields = sanitizeNotesOp(o.op);
    if (!fields) return;
    const dd = dRef.current;
    const lww = dd.lww();
    const cur = dd.stateRef.current;
    const r = applyNotesFields(cur, fields, k => lww.accept(`notes:${k}`, o.seq), pendingRef.current, o.author_name);
    if (!r.applied.length) return;
    if (knownRef.current) for (const k of r.applied) knownRef.current[k] = fields[k];
    dd.setSilently(prev => applyNotesFields(prev, Object.fromEntries(r.applied.map(k => [k, fields[k]])), () => true, new Set(), o.author_name).state);
    if (!o.replay) dd.notify(`📝 ${o.author_name || 'Un collaborateur'} a modifié ${notesChangeLabel(r.applied, cur.tracks)}.`);
  }, []);

  /** Notre opération « notes » est partie (numéro du journal) : plus en attente. */
  const onNotesSent = useCallback((op: Record<string, unknown>, seq: number) => {
    const f = (op as { fields?: Record<string, string> }).fields;
    if (!f) return;
    for (const k of Object.keys(f)) { pendingRef.current.delete(k); dRef.current.lww().note(`notes:${k}`, seq); }
  }, []);

  return { importOpen, setImportOpen, onRemoteNotes, onNotesSent, saveNewVersion };
}

export { CLIP_DRAG_TYPE };
