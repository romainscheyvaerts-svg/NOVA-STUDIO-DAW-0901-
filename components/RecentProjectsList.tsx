import React, { useEffect, useMemo, useState } from 'react';
import { recoveryStore } from '../utils/recoveryStore';
import { indexIsIncomplete, matchesQuery, mergeRecents, readRecentIndex, rememberRecent, type RecentProject } from '../utils/recentProjects';
import { isNovaDesktop } from '../utils/desktopApp';
import { novaBridge } from '../services/NovaBridge';
import { bridgeDiskBackend } from '../services/DiskProjectStore';

const fmtWhen = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const hm = d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `aujourd'hui à ${hm}`;
  if (d.toDateString() === y.toDateString()) return `hier à ${hm}`;
  return `${d.toLocaleDateString('fr-BE', { weekday: 'short', day: 'numeric', month: 'short' })} à ${hm}`;
};

/** Charge les projets récents (appareil + disque de Nova Studio), sans relire tous les JSON. */
export async function loadRecentProjects(excludeProjectId?: string | null): Promise<RecentProject[]> {
  const store = recoveryStore();
  const ids = new Set(await store.versionIds());
  const index = readRecentIndex();
  let fallback: Awaited<ReturnType<typeof store.listVersions>> | undefined;
  if (indexIsIncomplete(index, ids)) {
    // 1re ouverture après la mise à jour (ou version écrite par un autre onglet) : index refait une fois.
    fallback = await store.listVersions();
    // Du plus ancien au plus récent : chaque projet garde sa dernière version, le plus récent en tête.
    for (const v of [...fallback].sort((a, b) => a.savedAt - b.savedAt)) {
      rememberRecent({ projectId: v.projectId, name: v.name, savedAt: v.savedAt, versionId: v.id, tracks: v.tracks, takes: v.takes, beatTitle: v.beatTitle });
    }
  }
  let disk: Awaited<ReturnType<ReturnType<typeof bridgeDiskBackend>['listProjects']>> = [];
  if (isNovaDesktop() && novaBridge.projectsOnDisk()) {
    try { disk = await bridgeDiskBackend().listProjects(); } catch { /* pont occupé : l'appareil suffit */ }
  }
  return mergeRecents({ index: readRecentIndex(), deviceIds: ids, fallback, disk, excludeProjectId });
}

/**
 * « Récents » : un projet par ligne (nom, quand, pistes, prises), recherche par nom.
 * Ouvrir = sa dernière version (le projet ouvert garde d'abord ses modifications).
 */
const RecentProjectsList: React.FC<{
  currentProjectId?: string | null;
  onOpen: (p: RecentProject) => void;
  busy?: boolean;
  /** Rien à montrer : le parent peut choisir un autre onglet. */
  onEmpty?: () => void;
  /** Accueil : rien du tout quand il n'y a aucun projet (pas de message), titre au-dessus sinon. */
  hideWhenEmpty?: boolean;
  title?: string;
}> = ({ currentProjectId, onOpen, busy, onEmpty, hideWhenEmpty, title }) => {
  const [list, setList] = useState<RecentProject[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    let live = true;
    loadRecentProjects(currentProjectId).then(l => { if (!live) return; setList(l); if (!l.length) onEmpty?.(); })
      .catch(() => { if (live) setList([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);
  const shown = useMemo(() => (list || []).filter(p => matchesQuery(p, q)), [list, q]);
  if (list === null) return hideWhenEmpty ? null : <p className="p-6 text-[12px] text-slate-400">Chargement des projets récents…</p>;
  if (!list.length && hideWhenEmpty) return null;
  if (!list.length) {
    return (
      <div className="p-8 text-center space-y-2" data-testid="recent-projects-empty">
        <p className="text-[13px] text-slate-300">Aucun autre projet sur cet appareil pour l'instant.</p>
        <p className="text-[12px] text-slate-500">Chaque projet sur lequel tu travailles apparaît ici tout seul (sauvegarde automatique).</p>
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col" data-testid="recent-projects">
      {title && <h4 className="px-4 pt-2 text-xs font-bold text-slate-400 uppercase">{title}</h4>}
      {list.length > 6 && (
        <div className="px-4 pt-4">
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Chercher un projet (nom, beat)…" aria-label="Chercher un projet"
            data-testid="recent-projects-search"
            className="w-full h-11 bg-black/40 border border-white/10 rounded-xl px-3 text-[13px] text-white focus:border-cyan-500 focus:outline-none" />
        </div>
      )}
      <ul className="flex-1 overflow-y-auto p-4 space-y-1.5">
        {shown.map(p => (
          <li key={p.projectId}>
            <button type="button" disabled={busy} onClick={() => onOpen(p)} data-testid="recent-project" data-project-id={p.projectId}
              className="w-full min-h-14 flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] hover:border-cyan-500/40 p-3 text-left transition-all disabled:opacity-40">
              <span className="w-9 h-9 shrink-0 rounded-lg bg-cyan-500/10 text-cyan-300 flex items-center justify-center" aria-hidden="true">
                <i className={`fas ${p.source === 'disque' ? 'fa-hdd' : 'fa-music'}`}></i>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-bold text-white truncate">{p.name}</span>
                <span className="block text-[11px] text-slate-400 truncate">
                  {[fmtWhen(p.savedAt), `${p.tracks} piste${p.tracks > 1 ? 's' : ''}`, p.takes ? `${p.takes} prise${p.takes > 1 ? 's' : ''}` : null, p.beatTitle, p.source === 'disque' ? 'sur le disque' : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="shrink-0 text-[12px] font-black text-cyan-300">Ouvrir</span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="p-4 text-[12px] text-slate-400">Aucun projet ne correspond à « {q} ».</li>}
      </ul>
    </div>
  );
};

export default RecentProjectsList;
