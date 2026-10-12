import React, { useEffect, useState } from 'react';
import { presetCloud, type SyncStatus } from '../services/PresetCloud';

/**
 * Ligne d'état de la synchronisation des presets entre postes (services/PresetCloud),
 * dans le menu des presets d'un effet et la fenêtre des Track Presets. Jamais
 * bloquante : hors ligne, déconnecté ou serveur pas encore prêt, les presets
 * restent sur l'appareil et la ligne le dit.
 */
const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'à l’instant';
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  return `il y a ${h} h`;
};

const ICON: Record<SyncStatus['state'], string> = {
  off: 'fa-laptop', soon: 'fa-cloud', idle: 'fa-cloud', syncing: 'fa-sync-alt fa-spin', ok: 'fa-cloud', offline: 'fa-plane', error: 'fa-pause-circle',
};

export const PresetCloudStatus: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const sync = presetCloud();
  const [st, setSt] = useState<SyncStatus>(() => sync.status());
  useEffect(() => sync.subscribe(setSt), [sync]);
  // À l'ouverture : on rafraîchit l'état (sans forcer : ni requête répétée, ni boucle).
  useEffect(() => { if (st.state === 'idle') void sync.sync(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const canRetry = st.state === 'ok' || st.state === 'offline' || st.state === 'error' || st.state === 'idle';
  const tone = st.state === 'ok' ? 'text-emerald-500' : st.state === 'error' ? 'text-amber-500' : 'text-nv-muted';
  const text = st.state === 'ok' && st.at ? `${st.message.replace(/ : tu les.*$/, '')} (${ago(st.at)}${st.pulled ? `, ${st.pulled} reçu${st.pulled > 1 ? 's' : ''}` : ''}${st.pushed ? `, ${st.pushed} envoyé${st.pushed > 1 ? 's' : ''}` : ''}).` : st.message;
  return (
    <div role="status" aria-live="polite" data-testid="preset-cloud-status" data-state={st.state}
      className={`flex items-start gap-2 rounded-lg bg-nv-well px-2 py-1.5 ${compact ? 'text-[10px]' : 'text-[11px]'} ${tone}`}>
      <i className={`fas ${ICON[st.state]} mt-0.5 shrink-0`} aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
      {canRetry && (
        <button type="button" data-testid="preset-cloud-sync" disabled={st.state === 'syncing'}
          onClick={() => void sync.sync({ force: true })}
          title="Synchroniser maintenant avec ton compte"
          className="shrink-0 rounded-md px-1.5 font-bold text-nv-accent hover:bg-nv-accent/10 [@media(pointer:coarse)]:min-h-[36px]">Synchroniser</button>
      )}
    </div>
  );
};

export default PresetCloudStatus;
