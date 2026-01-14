import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  // 1. On vérifie que la demande est bien un envoi de données (POST)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  // 2. On récupère le message envoyé par ton site
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Le message est vide' });
  }

  try {
    // 3. On se connecte à Gemini avec la clé secrète (stockée chez Vercel)
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    
    // On utilise le modèle Gemini Pro
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    // 4. On envoie la question à l'IA
    const result = await model.generateContent(message);
    const response = await result.response;
    const text = response.text();

    // 5. On renvoie la réponse propre à ton site
    res.status(200).json({ text });

  } catch (error) {
    console.error("Erreur API:", error);
    res.status(500).json({ error: 'Erreur lors de la communication avec Google AI' });
  }
}
