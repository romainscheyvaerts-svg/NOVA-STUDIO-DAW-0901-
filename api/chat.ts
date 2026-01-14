import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");

export default async function (req, res) {
  // Indispensable pour les fonctions Vercel avec Vite
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const { message, state } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Tu es Nova, assistant DAW. État: ${JSON.stringify(state)}. Message: ${message}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    // Format de retour strict
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ 
      text: response.text(), 
      actions: [] 
    }));
  } catch (error) {
    console.error("Erreur détaillée:", error);
    return res.status(500).json({ text: "Erreur Gemini", details: error.message });
  }
}
