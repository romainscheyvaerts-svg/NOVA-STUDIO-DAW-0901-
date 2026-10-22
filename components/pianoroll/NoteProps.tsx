import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MidiNote } from '../../types';
import { noteNameFr } from '../../utils/scales';

/**
 * Propriétés de la note (double-clic sur une note, ou « Notes ▾ › Propriétés ») :
 * hauteur, début, longueur, vélocité, glissé, muette, effacer. Plusieurs notes
 * sélectionnées : les champs communs s'appliquent à toutes (début et longueur
 * décalés d'autant). Chaque réglage validé = une étape d'annulation.
 */

interface Props {
  notes: MidiNote[];
  anchor: { x: number; y: number };
  /** Durée d'un temps (s) au début des notes : début et longueur s'affichent en temps. */
  beatSec: number;
  isDrum: boolean;
  onApply: (fn: (n: MidiNote) => MidiNote, label: string) => void;
  onDelete: () => void;
  onPreview: (pitch: number) => void;
  onClose: () => void;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

const NoteProps: React.FC<Props> = ({ notes, anchor, beatSec, isDrum, onApply, onDelete, onPreview, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);
  const first = notes[0];
  const single = notes.length === 1;
  const [vel, setVel] = useState(() => Math.round(first.velocity * 127));
  useEffect(() => { setVel(Math.round(first.velocity * 127)); }, [first.velocity]);

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)), y: anchor.y + r.height > window.innerHeight - 8 ? Math.max(8, anchor.y - r.height - 12) : anchor.y });
  }, [anchor.x, anchor.y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!first) return null;
  const startBeats = r3(first.start / beatSec + 1);
  const lenBeats = r3(first.duration / beatSec);
  const allSlide = notes.every(n => n.slide);
  const allMuted = notes.every(n => n.muted);
  const commitVel = (v: number) => {
    const val = Math.max(1, Math.min(127, Math.round(v)));
    if (notes.every(n => Math.round(n.velocity * 127) === val)) return;
    onApply(n => ({ ...n, velocity: val / 127 }), `Vélocité ${val}`);
  };
  const lbl = 'text-[10px] font-black uppercase tracking-widest';
  const field = 'h-9 [@media(pointer:coarse)]:h-11 rounded-lg px-2 w-full border';
  const fieldStyle = { background: 'var(--pr-cap)', borderColor: 'var(--pr-cap-line)', color: 'var(--pr-cap-ink)' } as React.CSSProperties;

  return (
    <>
      <div className="fixed inset-0 z-[290]" onPointerDown={e => { e.stopPropagation(); onClose(); }} onContextMenu={e => e.preventDefault()} />
      <div ref={ref} role="dialog" aria-label="Propriétés de la note" data-nova-roll-menu="proprietes"
        className="pr-menu fixed z-[300] w-72 max-h-[80vh] overflow-y-auto !p-3 space-y-3" style={{ left: pos.x, top: pos.y }}>
        <div className="flex items-center justify-between">
          <b className="text-[12px]">{single ? `Note ${noteNameFr(first.pitch)}` : `${notes.length} notes`}</b>
          <button type="button" className="pr-cap !h-8 !min-w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!min-w-11" aria-label="Fermer" onClick={onClose}><i className="fas fa-times" /></button>
        </div>
        {!isDrum && (
          <div>
            <div className={lbl} style={{ color: 'var(--pr-menu-soft)' }}>Hauteur</div>
            <div className="flex gap-1.5 mt-1">
              <button type="button" className="pr-cap" aria-label="Un demi-ton plus bas" onClick={() => { onApply(n => ({ ...n, pitch: Math.max(0, n.pitch - 1) }), 'Un demi-ton plus bas'); onPreview(Math.max(0, first.pitch - 1)); }}><i className="fas fa-minus" /></button>
              {single ? (
                <select aria-label="Hauteur de la note" className={field} style={fieldStyle} value={first.pitch}
                  onChange={e => { const p = Number(e.target.value); onApply(n => ({ ...n, pitch: p }), `Note ${noteNameFr(p)}`); onPreview(p); }}>
                  {Array.from({ length: 128 }, (_, i) => 127 - i).map(p => <option key={p} value={p}>{noteNameFr(p)}</option>)}
                </select>
              ) : <span className="flex-1 text-center self-center" style={{ color: 'var(--pr-menu-soft)' }}>toutes ensemble</span>}
              <button type="button" className="pr-cap" aria-label="Un demi-ton plus haut" onClick={() => { onApply(n => ({ ...n, pitch: Math.min(127, n.pitch + 1) }), 'Un demi-ton plus haut'); onPreview(Math.min(127, first.pitch + 1)); }}><i className="fas fa-plus" /></button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={lbl} style={{ color: 'var(--pr-menu-soft)' }}>Début (temps)</span>
            <input type="number" step={0.25} min={1} aria-label="Début de la note, en temps" className={`${field} mt-1`} style={fieldStyle} defaultValue={startBeats} key={`s${startBeats}`}
              onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && Math.abs(v - startBeats) > 1e-4) { const d = (v - startBeats) * beatSec; onApply(n => ({ ...n, start: Math.max(0, n.start + d) }), 'Note déplacée'); } }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          </label>
          <label className="block">
            <span className={lbl} style={{ color: 'var(--pr-menu-soft)' }}>Longueur (temps)</span>
            <input type="number" step={0.25} min={0.0625} aria-label="Longueur de la note, en temps" className={`${field} mt-1`} style={fieldStyle} defaultValue={lenBeats} key={`l${lenBeats}`}
              onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0 && Math.abs(v - lenBeats) > 1e-4) onApply(n => ({ ...n, duration: Math.max(0.01, v * beatSec) }), 'Longueur changée'); }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          </label>
        </div>
        <label className="block">
          <span className={`${lbl} flex justify-between`} style={{ color: 'var(--pr-menu-soft)' }}><span>Vélocité</span><b style={{ color: 'var(--pr-cap-ink)' }}>{vel}</b></span>
          <input type="range" min={1} max={127} value={vel} aria-label="Vélocité de la note" className="w-full h-8 [@media(pointer:coarse)]:h-11 accent-cyan-500" data-nova-note-vel=""
            onChange={e => setVel(Number(e.target.value))} onPointerUp={() => commitVel(vel)} onKeyUp={() => commitVel(vel)} onBlur={() => commitVel(vel)} />
        </label>
        <div className="flex flex-wrap gap-2">
          {!isDrum && (
            <button type="button" className="pr-cap" aria-pressed={allSlide} data-nova-note-slide=""
              title="Glissé : posée pendant une note tenue, elle la fait glisser jusqu'à sa hauteur (808)"
              onClick={() => onApply(n => { if (allSlide) { const { slide, ...rest } = n; void slide; return rest; } return { ...n, slide: true }; }, allSlide ? 'Glissé retiré' : 'Note glissée')}>
              <i className="fas fa-level-up-alt rotate-90" />Glissé
            </button>
          )}
          <button type="button" className="pr-cap" aria-pressed={allMuted} data-nova-note-mute=""
            onClick={() => onApply(n => { if (allMuted) { const { muted, ...rest } = n; void muted; return rest; } return { ...n, muted: true }; }, allMuted ? 'Note réactivée' : 'Note muette')}>
            <i className="fas fa-volume-mute" />Muette
          </button>
          <button type="button" className="pr-cap ml-auto" onClick={() => { onDelete(); onClose(); }}><i className="fas fa-trash text-red-500" />Effacer</button>
        </div>
      </div>
    </>
  );
};

export default NoteProps;
