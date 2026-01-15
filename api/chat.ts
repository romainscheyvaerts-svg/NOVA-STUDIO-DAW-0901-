import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

const SYSTEM_PROMPT = `Tu es Nova, l'assistant IA intégré à Nova Studio DAW, un logiciel de production musicale professionnel.

Ton rôle est d'aider les producteurs et artistes avec :
- Le mixage et le mastering
- Les réglages d'effets (EQ, compression, reverb, delay, autotune, etc.)
- Les conseils de production musicale
- L'optimisation du son des voix et instruments

Tu dois répondre de manière :
- Concise et directe (max 2-3 phrases)
- Technique mais accessible
- En français

Tu as accès à l'état actuel du projet (BPM, pistes, plugins actifs).
Ne réponds jamais avec du code ou des instructions techniques complexes.
Donne des conseils pratiques orientés production musicale.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      text: "Méthode non autorisée",
      error: 'Method Not Allowed' 
    });
  }

  try {
    // Check API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[API] GEMINI_API_KEY not configured');
      return res.status(500).json({
        text: "⚠️ Clé API Gemini non configurée sur Vercel. Va dans Settings > Environment Variables et ajoute GEMINI_API_KEY.",
        error: "GEMINI_API_KEY missing"
      });
    }

    // Parse request body
    const { message, state } = req.body || {};
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        text: "Message requis",
        error: 'Message required' 
      });
    }

    // Build context from DAW state
    let contextInfo = '';
    if (state) {
      contextInfo = `\n\nÉtat actuel du projet:
- BPM: ${state.bpm || 120}
- Pistes: ${state.trackCount || 0}
- Lecture: ${state.isPlaying ? 'En cours' : 'Arrêtée'}
- Enregistrement: ${state.isRecording ? 'Actif' : 'Inactif'}`;
      
      if (state.tracks && state.tracks.length > 0) {
        contextInfo += `\n- Pistes actives: ${state.tracks.map((t: any) => `${t.name} (${t.type})`).join(', ')}`;
      }
    }

    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 256,
      }
    });

    // Generate response
    const fullPrompt = `${SYSTEM_PROMPT}${contextInfo}\n\nQuestion de l'utilisateur: ${message}`;
    
    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const text = response.text();

    // Return success
    return res.status(200).json({ 
      text: text || "Je suis là pour t'aider avec ton mix !",
      actions: [] 
    });

  } catch (error: any) {
    console.error('[API] Gemini Error:', error);
    
    // Handle specific error types
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
      error: error.message || 'Unknown error'
    });
  }
}
