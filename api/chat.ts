import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Catalogue des actions que Nova peut exécuter dans le DAW.
 * Doit rester aligné avec `executeAIAction` dans App.tsx et `AIActionType` dans types.ts.
 */
const ACTION_CATALOG = `
TRANSPORT ET PROJET
| PLAY / STOP / RECORD | {} | lecture, arrêt, enregistrement |
| SEEK | { time } | placer la tête de lecture (secondes) |
| SET_LOOP | { start, end, active } | boucle (secondes) |
| TOGGLE_LOOP | { active } | activer/désactiver la boucle |
| SET_BPM | { bpm } | tempo |
| SET_TIME_SIGNATURE | { numerator, denominator } | signature rythmique |
| SET_METRONOME | { enabled, volume, countIn, accentDownbeat } | métronome (countIn en mesures) |
| SET_PROJECT_KEY | { key, scale } | key 0-11 (0=C), scale ex. "minor" |
| SET_VIEW | { view } | ARRANGEMENT, MIXER ou AUTOMATION |
| UNDO / REDO | {} | annuler / rétablir |
| SAVE_PROJECT | { name } | sauvegarder dans le cloud |
| OPEN_EXPORT | {} | ouvrir la fenêtre d'export |

PISTES
| SET_VOLUME | { trackId, volume } | 0 à 1 |
| SET_PAN | { trackId, pan } | -1 (gauche) à 1 (droite) |
| MUTE_TRACK | { trackId, isMuted } | |
| SOLO_TRACK | { trackId, isSolo } | |
| ARM_TRACK | { trackId, armed } | armer pour l'enregistrement |
| RENAME_TRACK | { trackId, name } | |
| CREATE_TRACK | { name, type } | type : AUDIO, MIDI, DRUM_RACK, SAMPLER, BUS, SEND |
| DELETE_TRACK | { trackId } | |
| DUPLICATE_TRACK | { trackId } | |
| SET_TRACK_OUTPUT | { trackId, outputTrackId } | routage vers un bus ou "master" |
| SET_SEND_LEVEL | { trackId, sendId, level } | 0 à 1 |
| FREEZE_TRACK | { trackId, frozen } | gel (rendu figé, CPU libéré) |
| PREPARE_REC | { trackId } | arme la piste et active le mode REC |
| CLEAN_MIX | {} | volumes et pans neutres |

EFFETS
| UPDATE_PLUGIN | { trackId, pluginType, params } | ajoute l'effet s'il manque puis applique les paramètres |
| SET_PLUGIN_PARAM | { trackId, pluginType, param, value } | un paramètre précis |
| BYPASS_PLUGIN | { trackId, pluginType, isEnabled } | |
| REMOVE_PLUGIN | { trackId, pluginType } | |
| MOVE_PLUGIN | { trackId, pluginType, toIndex } | position dans la chaîne (0 = premier) |
| COPY_PLUGIN | { sourceTrackId, pluginType, destTrackId } | |
| OPEN_PLUGIN | { trackId, pluginType } | ouvrir l'interface |
| CLOSE_PLUGIN | {} | |
| RESET_FX | { trackId } | retire tous les effets (toutes les pistes si trackId absent) |

CLIPS
| MUTE_CLIP | { trackId, clipId, isMuted } | |
| DELETE_CLIP | { trackId, clipId } | |
| DUPLICATE_CLIP | { trackId, clipId } | |
| RENAME_CLIP | { trackId, clipId, name } | |
| MOVE_CLIP | { trackId, clipId, start, destTrackId } | destTrackId optionnel |
| SPLIT_CLIP | { trackId, clipId, time } | couper à un instant |
| NORMALIZE_CLIP | { trackId, clipId } | |
| SET_CLIP_GAIN | { trackId, clipId, gain } | |
| SET_CLIP_FADE | { trackId, clipId, fadeIn, fadeOut } | en secondes |

MIDI
| CREATE_PATTERN | { trackId, time } | crée un clip MIDI vide et ouvre le piano roll |
| ADD_NOTES | { trackId, clipId, notes } | notes = [{ pitch, start, duration, velocity }] ; pitch MIDI (60 = do3), start et duration en secondes, velocity 0-1. Le clip est créé s'il n'existe pas. |
| CLEAR_NOTES | { trackId, clipId } | vide le pattern |

AUTOMATION
| SET_AUTOMATION | { trackId, parameter, points } | parameter : volume ou pan ; points = [{ time, value }] |
| CLEAR_AUTOMATION | { trackId, parameter } | |

MARQUEURS ET GROUPES
| ADD_MARKER | { time, name } | |
| DELETE_MARKER | { markerId } ou { name } | |
| GOTO_MARKER | { markerId } ou { name } | |
| CREATE_GROUP | { trackIds } | au moins 2 pistes, volume/mute/solo liés |
| UPDATE_GROUP | { groupId, name, linkedVolume, linkedMute, linkedSolo, linkedPan } | |
| DELETE_GROUP | { groupId } | |

Effets disponibles (pluginType) : AUTOTUNE, PROEQ12, COMPRESSOR, VOCALSATURATOR, REVERB,
DELAY, CHORUS, FLANGER, DOUBLER, STEREOSPREADER, DEESSER, DENOISER, MASTERSYNC.
`;

const SYSTEM_PROMPT = `Tu es Nova, l'assistant IA intégré à Nova Studio DAW, un logiciel de production musicale.

Tu aides sur le mixage, le mastering, les réglages d'effets et la production, ET tu peux agir
directement sur le projet en renvoyant des actions.

RÈGLES DE RÉPONSE
- Réponds en français, de manière concise et technique (2-3 phrases maximum pour "text").
- Tu réponds UNIQUEMENT avec un objet JSON valide, sans texte autour et sans bloc de code :
  { "text": "ta réponse à l'utilisateur", "actions": [ { "action": "...", "payload": { ... }, "description": "..." } ] }
- "actions" peut être un tableau vide si la demande est une simple question ou un conseil.
- N'agis QUE si l'utilisateur demande explicitement une modification. Un conseil ne déclenche pas d'action.
- Utilise TOUJOURS les trackId exacts fournis dans l'état du projet. N'invente jamais d'identifiant.
- "description" est une phrase courte décrivant l'action, affichée à l'utilisateur.
- Reste dans les bornes indiquées (volume 0-1, pan -1 à 1, etc.).
- Tu peux enchaîner plusieurs actions pour une seule demande : elles sont appliquées dans l'ordre.
- Pour créer une mélodie ou une batterie, utilise CREATE_TRACK puis ADD_NOTES. Convertis les
  durées musicales en secondes avec le BPM du projet (une noire = 60/BPM secondes).
- Pour un fondu, une montée ou une descente de volume, utilise SET_AUTOMATION.
- N'invente jamais d'identifiant : les trackId, clipId, sendId et pluginType figurent dans l'état.

ACTIONS DISPONIBLES
${ACTION_CATALOG}`;

/** Extrait un objet JSON même si le modèle l'a entouré de texte ou d'un bloc de code. */
function parseModelJson(raw: string): { text: string; actions: any[] } | null {
  if (!raw) return null;
  let candidate = raw.trim();

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  if (!candidate.startsWith('{')) {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first === -1 || last <= first) return null;
    candidate = candidate.slice(first, last + 1);
  }

  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      actions: Array.isArray(parsed.actions) ? parsed.actions : []
    };
  } catch {
    return null;
  }
}

/** Ne laisse passer que des actions bien formées (le front n'a pas à se défendre seul). */
function sanitizeActions(actions: any[]): any[] {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter(a => a && typeof a.action === 'string')
    .slice(0, 24)
    .map(a => ({
      action: a.action.toUpperCase(),
      payload: (a.payload && typeof a.payload === 'object') ? a.payload : {},
      description: typeof a.description === 'string' ? a.description : undefined
    }));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      text: "Méthode non autorisée",
      actions: [],
      error: 'Method Not Allowed'
    });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[API] GEMINI_API_KEY not configured');
      return res.status(500).json({
        text: "⚠️ Clé API Gemini non configurée. Ajoute GEMINI_API_KEY dans les variables d'environnement (Vercel) ou dans .env.local en local.",
        actions: [],
        error: "GEMINI_API_KEY missing"
      });
    }

    const { message, state } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        text: "Message requis",
        actions: [],
        error: 'Message required'
      });
    }

    // Contexte projet : les trackId sont indispensables pour que les actions ciblent
    // la bonne piste, on envoie donc l'état sérialisé tel quel.
    let contextInfo = '';
    if (state) {
      contextInfo = `\n\nÉTAT ACTUEL DU PROJET (JSON) :\n${JSON.stringify(state).slice(0, 12000)}`;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        temperature: 0.4,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
        responseMimeType: "application/json"
      }
    });

    const fullPrompt = `${SYSTEM_PROMPT}${contextInfo}\n\nDemande de l'utilisateur : ${message}`;

    const result = await model.generateContent(fullPrompt);
    const raw = (await result.response).text();

    const parsed = parseModelJson(raw);

    if (!parsed) {
      // Le modèle a répondu en texte libre : on le transmet sans action.
      console.warn('[API] Réponse non-JSON du modèle, transmise en texte brut.');
      return res.status(200).json({
        text: raw || "Je suis là pour t'aider avec ton mix !",
        actions: []
      });
    }

    return res.status(200).json({
      text: parsed.text || "C'est fait.",
      actions: sanitizeActions(parsed.actions)
    });

  } catch (error: any) {
    console.error('[API] Gemini Error:', error);

    let errorMessage = "Erreur lors de la communication avec l'IA.";

    if (error.message?.includes('API_KEY')) {
      errorMessage = "Clé API Gemini invalide ou expirée.";
    } else if (error.message?.includes('quota')) {
      errorMessage = "Quota API dépassé. Réessaie plus tard.";
    } else if (error.message?.includes('network')) {
      errorMessage = "Erreur réseau. Vérifie ta connexion.";
    }

    return res.status(500).json({
      text: `❌ ${errorMessage}`,
      actions: [],
      error: error.message || 'Unknown error'
    });
  }
}
