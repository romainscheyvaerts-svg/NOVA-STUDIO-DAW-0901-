import React from 'react';
import { chordNameFr, chordSymbol, chordTones } from '../utils/chordDetect';
import { useProjectChords } from '../utils/chordTrack';
import { chordColor } from './ChordLane';

/**
 * Piano roll (V20) : les notes de l'accord en cours sont surlignées, accord
 * par accord, d'après la piste d'accords (comme Logic quand la Chord Track
 * guide l'édition). Fondamentale plus marquée ; nom de l'accord sur ses
 * lignes de fondamentale. Purement visuel (aucun clic capté).
 */
interface Props {
  /** Début (s, timeline) et durée du clip ouvert. */
  clipStart: number;
  clipDuration: number;
  zoomX: number;
  /** Lignes affichées de haut en bas (notes MIDI), comme dans le piano roll. */
  rows: number[];
  rowHeight: number;
  hidden?: boolean;
}

const ChordRollOverlay: React.FC<Props> = ({ clipStart, clipDuration, zoomX, rows, rowHeight, hidden }) => {
  const chords = useProjectChords();
  if (hidden || !chords.length) return null;
  const from = clipStart, to = clipStart + clipDuration + 4;
  const out: React.ReactNode[] = [];
  for (const c of chords) {
    if (c.end <= from || c.start >= to) continue;
    const left = (Math.max(c.start, from) - clipStart) * zoomX;
    const width = (Math.min(c.end, to) - Math.max(c.start, from)) * zoomX;
    const tones = new Set(chordTones(c.root, c.quality));
    const col = chordColor(c.root);
    rows.forEach((p, i) => {
      const pc = ((p % 12) + 12) % 12;
      if (!tones.has(pc)) return;
      const isRoot = pc === c.root;
      out.push(
        <div key={`${c.id}-${p}`} className="absolute pointer-events-none" data-chord-row={p}
          style={{ left, width, top: i * rowHeight, height: rowHeight, backgroundColor: `color-mix(in srgb, ${col} ${isRoot ? 22 : 13}%, transparent)`, borderLeft: `2px solid color-mix(in srgb, ${col} 55%, transparent)` }}>
          {isRoot && width > 26 && (
            <span className="absolute left-1 top-0 text-[8px] font-black leading-none pointer-events-none" style={{ color: col, lineHeight: `${rowHeight}px` }} title={chordNameFr(c.root, c.quality)}>
              {chordSymbol(c.root, c.quality)}
            </span>
          )}
        </div>,
      );
    });
  }
  return <div className="absolute inset-0 pointer-events-none" data-testid="chord-roll-overlay" aria-hidden>{out}</div>;
};

export default ChordRollOverlay;
