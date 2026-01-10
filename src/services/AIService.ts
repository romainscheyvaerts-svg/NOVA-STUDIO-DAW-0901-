import { GoogleGenAI, Type } from "@google/genai";
import { DAWState, AIAction } from "../types";
import { NOTES } from "../utils/constants"; 

const SYSTEM_INSTRUCTIONS = `
RÔLE : Tu es Studio Master AI, un ingénieur du son expert en Recording (REX) et Mixage. 
Ton but est d'aider l'utilisateur à produire un hit en pilotant le DAW via window.DAW_CONTROL.

MAPPING DU JARGON (PLUGINS) :
- "Auto-tune / Gamme" -> 'AUTOTUNE'
- "Nettoyer / Souffle" -> 'DENOISER'
- "Compresseur / Volume / Lisser" -> 'COMPRESSOR'
- "Largeur / Phase / Stéréo" -> 'STEREOSPREADER'
- "EQ / Fréquences" -> 'PROEQ12'
- "Sifflements / Les S" -> 'DEESSER'
- "Reverb / Espace" -> 'REVERB'
- "Echo / Delay" -> 'DELAY'
- "Chorus / Épaisseur" -> 'CHORUS'
- "Chaleur / Saturation" -> 'VOCALSATURATOR'

COMMANDES D'ACTION (FORMAT JSON OBLIGATOIRE) :
Tu dois retourner un tableau d'objets "actions" dans ton JSON.

Gestion des Pistes :
- { "action": "MUTE_TRACK", "payload": { "trackId": "ID", "isMuted": true } }
- { "action": "SOLO_TRACK", "payload": { "trackId": "ID", "isSolo": true } }
- { "action": "SET_VOLUME", "payload": { "trackId": "ID", "volume": 1.0 } } (0.0 à 1.5)
- { "action": "SET_PAN", "payload": { "trackId": "ID", "pan": 0 } } (-1.0 à 1.0)
- { "action": "RENAME_TRACK", "payload": { "trackId": "ID", "name": "NOUVEAU NOM" } }
- { "action": "DUPLICATE_TRACK", "payload": { "trackId": "ID" } }
- { "action": "ADD_TRACK", "payload": { "type": "AUDIO", "name": "VOCAL 2" } }

Gestion des Effets (AVANCÉ) :
- { "action": "OPEN_PLUGIN", "payload": { "trackId": "ID", "type": "PLUGIN_TYPE", "params": { ... } } }
  Tu PEUX envoyer des paramètres lors de l'ouverture (ex: réglages EQ).
  
  STRUCTURE PROEQ12 (12 Bandes) :
  params: { 
    bands: [
      { id: 0, type: 'highpass', frequency: 100, isEnabled: true, gain: 0, q: 1 },
      { id: 11, type: 'lowpass', frequency: 5000, isEnabled: true, gain: 0, q: 1 },
      ...autres bandes
    ]
  }
  NOTE: Si tu veux juste changer une bande, fournis le tableau 'bands' complet en copiant les défauts ou modifie juste ceux qui comptent (le système tentera de fusionner, mais l'idéal est de viser juste). Band 0 est souvent HP, Band 11 est LP.

  AUTRES PLUGINS :
  - COMPRESSOR: { threshold: -20, ratio: 4 }
  - REVERB: { mix: 0.4, decay: 2.0 }

- { "action": "CLOSE_PLUGIN", "payload": {} }
- { "action": "BYPASS_PLUGIN", "payload": { "trackId": "ID", "pluginId": "ID_PLUGIN", "isEnabled": false } }

Transport :
- { "action": "PLAY", "payload": {} }
- { "action": "STOP", "payload": {} }
- { "action": "SEEK", "payload": { "time": 10.5 } }
- { "action": "SET_BPM", "payload": { "bpm": 140 } }

Intelligence :
- { "action": "RUN_MASTER_SYNC", "payload": {} } (Lance l'analyse de l'instru)
- { "action": "NORMALIZE_CLIP", "payload": { "trackId": "ID", "clipId": "ID" } }

CONSIGNE : Sois concis, technique et efficace. Ne demande jamais la permission pour aider, AGIS via les commandes. Réponds UNIQUEMENT en JSON.
Exemple : User: "Mets un EQ avec un low pass à 500Hz sur le beat" -> { "text": "Low Pass appliqué.", "actions": [ { "action": "OPEN_PLUGIN", "payload": { "trackId": "instrumental", "type": "PROEQ12", "params": { "bands": [{ "id": 11, "type": "lowpass", "frequency": 500, "isEnabled": true, "q": 1, "gain": 0 }] } } } ] }
`;

export const getAIProductionAssistance = async (currentState: DAWState, userMessage: string): Promise<{ text: string, actions: AIAction[] }> => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const maxTime = Math.max(...currentState.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 60);
    
    const keyName = (currentState.projectKey !== undefined) ? NOTES[currentState.projectKey] : 'Unknown';
    const scaleName = currentState.projectScale || 'Unknown';

    const stateSummary = {
      tracks: currentState.tracks.map(t => ({ id: t.id, name: t.name, type: t.type, volume: t.volume, pan: t.pan, isMuted: t.isMuted, isSolo: t.isSolo, plugins: t.plugins.map(p => ({ id: p.id, type: p.type, isEnabled: p.isEnabled })) })),
      selectedTrackId: currentState.selectedTrackId,
      currentTime: currentState.currentTime,
      bpm: currentState.bpm,
      projectKey: `${keyName} ${scaleName}`, 
      maxTime: maxTime
    };

    const prompt = `User: ${userMessage}\nState: ${JSON.stringify(stateSummary)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTIONS,
        responseMimeType: "application/json",
      }
    });

    const rawText = response.text || "{}";
    const result = JSON.parse(rawText);
    
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
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        const systemPrompt = `You are a creative director for a top-tier Hip-Hop/Rap producer.
        Task:
        1. Generate a **HARD, IMPACTFUL** Beat Name (1-3 words max, uppercase). Think: Future, Metro Boomin, Drake, Drill, Trap style. Use words related to: Money, Night, Street, Power, Space, Emotions, Luxury.
        2. Generate a highly detailed **Visual Prompt** for the album cover art.
        
        Visual Style Requirements:
        - Urban, Dark, Cinematic, High Contrast.
        - Elements: Neon lights, Smoke, Luxury cars, Cash, Abstract geometry, Cyberpunk cityscapes, Hoodies, Grillz texture, Chrome.
        - Vibe: Fits the genre "${category}".
        
        Return JSON only.`;

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [{ 
                role: 'user', 
                parts: [{ text: `Genre: ${category}. Generate metadata.` }] 
            }],
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        name: { type: Type.STRING },
                        prompt: { type: Type.STRING }
                    }
                }
            }
        });
        
        return JSON.parse(response.text || '{"name": "NIGHT RIDER", "prompt": "Neon city street at night with a matte black sports car"}');
    } catch (e) {
        console.error("AI Metadata Error:", e);
        return { name: `${category.toUpperCase()} ANTHEM`, prompt: "Abstract dark neon geometric shapes with smoke" };
    }
};

export const generateCoverArt = async (beatName: string, category: string, vibe: string): Promise<string | null> => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    const prompt = `High quality Hip-Hop Album Cover Art for a beat named "${beatName}" (${category}).
    Visual Description: ${vibe || 'Dark moody street atmosphere'}.
    
    Aesthetic Rules:
    - Style: 3D Render, Digital Art, Unreal Engine 5, or High-end Photography.
    - Atmosphere: Urban, Gritty, Hype, Trap, Drill, or Lo-Fi (depending on category).
    - Lighting: Cinematic lighting, volumetric fog, neon accents (Cyan, Purple, Red or Gold).
    - Composition: Centered, symmetrical or rule of thirds. Professional Mixtape Cover standard.
    
    IMPORTANT: **NO TEXT**, NO LETTERS on the image. Just the artwork.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: prompt }],
      },
      config: {
        imageConfig: {
          aspectRatio: "1:1" 
        }
      },
    });

    if (response.candidates && response.candidates[0].content.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error("[AI_SERVICE] Image Generation Error:", error);
    throw error;
  }
};