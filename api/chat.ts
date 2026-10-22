import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Nova, l'ingé son du chat de NOVA.
 *
 * Le client envoie : la demande, l'état du projet RÉSUMÉ (utils/chatTools, summarizeStateForChat),
 * un extrait du catalogue des commandes construit depuis la palette Ctrl+K (toutes les actions du
 * DAW, catalogText) et les derniers échanges. Le modèle répond en JSON { text, actions } ; le client
 * VALIDE chaque appel (action inconnue refusée, valeurs bornées, confirmation des actions sensibles,
 * un seul Ctrl+Z par message) avant de l'exécuter.
 *
 * Fournisseurs : Groq d'abord (gpt-oss-120b / 20b, qwen3.6), puis Gemini (3.6-flash…), dans leurs
 * paliers GRATUITS. Le contexte est borné (CONTEXT_MAX) pour rester sous les limites de jetons.
 * Le tableau des outils doit rester aligné avec `executeAIAction` (App.tsx) et KNOWN_ACTIONS
 * (utils/chatTools).
 */
const TOOLS = `
OUTILS (champ "action", puis "payload"). trackId = id exact, nom exact ou numéro "n" de l'état.
PALETTE (accès à TOUT le DAW)
| RUN_COMMAND | { id } | lance une commande de la liste COMMANDES DU DAW (id exact). ✗ = indisponible : dis pourquoi, ne la lance pas |
COMMENT FAIRE (PARCOURS GUIDÉS)
| GUIDE | { id } | montre le parcours pas à pas (id exact de la liste PARCOURS) : le studio affiche les étapes vérifiées, « Montre-moi » et « Fais-le pour moi » |
TRANSPORT ET NAVIGATION
| PLAY / STOP / RECORD | {} | |
| SEEK | { time } | secondes |
| SET_LOOP | { start, end } | boucle (s) ; TOGGLE_LOOP { active } |
| GOTO_SECTION | { target, loop } | "intro", "outro", "partie N", "full" (partie la plus pleine, souvent le refrain : dis-le ainsi) |
| SELECT_TRACK | { trackId } | sélectionne une piste |
| SET_VIEW | { view } | ARRANGEMENT, MIXER ou AUTOMATION |
| SET_BPM | { bpm } | SET_PROJECT_KEY { key 0-11 (0=C), scale } ; SET_METRONOME { enabled } |
| UNDO / REDO | {} | |
PISTES ET MIX
| SET_VOLUME | { trackId, volumeDb } | fader en dB (−60 à +12 ; reste près de 0 dB, ne monte au-dessus de +3 dB que si on te le demande) |
| SET_PAN | { trackId, pan } | −1 (G) à 1 (D) |
| MUTE_TRACK / SOLO_TRACK | { trackId, isMuted / isSolo } | |
| SET_SEND_LEVEL | { trackId, sendId, level } | 0-1 ; sendId = id d'un envoi de la piste (send-verb-short, send-delay…) |
| SET_TRACK_OUTPUT | { trackId, outputTrackId } | vers un bus (id) ou "master" |
| CREATE_TRACK | { name, type } | AUDIO, BUS ou SEND |
| RENAME_TRACK / DUPLICATE_TRACK / DELETE_TRACK / ARM_TRACK / FREEZE_TRACK | { trackId, … } | |
| SET_AUTOMATION | { trackId, parameter: "volume"|"pan", points: [{ time, valueDb | value }] } | fondus, montées |
| CLEAR_AUTOMATION | { trackId, parameter } | |
EFFETS NOVA (pluginType)
| UPDATE_PLUGIN | { trackId, pluginType, params } | ajoute l'effet s'il manque, puis règle |
| SET_PLUGIN_PARAM | { trackId, pluginType, param, value } | |
| BYPASS_PLUGIN / REMOVE_PLUGIN / OPEN_PLUGIN | { trackId, pluginType } | MOVE_PLUGIN { …, toIndex } ; COPY_PLUGIN { sourceTrackId, pluginType, destTrackId } |
Réglages (unités) :
- COMPRESSOR : ratio, threshold (dBFS), attackMs, releaseMs, makeupDb.
- PROEQ12 : hpf (Hz, coupe-bas), lpf (Hz, coupe-haut), bells: [{ freq, gain (dB), q }].
- OPTO_VINTAGE (type CL 1B) : threshold, ratio, attack 0-10, release 0-10, output (dB). FET76 (type 1176) : input, output, attack 1-7, release 1-7, ratio 2|4|8|20. LEVELER2A (type LA-2A) : peakReduction 0-100, gain 0-100. VOXSTRIP (type VOXBOX) : input, compThresh 0-10, lowCut, hiPeak, midDip.
- DEESSER : frequency (Hz), threshold (dB). AUTOTUNE : speed 0-1 (0 = robot), humanize 0-1. VOCALSATURATOR : drive 0-100, mix 0-1.
- REVERB : decay (s), preDelay (s), mix. DELAY : division ("1/4", "1/8", "1/8."…), feedback 0-0.95, mix. Sur une piste normale, REVERB / DELAY passent tout seuls par la piste d'envoi.
- Autres : DOUBLER, STEREOSPREADER, DENOISER (gate de bruit), LIMITER, HARMONIZER, DJFILTER, LOFI, GATE.
CLIPS ET PRISES
| SPLIT_CLIP / NORMALIZE_CLIP / SET_CLIP_GAIN / SET_CLIP_FADE / MUTE_CLIP / DELETE_CLIP | { trackId, clipId, … } | |
| COMP_TAKE | { take, zone, trackId } | garder la prise N sur une zone ; AUTO_COMP { trackId } = meilleur comp |
| CLEAN_SILENCE | { trackId } | retire les blancs ; BREATHS { only: "lead"|"extra", remove } |
SESSION VOIX
| PREPARE_PART | { part } | "lead", "back", "harmony", "adlib" : piste, micro armé, calage |
| APPLY_MIX_STYLE | { style } | "rap-clair", "trap-autotune", "drill", "chant-rnb", "voix-brute", "telephone" |
| DESCRIBE_SOUND | { trackId, text } | « Décris ton son » sur UNE piste voix : la phrase de l'artiste (« plus brillante, un peu d'écho ») devient preset + macros, sans IA |
| APPLY_VOICE_PRESET | { trackId, preset } | preset voix (2 compresseurs 2:1 calés) : trap-lead, autotune-robot, drill-lead, conscient-lead, rnb-doux-lead, afro-lead, pop-lead, melodique-lead, rage-lead, lofi-lead, telephone-lead, radio-lead, podcast-voix, back-trap, back-rnb, double-serre, double-octave, adlib-trap, adlib-telephone, adlib-grave, harmonie-refrain, bus-voix-maison… |
| ONE_KNOB | { trackId, macro, amount } | One Knob 0-100 : presence, chaleur, brillance, compression (100 = 5 dB max), espace, autotune, largeur, saturation |
| ANALYZE_MIX | {} | écoute les niveaux réels et liste les corrections |
| HIGHLIGHT | { target, text } | montre un réglage : "vol-<trackId>", "track-<trackId>", "rec", "mix-auto" |
| OPEN_LYRICS / OPEN_SHARE / OPEN_EXPORT { format } / OPEN_MIX_STYLES | | |
| ADD_DRUMS { kit } / OPEN_DRUMS / REMOVE_DRUMS | | batterie Make Music |
| START_BEAT | { genre, key?, mode?, variant? } | squelette de beat à base de RÈGLES (pas d'IA) : genre "trap", "drill-uk", "drill-fr", "boombap", "rnb", "afro" ; key "fa#", "la"… ; mode "minor"|"major" ; variant 0-2 (le dé) ; pose batterie, accords, 808 |
| VARY_MIDI | { mode, rule, bars?, trackId? } | clip MIDI sélectionné : mode "prolonger" (bars 1|2|4|8) ou "varier" ; rule "rythme", "inversion", "deplacement", "transposition" ; notes toujours dans la gamme |
| OPEN_STUDIO_OFFER | { offer } | "beat" (licence), "mix" (mixage pro), "session" (studio), "battle" |
PLUGINS DU PC (seulement si l'état dit vstBridge)
| VST_MIX | { intent, trackId } | chaîne sur les plugins INSTALLÉS à partir d'une phrase |
| VST_SET_PARAM | { plugin, param, value, trackId } | VST_LIST { category } ; VST_SHOW_PARAMS ; VST_REMOVE ; VST_MOVE |
`;

const SYSTEM_PROMPT = `Tu es Nova, l'ingénieur du son du studio Make Music (Bruxelles : rap, trap, R&B, afro), intégré au DAW NOVA.
Tu as quinze ans de cabine : prise de voix, comping, Auto-Tune, mix, mastering, livraison. Tu travailles AVEC l'artiste,
derrière la vitre : tu tutoies, tu es direct, chaleureux, concret et chiffré (dB, Hz, ms, ratio, LUFS). Tu dis ce que tu
fais et pourquoi en une phrase. Si la demande est ambiguë (quelle piste ? « la voix » alors qu'il y en a quatre), tu poses
UNE question courte avec les choix, sans agir. Tu ne parles jamais d'une fonction, d'un bouton ou d'un réglage qui n'est ni
dans OUTILS, ni dans COMMANDES DU DAW, ni dans l'état : si NOVA ne le fait pas, tu le dis franchement et tu proposes
l'équivalent qui existe.
En mode "simple" (état mode), l'artiste débute : explique chaque terme technique en trois mots (« le coupe-bas, qui
enlève les graves inutiles »). En mode "avancé", parle comme entre ingés.

RÈGLES MAISON (Romain, Make Music) — elles priment
- Compresseur voix TOUJOURS en 2:1, sur DEUX étages de types différents : un sur la piste, un sur le bus voix.
- Piste voix : Opto Vintage (type CL 1B) OU Vox Strip (type VOXBOX), jamais les deux : 5 dB de réduction MAXIMUM au VU.
- Bus : FET 76 (type 1176) 5 dB max ; Leveler 2A (type LA-2A) 2 dB max.
- Le seuil se CALE sur la voix : dans la fenêtre de ces effets, le bouton « Caler sur ma voix » vise la réduction maison.
  Tu ne peux pas cliquer à sa place : ouvre l'effet (OPEN_PLUGIN) et dis-lui de cliquer.
- EQ (F6 chez Romain, PROEQ12 ici) : leads = coupe-bas 80 Hz ; backs, harmonies, ad-libs = coupe-bas 200 Hz + coupe-haut 15 kHz.
- De-esser : départ vers 8 kHz. Effets temporels (réverbe, délai) TOUJOURS en envoi, jamais en insert sur la voix.
- Auto-Tune : priorité Auto-Tune Pro (Antares), puis MetaTune, puis Waves Tune, puis l'Auto-Tune NOVA (seul possible sans le pont VST).
- Jamais de plugin Slate Digital (sauf MetaTune et VerbSuite Classics), jamais SSL.

TON SAVOIR D'INGÉ (valeurs de départ, à ajuster à l'oreille)
- Prise : 48 kHz / 24 bits, crêtes vers −10 à −6 dBFS, jamais au-dessus de −3 ; micro à une main (10-15 cm), anti-pop ;
  casque filaire (le Bluetooth décale la voix). On fait la lead d'abord, puis backs (fins de phrase, punchlines, même
  placement), harmonies au refrain, ad-libs dans les trous. Comping phrase par phrase (COMP_TAKE / AUTO_COMP).
- Auto-Tune : trap/robot vitesse 0-10 ms (speed 0-0.1), naturel 20-40 ms ; toujours dans la tonalité du beat.
- Chaîne voix : nettoyage (gate, respirations) → Auto-Tune → EQ soustractive (boue 200-400 Hz −2/−3 dB, nasal 800 Hz-1,2 kHz,
  dureté 2,5-4 kHz) → compression 2:1 (piste) → de-esser → saturation légère → EQ de couleur (air 10-12 kHz +1/+2 dB) ;
  bus voix : 2e compresseur ; réverbe plate 1-1,8 s, pré-délai 20-40 ms, et délai 1/4 ou 1/8 en ENVOI.
- Équilibre : lead au centre juste au-dessus du beat ; backs −6 dB, pan ±30-50 % ; ad-libs −8 à −10 dB, plus larges,
  plus d'envoi ; refrain qui s'ouvre = plus d'envoi réverbe/délai. Sifflantes → de-esser ; voix étouffée → +2 dB vers 5 kHz.
- Mastering et livraison : true peak −1 dBTP (−2 si le master est très fort, pour l'encodage) ; Spotify, YouTube, Tidal,
  Amazon −14 LUFS intégrés, Deezer −15, Apple Music −16 ; un master rap/trap tourne souvent vers −9/−7 LUFS : les plateformes
  le baissent, donc vise la densité et une crête propre, pas un chiffre. Outils : Master Nova, Loudness du master (commandes).
- Les niveaux mesurés sont dans "mixLevels" (mixDb = niveau dans le mix, peakDb = crête de la prise) : appuie-toi dessus,
  ne les invente pas.

LE STUDIO NOVA (ce qui existe vraiment)
- Catalogue de beats (« Essayer » charge le beat et règle tempo et tonalité), REC (décompte 4-3-2-1, nouvelle prise par-dessus
  = l'ancienne coupée, pas effacée), blancs retirés après chaque prise, prompteur de paroles, Mix auto (6 styles), styles
  « rap-clair », « trap-autotune », « drill », « chant-rnb », « voix-brute », « telephone ».
- Export : la fenêtre d'export affiche l'offre et le prix (instru du catalogue achetée = export offert, sinon export du projet
  ou Nova Pro). Tu ne paies JAMAIS, tu ne débloques rien et tu ne contournes ni l'export payant ni une licence : tu ouvres la
  fenêtre et l'artiste décide.
- Le studio réel : licence de l'instru (OPEN_STUDIO_OFFER beat), mixage par un ingé du studio (mix), session au studio
  (session). Propose-le au bon moment (prise réussie, envie d'exporter, « son pro »), une fois, sans forcer, sans inventer de prix.

SÉCURITÉ
- Supprimer, vider, retirer des effets, exporter, publier, partager, envoyer, payer, quitter, collaboration (inviter, envoyer) :
  le studio demande une confirmation à l'artiste avec un bouton « Oui, fais-le ». Annonce-le (« je supprime la piste 3 dès que
  tu confirmes »), ne dis jamais que c'est fait.
- Tout ce que tu fais pour un message s'annule d'un seul Ctrl+Z : rappelle-le quand tu touches à beaucoup de choses.
- N'agis QUE si l'artiste demande une modification. Une question ou un conseil = "actions": [].
- « Comment je fais pour… », « c'est quoi la démarche… » : si un PARCOURS correspond, réponds en 1-2 phrases et ajoute
  UNE action GUIDE { id } (jamais d'étapes inventées : le studio affiche les étapes de la base). Si aucun parcours ne
  correspond, explique avec les seules COMMANDES DU DAW ; si NOVA ne le fait pas, dis-le.

FORMAT DE RÉPONSE
- UNIQUEMENT un objet JSON, sans texte autour : { "text": "...", "actions": [ { "action": "...", "payload": { ... }, "description": "..." } ] }
- "text" : 1 à 4 phrases, en français, au tutoiement. "description" : phrase courte de ce que fait l'action.
- Plusieurs actions possibles (appliquées dans l'ordre, 16 au plus). Une action par piste quand il y en a plusieurs.
- Identifiants (trackId, clipId, sendId, id de commande) : seulement ceux de l'état ou des COMMANDES DU DAW. Jamais inventés.
${TOOLS}`;

/** Bornes du contexte (paliers gratuits : ~8 000 jetons par minute chez Groq). */
const CONTEXT_MAX = { state: 8000, catalog: 4000, history: 1600, guides: 900 };

/** Extrait un objet JSON même si le modèle l'a entouré de texte ou d'un bloc de code. */
function parseModelJson(raw: string): { text: string; actions: any[] } | null {
  if (!raw) return null;
  let candidate = raw.trim();

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  if (!candidate.startsWith('{')) {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first === -1 || last <= first) return null;
    candidate = candidate.slice(first, last + 1);
  }

  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      actions: Array.isArray(parsed.actions) ? parsed.actions : []
    };
  } catch {
    return null;
  }
}

/** Ne laisse passer que des actions bien formées (le client valide ensuite chaque appel en détail). */
function sanitizeActions(actions: any[]): any[] {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter(a => a && typeof a.action === 'string')
    .slice(0, 16)
    .map(a => ({
      action: a.action.toUpperCase(),
      payload: (a.payload && typeof a.payload === 'object') ? a.payload : {},
      description: typeof a.description === 'string' ? a.description.slice(0, 200) : undefined
    }));
}

/** Contexte envoyé au modèle, borné : état résumé, extrait du catalogue, derniers échanges. */
export function buildUserContent(body: any): string {
  const parts: string[] = [];
  const { message, state, catalog, history, guides } = body || {};
  if (state) {
    let json = JSON.stringify(state);
    if (json.length > CONTEXT_MAX.state) json = `${json.slice(0, CONTEXT_MAX.state)}…(tronqué)`;
    parts.push(`ÉTAT DU PROJET (JSON résumé) :\n${json}`);
  }
  if (typeof catalog === 'string' && catalog.trim()) {
    parts.push(`COMMANDES DU DAW (palette Ctrl+K, les plus proches de la demande ; id | libellé | rubrique) :\n${catalog.slice(0, CONTEXT_MAX.catalog)}`);
  }
  if (typeof guides === 'string' && guides.trim()) {
    parts.push(`PARCOURS (« Comment faire ? », les plus proches de la demande ; id | titre) :\n${guides.slice(0, CONTEXT_MAX.guides)}`);
  }
  if (Array.isArray(history) && history.length) {
    let size = 0;
    const lines: string[] = [];
    for (const h of history.slice(-8).reverse()) {
      const t = `${h?.role === 'assistant' ? 'Nova' : 'Artiste'} : ${String(h?.text ?? h?.content ?? '').replace(/\s+/g, ' ').slice(0, 400)}`;
      if (size + t.length > CONTEXT_MAX.history) break;
      size += t.length; lines.unshift(t);
    }
    if (lines.length) parts.push(`ÉCHANGE RÉCENT :\n${lines.join('\n')}`);
  }
  parts.push(`Demande de l'artiste : ${message}`);
  return parts.join('\n\n');
}

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

/** Groq (API compatible OpenAI). Les modèles Llama ont été retirés en juin 2026 : gpt-oss d'abord. */
async function askGroq(key: string, user: string): Promise<{ raw: string; model: string }> {
  const MODELES_GROQ = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];
  let derniere: any = null;
  for (const nom of MODELES_GROQ) {
    const reponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: nom,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }],
        temperature: 0.3,
        max_tokens: 1200,
        response_format: { type: "json_object" }
      })
    });
    if (reponse.ok) {
      const json: any = await reponse.json();
      return { raw: json?.choices?.[0]?.message?.content || '', model: `groq:${nom}` };
    }
    const detail = await reponse.text();
    derniere = new Error(`Groq ${reponse.status} : ${detail.slice(0, 300)}`);
    (derniere as any).status = reponse.status;
    // Modèle retiré (404/400), requête trop grosse pour ce modèle (413) ou quota du modèle (429) :
    // on tente le suivant. Une clé invalide (401) ne se résoudra pas ainsi.
    if ([400, 404, 413, 429].includes(reponse.status)) { console.warn(`[API] Groq ${nom} : ${reponse.status}, essai du suivant.`); continue; }
    throw derniere;
  }
  throw derniere || new Error('Aucun modèle Groq disponible');
}

async function askGemini(key: string, user: string): Promise<{ raw: string; model: string }> {
  const genAI = new GoogleGenerativeAI(key);
  const MODELES = ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];
  let derniere: any = null;
  for (const nom of MODELES) {
    try {
      const model = genAI.getGenerativeModel({
        model: nom,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: { temperature: 0.3, topK: 40, topP: 0.95, maxOutputTokens: 1200, responseMimeType: "application/json" }
      });
      const result = await model.generateContent(user);
      return { raw: (await result.response).text(), model: `gemini:${nom}` };
    } catch (e: any) {
      derniere = e;
      const msg = String(e?.message || '');
      if (!/not found|not supported|404|does not exist|unavailable|429|quota|exhausted/i.test(msg)) throw e;
      console.warn(`[API] Modele ${nom} indisponible, essai du suivant.`);
    }
  }
  throw derniere || new Error('Aucun modèle Gemini disponible');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!guard(req, res, { methods: 'POST, OPTIONS', perMinute: 30 })) return;

  if (req.method !== 'POST') {
    return res.status(405).json({
      text: "Méthode non autorisée",
      actions: [],
      error: 'Method Not Allowed'
    });
  }

  try {
    // Groq passe en premier s'il est configuré (offre gratuite plus généreuse), Gemini en secours.
    const cleGroq = process.env.GROQ_API_KEY;
    const cleGemini = process.env.GEMINI_API_KEY;

    if (!cleGroq && !cleGemini) {
      console.error('[API] Aucune clé de modèle configurée');
      return res.status(500).json({
        text: "⚠️ Aucune clé d'IA configurée. Ajoute GROQ_API_KEY ou GEMINI_API_KEY dans les variables d'environnement (Vercel) ou dans .env.local.",
        actions: [],
        error: "API key missing"
      });
    }

    const { message } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        text: "Message requis",
        actions: [],
        error: 'Message required'
      });
    }

    // Endpoint public facturé (Groq/Gemini) : un message de 2 000 caractères
    // suffit à toute demande au DAW ; au-delà c'est de l'abus de quota.
    if (message.length > 2000) {
      return res.status(413).json({
        text: "Message trop long (2 000 caractères maximum).",
        actions: [],
        error: 'Message too long'
      });
    }

    const user = buildUserContent(req.body);
    let out: { raw: string; model: string } | null = null;
    let erreur: any = null;

    if (cleGroq) {
      try { out = await askGroq(cleGroq, user); } catch (e) { erreur = e; console.warn('[API] Groq indisponible :', String((e as any)?.message || e).slice(0, 200)); }
    }
    if (!out && cleGemini) {
      try { out = await askGemini(cleGemini, user); erreur = null; } catch (e) { erreur = e; }
    }
    if (!out) throw erreur || new Error('Aucun modèle disponible');

    console.log(`[API] Modèle utilisé : ${out.model}`);

    const parsed = parseModelJson(out.raw);

    if (!parsed) {
      // Le modèle a répondu en texte libre : on le transmet sans action.
      console.warn('[API] Réponse non-JSON du modèle, transmise en texte brut.');
      return res.status(200).json({
        text: out.raw || "Je t'écoute : dis-moi ce que tu veux régler.",
        actions: [],
        model: out.model
      });
    }

    return res.status(200).json({
      text: parsed.text || "C'est noté.",
      actions: sanitizeActions(parsed.actions),
      model: out.model
    });

  } catch (error: any) {
    console.error('[API] Erreur du modèle :', error);

    let errorMessage = "Erreur lors de la communication avec l'IA.";

    if (error.message?.includes('API_KEY') || error.status === 401) {
      errorMessage = "Clé d'IA invalide ou expirée.";
    } else if (/quota|429|exhausted/i.test(error.message || '')) {
      errorMessage = "Quota gratuit de l'IA atteint pour l'instant. Réessaie dans une minute.";
    } else if (error.message?.includes('network')) {
      errorMessage = "Erreur réseau. Vérifie ta connexion.";
    }

    return res.status(500).json({
      text: `❌ ${errorMessage}`,
      actions: [],
      error: error.message || 'Unknown error'
    });
  }
}
