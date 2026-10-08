import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clip, ContextMenuItem, Track, TrackType } from '../types';
import { midiBus } from '../utils/midiBus';
import { midiCapture } from '../utils/midiCapture';
import { hasMidi } from '../utils/midiImport';

/**
 * Entrées MIDI (V25) des menus partagés : barre de transport (bureau), menu
 * ☰ (tablette, téléphone), menus du clip et de la piste. Elles n'envoient
 * qu'une demande sur utils/midiBus ; components/MidiHost fait le travail.
 */

/** Nombre de notes en mémoire pour « Capturer » (badge). */
export function useCaptureCount(): number {
  const [n, setN] = useState(midiCapture.size);
  useEffect(() => midiCapture.subscribe(() => setN(midiCapture.size)), []);
  return n;
}

export const CAPTURE_HINT = 'Capturer : crée un clip avec ce que tu viens de jouer, même sans avoir enregistré (comme Capture MIDI dans Ableton Live et la fonction Capture Recording de Logic). Ctrl+Maj+C.';

/** Menu du clip : groove (MIDI), export .mid, ou extraction du groove (audio). */
export function midiClipMenuItems(trackId: string, clip: Clip, close: () => void): ContextMenuItem[] {
  if (clip.type === TrackType.MIDI && Array.isArray(clip.notes)) {
    return [
      { label: clip.groove ? 'Groove et swing… (actif)' : 'Groove et swing…', icon: 'fa-drum', title: 'Swing 50-75 %, grooves MPC et trap, groove extrait d’une boucle (Groove Pool de Live, swing de FL Studio)',
        onClick: () => { midiBus.emit({ type: 'groove', trackId, clipId: clip.id }); close(); } },
      { label: 'Exporter le clip en .mid', icon: 'fa-file-export', title: 'Fichier MIDI standard pour un autre DAW (Export MIDI Clip de Live, Export as MIDI File de Logic)', disabled: !clip.notes.length,
        onClick: () => { midiBus.emit({ type: 'export', scope: 'clip', trackId, clipId: clip.id }); close(); } },
    ];
  }
  return [{ label: 'Extraire le groove…', icon: 'fa-drum', title: 'Garde le balancement de cette boucle pour le poser sur tes clips MIDI (Extract Groove dans Ableton Live)',
    onClick: () => { midiBus.emit({ type: 'groove', trackId, clipId: clip.id }); close(); } }];
}

/** Menu de la piste : exporter ses notes, importer un .mid dessus. */
export function midiTrackMenuItems(track: Track | undefined, close: () => void): ContextMenuItem[] {
  if (!track) return [];
  const items: ContextMenuItem[] = [];
  if (hasMidi(track)) items.push({ label: 'Exporter la piste en .mid', icon: 'fa-file-export', title: 'Toutes les notes de la piste, à leur place dans le morceau (Export MIDI de Pro Tools et Logic)',
    onClick: () => { midiBus.emit({ type: 'export', scope: 'track', trackId: track.id }); close(); } });
  if (track.type === TrackType.MIDI || track.type === TrackType.DRUM_RACK || track.type === TrackType.SAMPLER) items.push({ label: 'Importer un .mid sur cette piste…', icon: 'fa-file-import',
    title: 'Pack MIDI, mélodie d’un autre DAW : les notes arrivent sur cette piste à la tête de lecture',
    onClick: () => { midiBus.emit({ type: 'import-pick', trackId: track.id }); close(); } });
  return items;
}

/** Bouton « MIDI » de la barre de transport (bureau) et son menu. */
export const MidiFileMenu: React.FC<{ tracks?: Track[] }> = ({ tracks }) => {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const count = useCaptureCount();
  const anyMidi = !tracks || tracks.some(hasMidi);
  const item = 'w-full min-h-10 px-3 rounded-lg text-left flex items-center gap-2.5 hover:bg-white/10 text-[12px] font-semibold disabled:opacity-40';
  return (
    <>
      <button ref={btn} type="button" data-nova-midi-menu="" aria-haspopup="menu" aria-expanded={!!open}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setOpen(open ? null : { x: Math.min(window.innerWidth - 300, r.left), y: r.bottom + 6 }); }}
        title="Fichiers MIDI (.mid) et Capture MIDI"
        className="relative h-8 px-3 rounded-lg flex items-center space-x-2 transition-all bg-white/[0.05] text-slate-400 hover:bg-white/10 hover:text-white">
        <i className="fas fa-music text-[10px]"></i>
        <span className="hidden min-[2300px]:inline text-[10px] font-bold tracking-wide">MIDI</span>
        {count > 0 && <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-black leading-4 text-center" title={`${count} note${count > 1 ? 's' : ''} jouée${count > 1 ? 's' : ''} en mémoire`}>{count > 99 ? '99+' : count}</span>}
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[590]" onPointerDown={() => setOpen(null)} />
          <div role="menu" aria-label="MIDI" className="fixed z-[600] w-72 rounded-xl border border-white/15 bg-[#1a1c22] p-1.5 shadow-2xl text-slate-100" style={{ left: open.x, top: open.y }}>
            <button role="menuitem" type="button" className={item} data-testid="midi-import" onClick={() => { setOpen(null); midiBus.emit({ type: 'import-pick' }); }}
              title="Ouvre un fichier .mid (pack MIDI, export d’un autre DAW) : une piste par partie, la batterie sur la boîte à rythmes">
              <i className="fas fa-file-import w-4 text-cyan-300" />Importer un fichier .mid…</button>
            <button role="menuitem" type="button" className={item} data-testid="midi-export-all" disabled={!anyMidi} onClick={() => { setOpen(null); midiBus.emit({ type: 'export', scope: 'all' }); }}
              title="Toutes les pistes MIDI dans un seul fichier (format 1), au tempo du projet">
              <i className="fas fa-file-export w-4 text-cyan-300" />Exporter toutes les pistes MIDI (.mid)</button>
            <button role="menuitem" type="button" className={item} data-testid="midi-capture" onClick={() => { setOpen(null); midiBus.emit({ type: 'capture' }); }} title={CAPTURE_HINT}>
              <i className="fas fa-hand-sparkles w-4 text-red-400" />Capturer ce que je viens de jouer{count > 0 ? ` (${count})` : ''}<span className="ml-auto text-[10px] text-slate-500">Ctrl+Maj+C</span></button>
            <button role="menuitem" type="button" className={item} onClick={() => { setOpen(null); midiBus.emit({ type: 'groove' }); }}
              title="Swing et groove du clip MIDI sélectionné (Groove Pool de Live, swing de FL)">
              <i className="fas fa-drum w-4 text-amber-300" />Groove et swing du clip…</button>
          </div>
        </>, document.body)}
    </>
  );
};

/** Entrées du menu ☰ (tablette et téléphone : version simple). */
export const MidiMobileMenuItems: React.FC<{ onDone: () => void; tracks?: Track[] }> = ({ onDone, tracks }) => {
  const count = useCaptureCount();
  const anyMidi = !tracks || tracks.some(hasMidi);
  const cls = 'w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3 disabled:opacity-40';
  const go = (e: Parameters<typeof midiBus.emit>[0]) => { onDone(); setTimeout(() => midiBus.emit(e), 0); };
  return (
    <>
      <button type="button" className={cls} data-testid="m-midi-import" onClick={() => go({ type: 'import-pick' })}><i className="w-5 text-center text-cyan-300 fas fa-file-import" /><span>Importer un fichier .mid</span></button>
      <button type="button" className={cls} data-testid="m-midi-export" disabled={!anyMidi} onClick={() => go({ type: 'export', scope: 'all' })}><i className="w-5 text-center text-cyan-300 fas fa-file-export" /><span>Exporter en .mid</span></button>
      <button type="button" className={cls} data-testid="m-midi-swing" onClick={() => go({ type: 'groove' })}><i className="w-5 text-center text-amber-300 fas fa-drum" /><span>Swing du clip MIDI</span></button>
      <button type="button" className={cls} data-testid="m-midi-capture" onClick={() => go({ type: 'capture' })} title={CAPTURE_HINT}><i className="w-5 text-center text-red-400 fas fa-hand-sparkles" /><span>Capturer ce que j’ai joué{count > 0 ? ` (${count})` : ''}</span></button>
    </>
  );
};

export default MidiFileMenu;

/** Ligne « Fichier MIDI » de la fenêtre d'export (présente seulement s'il y a des notes). */
export const MidiExportRow: React.FC<{ tracks: Track[] }> = ({ tracks }) => {
  const n = tracks.filter(hasMidi).length;
  if (!n) return null;
  return (
    <button type="button" data-testid="export-midi" onClick={() => midiBus.emit({ type: 'export', scope: 'all' })}
      title="Fichier MIDI standard (format 1) pour l’ouvrir dans un autre DAW : Ableton, FL Studio, Logic, Pro Tools"
      className="w-full min-h-12 px-4 py-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-left flex items-center gap-3">
      <span className="text-2xl leading-none" aria-hidden="true">🎹</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-black text-white">Notes MIDI (.mid)</span>
        <span className="block text-[12px] text-slate-400">{n} piste{n > 1 ? 's' : ''} MIDI dans un seul fichier, au tempo du projet. Gratuit.</span>
      </span>
      <i className="fas fa-download text-slate-500" aria-hidden="true"></i>
    </button>
  );
};
