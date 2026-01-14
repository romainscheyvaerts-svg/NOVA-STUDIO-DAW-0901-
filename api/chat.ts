import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");

export default async function handler(req: any, res: any) {
  // On accepte uniquement les messages envoyés (POST)
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { message, state } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Tu es Nova, l'IA assistante du DAW. 
    État du projet : ${JSON.stringify(state)}
    Utilisateur : ${message}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    // Format de réponse que ton App.tsx attend
    return res.status(200).json({ 
      text: response.text(), 
      actions: [] 
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ text: "Erreur de connexion avec Gemini." });
  }
}
