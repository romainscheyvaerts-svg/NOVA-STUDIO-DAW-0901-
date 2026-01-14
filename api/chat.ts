import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { message, state } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(`Tu es Nova. État du DAW: ${JSON.stringify(state)}. Message: ${message}`);
    const response = await result.response;
    
    return res.status(200).json({ 
      text: response.text(), 
      actions: [] 
    });
  } catch (error) {
    return res.status(500).json({ text: "Erreur de connexion avec Gemini." });
  }
}
