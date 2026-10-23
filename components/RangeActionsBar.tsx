import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditCommands } from '../hooks/useEditCommands';
import { useEditSelection } from '../utils/editSelection';
import { selLength } from '../utils/timeSelection';
import { openNovaWindow } from '../utils/novaWindows';
import { fmtDb, parseDb } from '../utils/automationRange';
import { runEditCommand } from '../utils/editCommands';
import { chordLabel, keysOf } from '../utils/keymap';

/**
 * Barre d'actions de la sélection de plage (Sélecteur / Smart Tool) : tout ce
 * qu'on fait sur une plage dans Pro Tools, à portée de clic, avec le raccourci
 * dans l'infobulle. Au doigt (tablette), les libellés restent courts.
 */
const fmt = (s: number) => (s >= 1 ? `${s.toFixed(2).replace('.', ',')} s` : `${Math.round(s * 1000)} ms`);

/**
 * Barre des actions sur la plage, posée EN BAS de la fenêtre d'édition, à gauche
 * de la timeline (après les en-têtes de pistes) : avant, elle était en haut à
 * droite, sur la règle (mesures 9 à 16 cachées, clics de positionnement perdus).
 * insetLeft : largeur des en-têtes de pistes.
 */
const RangeActionsBar: React.FC<{ commands: EditCommands; insetLeft?: number }> = ({ commands, insetLeft = 0 }) => {
  const { time } = useEditSelection();
  // « Volume de la plage » : petite fenêtre de saisie en dB, au-dessus de la barre.
  const [volOpen, setVolOpen] = useState(false);
  const [volText, setVolText] = useState('+1');
  // « Écrire sur la plage » (Pro Tools : Write to Current / All Enabled) : la valeur actuelle du fader.
  const [writeOpen, setWriteOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // Pendant un geste commencé ailleurs (glisser une plage, déplacer un clip), la barre
  // s'efface et laisse passer le pointeur : posée en bas, elle ne doit pas arrêter un
  // glisser qui passe dessous (la plage s'arrêtait au bord de la barre).
  const [passive, setPassive] = useState(false);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (barRef.current?.contains(t) || (t as HTMLElement).closest?.('[data-testid="range-volume"], [data-testid="range-write"]'))) return;
      setPassive(true);
    };
    const up = () => setPassive(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
  }, []);
  useEffect(() => { if (!time) { setVolOpen(false); setWriteOpen(false); } }, [time]);
  useEffect(() => { if (volOpen) setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0); }, [volOpen]);
  if (!time) return null;
  const volDb = parseDb(volText);
  const applyVol = (v: number | null = volDb) => { if (v === null || Math.abs(v) < 1e-9) return; commands.volumeRange(v); setVolOpen(false); };
  const bump = (step: number) => setVolText(t => { const v = Math.round(((parseDb(t) ?? 0) + step) * 10) / 10; return v > 0 ? `+${v}` : `${v}`; });
  const actions: { label: string; icon: string; title: string; run: () => unknown; danger?: boolean }[] = [
    { label: 'Couper', icon: 'fa-cut', title: 'Couper la plage (Ctrl+X, comme dans les studios pro)', run: commands.cutSelection },
    { label: 'Copier', icon: 'fa-copy', title: 'Copier la plage (Ctrl+C)', run: commands.copySelection },
    { label: 'Dupliquer', icon: 'fa-clone', title: 'Dupliquer la plage juste après (Ctrl+D, « Duplicate »)', run: commands.duplicateSelection },
    { label: 'Séparer', icon: 'fa-grip-lines-vertical', title: 'Séparer les clips aux bords de la plage (Ctrl+E, « Separate Clip »)', run: commands.separate },
    { label: 'Consolider', icon: 'fa-layer-group', title: 'Consolider la plage : sans effets (Alt+Maj+3, « Consolidate Clip ») ou avec effets sur une nouvelle piste', run: () => openNovaWindow('bounce', { bounce: { mode: 'range' }, range: { start: time.start, end: time.end, trackIds: time.trackIds } }) },
    { label: 'Traiter', icon: 'fa-wand-magic-sparkles', title: 'Traiter les clips de la plage avec un effet NOVA ou un VST, avec poignées ; l’original est gardé', run: () => openNovaWindow('audiosuite', { range: { start: time.start, end: time.end, trackIds: time.trackIds } }) },
    { label: 'Fondus', icon: 'fa-bezier-curve', title: 'Créer des fondus sur la plage : entrée, sortie ou crossfade sur une jonction (Ctrl+F, « Fades »)', run: commands.fadesFromSelection },
    { label: 'Boucler', icon: 'fa-sync-alt', title: 'Boucler la lecture sur la plage (« Loop Playback » sur la sélection)', run: commands.loopSelection },
    { label: 'Punch', icon: 'fa-bullseye', title: 'La plage devient la zone de punch : REC ne remplacera qu\'elle (Punch-in / punch-out)', run: commands.punchSelection },
    { label: 'Volume', icon: 'fa-volume-high', title: 'Volume de la plage : monter ou baisser la courbe de volume des pistes sélectionnées de N dB (refrain +2 dB…), rampes de 10 ms aux bords (Trim sur la sélection en vue volume, « Write to Selection »)', run: () => setVolOpen(v => !v) },
    { label: 'Écrire', icon: 'fa-pen-nib', title: 'Écrire la valeur ACTUELLE du fader (ou du pan, ou de tous les réglages) sur toute la plage : règle à l’oreille, puis écris (Write Automation to Current, Ctrl+/ ; to All Enabled, Ctrl+Alt+/)', run: () => { setVolOpen(false); setWriteOpen(v => !v); } },
    { label: 'Copier l’automation', icon: 'fa-wave-square', title: 'Copier l’automation de la plage : volume, pan, muet, envois et réglages d’effets de chaque piste (« Copy Special > Automation »)', run: commands.copyAutomation },
    ...(commands.hasAutomationClipboard() ? [{ label: 'Coller l’automation', icon: 'fa-paste', title: 'Coller l’automation copiée au début de la plage, sur les mêmes réglages (« Paste Special > Merge ») ; un réglage d’effet absent de la piste est ignoré', run: commands.pasteAutomation }] : []),
    { label: 'Exporter', icon: 'fa-compact-disc', title: 'Exporter seulement la plage (« Bounce » de la sélection)', run: commands.exportSelection },
    { label: 'Effacer', icon: 'fa-trash', title: 'Effacer le contenu de la plage, en laissant un blanc (Suppr)', run: commands.deleteSelection, danger: true },
  ];
  return (
    <>
    <div ref={barRef} role="toolbar" aria-label="Actions sur la sélection de plage" data-nova-target="range-actions"
      data-passive={passive ? '1' : '0'}
      style={{ left: insetLeft + 12, maxWidth: `calc(100% - ${insetLeft + 24}px)`, ...(passive ? { pointerEvents: 'none', opacity: 0.25 } : {}) }}
      className="absolute bottom-3 z-40 transition-opacity duration-150 overflow-x-auto flex flex-nowrap items-center gap-1 px-1.5 py-0.5 rounded-xl border border-sky-400/30 bg-nv-surface/95 shadow-2xl backdrop-blur">
      <span className="px-2 text-[10px] font-black text-sky-300 whitespace-nowrap" title="Plage sélectionnée (Sélecteur)">
        Plage {fmt(selLength(time))} · {time.trackIds.length} piste{time.trackIds.length > 1 ? 's' : ''}
      </span>
      {actions.map(a => (
        <button key={a.label} type="button" title={a.title} aria-label={a.label} onClick={() => a.run()}
          className={`shrink-0 h-8 px-2 rounded-lg flex items-center gap-1.5 text-[10px] font-bold border border-white/10 transition-colors ${a.danger ? 'text-red-300 hover:bg-red-500/20' : 'text-slate-200 hover:bg-white/10'}`}>
          <i className={`fas ${a.icon} text-[10px]`}></i>
          <span className="hidden 2xl:inline">{a.label}</span>
        </button>
      ))}
      <button type="button" onClick={commands.clearSelection} aria-label="Désélectionner la plage" title="Désélectionner la plage"
        className="shrink-0 h-8 w-8 rounded-lg text-slate-400 hover:text-white hover:bg-white/10">
        <i className="fas fa-times text-[11px]"></i>
      </button>
    </div>
      {volOpen && createPortal(
        <div role="dialog" aria-label="Volume de la plage" data-testid="range-volume"
          className="fixed z-[650] flex items-center gap-1.5 rounded-xl border border-sky-400/30 bg-nv-surface p-2 shadow-2xl"
          style={(() => { const r = barRef.current?.getBoundingClientRect(); return r ? { bottom: Math.max(8, window.innerHeight - r.top + 4), left: Math.max(8, r.left) } : {}; })()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setVolOpen(false); } }}>
          <span className="px-1 text-[11px] font-bold text-sky-200 whitespace-nowrap">Volume de la plage</span>
          <button type="button" onClick={() => bump(-1)} aria-label="−1 dB" className="nova-hit-tactile h-8 w-9 rounded-lg bg-white/5 text-[12px] font-bold text-slate-200 hover:bg-white/10">−1</button>
          <input ref={inputRef} value={volText} onChange={e => setVolText(e.target.value)} inputMode="decimal" aria-label="Volume de la plage (dB)"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyVol(); } if (e.key === 'ArrowUp') { e.preventDefault(); bump(0.5); } if (e.key === 'ArrowDown') { e.preventDefault(); bump(-0.5); } }}
            className={`h-8 w-16 rounded-lg border bg-black/40 px-2 text-center font-mono text-[12px] text-white outline-none ${volDb === null ? 'border-red-400/60' : 'border-white/15 focus:border-sky-400/60'}`} />
          <span className="text-[11px] text-slate-400">dB</span>
          <button type="button" onClick={() => bump(1)} aria-label="+1 dB" className="nova-hit-tactile h-8 w-9 rounded-lg bg-white/5 text-[12px] font-bold text-slate-200 hover:bg-white/10">+1</button>
          <button type="button" onClick={() => applyVol()} disabled={volDb === null || Math.abs(volDb) < 1e-9} data-testid="range-volume-apply"
            className="h-8 rounded-lg bg-sky-500 px-3 text-[11px] font-black text-black disabled:opacity-40">{volDb === null ? 'dB ?' : `Appliquer ${fmtDb(volDb)}`}</button>
        </div>
      , document.body)}
      {writeOpen && createPortal(
        <div role="menu" aria-label="Écrire l’automation sur la plage" data-testid="range-write"
          className="fixed z-[650] flex flex-col gap-0.5 rounded-xl border border-sky-400/30 bg-nv-surface p-1.5 shadow-2xl min-w-[260px] max-h-[calc(100vh-120px)] overflow-y-auto"
          style={(() => { const r = barRef.current?.getBoundingClientRect(); return r ? { bottom: Math.max(8, window.innerHeight - r.top + 4), left: Math.max(8, r.left) } : {}; })()}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setWriteOpen(false); } }}>
          <span className="px-2 pt-0.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-sky-200">Écrire la valeur actuelle sur la plage</span>
          {([
            { id: 'pt.writeCurrent', label: 'Volume (position du fader)', arg: {}, cmd: 'writeAutomation' as const },
            { id: 'pt.writePan', label: 'Pan', arg: { param: 'pan' }, cmd: 'writeAutomation' as const },
            { id: 'pt.writeAll', label: 'Tous les réglages automatisés', arg: { all: true }, cmd: 'writeAutomation' as const },
            { sep: 'Volume actuel sur une étendue' },
            { id: 'pt.writeToStart', label: 'Du début jusqu’ici (Write to Start)', arg: { span: 'start' }, cmd: 'writeAutomationSpan' as const },
            { id: 'pt.writeToEnd', label: 'D’ici à la fin (Write to End)', arg: { span: 'end' }, cmd: 'writeAutomationSpan' as const },
            { id: 'pt.writeToAll', label: 'Tout le morceau (Write to All)', arg: { span: 'all' }, cmd: 'writeAutomationSpan' as const },
            { id: 'pt.writeToPunch', label: 'Zone de punch (Write to Punch)', arg: { span: 'punch' }, cmd: 'writeAutomationSpan' as const },
            { sep: 'Glisser d’une valeur à l’autre' },
            { id: 'pt.glide', label: 'Rampe droite sur la plage (Glide)', arg: {}, cmd: 'glideAutomation' as const },
            { id: 'pt.glideCurrent', label: 'Rampe jusqu’au fader (Glide to Current)', arg: { toCurrent: true }, cmd: 'glideAutomation' as const },
          ] as ({ id: string; label: string; arg: any; cmd: 'writeAutomation' | 'writeAutomationSpan' | 'glideAutomation' } | { sep: string })[]).map(o => ('sep' in o ? (
            <span key={o.sep} className="px-2 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-200/80 border-t border-white/10 mt-0.5">{o.sep}</span>
          ) : (
            <button key={o.id} type="button" role="menuitem" data-testid={`range-${o.id}`}
              onClick={() => { runEditCommand(o.cmd, o.arg); setWriteOpen(false); }}
              className="nova-hit-tactile flex min-h-[34px] [@media(pointer:coarse)]:min-h-[44px] items-center gap-2 rounded-lg px-2 text-left text-[12px] font-semibold text-slate-100 hover:bg-white/10">
              <span className="flex-1">{o.label}</span>
              <span className="text-[10px] text-slate-400">{keysOf(o.id)[0] ? chordLabel(keysOf(o.id)[0]) : ''}</span>
            </button>
          )))}
        </div>
      , document.body)}
    </>
  );
};

export default RangeActionsBar;
