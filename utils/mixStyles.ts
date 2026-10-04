/**
 * Styles de mix COMBINABLES pour Nova (chat) : une phrase libre (« mix spatial et
 * saturé avec beaucoup de delay », « un mix neutre », « rends ma voix plus pro »)
 * devient une combinaison de styles avec une intensité chacun, puis des
 * « dimensions » (espace, délai, saturation, air…) entre 0 et 1 que le planificateur
 * (utils/mixPlanner.ts) traduit en chaîne et en réglages sur les plugins installés.
 */

export type MixDim =
  | 'clean' | 'compression' | 'air' | 'presence' | 'warmth' | 'saturation' | 'space' | 'delay'
  | 'width' | 'deess' | 'tune' | 'lofi' | 'radio' | 'dark';

export type Dims = Partial<Record<MixDim, number>>;

export interface MixStyleDef {
  id: string;
  label: string;
  emoji: string;
  /** Une phrase pour l'artiste. */
  description: string;
  dims: Dims;
  /** Mots qui l'appellent dans une phrase libre (texte sans accents, minuscules). */
  words: RegExp;
  /** Style « correctif » : ajouté par-dessus le mix existant, sans le remplacer. */
  tweak?: boolean;
  /** Vitesse d'autotune proposée (0 robot … 0,45 naturel), si le style en veut. */
  tuneSpeed?: number;
}

export const MIX_STYLES: MixStyleDef[] = [
  { id: 'neutre', label: 'Neutre / naturel', emoji: '🎙️', description: 'Voix propre et naturelle, compression légère, presque pas d’effets.',
    dims: { clean: 0.6, compression: 0.45, air: 0.3, deess: 0.5, space: 0.12 }, words: /\b(neutre|naturel\w*|propre|simple|clean|sobre|transparent)\b/ },
  { id: 'spatial', label: 'Spatial / aérien', emoji: '🌌', description: 'Grande reverb aérée, un peu de délai, voix large et brillante.',
    dims: { space: 0.85, delay: 0.3, width: 0.6, air: 0.6, clean: 0.4, compression: 0.5, deess: 0.5 }, words: /\b(spatia\w*|aerien\w*|espace|ambian\w*|large|reverb\w*|planant\w*|atmospher\w*)\b/ },
  { id: 'sature', label: 'Saturé / chaud', emoji: '🔥', description: 'Saturation à lampe ou à bande, voix épaisse et chaude.',
    dims: { saturation: 0.8, warmth: 0.6, compression: 0.6, clean: 0.4, deess: 0.5 }, words: /\b(satur\w*|chaud\w*|sale|grain\w*|crunch\w*|distor\w*|epais\w*|analogique)\b/ },
  { id: 'delais', label: 'Délais marqués', emoji: '🔁', description: 'Échos bien présents, calés sur le tempo.',
    dims: { delay: 0.85, space: 0.2, clean: 0.4, compression: 0.5 }, words: /\b(delays?|delai\w*|echo\w*|repetition\w*)\b/ },
  { id: 'trap', label: 'Trap moderne', emoji: '🤖', description: 'Autotune serré, voix brillante et compressée, délais et reverb.',
    dims: { tune: 1, compression: 0.7, air: 0.7, presence: 0.4, delay: 0.5, space: 0.4, saturation: 0.3, deess: 0.6, clean: 0.5 }, words: /\b(trap|melodique|cloud|rage|plugg)\b/, tuneSpeed: 0 },
  { id: 'drill', label: 'Drill', emoji: '🔪', description: 'Voix sombre, compressée et saturée, autotune discret.',
    dims: { tune: 0.4, compression: 0.8, saturation: 0.55, dark: 0.4, delay: 0.4, space: 0.15, deess: 0.5, clean: 0.5 }, words: /\bdrill\b/, tuneSpeed: 0.25 },
  { id: 'rnb', label: 'R&B doux', emoji: '🎶', description: 'Justesse naturelle, voix douce et large, reverb aérée.',
    dims: { tune: 0.5, compression: 0.5, air: 0.6, space: 0.7, delay: 0.3, width: 0.5, warmth: 0.3, deess: 0.6, clean: 0.5 }, words: /\b(r ?n ?b|rnb|r&b|doux|douce|soul|chante\w*|smooth|love)\b/, tuneSpeed: 0.35 },
  { id: 'lofi', label: 'Lo-fi', emoji: '📼', description: 'Couleur cassette, aigus adoucis, un peu de souffle.',
    dims: { lofi: 0.9, saturation: 0.5, dark: 0.6, space: 0.3, compression: 0.5 }, words: /\b(lo ?fi|vintage|cassette|vieux|old school|retro)\b/ },
  { id: 'radio', label: 'Radio / téléphone', emoji: '📞', description: 'Bande étroite façon radio ou téléphone, compressée et saturée.',
    dims: { radio: 1, saturation: 0.4, compression: 0.8 }, words: /\b(radio|telephone|tel|megaphone|talkie)\b/ },
  { id: 'pro', label: 'Plus pro', emoji: '⭐', description: 'Voix nette, tenue et devant : nettoyage, deux compresseurs, de-esser, présence et air.',
    dims: { clean: 0.8, compression: 0.65, deess: 0.7, presence: 0.5, air: 0.5, space: 0.25 }, words: /\b(pro|professionnel\w*|studio|propre et fort|radio ready|qualite)\b/, tweak: true },
  { id: 'air', label: 'Plus d’air', emoji: '🌬️', description: 'Aigus soyeux au-dessus de 10 kHz.', dims: { air: 0.9, deess: 0.55 }, words: /\b(air|aere\w*|brillan\w*|ouvert\w*|clair\w*)\b/, tweak: true },
  { id: 'sifflantes', label: 'Moins de sifflantes', emoji: '🐍', description: 'De-esser plus présent sur les « s » et les « ch ».', dims: { deess: 0.95 }, words: /\b(sifflant\w*|siffle\w*|sibilan\w*|les s\b|des s\b|les ch\b|agress\w*)\b/, tweak: true },
  { id: 'compression', label: 'Compression', emoji: '🗜️', description: 'Voix tenue : un compresseur à la prise et un autre (d’un autre type) sur le bus voix, ratio 2:1.', dims: { compression: 0.6 }, words: /\b(compress\w*|comp)\b/, tweak: true },
  { id: 'sombre', label: 'Plus sombre', emoji: '🌑', description: 'Aigus adoucis, voix plus feutrée.', dims: { dark: 0.7, warmth: 0.4 }, words: /\b(sombre|feutre\w*|mat\b|doux en haut|moins brillant)\b/, tweak: true },
];

export const findMixStyle = (id: string) => MIX_STYLES.find(s => s.id === id);

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'-]/g, ' ').replace(/\s+/g, ' ').trim();

export interface MixIntent {
  styles: { id: string; intensity: number }[];
  dims: Dims;
  /** Rien de reconnu : proposer des styles. */
  unknown: boolean;
  /** Ne touche qu'à un aspect (« plus d'air ») : ne remplace pas le reste. */
  tweakOnly: boolean;
  tuneSpeed?: number;
}

/** Intensité lue autour du mot du style : « beaucoup de », « très », « un peu »… */
const intensityNear = (msg: string, index: number): number => {
  const before = msg.slice(Math.max(0, index - 28), index);
  if (/(beaucoup|tres|max\w*|enorme\w*|grave|fort\w*|plein|a fond|bien|vraiment|super|hyper)\s*(de |d |du |des )?(l )?$/.test(before)) return 1;
  if (/(un peu|leger\w*|subtil\w*|legerement|discret\w*|peu de|une touche de|un poil)\s*(de |d |du |des )?(l )?$/.test(before)) return 0.4;
  if (/(moins|pas trop)\s*(de |d )?$/.test(before)) return 0.3;
  return 0.7;
};

/** Phrase libre → combinaison de styles et dimensions (0–1). */
export const parseMixIntent = (raw: string): MixIntent => {
  const msg = norm(raw);
  const styles: { id: string; intensity: number }[] = [];
  for (const s of MIX_STYLES) {
    const m = s.words.exec(msg);
    if (!m) continue;
    // « moins de sifflantes » = plus de de-esser ; « moins d'air » = plus sombre.
    if (s.id === 'air' && /\bmoins (d |de )?air\b/.test(msg)) { styles.push({ id: 'sombre', intensity: 0.7 }); continue; }
    const k = s.id === 'sifflantes' ? Math.max(0.7, intensityNear(msg, m.index)) : intensityNear(msg, m.index);
    styles.push({ id: s.id, intensity: k });
  }
  // « pro » ne doit pas prendre « produit », « prod » : déjà évité par \b. « studio » seul n'est pas « pro ».
  const dims: Dims = {};
  for (const { id, intensity } of styles) {
    const def = findMixStyle(id)!;
    for (const [d, v] of Object.entries(def.dims) as [MixDim, number][]) {
      // Combinaison : la plus forte demande l'emporte, une 2e demande ajoute un peu.
      const cur = dims[d] ?? 0;
      const add = v * intensity;
      dims[d] = Math.min(1, Math.max(cur, add) + Math.min(cur, add) * 0.25);
    }
  }
  const tuneSpeed = styles.map(s => findMixStyle(s.id)!.tuneSpeed).find(x => typeof x === 'number');
  return {
    styles, dims, unknown: styles.length === 0,
    tweakOnly: styles.length > 0 && styles.every(s => findMixStyle(s.id)!.tweak),
    tuneSpeed,
  };
};

/** 2 ou 3 styles à proposer quand l'artiste ne sait pas (d'après le genre / le tempo du beat). */
export const suggestStyles = (genre?: string | null, bpm?: number): MixStyleDef[] => {
  const g = norm(`${genre || ''}`);
  const ids = /drill/.test(g) ? ['drill', 'sature', 'neutre']
    : /r ?n ?b|soul|love|afro|pop/.test(g) ? ['rnb', 'spatial', 'neutre']
      : /boom ?bap|old|lofi|jazz/.test(g) ? ['lofi', 'neutre', 'sature']
        : (bpm || 0) >= 125 || /trap|cloud/.test(g) ? ['trap', 'spatial', 'neutre']
          : ['neutre', 'trap', 'spatial'];
  return ids.map(id => findMixStyle(id)!);
};

/** « spatial (fort) + saturé + délais » pour l'explication. */
export const describeIntent = (it: MixIntent): string =>
  it.styles.map(s => {
    const d = findMixStyle(s.id)!;
    const k = s.intensity >= 0.95 ? ' (fort)' : s.intensity <= 0.45 ? ' (léger)' : '';
    return `${d.label.toLowerCase()}${k}`;
  }).join(' + ');
