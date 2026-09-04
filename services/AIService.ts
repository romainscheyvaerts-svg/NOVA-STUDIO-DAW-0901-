import { DAWState, AIAction } from "../types";
import { NOTES } from "../plugins/AutoTunePlugin";

export const getAIProductionAssistance = async (currentState: DAWState, userMessage: string): Promise<{ text: string, actions: AIAction[] }> => {
  try {
    const maxTime = Math.max(...currentState.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 60);

    const keyName = (currentState.projectKey !== undefined) ? NOTES[currentState.projectKey] : 'Unknown';
    const scaleName = currentState.projectScale || 'Unknown';

    const stateSummary = {
      tracks: currentState.tracks.map(t => ({
        id: t.id, name: t.name, type: t.type, volume: t.volume, pan: t.pan,
        isMuted: t.isMuted, isSolo: t.isSolo,
        plugins: t.plugins.map(p => ({ id: p.id, type: p.type, isEnabled: p.isEnabled }))
      })),
      selectedTrackId: currentState.selectedTrackId,
      currentTime: currentState.currentTime,
      bpm: currentState.bpm,
      projectKey: `${keyName} ${scaleName}`,
      maxTime: maxTime
    };

    // Appel API Vercel serverless
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMessage, state: stateSummary })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Erreur API');
    }

    const result = await response.json();

    return {
      text: result.text || "Réglages de mixage appliqués.",
      actions: result.actions || []
    };
  } catch (error) {
    console.error("[AI_SERVICE] Erreur :", error);
    throw error;
  }
};

/** Sur GitHub Pages il n'y a pas de backend : on tape sur l'API Vercel. */
const apiBase = (): string =>
  (typeof window !== 'undefined' && window.location.hostname.includes('github.io'))
    ? 'https://nova-studio-daw-0901.vercel.app'
    : '';

/**
 * Nom + prompt de cover generes par l'IA.
 * Renvoyait auparavant une valeur en dur, identique a chaque appel.
 */
export const generateCreativeMetadata = async (category: string): Promise<{ name: string, prompt: string }> => {
  const fallback = {
    name: `${category.toUpperCase()} BEAT`,
    prompt: "Dark urban atmosphere with neon lights"
  };

  try {
    const response = await fetch(`${apiBase()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category })
    });

    if (!response.ok) return fallback;
    const data = await response.json();
    if (!data || typeof data.name !== 'string') return fallback;
    return { name: data.name, prompt: data.prompt || fallback.prompt };
  } catch (error) {
    console.error('[AI_SERVICE] generateCreativeMetadata :', error);
    return fallback;
  }
};

/**
 * Generation d'image : non disponible.
 * Le backend n'expose aucun modele image, on le dit explicitement plutot que
 * de renvoyer null en silence (l'UI affichait "Echec de la generation" sans
 * expliquer que la fonctionnalite n'existe pas).
 */
export const generateCoverArt = async (_beatName: string, _category: string, _vibe: string): Promise<string | null> => {
  throw new Error("Génération d'image non disponible — importe une cover manuellement.");
};
