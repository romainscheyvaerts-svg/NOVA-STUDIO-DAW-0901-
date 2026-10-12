import React, { useEffect, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import { ioNamesStore, MAX_NAMED_INPUTS } from '../utils/ioNames';

/**
 * Entrées nommées (Pro Tools : I/O Setup, simplifié) : un nom par entrée de la
 * carte son (« Micro cabine », « Guitare DI »…). Les sélecteurs d'entrée des
 * pistes les affichent. Gardés sur ce poste (c'est le câblage du studio).
 */
const IoNamesDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [draft, setDraft] = useState<Record<number, string>>({});
  const available = (() => { try { return audioEngine.getInputInfo().available; } catch { return 2; } })();
  const count = Math.min(MAX_NAMED_INPUTS, Math.max(8, available, ...Object.keys(ioNamesStore.get()).map(k => Number(k) + 1)));
  useEffect(() => { if (open) setDraft({ ...ioNamesStore.get() }); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  const save = () => {
    ioNamesStore.set(draft);
    const n = Object.values(ioNamesStore.get()).length;
    try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: n ? `🎛️ ${n} entrée${n > 1 ? 's' : ''} nommée${n > 1 ? 's' : ''} : les sélecteurs d’entrée des pistes les affichent.` : 'Noms des entrées effacés.' })); } catch { /* hors navigateur */ }
    onClose();
  };
  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Entrées nommées" data-testid="io-names-dialog" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[90vh] flex flex-col gap-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-black">Entrées nommées</h2>
            <p className="text-[12px] text-nv-muted">Le câblage du studio (Pro Tools : I/O Setup). Laisse vide pour garder « Entrée N ». {available} entrée{available > 1 ? 's' : ''} détectée{available > 1 ? 's' : ''}.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>
        <form className="min-h-0 flex-1 overflow-y-auto grid grid-cols-1 gap-1.5" onSubmit={e => { e.preventDefault(); save(); }}>
          {Array.from({ length: count }, (_, i) => (
            <label key={i} className="flex items-center gap-2 text-[12px]">
              <span className={`w-20 shrink-0 font-mono ${i < available ? 'text-cyan-300' : 'text-nv-muted'}`}>Entrée {i + 1}</span>
              <input value={draft[i] || ''} maxLength={40} placeholder={i === 0 ? 'Micro cabine' : i === 1 ? 'Micro talkback' : ''}
                onChange={e => setDraft(d => ({ ...d, [i]: e.target.value }))} aria-label={`Nom de l’entrée ${i + 1}`} data-testid={`io-name-${i}`}
                className="min-h-[34px] [@media(pointer:coarse)]:min-h-[44px] flex-1 min-w-0 rounded-lg border border-nv-line bg-nv-well px-2 text-[12px]" />
            </label>
          ))}
          <button type="submit" hidden />
        </form>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] px-4 rounded-xl border border-nv-line text-[13px] font-bold hover:bg-nv-accent/10">Annuler</button>
          <button type="button" onClick={save} data-testid="io-names-save" className="min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] px-4 rounded-xl bg-cyan-500 text-black text-[13px] font-bold hover:bg-cyan-400">Enregistrer</button>
        </div>
      </div>
    </div>
  );
};

export default IoNamesDialog;
