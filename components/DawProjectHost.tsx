import React, { Suspense, useEffect, useState } from 'react';
import type { DAWState } from '../types';
import { dawProjectBus } from '../utils/dawproject/dawProjectBus';

const Dialogs = React.lazy(() => import('./DawProjectDialogs').then(m => ({ default: (p: { mode: 'import' | 'export'; files?: File[]; getState: () => DAWState; onClose: () => void; getOwned?: () => (string | number)[] }) =>
  p.mode === 'import' ? <m.DawProjectImportDialog getState={p.getState} initialFiles={p.files} onClose={p.onClose} /> : <m.DawProjectExportDialog getState={p.getState} onClose={p.onClose} getOwned={p.getOwned} /> })));

/**
 * Échange DAWproject (format ouvert) : ouvre les fenêtres d'import et d'export
 * (dawProjectBus) et prend les .dawproject glissés n'importe où dans NOVA. Le reste du
 * glisser-déposer n'est pas touché. Fenêtres chargées à la demande (léger).
 */
const DawProjectHost: React.FC<{ getState: () => DAWState; getOwned?: () => (string | number)[] }> = ({ getState, getOwned }) => {
  const [open, setOpen] = useState<{ mode: 'import' | 'export'; files?: File[]; key: number } | null>(null);

  useEffect(() => dawProjectBus.on(c => setOpen({ mode: c.kind, files: c.kind === 'import' ? c.files : undefined, key: Date.now() })), []);

  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.some(f => /\.dawproject$/i.test(f.name))) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen({ mode: 'import', files, key: Date.now() });
    };
    window.addEventListener('drop', onDrop, true);
    return () => window.removeEventListener('drop', onDrop, true);
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Dialogs key={open.key} mode={open.mode} files={open.files} getState={getState} getOwned={getOwned} onClose={() => setOpen(null)} />
    </Suspense>
  );
};

export default DawProjectHost;
