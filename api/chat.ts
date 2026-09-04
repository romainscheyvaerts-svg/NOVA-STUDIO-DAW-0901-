import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Catalogue des actions que Nova peut exécuter dans le DAW.
 * Doit rester aligné avec `executeAIAction` dans App.tsx et `AIActionType` dans types.ts.
 */
const ACTION_CATALOG = `
| action | payload | effet |
|---|---|---|
| SET_VOLUME | { trackId, volume }        | volume entre 0 et 1 |
| SET_PAN | { trackId, pan }              | pan entre -1 (gauche) et 1 (droite) |
| MUTE_TRACK | { trackId, isMuted }       | couper / rétablir la piste |
| SOLO_TRACK | { trackId, isSolo }        | solo de la piste |
| RENAME_TRACK | { trackId, name }        | renommer la piste |
| CREATE_TRACK | { name, type }           | type : AUDIO, MIDI, BUS ou SEND |
| DELETE_TRACK | { trackId }              | supprimer la piste |
| DUPLICATE_TRACK | { trackId }           | dupliquer la piste |
| UPDATE_PLUGIN | { trackId, pluginType, params } | ajoute l'effet s'il est absent puis applique les paramètres |
| SET_PLUGIN_PARAM | { trackId, pluginType, param, value } | régler un paramètre précis |
| BYPASS_PLUGIN | { trackId, pluginType, isEnabled } | activer / bypasser un effet |
| OPEN_PLUGIN | { trackId, pluginType }   | ouvrir l'interface de l'effet |
| CLOSE_PLUGIN | {}                       | fermer l'interface ouverte |
| RESET_FX | { trackId }                  | retirer tous les effets (toutes les pistes si trackId absent) |
| SET_SEND_LEVEL | { trackId, sendId, level } | niveau de départ (0 à 1) |
| PLAY | {}                               | lancer la lecture |
| STOP | {}                               | arrêter |
| RECORD | {}                             | armer / lancer l'enregistrement |
| SEEK | { time }                         | placer la tête de lecture (secondes) |
| SET_LOOP | { start, end, active }        | boucle (secondes) |
| SET_BPM | { bpm }                       | tempo du projet |
| MUTE_CLIP | { trackId, clipId, isMuted } | couper un clip |
| SPLIT_CLIP | { trackId, clipId, time }  | couper un clip à un instant donné |
| NORMALIZE_CLIP | { trackId, clipId }    | normaliser le gain du clip |
| PREPARE_REC | { trackId }               | armer la piste pour l'enregistrement |
| CLEAN_MIX | {}                          | remettre volumes et pans à des valeurs neutres |

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
    .slice(0, 12)
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
