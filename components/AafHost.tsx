import React, { Suspense, useEffect, useState } from 'react';
import type { DAWState } from '../types';
import { aafBus } from '../utils/aaf/aafBus';

const Dialogs = React.lazy(() => import('./AafDialogs').then(m => ({ default: (p: { mode: 'import' | 'export'; files?: File[]; getState: () => DAWState; onClose: () => void }) =>
  p.mode === 'import' ? <m.AafImportDialog getState={p.getState} initialFiles={p.files} onClose={p.onClose} /> : <m.AafExportDialog getState={p.getState} onClose={p.onClose} /> })));

/**
 * Échange AAF avec Pro Tools : ouvre les fenêtres d'import et d'export (aafBus) et
 * prend les .aaf glissés n'importe où dans NOVA (avec leurs sons, s'ils sont déposés
 * en même temps). Le reste du glisser-déposer (sons, MIDI…) n'est pas touché.
 */
const AafHost: React.FC<{ getState: () => DAWState }> = ({ getState }) => {
  const [open, setOpen] = useState<{ mode: 'import' | 'export'; files?: File[]; key: number } | null>(null);

  useEffect(() => aafBus.on(c => setOpen({ mode: c.kind, files: c.kind === 'import' ? c.files : undefined, key: Date.now() })), []);

  useEffect(() => {
    const hasAaf = (e: DragEvent) => Array.from(e.dataTransfer?.files || []).some(f => /\.aaf$/i.test(f.name));
    const onDrop = (e: DragEvent) => {
      if (!hasAaf(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen({ mode: 'import', files: Array.from(e.dataTransfer!.files), key: Date.now() });
    };
    // Un .aaf n'a pas de type connu du navigateur : on autorise le dépôt (sinon le navigateur ouvrirait le fichier).
    const onOver = (e: DragEvent) => {
      const items = Array.from(e.dataTransfer?.items || []);
      if (items.some(i => i.kind === 'file' && (i.type === '' || i.type === 'application/octet-stream'))) e.preventDefault();
    };
    window.addEventListener('dragover', onOver, true);
    window.addEventListener('drop', onDrop, true);
    return () => { window.removeEventListener('dragover', onOver, true); window.removeEventListener('drop', onDrop, true); };
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Dialogs key={open.key} mode={open.mode} files={open.files} getState={getState} onClose={() => setOpen(null)} />
    </Suspense>
  );
};

export default AafHost;
