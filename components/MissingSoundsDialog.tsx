import React, { useRef, useState } from 'react';
import { matchFiles, type MissingClip } from '../utils/missingSounds';
import { pickAudioFiles } from '../utils/importPlacement';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * « Sons manquants » : la liste des clips muets (son introuvable à l'ouverture) et le moyen
 * de leur redonner leur son — plusieurs fichiers d'un coup (reliés par le nom) ou un par un.
 */
const MissingSoundsDialog: React.FC<{
  missing: MissingClip[];
  onRelink: (items: { clipId: string; file: File }[]) => Promise<{ ok: number; failed: string[] }>;
  onClose: () => void;
}> = ({ missing, onRelink, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const oneFor = useRef<string | null>(null);

  const run = async (items: { clipId: string; file: File }[], unmatched = 0) => {
    if (!items.length) { setNote(unmatched ? `Aucun nom ne correspond (${unmatched} fichier${unmatched > 1 ? 's' : ''}). Relie-les un par un avec « Choisir… ».` : null); return; }
    setBusy(true);
    try {
      const r = await onRelink(items);
      const parts = [`${r.ok} clip${r.ok > 1 ? 's' : ''} relié${r.ok > 1 ? 's' : ''}`];
      if (r.failed.length) parts.push(`illisible${r.failed.length > 1 ? 's' : ''} : ${r.failed.slice(0, 3).join(', ')}`);
      if (unmatched) parts.push(`${unmatched} fichier${unmatched > 1 ? 's' : ''} sans clip du même nom`);
      setNote(parts.join(' · '));
    } finally { setBusy(false); }
  };

  const pickMany = () => pickAudioFiles(files => {
    const m = matchFiles(files, missing);
    const used = new Set(m.values());
    void run([...m.entries()].map(([clipId, i]) => ({ clipId, file: files[i] })), files.filter((_, i) => !used.has(i)).length);
  }, true);

  const pickOne = (clipId: string) => {
    oneFor.current = clipId;
    pickAudioFiles(files => { const f = files[0]; if (f && oneFor.current) void run([{ clipId: oneFor.current, file: f }]); }, false);
  };

  return (
    <div className="fixed inset-0 z-[1250] flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="missing-title" data-testid="missing-sounds" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-3xl border border-amber-400/30 bg-nv-surface p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="missing-title" className="text-lg font-black text-white">🔗 Sons manquants</h2>
            <p className="text-[12px] text-slate-400 mt-1">
              {missing.length ? `${missing.length} clip${missing.length > 1 ? 's' : ''} sans son (introuvable à l'ouverture) : ${missing.length > 1 ? 'ils restent' : 'il reste'} à sa place, muet. Choisis le fichier du son pour le relier.` : 'Tous les sons sont reliés.'}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fermer" className="w-11 h-11 shrink-0 rounded-xl bg-white/5 text-slate-300">✕</button>
        </div>
        {missing.length > 0 && (
          <button type="button" onClick={pickMany} disabled={busy} data-testid="missing-pick-many"
            className="mt-4 min-h-11 rounded-xl bg-amber-400 text-black text-[13px] font-black hover:bg-amber-300 disabled:opacity-40">
            {busy ? 'Lecture des fichiers…' : 'Choisir les fichiers (reliés par leur nom)…'}
          </button>
        )}
        {note && <p className="mt-3 text-[12px] text-emerald-300" role="status" data-testid="missing-note">{note}</p>}
        <ul className="mt-3 flex-1 overflow-y-auto space-y-1.5 pr-1">
          {missing.map(m => (
            <li key={m.clipId} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3" data-testid="missing-row">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-white truncate">{m.clipName}</p>
                <p className="text-[11px] text-slate-400 truncate">{m.trackName} · à {fmt(m.start)} · {fmt(m.duration)}</p>
              </div>
              <button type="button" onClick={() => pickOne(m.clipId)} disabled={busy} className="min-h-11 shrink-0 rounded-xl bg-white/10 px-4 text-[12px] font-black text-white hover:bg-white/15">Choisir…</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default MissingSoundsDialog;
