import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { message, state } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(`Tu es Nova. État: ${JSON.stringify(state)}. Message: ${message}`);
    const response = await result.response;
    const text = response.text();

    return res.status(200).json({ text, actions: [] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ text: "Erreur Gemini", error: error.message });
  }
}
