import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Génération créative pour le panneau admin (nom + prompt de cover d'un beat).
 * Remplace les valeurs en dur qui renvoyaient toujours le même résultat.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY non configurée." });
    }

    const { category } = req.body || {};
    const theme = typeof category === 'string' && category.trim() ? category.trim() : 'trap';

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        temperature: 1.0,
        maxOutputTokens: 256,
        responseMimeType: 'application/json'
      }
    });

    const prompt = `Tu nommes des instrumentales pour un catalogue de beats.
Style / contexte : "${theme}".

Renvoie UNIQUEMENT un objet JSON :
{ "name": "...", "prompt": "..." }

- "name" : un titre court et percutant (1 à 3 mots), en majuscules, sans guillemets,
  evocateur du style. Evite les noms generiques du type "TRAP BEAT".
- "prompt" : une description visuelle en anglais (15 à 25 mots) pour generer une
  pochette d'album correspondant a l'ambiance, sans texte ni logo dans l'image.`;

    const result = await model.generateContent(prompt);
    const raw = (await result.response).text().trim();

    let parsed: any = null;
    try {
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      parsed = JSON.parse(fenced ? fenced[1].trim() : raw);
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed.name !== 'string') {
      return res.status(200).json({
        name: `${theme.toUpperCase()} BEAT`,
        prompt: 'Dark urban atmosphere with neon lights',
        fallback: true
      });
    }

    return res.status(200).json({
      name: String(parsed.name).slice(0, 40),
      prompt: typeof parsed.prompt === 'string'
        ? String(parsed.prompt).slice(0, 300)
        : 'Dark urban atmosphere with neon lights'
    });
  } catch (error: any) {
    console.error('[API] generate error:', error);
    return res.status(500).json({ error: error?.message || 'Erreur inconnue' });
  }
}
