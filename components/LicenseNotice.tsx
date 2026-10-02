import React, { useEffect, useState } from 'react';
import { novaBridge, LicenseWindowEvent } from '../services/NovaBridge';

/** Un seul message par plugin et par session (le pont peut signaler plusieurs fois). */
const shown = new Set<string>();

/**
 * Fenêtre d'activation de licence ouverte par un plugin VST (pont VST v6) :
 * le pont l'a ramenée au premier plan sur le PC ; on dit au musicien quoi
 * faire, et « C'est fait » relance le chargement ou le rendu.
 */
const LicenseNotice: React.FC = () => {
  const [queue, setQueue] = useState<LicenseWindowEvent[]>([]);

  useEffect(() => novaBridge.onLicenseWindow((e) => {
    const key = `${e.path}#${e.pluginName || ''}`;
    if (shown.has(key)) return;
    shown.add(key);
    setQueue(q => [...q, e]);
  }), []);

  const cur = queue[0];
  if (!cur) return null;
  const close = () => setQueue(q => q.slice(1));

  return (
    <div role="alertdialog" aria-live="assertive" aria-label="Activation de licence d'un plugin"
      data-license-notice
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[900] w-[min(480px,calc(100vw-32px))] rounded-2xl border border-amber-400/40 bg-[#1a1710] shadow-2xl p-4 text-left">
      <div className="flex items-start gap-3">
        <i className="fas fa-key text-amber-300 mt-0.5"></i>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-white leading-snug">
            {cur.status === 'nag'
              ? <><b>{cur.plugin}</b> ouvre encore sa fenêtre de licence (version d'essai ou rappel d'enregistrement ?) : elle est ouverte sur ton PC. Active-le, puis reviens ici.</>
              : <><b>{cur.plugin}</b> demande une activation de licence : la fenêtre est ouverte sur ton PC. Active-le, puis reviens ici.</>}
          </p>
          {cur.title && <p className="text-[11px] text-amber-200/70 truncate">Fenêtre : « {cur.title} »</p>}
          <p className="text-[11px] text-slate-400">
            Tu ne la vois pas ? Regarde dans la barre des tâches de Windows.{' '}
            {cur.status === 'nag'
              ? "Si elle revient à chaque fois, c'est sans doute une version d'essai : Nova ne charge plus ce plugin tout seul."
              : 'Une fois activé, le plugin ne la rouvre plus.'}
          </p>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => { novaBridge.licenseDone(cur.path); close(); }}
              className="h-9 px-4 rounded-lg bg-amber-400 text-black text-xs font-black hover:bg-amber-300">C'est fait</button>
            <button type="button" onClick={close}
              className="h-9 px-3 rounded-lg bg-white/10 text-white text-xs font-bold hover:bg-white/20">Plus tard</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LicenseNotice;
