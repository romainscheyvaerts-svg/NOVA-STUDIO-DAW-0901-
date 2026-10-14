import React, { Suspense, useEffect, useState } from 'react';
import type { DAWState } from '../types';
import { distributionBus } from '../utils/distributionBus';

const DistributionPanel = React.lazy(() => import('./DistributionPanel'));

/**
 * Lot 12 · monte la fenêtre « Prêt pour Spotify / Apple / TikTok ? » quand la fenêtre
 * Exporter la demande (utils/distributionBus.ts). Chargée à la demande.
 */
const DistributionHost: React.FC<{ getState: () => DAWState; getOwned?: () => (string | number)[] }> = ({ getState, getOwned }) => {
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => distributionBus.on(() => setOpen(Date.now())), []);
  if (open === null) return null;
  return (
    <Suspense fallback={null}>
      <DistributionPanel key={open} getState={getState} getOwned={getOwned} onClose={() => setOpen(null)} />
    </Suspense>
  );
};

export default DistributionHost;
