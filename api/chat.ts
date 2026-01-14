import { GoogleGenerativeAI } from "@google/generative-ai";
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers pour permettre les requêtes depuis le frontend
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        text: "Clé API Gemini manquante. Configurez GEMINI_API_KEY dans les variables d'environnement Vercel.",
        error: "Missing API key"
      });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const { message, state } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(`Tu es Nova. État: ${JSON.stringify(state)}. Message: ${message}`);
    const response = await result.response;
    const text = response.text();

    return res.status(200).json({ text, actions: [] });
  } catch (error) {
    console.error('Erreur Gemini:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({
      text: "Erreur lors de la communication avec Gemini",
      error: errorMessage
    });
  }
}
