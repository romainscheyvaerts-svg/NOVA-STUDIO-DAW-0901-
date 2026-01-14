import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

// Utilise la clé GOOGLE_API_KEY que tu as configurée sur Vercel
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");

export async function POST(req: Request) {
  try {
    const { message, state } = await req.json();
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Tu es Nova, l'IA assistante de ce DAW. 
    Réponds de manière concise.
    État du projet : ${JSON.stringify(state)}
    Utilisateur : ${message}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    return NextResponse.json({
      text: response.text(),
      actions: []
    });
  } catch (error) {
    console.error("Erreur Gemini:", error);
    return NextResponse.json(
      { text: "Erreur de connexion avec Gemini. Vérifie ta clé sur Vercel." },
      { status: 500 }
    );
  }
}
