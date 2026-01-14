import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");

export default async function handler(req: any, res: any) {
  try {
    const { message, state } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `Tu es Nova. État du projet : ${JSON.stringify(state)}. Utilisateur : ${message}`;
    const result = await model.generateContent(prompt);
    
    res.status(200).json({ text: result.response.text(), actions: [] });
  } catch (error) {
    res.status(500).json({ text: "Erreur de connexion Gemini" });
  }
}
