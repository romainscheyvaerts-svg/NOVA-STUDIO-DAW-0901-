import React, { useEffect, useRef, useState } from 'react';

/** Palette façon Pro Tools (couleurs de clips et de pistes), lisible sur fond sombre. */
export const PT_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#00f2ff', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#94a3b8', '#64748b', '#a16207', '#b45309', '#fbbf24', '#e2e8f0',
];

interface Props {
  open: boolean;
  /** « Renommer le clip », « Couleur de la piste »… */
  title: string;
  ptHint: string;
  /** Nom actuel ; absent = pas de champ nom (couleur de piste). */
  name?: string;
  color: string;
  /** Plusieurs clips : le nom ne s'applique qu'au premier. */
  countLabel?: string;
  focus?: 'name' | 'color';
  onSave: (v: { name?: string; color?: string }) => void;
  onClose: () => void;
}

/** Renommer un clip, changer la couleur d'un clip ou d'une piste (annulable par Ctrl+Z). */
const ClipPropsDialog: React.FC<Props> = ({ open, title, ptHint, name, color, countLabel, focus = 'name', onSave, onClose }) => {
  const [n, setN] = useState(name ?? '');
  const [c, setC] = useState(color);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setN(name ?? ''); setC(color); }, [name, color, open]);
  useEffect(() => { if (open && focus === 'name') setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30); }, [open, focus]);
  if (!open) return null;

  const save = () => {
    const out: { name?: string; color?: string } = {};
    if (name !== undefined && n.trim() && n.trim() !== name) out.name = n.trim();
    if (c !== color) out.color = c;
    if (out.name !== undefined || out.color !== undefined) onSave(out);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="clipprops-title">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-nv-surface p-5 shadow-2xl" onClick={e => e.stopPropagation()} data-testid="clip-props">
        <div className="mb-3 flex items-center">
          <h2 id="clipprops-title" className="mr-auto text-[15px] font-black text-white" title={ptHint}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-9 w-9 rounded-lg bg-white/5 text-slate-300">✕</button>
        </div>
        {countLabel && <p className="mb-2 text-[11px] text-slate-400">{countLabel}</p>}
        {name !== undefined && (
          <label className="mb-4 block">
            <span className="text-[11px] font-bold text-slate-300">Nom</span>
            <input ref={inputRef} value={n} onChange={e => setN(e.target.value)} maxLength={60} aria-label="Nom"
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white outline-none focus:border-cyan-500/60" />
          </label>
        )}
        <span className="text-[11px] font-bold text-slate-300">Couleur</span>
        <div className="mt-1 grid grid-cols-8 gap-1.5" role="radiogroup" aria-label="Couleur">
          {PT_COLORS.map(col => (
            <button key={col} type="button" role="radio" aria-checked={c === col} aria-label={col} onClick={() => setC(col)}
              className={`h-7 w-full rounded-md ring-offset-2 ring-offset-[#121418] ${c === col ? 'ring-2 ring-white' : 'hover:ring-1 hover:ring-white/40'}`}
              style={{ backgroundColor: col }} />
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg bg-white/5 px-4 py-2 text-[12px] font-bold text-slate-300">Annuler</button>
          <button type="button" onClick={save} data-testid="clip-props-save" className="rounded-lg bg-cyan-500 px-4 py-2 text-[12px] font-black text-black">Valider</button>
        </div>
      </div>
    </div>
  );
};

export default ClipPropsDialog;
