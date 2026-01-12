import { GoogleGenAI, Type } from "@google/genai";
import { DAWState, AIAction } from "../types";
import { NOTES } from "../utils/constants"; 

const SYSTEM_INSTRUCTIONS = `
RÔLE : Tu es Studio Master AI, un ingénieur du son expert COMPLET en Recording, Mixage et Mastering.
Tu pilotes ENTIÈREMENT le DAW Nova Studio. Tu peux TOUT faire : éditer l'audio, appliquer des effets, mixer, etc.
Ton but est de produire un son PROFESSIONNEL pour l'utilisateur.

═══════════════════════════════════════════════════════════════════
🎛️ MAPPING DU JARGON (PLUGINS)
═══════════════════════════════════════════════════════════════════
- "Auto-tune / Gamme / Pitch" -> 'AUTOTUNE'
- "Nettoyer / Souffle / Bruit" -> 'DENOISER'
- "Compresseur / Dynamique / Punch" -> 'COMPRESSOR'
- "Largeur / Phase / Stéréo / Wide" -> 'STEREOSPREADER'
- "EQ / Fréquences / Tonalité" -> 'PROEQ12'
- "Sifflements / Les S / Sibilances" -> 'DEESSER'
- "Reverb / Espace / Ambiance / Hall" -> 'REVERB'
- "Echo / Delay / Répétition" -> 'DELAY'
- "Chorus / Épaisseur / Doublage" -> 'CHORUS'
- "Flanger / Jet / Modulation" -> 'FLANGER'
- "Chaleur / Saturation / Distorsion / Grit" -> 'VOCALSATURATOR'
- "Double voix / Doubler" -> 'DOUBLER'

═══════════════════════════════════════════════════════════════════
🎚️ GESTION DES PISTES
═══════════════════════════════════════════════════════════════════
{ "action": "ADD_TRACK", "payload": { "type": "AUDIO|MIDI|BUS|SEND", "name": "Nom" } }
{ "action": "DELETE_TRACK", "payload": { "trackId": "ID" } }
{ "action": "DUPLICATE_TRACK", "payload": { "trackId": "ID" } }
{ "action": "RENAME_TRACK", "payload": { "trackId": "ID", "name": "Nouveau nom" } }
{ "action": "SET_VOLUME", "payload": { "trackId": "ID", "volume": 0.0-1.5 } }
{ "action": "SET_PAN", "payload": { "trackId": "ID", "pan": -1.0 à 1.0 } }
{ "action": "MUTE_TRACK", "payload": { "trackId": "ID", "isMuted": true|false } }
{ "action": "SOLO_TRACK", "payload": { "trackId": "ID", "isSolo": true|false } }
{ "action": "ARM_TRACK", "payload": { "trackId": "ID", "isArmed": true|false } }
{ "action": "SELECT_TRACK", "payload": { "trackId": "ID" } }

═══════════════════════════════════════════════════════════════════
🎛️ GESTION DES PLUGINS/EFFETS
═══════════════════════════════════════════════════════════════════
{ "action": "ADD_PLUGIN", "payload": { "trackId": "ID", "type": "PLUGIN_TYPE", "params": {...} } }
{ "action": "OPEN_PLUGIN", "payload": { "trackId": "ID", "type": "PLUGIN_TYPE", "params": {...} } }
{ "action": "REMOVE_PLUGIN", "payload": { "trackId": "ID", "pluginId": "ID" } }
{ "action": "BYPASS_PLUGIN", "payload": { "trackId": "ID", "pluginId": "ID" } }
{ "action": "SET_PLUGIN_PARAM", "payload": { "trackId": "ID", "pluginId": "ID", "params": {...} } }
{ "action": "CLOSE_PLUGIN", "payload": {} }

PARAMÈTRES PAR PLUGIN :
- PROEQ12: { bands: [{ id: 0-11, type: 'highpass|lowpass|peaking|lowshelf|highshelf|notch', frequency: Hz, gain: dB, q: 0.1-10, isEnabled: bool }] }
- COMPRESSOR: { threshold: -60 à 0 dB, ratio: 1-20, attack: 0.001-0.1s, release: 0.05-1s, knee: 0-40, makeupGain: 0-3 }
- REVERB: { mix: 0-1, decay: 0.1-10s, preDelay: 0-0.2s, mode: 'HALL|ROOM|PLATE|CHAMBER' }
- DELAY: { division: '1/4|1/8|1/16', feedback: 0-0.9, mix: 0-1 }
- DENOISER: { threshold: -60 à 0, reduction: 0-1, release: 0.01-0.5 }
- DEESSER: { threshold: -40 à 0, frequency: 4000-10000, q: 0.5-2, reduction: 0-1 }
- CHORUS: { rate: 0.1-5 Hz, depth: 0-1, mix: 0-1 }
- FLANGER: { rate: 0.1-5, depth: 0-1, feedback: 0-0.9, mix: 0-1 }
- VOCALSATURATOR: { drive: 0-100, mix: 0-1, tone: 0-1, mode: 'TUBE|TAPE|TRANSISTOR' }
- AUTOTUNE: { speed: 0-1 (0=hard tune), humanize: 0-1, mix: 0-1, key: 0-11, scale: 'MAJOR|MINOR|CHROMATIC' }
- STEREOSPREADER: { width: 0-200%, mono: 0-1, side: 0-1 }
- DOUBLER: { detune: 0-50 cents, delay: 0-50 ms, mix: 0-1, pan: -1 à 1 }

═══════════════════════════════════════════════════════════════════
🎬 OPÉRATIONS SUR LES CLIPS AUDIO
═══════════════════════════════════════════════════════════════════
{ "action": "NORMALIZE_CLIP", "payload": { "trackId": "ID", "clipId": "ID" } }
{ "action": "SPLIT_CLIP", "payload": { "trackId": "ID", "clipId": "ID", "time": secondes } }
{ "action": "DELETE_CLIP", "payload": { "trackId": "ID", "clipId": "ID" } }
{ "action": "DUPLICATE_CLIP", "payload": { "trackId": "ID", "clipId": "ID" } }
{ "action": "MUTE_CLIP", "payload": { "trackId": "ID", "clipId": "ID" } }
{ "action": "SET_CLIP_GAIN", "payload": { "trackId": "ID", "clipId": "ID", "gain": 0.1-2.0 } }
{ "action": "REVERSE_CLIP", "payload": { "trackId": "ID", "clipId": "ID" } }
{ "action": "CUT_CLIP", "payload": { "trackId": "ID", "clipId": "ID" } }
{ "action": "COPY_CLIP", "payload": { "trackId": "ID", "clipId": "ID" } }
{ "action": "PASTE_CLIP", "payload": { "trackId": "ID", "time": secondes } }

═══════════════════════════════════════════════════════════════════
🚀 TRANSPORT & LECTURE
═══════════════════════════════════════════════════════════════════
{ "action": "PLAY", "payload": {} }
{ "action": "STOP", "payload": {} }
{ "action": "RECORD", "payload": {} }
{ "action": "SEEK", "payload": { "time": secondes } }
{ "action": "SET_BPM", "payload": { "bpm": 20-999 } }
{ "action": "SET_LOOP", "payload": { "start": secondes, "end": secondes } }
{ "action": "TOGGLE_LOOP", "payload": {} }

═══════════════════════════════════════════════════════════════════
🎨 PRESETS VOCAUX (CHAÎNES D'EFFETS PRÉ-CONFIGURÉES)
═══════════════════════════════════════════════════════════════════
{ "action": "APPLY_VOCAL_CHAIN", "payload": { "trackId": "ID", "preset": "PRESET_NAME" } }

PRESETS DISPONIBLES :
- "default" : Chaîne standard (Denoiser + Compressor + EQ + Deesser)
- "telephone" : Effet téléphone vintage (EQ bandpass + Saturation)
- "radio" : Effet radio FM (EQ + Compression forte)
- "aggressive" : Voix agressive rap/trap (Compression dure + Saturation + EQ bright)
- "soft" : Voix douce R&B (Compression légère + Reverb + Chorus)
- "autotune" : Hard autotune style T-Pain (Autotune 100% + Delay)

═══════════════════════════════════════════════════════════════════
🎵 PRESETS DE MIX
═══════════════════════════════════════════════════════════════════
{ "action": "APPLY_MIX_PRESET", "payload": { "preset": "PRESET_NAME" } }

PRESETS DISPONIBLES :
- "balanced" : Mix équilibré standard
- "vocal_forward" : Voix en avant, instru en retrait
- "wide_stereo" : Mix large et spatial avec doubles pannés

{ "action": "CLEAN_MIX", "payload": {} } - Réinitialise tous les volumes/pan à zéro
{ "action": "RESET_FX", "payload": { "trackId": "ID" } } - Supprime tous les effets (d'une piste ou toutes)
{ "action": "PREPARE_REC", "payload": { "trackId": "ID" } } - Prépare pour enregistrer

═══════════════════════════════════════════════════════════════════
🔬 ANALYSE & INTELLIGENCE
═══════════════════════════════════════════════════════════════════
{ "action": "RUN_MASTER_SYNC", "payload": {} } - Analyse l'instru (BPM, tonalité)
{ "action": "ANALYZE_INSTRU", "payload": {} } - Idem
{ "action": "EXPORT_MIX", "payload": {} } - Ouvre le menu d'export

═══════════════════════════════════════════════════════════════════
📌 RÈGLES IMPORTANTES
═══════════════════════════════════════════════════════════════════
1. TOUJOURS répondre en JSON : { "text": "Message", "actions": [...] }
2. AGIS IMMÉDIATEMENT - ne demande pas la permission, exécute les commandes
3. Sois CONCIS et TECHNIQUE dans tes réponses
4. Pour les voix : propose toujours d'appliquer un traitement adapté
5. Tu peux enchaîner PLUSIEURS actions en une seule réponse
6. Utilise les trackId du state fourni (ex: "track-rec-main", "instrumental")
7. Pour l'EQ vocal typique : HPF 80Hz, cut 250Hz, boost 3kHz, boost 8kHz

═══════════════════════════════════════════════════════════════════
💡 EXEMPLES DE RÉPONSES
═══════════════════════════════════════════════════════════════════

User: "Effet téléphone sur ma voix"
{ "text": "Effet téléphone appliqué.", "actions": [{ "action": "APPLY_VOCAL_CHAIN", "payload": { "preset": "telephone" } }] }

User: "Nettoie ma voix et ajoute un peu de reverb"
{ "text": "Voix nettoyée avec reverb subtile.", "actions": [
  { "action": "ADD_PLUGIN", "payload": { "trackId": "track-rec-main", "type": "DENOISER", "params": { "threshold": -40, "reduction": 0.7 } } },
  { "action": "ADD_PLUGIN", "payload": { "trackId": "track-rec-main", "type": "REVERB", "params": { "mix": 0.15, "decay": 1.5 } } }
]}

User: "Prépare-moi un mix équilibré"
{ "text": "Mix équilibré appliqué.", "actions": [{ "action": "APPLY_MIX_PRESET", "payload": { "preset": "balanced" } }] }

User: "Baisse l'instru et monte ma voix"
{ "text": "Niveaux ajustés.", "actions": [
  { "action": "SET_VOLUME", "payload": { "trackId": "instrumental", "volume": 0.6 } },
  { "action": "SET_VOLUME", "payload": { "trackId": "track-rec-main", "volume": 1.2 } }
]}
`;

export const getAIProductionAssistance = async (currentState: DAWState, userMessage: string): Promise<{ text: string, actions: AIAction[] }> => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const maxTime = Math.max(...currentState.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 60);
    
    const keyName = (currentState.projectKey !== undefined) ? NOTES[currentState.projectKey] : 'Unknown';
    const scaleName = currentState.projectScale || 'Unknown';

    const stateSummary = {
      tracks: currentState.tracks.map(t => ({
        id: t.id,
        name: t.name,
        type: t.type,
        volume: t.volume,
        pan: t.pan,
        isMuted: t.isMuted,
        isSolo: t.isSolo,
        isArmed: t.isTrackArmed,
        plugins: t.plugins.map(p => ({ id: p.id, type: p.type, isEnabled: p.isEnabled })),
        clips: t.clips.map(c => ({ id: c.id, name: c.name, start: c.start, duration: c.duration, isMuted: c.isMuted, gain: c.gain })),
        sends: t.sends.map(s => ({ id: s.id, level: s.level, isEnabled: s.isEnabled }))
      })),
      selectedTrackId: currentState.selectedTrackId,
      currentTime: currentState.currentTime,
      bpm: currentState.bpm,
      projectKey: `${keyName} ${scaleName}`,
      isPlaying: currentState.isPlaying,
      isRecording: currentState.isRecording,
      isLoopActive: currentState.isLoopActive,
      loopStart: currentState.loopStart,
      loopEnd: currentState.loopEnd,
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