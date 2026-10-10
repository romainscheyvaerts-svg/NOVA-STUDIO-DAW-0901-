import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioAnalysisEngine } from '../engine/AudioAnalysisEngine';
import { detectKey } from '../utils/keyDetect';
import { ImportTempoProposal, keyToPropose, shouldDetectTempo, tempoToPropose } from '../utils/importTempo';

/**
 * Beat importé du PC : tempo (et tonalité) détectés à l'écoute, puis une carte
 * propose de régler le projet en un geste (components/ImportTempoCard).
 * Rien n'est changé sans l'accord de l'ingé.
 */
export function useImportTempo(o: {
  getProject: () => { bpm: number; projectKey?: number; projectScale?: string };
  applyBpm: (bpm: number) => void;
  applyKey: (rootKey: number, scale: string) => void;
  notify: (text: string) => void;
  keyName: (rootKey: number, scale: string) => string;
}) {
  const [proposal, setProposal] = useState<ImportTempoProposal | null>(null);
  const [detecting, setDetecting] = useState<string | null>(null);
  const seq = useRef(0);
  const opts = useRef(o);
  opts.current = o;

  /** Après un import : détecte (en tâche de fond) et propose si utile. */
  const offer = useCallback(async (buffer: AudioBuffer, fileName: string, landedOnBeatTrack: boolean) => {
    if (!shouldDetectTempo({ durationSec: buffer.duration, landedOnBeatTrack, fileName })) return;
    const id = ++seq.current;
    const name = fileName.replace(/\.[^/.]+$/, '');
    setDetecting(name);
    try {
      const debut = Math.min(10, buffer.duration * 0.2);
      const [bpm, key] = await Promise.all([
        AudioAnalysisEngine.detectBPMAdvanced(buffer, debut, Math.min(30, buffer.duration * 0.6)).catch(() => 0),
        detectKey(buffer).catch(() => null),
      ]);
      if (id !== seq.current) return; // un autre import est arrivé entre-temps
      const p = opts.current.getProject();
      const propBpm = tempoToPropose(bpm, p.bpm);
      const propKey = keyToPropose(key, { rootKey: p.projectKey, scale: p.projectScale });
      if (propBpm == null && !propKey) {
        if (bpm) opts.current.notify(`🥁 « ${name} » : ${Math.round(bpm)} BPM détectés, le projet est déjà au bon tempo.`);
        return;
      }
      setProposal({ name, bpm: propBpm, projectBpm: p.bpm, key: propKey });
    } finally {
      if (id === seq.current) setDetecting(null);
    }
  }, []);

  /** Un geste : le tempo (et la tonalité si demandé) du projet suivent le beat. */
  const accept = useCallback((withKey: boolean) => {
    const p = proposal;
    if (!p) return;
    const done: string[] = [];
    if (p.bpm != null) { opts.current.applyBpm(p.bpm); done.push(`tempo ${p.bpm} BPM`); }
    if (withKey && p.key) { opts.current.applyKey(p.key.rootKey, p.key.scale); done.push(`tonalité ${opts.current.keyName(p.key.rootKey, p.key.scale)} (Auto-Tune réglé)`); }
    setProposal(null);
    if (done.length) opts.current.notify(`🥁 Projet réglé sur le beat : ${done.join(', ')}. Ctrl+Z pour revenir.`);
  }, [proposal]);

  const dismiss = useCallback(() => { setProposal(null); }, []);

  // Sans réponse au bout d'une minute, la carte s'efface (le tempo reste réglable dans la barre).
  useEffect(() => {
    if (!proposal) return;
    const id = window.setTimeout(() => setProposal(cur => (cur === proposal ? null : cur)), 60000);
    return () => window.clearTimeout(id);
  }, [proposal]);

  return { proposal, detecting, offer, accept, dismiss };
}
