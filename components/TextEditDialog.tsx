/**
 * L5 · écart 18 · « Éditer par le texte » : la prise se lit comme un texte (la
 * transcription locale, utils/voiceLyrics). Cliquer des mots = les sélectionner
 * dans le clip (plage de l'arrangement, tête de lecture) ; « Effacer » (Suppr)
 * retire les mots, une respiration ou un silence par une coupe propre, dans le
 * silence, avec de courts fondus ; « Découper par phrase / par mot » ;
 * double-clic sur un mot pour corriger le texte (gardé dans le projet).
 *
 * Chaque geste = une seule étape d'annulation (Ctrl+Z). La logique est dans
 * utils/textEdit (testée) ; ici, seulement l'affichage et les gestes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, DAWState, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { applySelection } from '../utils/selectionMemory';
import { editModeStore } from '../utils/editModes';
import { detectClipBreaths, monoSlice } from '../utils/breaths';
import {
  applyCuts, cutRangesFor, cutSummary, quietestPoint, renameWord, splitTake, splitTimes, takeClips, takeTokens, tokensSpan, tokensText,
  type QuietSnap, type TextToken,
} from '../utils/textEdit';
import { openNovaWindow } from '../utils/novaWindows';
import { AbPlayer } from '../utils/abPlayer';

export interface TextEditRequest { trackId: string; clipId: string }

interface Props {
  request: TextEditRequest | null;
  tracks: Track[];
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onSeek: (time: number) => void;
  onClose: () => void;
}

const notify = (detail: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail })); } catch { /* hors navigateur */ } };
const btn = 'min-h-10 [@media(pointer:coarse)]:min-h-11 px-3 py-2 rounded-xl text-[12px] leading-tight font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const primary = `${btn} bg-cyan-500 text-black hover:bg-cyan-400 font-black`;
const secondary = `${btn} border border-nv-line text-nv-ink hover:bg-nv-accent/10`;
const fmt = (s: number) => `${s.toFixed(s < 10 ? 2 : 1).replace('.', ',')} s`;
const RIPPLE_KEY = 'nova_text_edit_ripple';

const TextEditDialog: React.FC<Props> = ({ request, tracks, setState, onSeek, onClose }) => {
  const track = tracks.find(t => t.id === request?.trackId);
  const first = track?.clips.find(c => c.id === request?.clipId);
  // La prise : tous les clips de la piste qui jouent ce son (ils restent liés après une coupe).
  const [bufferId] = useState(() => first?.bufferId || '');
  const clips = useMemo(() => (track && bufferId ? takeClips(track, bufferId) : []), [track, bufferId]);
  const buf = bufferId ? audioBufferRegistry.get(bufferId) : undefined;
  const [breaths, setBreaths] = useState<{ start: number; end: number }[]>([]);
  const tokens = useMemo(() => takeTokens(clips, { breaths }), [clips, breaths]);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  const [ripple, setRipple] = useState<boolean>(() => {
    try { const v = localStorage.getItem(RIPPLE_KEY); if (v === '1' || v === '0') return v === '1'; } catch { /* stockage indisponible */ }
    return editModeStore.get().mode === 'SHUFFLE';
  });
  const [playing, setPlaying] = useState(false);
  const player = useRef<AbPlayer | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Respirations (détection locale, en différé : la fenêtre s'ouvre tout de suite).
  useEffect(() => {
    if (!buf || !clips.length) return;
    const id = window.setTimeout(() => {
      try { setBreaths(clips.flatMap(c => detectClipBreaths(c, buf, 'normale').map(r => ({ start: r.start, end: r.end })))); } catch { /* sans respirations */ }
    }, 60);
    return () => window.clearTimeout(id);
  }, [buf, clips]);
  useEffect(() => () => player.current?.close(), []);
  useEffect(() => { setSel(null); setEditing(null); }, [clips.length]);

  // Recalage des coupes sur le vrai silence (les temps de la transcription sont approximatifs).
  const snap: QuietSnap | undefined = useMemo(() => (buf ? (_id, a, b, f) => {
    const x = monoSlice(buf, a, b);
    return a + quietestPoint(x, buf.sampleRate, 0, b - a, f - a);
  } : undefined), [buf]);

  const select = useCallback((i: number, extend: boolean) => {
    const next: [number, number] = extend && sel ? [sel[0], i] : [i, i];
    setSel(next);
    const span = tokensSpan(tokens, next[0], next[1]);
    if (span && request) {
      applySelection({ time: { start: span.start, end: span.end, trackIds: [request.trackId] }, clipIds: [] });
      onSeek(span.start);
    }
  }, [sel, tokens, request, onSeek]);

  const erase = useCallback(() => {
    if (!sel || !request) return;
    const ranges = cutRangesFor(tokens, clips, sel[0], sel[1], snap);
    if (!ranges.length) return;
    const msg = cutSummary(tokens, sel[0], sel[1], ranges, ripple);
    const ids = new Set(clips.map(c => c.id));
    setState(prev => ({
      ...prev,
      tracks: prev.tracks.map(t => {
        if (t.id !== request.trackId) return t;
        const takeNow = t.clips.filter(c => ids.has(c.id));
        if (!ripple) return { ...t, clips: [...t.clips.filter(c => !ids.has(c.id)), ...applyCuts(takeNow, ranges, { ripple: false })].sort((a, b) => a.start - b.start) };
        return { ...t, clips: applyCuts(t.clips, ranges, { ripple: true }) };
      }),
    }));
    setSel(null);
    notify(`✂️ ${msg} Ctrl+Z pour annuler.`);
  }, [sel, request, tokens, clips, snap, ripple, setState]);

  const split = (by: 'phrase' | 'word' | 'here') => {
    if (!request) return;
    let times: number[];
    if (by === 'here') {
      if (!sel) return;
      const i = Math.min(sel[0], sel[1]);
      const prevWord = [...tokens.slice(0, i)].reverse().find(t => t.kind === 'word');
      const cur = tokens[i];
      if (!prevWord || prevWord.clipId !== cur.clipId) { notify('Rien à couper ici : c’est déjà le début d’un clip.'); return; }
      const c = clips.find(x => x.id === cur.clipId)!;
      const off = c.offset || 0;
      const a = prevWord.e, b = cur.s;
      const m = (a + b) / 2;
      const s = snap ? snap(c.id, Math.max(off, a - 0.04), Math.min(off + c.duration, b + 0.04), m) : m;
      times = [c.start + (s - off)];
    } else times = splitTimes(tokens, clips, by, snap);
    if (!times.length) { notify(by === 'phrase' ? 'Pas de fin de phrase trouvée dans cette prise (aucun silence de plus de 0,35 s).' : 'Rien à découper.'); return; }
    const ids = clips.map(c => c.id);
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (t.id === request.trackId ? { ...t, clips: splitTake(t.clips, ids, times) } : t)) }));
    notify(`✂️ Prise découpée en ${times.length + clips.length} clips${by === 'phrase' ? ' (une phrase par clip)' : by === 'word' ? ' (un mot par clip)' : ''}, dans les silences, avec de courts fondus. Ctrl+Z pour annuler.`);
  };

  const commitRename = () => {
    if (!editing || !request) return;
    const tok = tokens[editing.i];
    const text = editing.text.trim();
    setEditing(null);
    if (!tok || tok.kind !== 'word' || !text || text === tok.text) return;
    const c = clips.find(x => x.id === tok.clipId);
    const w = c?.transcript?.words[tok.index];
    if (!w) return;
    const ids = clips.map(x => x.id);
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (t.id === request.trackId ? { ...t, clips: renameWord(t.clips, ids, { s: w.s, e: w.e }, text) } : t)) }));
    notify(`✏️ « ${tok.text} » corrigé en « ${text} » (gardé dans le projet).`);
  };

  const listen = () => {
    if (playing) { player.current?.stop(); setPlaying(false); return; }
    if (!buf || !clips.length) return;
    // La sélection (ou toute la prise), telle qu'elle sonne maintenant : morceaux mis bout à bout.
    const span = sel ? tokensSpan(tokens, sel[0], sel[1]) : { start: clips[0].start, end: clips[clips.length - 1].start + clips[clips.length - 1].duration };
    if (!span) return;
    const sr = buf.sampleRate;
    const n = Math.max(1, Math.round((span.end - span.start + 0.3) * sr));
    const out = Array.from({ length: buf.numberOfChannels }, () => new Float32Array(n));
    const from = span.start - 0.15;
    for (const c of clips) {
      const a = Math.max(c.start, from), b = Math.min(c.start + c.duration, from + n / sr);
      if (b <= a) continue;
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        const i0 = Math.round(((c.offset || 0) + (a - c.start)) * sr), o0 = Math.round((a - from) * sr), len = Math.round((b - a) * sr);
        for (let k = 0; k < len && o0 + k < n && i0 + k < d.length; k++) out[ch][o0 + k] += d[i0 + k];
      }
    }
    if (!player.current) player.current = new AbPlayer();
    player.current.onEnd = () => setPlaying(false);
    player.current.play({ orig: out, wet: out, sampleRate: sr }, 1, true);
    setPlaying(true);
  };

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') { e.preventDefault(); if (sel) setSel(null); else onClose(); }
      // Suppr / Retour arrière : effacent les MOTS choisis (jamais les clips sélectionnés derrière la fenêtre).
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); e.stopImmediatePropagation(); erase(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [request, sel, erase, onClose]);

  if (!request) return null;
  const a = sel ? Math.min(sel[0], sel[1]) : -1, b = sel ? Math.max(sel[0], sel[1]) : -1;
  const span = sel ? tokensSpan(tokens, a, b) : null;
  const words = tokens.filter(t => t.kind === 'word').length;

  const chip = (t: TextToken, i: number) => {
    const on = i >= a && i <= b;
    const base = `rounded-md px-1.5 py-1 [@media(pointer:coarse)]:py-2 [@media(pointer:coarse)]:min-h-[40px] text-left transition-colors ${on ? 'bg-cyan-500 text-black' : 'hover:bg-nv-accent/15'}`;
    if (t.kind === 'pause') {
      return (
        <button key={`p${i}`} type="button" data-token={i} data-kind={t.breath ? 'respiration' : 'silence'} onClick={e => select(i, e.shiftKey)}
          title={t.breath ? 'Respiration : Suppr pour la retirer (le silence est ramené à 0,12 s)' : 'Silence : Suppr pour le raccourcir à 0,12 s'}
          className={`${base} text-[11px] ${on ? '' : 'text-nv-muted border border-dashed border-nv-line'}`}>
          {t.breath ? '💨' : '⏸'} {fmt(t.e - t.s)}
        </button>
      );
    }
    if (editing?.i === i) {
      return (
        <input key={`w${i}`} autoFocus value={editing.text} aria-label="Corriger le mot" data-testid="text-edit-rename"
          onChange={e => setEditing({ i, text: e.target.value })} onBlur={commitRename}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } }}
          className="w-28 rounded-md border border-cyan-400 bg-nv-well px-1.5 py-1 text-[15px] text-nv-ink" />
      );
    }
    return (
      <button key={`w${i}`} type="button" data-token={i} data-kind="mot" onClick={e => select(i, e.shiftKey)} onDoubleClick={() => setEditing({ i, text: t.text })}
        title="Clic : sélectionner · Maj+clic : étendre · double-clic : corriger le texte"
        className={`${base} text-[15px] font-semibold`}>{t.text}</button>
    );
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Éditer par le texte" data-testid="text-edit-dialog" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-3xl max-h-[100dvh] overflow-y-auto space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-black">Éditer par le texte{first ? <span className="font-bold text-nv-muted"> · {first.name}</span> : null}</h2>
            <p className="text-[11px] text-nv-muted">Clique un mot (Maj+clic pour étendre) : il est sélectionné dans le clip. Suppr l’efface, proprement, dans le silence. Double-clic pour corriger un mot mal écrit.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>

        {!words ? (
          <div role="status" data-testid="text-edit-empty" className="space-y-2 rounded-xl border border-dashed border-nv-line p-4 text-[12px]">
            <p>Ce clip n’a pas encore de texte (ou le son a changé depuis la transcription).</p>
            <button type="button" className={secondary} onClick={() => { openNovaWindow('voice-transcribe', { targets: [{ trackId: request.trackId, clipId: request.clipId }] }); onClose(); }}>
              <i className="fas fa-closed-captioning mr-1.5" />Transcrire les paroles…
            </button>
          </div>
        ) : (
          <div ref={boxRef} data-testid="text-edit-text" className="max-h-[45dvh] overflow-y-auto rounded-xl border border-nv-line bg-nv-well p-3 leading-relaxed">
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
              {tokens.map((t, i) => (
                <React.Fragment key={i}>
                  {t.kind === 'word' && t.b && i > 0 && <span className="basis-full h-0" aria-hidden />}
                  {chip(t, i)}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        {words > 0 && (
          <p className="text-[12px]" role="status" data-testid="text-edit-selection">
            {sel && span
              ? <>Sélection : <b>« {tokensText(tokens, a, b).slice(0, 60)} »</b> · {fmt(span.start)} → {fmt(span.end)} ({fmt(span.end - span.start)})</>
              : <span className="text-nv-muted">{words} mots · {clips.length > 1 ? `${clips.length} clips` : '1 clip'}. Rien de sélectionné.</span>}
          </p>
        )}

        {words > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={primary} disabled={!sel} onClick={erase} data-testid="text-edit-delete" title="Efface la sélection (touche Suppr) : coupe dans le silence, fondus de 10 ms">
              <i className="fas fa-eraser mr-1.5" />Effacer
            </button>
            <button type="button" className={secondary} onClick={listen} aria-pressed={playing} data-testid="text-edit-listen" title="Écoute la sélection (ou toute la prise) telle qu’elle sonne maintenant">
              <i className={`fas ${playing ? 'fa-stop' : 'fa-play'} mr-1.5`} />Écouter
            </button>
            <button type="button" className={secondary} disabled={!sel} onClick={() => split('here')} title="Coupe le clip juste avant le mot sélectionné (dans le silence)">
              <i className="fas fa-scissors mr-1.5" />Couper avant
            </button>
            <button type="button" className={secondary} onClick={() => split('phrase')} data-testid="text-edit-split-phrase" title="Un clip par phrase, coupé dans les silences">
              <i className="fas fa-grip-lines mr-1.5" />Découper par phrase
            </button>
            <button type="button" className={secondary} onClick={() => split('word')} title="Un clip par mot, coupé dans les silences">
              <i className="fas fa-grip mr-1.5" />Par mot
            </button>
            <label className="ml-auto flex items-center gap-2 text-[12px]" title="Coché : la suite de la prise recule pour refermer le blanc (mode Shuffle). Décoché : un blanc reste, le reste ne bouge pas par rapport au beat.">
              <input type="checkbox" checked={ripple} data-testid="text-edit-ripple" className="h-4 w-4 accent-cyan-500"
                onChange={e => { setRipple(e.target.checked); try { localStorage.setItem(RIPPLE_KEY, e.target.checked ? '1' : '0'); } catch { /* stockage indisponible */ } }} />
              Refermer le blanc (la suite recule)
            </label>
          </div>
        )}
      </div>
    </div>
  );
};

export default TextEditDialog;
