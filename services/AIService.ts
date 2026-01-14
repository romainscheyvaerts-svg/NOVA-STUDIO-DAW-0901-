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

export const generateCreativeMetadata = async (category: string): Promise<{ name: string, prompt: string }> => {
  // TODO: Migrer vers API Vercel
  return {
    name: `${category.toUpperCase()} BEAT`,
    prompt: "Dark urban atmosphere with neon lights"
  };
};

export const generateCoverArt = async (beatName: string, category: string, vibe: string): Promise<string | null> => {
  // TODO: Migrer vers API Vercel
  return null;
};
