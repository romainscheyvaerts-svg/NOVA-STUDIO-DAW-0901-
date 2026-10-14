/**
 * Ouverture de la fenêtre « Prêt pour Spotify / Apple / TikTok ? » (lot 12) depuis la fenêtre
 * Exporter : un simple événement, la fenêtre est montée par components/DistributionHost.tsx.
 */
const listeners = new Set<() => void>();

export const distributionBus = {
  on(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  emit() { listeners.forEach(fn => fn()); },
};

export const openDistribution = () => distributionBus.emit();
