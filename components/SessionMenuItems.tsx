import React from 'react';
import { openImportSession, openSessionPanel } from '../utils/r21Bus';

/**
 * R21 · Entrées du menu ☰ (téléphone, tablette, petites largeurs) : notes,
 * versions ; et, hors téléphone, liste des clips, arrangements et import.
 */
const item = 'w-full min-h-12 px-4 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-100 font-semibold transition-colors flex items-center gap-3';

const SessionMenuItems: React.FC<{ onDone: () => void; phone?: boolean }> = ({ onDone, phone }) => (
  <>
    <button type="button" data-testid="menu-session-notes" className={item} onClick={() => { openSessionPanel('notes'); onDone(); }}>
      <i className="w-5 text-center text-amber-300 fas fa-sticky-note"></i><span>Notes de la session</span>
    </button>
    <button type="button" data-testid="menu-session-versions" className={item} onClick={() => { openSessionPanel('versions'); onDone(); }}>
      <i className="w-5 text-center text-cyan-300 fas fa-code-branch"></i><span>Versions (v2, v3…)</span>
    </button>
    {!phone && (
      <>
        <button type="button" className={item} onClick={() => { openSessionPanel('clips'); onDone(); }}>
          <i className="w-5 text-center text-slate-300 fas fa-th-list"></i><span>Liste des clips</span>
        </button>
        <button type="button" className={item} onClick={() => { openSessionPanel('arrangements'); onDone(); }}>
          <i className="w-5 text-center text-lime-300 fas fa-random"></i><span>Arrangements (clean, radio edit…)</span>
        </button>
        <button type="button" data-testid="menu-session-import" className={item} onClick={() => { openImportSession(); onDone(); }}>
          <i className="w-5 text-center text-slate-300 fas fa-file-import"></i><span>Importer depuis une session</span>
        </button>
      </>
    )}
  </>
);

export default SessionMenuItems;
