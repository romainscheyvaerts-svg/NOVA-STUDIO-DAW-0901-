import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Génération créative pour le panneau admin (nom + prompt de cover d'un beat).
 * Remplace les valeurs en dur qui renvoyaient toujours le même résultat.
 */
/**
 * Protège les API d'IA : avant, n'importe quel site pouvait les appeler
 * (CORS « * ») et vider le quota Groq / Gemini, rendant Nova muet pour tous.
 * Seules les pages de Nova et de Make Music sont acceptées, avec une limite
 * de requêtes par adresse IP.
 */
const ALLOWED = [
  /^https:\/\/nova-studio-daw-0901[a-z0-9-]*\.vercel\.app$/,
  /^https:\/\/(www\.)?studiomakemusic\.com$/,
  /^https:\/\/make-music\.lovable\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

const hits = new Map<string, { n: number; reset: number }>();

/** true = la requête peut continuer ; false = réponse déjà envoyée. */
function guard(req: VercelRequest, res: VercelResponse, opts: { methods: string; perMinute: number }): boolean {
  const origin = String(req.headers.origin || '');
  const okOrigin = !origin || ALLOWED.some(r => r.test(origin));
  if (origin && okOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', opts.methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(okOrigin ? 200 : 403).end(); return false; }
  if (!okOrigin) { res.status(403).json({ text: 'Origine non autorisée', actions: [], error: 'Forbidden origin' }); return false; }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) hits.set(ip, { n: 1, reset: now + 60_000 });
  else if (++h.n > opts.perMinute) {
    res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
    res.status(429).json({ text: '⏳ Trop de demandes d\'un coup : réessaie dans une minute.', actions: [], error: 'Too Many Requests' });
    return false;
  }
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!guard(req, res, { methods: 'POST, OPTIONS', perMinute: 10 })) return;
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
