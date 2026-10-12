import React, { useEffect, useState } from 'react';
import { isNovaDesktop } from '../utils/desktopApp';
import { novaBridge } from '../services/NovaBridge';
import { onStorageStatus, refreshStorageStatus, requestPersistence, storageAdvice, storageStatus, type StorageStatus } from '../utils/storageProtection';

/**
 * Réglages › Sauvegardes : les projets sont-ils à l'abri d'un effacement automatique du
 * navigateur ? Place restante, conseil clair si la protection est refusée, et dans
 * Nova Studio, la copie sur le disque (Documents › Nova Studio › Projets).
 */
const TONE: Record<string, string> = {
  ok: 'border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-100',
  info: 'border-cyan-400/30 bg-cyan-400/[0.05] text-cyan-100',
  warn: 'border-amber-400/40 bg-amber-400/[0.07] text-amber-100',
  danger: 'border-red-400/50 bg-red-500/10 text-red-100',
};
const ICON: Record<string, string> = { ok: 'fa-shield-alt', info: 'fa-info-circle', warn: 'fa-exclamation-triangle', danger: 'fa-exclamation-circle' };

const StorageProtectionCard: React.FC = () => {
  const [st, setSt] = useState<StorageStatus>(() => storageStatus());
  const [asking, setAsking] = useState(false);
  const desktop = isNovaDesktop();
  const [diskOk, setDiskOk] = useState(() => novaBridge.projectsOnDisk());
  useEffect(() => {
    const off = onStorageStatus(setSt);
    void refreshStorageStatus();
    const offBridge = novaBridge.subscribe(() => setDiskOk(novaBridge.projectsOnDisk()));
    return () => { off(); offBridge(); };
  }, []);
  const advice = storageAdvice(st, desktop, diskOk);
  const canAsk = st.persist === 'unknown' || st.persist === 'denied';
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-2.5" data-testid="storage-protection">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest bg-emerald-500/10 px-2 py-0.5 rounded">Sauvegardes</span>
        <span className="text-[10px] font-mono text-slate-400" data-testid="storage-persist-state">
          {st.persist === 'granted' ? 'protégées' : st.persist === 'denied' ? 'non protégées' : st.persist === 'unsupported' ? 'protection indisponible' : 'à protéger'}
        </span>
      </div>
      {advice.map(a => (
        <div key={a.title} className={`rounded-xl border px-3 py-2 ${TONE[a.tone]}`} data-tone={a.tone}>
          <p className="text-[12px] font-bold"><i className={`fas ${ICON[a.tone]} mr-1.5`} />{a.title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-300">{a.text}</p>
        </div>
      ))}
      {canAsk && (
        <button type="button" disabled={asking} data-testid="storage-persist-ask"
          onClick={async () => { setAsking(true); try { await requestPersistence(); await refreshStorageStatus(); } finally { setAsking(false); } }}
          className="min-h-10 px-4 rounded-xl bg-emerald-400 text-black text-[11px] font-black disabled:opacity-50">
          {asking ? 'Demande en cours…' : 'Protéger mes projets maintenant'}
        </button>
      )}
    </div>
  );
};

export default StorageProtectionCard;
