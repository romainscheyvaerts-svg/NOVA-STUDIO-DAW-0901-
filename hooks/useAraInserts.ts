import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Track } from '../types';
import type { ChordEvent } from '../utils/chordDetect';
import { liveAraInserts, onAraInsertsChange } from '../engine/AraInsertNode';
import { araDocumentFor, araInsertOf, araMusicFor } from '../utils/araInsert';
import { araPluginKey, guessLeadTrack } from '../utils/araEdit';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { tempoMapStore } from '../utils/tempoMap';
import { novaBridge, BridgePlugin } from '../services/NovaBridge';

/**
 * Melodyne / VocAlign en insert (comme Pro Tools) : à chaque édition de la session (clips
 * déplacés, coupés, rognés, supprimés, dupliqués ; tempo ; accords), le document ARA de chaque
 * piste qui a un insert ARA est recalculé et confié à son nœud (qui n'envoie au pont que ce qui
 * a changé). Un son pas encore chargé est repris une seconde plus tard.
 */
export function useAraInserts(tracks: Track[], chords?: ChordEvent[] | null) {
  const [ver, setVer] = useState(0);
  useEffect(() => onAraInsertsChange(() => setVer(v => v + 1)), []);
  const tempo = useSyncExternalStore(tempoMapStore.subscribe, tempoMapStore.get, tempoMapStore.get);
  useEffect(() => {
    if (!liveAraInserts.size) return;
    const music = araMusicFor(tempo, chords || []);
    let waiting = false;
    for (const t of tracks) {
      const p = araInsertOf(t);
      const node = p ? liveAraInserts.get(p.id) : undefined;
      if (!node) continue;
      const dur = (id: string) => audioBufferRegistry.get(id)?.duration ?? null;
      const doc = araDocumentFor(t, dur);
      if (doc.skipped.some(s => s.reason === 'son pas encore chargé')) waiting = true;
      // VocAlign : le guide (la lead) choisi dans la barre de l'effet, sinon la piste qui y ressemble.
      let guide = null;
      if (node.kind === 'vocalign') {
        const gt = tracks.find(x => x.id === p!.params?.guideTrackId) || guessLeadTrack(tracks, t.id);
        if (gt) { const g = araDocumentFor(gt, dur); guide = { sources: g.sources, regions: g.regions }; }
      }
      node.setDocument(doc, music, guide);
    }
    if (!waiting) return;
    const timer = setTimeout(() => setVer(v => v + 1), 1000);
    return () => clearTimeout(timer);
  }, [tracks, chords, tempo, ver]);
}

/** Melodyne / VocAlign du PC proposés dans le menu « + » des effets (pont v12). */
export function araMenuPlugins(): BridgePlugin[] {
  if (!novaBridge.getBridgeState().araInsert) return [];
  const seen = new Set<string>();
  return novaBridge.getCachedPlugins().filter(p => {
    const k = araPluginKey(p.path || p.name);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
