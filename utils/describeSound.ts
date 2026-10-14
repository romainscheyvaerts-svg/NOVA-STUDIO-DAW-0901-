/**
 * Lot 8b — « Décris ton son » : une phrase de l'artiste (« voix plus brillante et plus en
 * avant avec un peu d'écho ») devient une chaîne d'effets NOVA, SANS IA : une table de
 * correspondance déterministe relie des mots (styles, rôles, adjectifs, effets) à un preset
 * de la bibliothèque (utils/voicePresets) et aux macros du One Knob (utils/oneKnob).
 * Même phrase = même chaîne, toujours. Table documentée dans RAPPORT.md (lot 8b), testée
 * par tests/describeSound.test.ts.
 *
 * Lecture de la phrase :
 *  1. minuscules, accents retirés, apostrophes et tirets → espaces, expressions de
 *     plusieurs mots soudées (« en avant » → « enavant », « boom bap » → « boombap ») ;
 *  2. chaque mot reconnu prend l'intensité du modificateur qui le précède (3 mots au plus) :
 *     « un peu / légèrement / une touche » 30 %, rien 50 %, « plus / bien / assez » 60 %,
 *     « très / beaucoup / vraiment / à fond » 90 % ; « moins / pas trop / sans » = l'inverse
 *     (la macro à 0 et la macro opposée à 60 % de l'intensité, quand il y en a une) ;
 *  3. style (« trap », « drill », « R&B »…) et rôle (« back », « ad-lib »…) choisissent le preset ;
 *     sans style, le preset de la piste est gardé (sinon celui du rôle, en trap) ;
 *  4. « écho / délai » règle l'envoi d'écho seul ; « sec » coupe les réverbes.
 * Les mots non compris sont rendus (l'interface les montre : rien n'est inventé).
 *
 * Fonction simple pour le chat (Nova ingé son) : `decrireTonSon(texte, contexte)`.
 */
import type { OneKnobMacro, Track } from '../types';
import { applyOneKnob, macroDef, type OneKnobOptions } from './oneKnob';
import {
  applyVoicePreset, findVoicePreset, roleFromTrackName, ROLE_NAMES, SEND_IDS, voicePresetsFor,
  type ApplyVoicePresetOptions, type VoicePreset, type VoicePresetRole, type VoicePresetStyle,
} from './voicePresets';

export const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/œ/g, 'oe').replace(/[’'`´-]/g, ' ').replace(/&/g, ' and ');

/** Expressions de plusieurs mots, soudées avant la lecture (ordre : les plus longues d'abord). */
const PHRASES: [RegExp, string][] = [
  [/\bvoix off\b/g, 'voixoff'], [/\ben avant\b/g, 'enavant'], [/\bau fond\b/g, 'aufond'], [/\ba fond\b/g, 'afond'],
  [/\bboom bap\b/g, 'boombap'], [/\bold school\b/g, 'oldschool'], [/\bhard tune\b/g, 'hardtune'], [/\bauto tune\b/g, 'autotune'],
  [/\bt pain\b/g, 'tpain'], [/\bad libs?\b/g, 'adlib'], [/\bbaby voice\b/g, 'babyvoice'], [/\bvoix de bebe\b/g, 'babyvoice'],
  [/\boctave (en )?dessous\b/g, 'octavedessous'], [/\bun peu\b/g, 'unpeu'], [/\bun brin\b/g, 'unpeu'], [/\bune touche\b/g, 'unpeu'],
  [/\bun soupcon\b/g, 'unpeu'], [/\bpas trop\b/g, 'pastrop'], [/\bmoins de\b/g, 'moins'], [/\bplus de\b/g, 'plus'],
  [/\br and b\b/g, 'rnb'], [/\br n b\b/g, 'rnb'], [/\blo fi\b/g, 'lofi'], [/\bpas de\b/g, 'sans'],
];

/** Mots soudés, tels qu'on les montre à l'artiste. */
const DISPLAY: Record<string, string> = {
  voixoff: 'voix off', enavant: 'en avant', aufond: 'au fond', afond: 'à fond', boombap: 'boom bap', oldschool: 'old school',
  hardtune: 'hard tune', tpain: 'T-Pain', adlib: 'ad-lib', babyvoice: 'baby voice', octavedessous: 'octave dessous', unpeu: 'un peu',
  pastrop: 'pas trop', rnb: 'R&B', lofi: 'lo-fi',
};

/** Intensités des modificateurs. */
const MODIFIERS: Record<string, number> = {
  unpeu: 0.3, legerement: 0.3, leger: 0.3, legere: 0.3, discret: 0.3, discrete: 0.3, subtil: 0.3, subtile: 0.3, doucement: 0.3,
  plus: 0.6, bien: 0.6, assez: 0.6, davantage: 0.6,
  tres: 0.9, beaucoup: 0.9, vraiment: 0.9, super: 0.9, hyper: 0.9, afond: 0.9, max: 0.9, enormement: 0.9, carrement: 0.9, grave: 0.9,
};
const NEGATORS = new Set(['moins', 'pastrop', 'sans', 'pas']);
export const DEFAULT_INTENSITY = 0.5;

type Entry =
  | { kind: 'macro'; macro: OneKnobMacro; meaning: string }
  | { kind: 'style'; style: VoicePresetStyle; meaning: string }
  | { kind: 'role'; role: VoicePresetRole; meaning: string }
  | { kind: 'preset'; preset: string; meaning: string }
  | { kind: 'echo'; meaning: string }
  | { kind: 'dry'; meaning: string };

const M = (macro: OneKnobMacro, meaning: string): Entry => ({ kind: 'macro', macro, meaning });
const S = (style: VoicePresetStyle, meaning: string): Entry => ({ kind: 'style', style, meaning });
const R = (role: VoicePresetRole, meaning: string): Entry => ({ kind: 'role', role, meaning });
const P = (preset: string, meaning: string): Entry => ({ kind: 'preset', preset, meaning });

/**
 * TABLE DE CORRESPONDANCE (mot normalisé → sens). Les formes au féminin et au pluriel
 * sont listées (pas de racinisation approximative : une table lisible et testée).
 */
export const LEXICON: Record<string, Entry> = {};
const add = (words: string, e: Entry) => words.split(/\s+/).forEach(w => { LEXICON[w] = e; });
// Macros
add('devant enavant present presente presence proche intelligible articule articulee net nette percant percante', M('presence', 'voix plus en avant'));
add('brillant brillante brillants brillance clair claire aerien aerienne air aigus aigu cristallin cristalline lumineux lumineuse ouvert ouverte', M('brillance', 'plus de brillance et d’air'));
add('chaud chaude chaleur chaleureux chaleureuse rond ronde doux douce douceur veloute veloutee epais epaisse corps plein pleine moelleux', M('chaleur', 'plus chaude et ronde'));
add('compresse compressee compresses compression tenu tenue dense regulier reguliere constant constante serre serree punchy pechu percutant percutante controle controlee', M('compression', 'plus compressée, plus tenue'));
add('reverbe reverb reverbere reverberee espace spacieux spacieuse ample aere aeree hall salle eglise cathedrale profondeur profond profonde lointain lointaine loin aufond', M('espace', 'plus d’espace (réverbe et écho en envoi)'));
add('autotune autotunee autotune tune tunee justesse juste accorde accordee corrige corrigee', M('autotune', 'justesse corrigée (Nova Tune)'));
add('large larges stereo wide elargi elargie spatialise ecarte ecartee', M('largeur', 'plus large (doubleur)'));
add('sature saturee saturation sale grain granuleux granuleuse crade disto distordu distordue distorsion agressif agressive rugueux rugueuse vener venere enerve enervee', M('saturation', 'plus de grain (saturation)'));
// Effets et cas particuliers
add('echo echos delai delay delais repetition repetitions', { kind: 'echo', meaning: 'écho en envoi' });
add('sec seche dry mat mate', { kind: 'dry', meaning: 'voix sèche (réverbes coupées)' });
// Styles
add('trap', S('trap', 'style trap'));
add('drill', S('drill', 'style drill'));
add('conscient consciente boombap oldschool lyrical texte', S('conscient', 'rap conscient / boom bap'));
add('rnb soul', S('rnb', 'R&B doux'));
add('afro afrobeat afrobeats afroswing amapiano dancehall zouk kompa', S('afro', 'style afro'));
add('pop', S('pop', 'style pop'));
add('melodique chante chantee future cloud', S('melodique', 'rap mélodique'));
add('lofi cassette vinyle vintage', S('lofi', 'voix lo-fi'));
add('telephone combine', S('telephone', 'effet téléphone'));
add('podcast parle parlee voixoff narration interview', S('podcast', 'voix parlée'));
// Presets précis
add('robot tpain hardtune', P('autotune-robot', 'autotune robot'));
add('travis', P('autotune-travis', 'autotune sombre (Travis)'));
add('rage carti babyvoice', P('rage-lead', 'rage / baby voice'));
add('radio talkie', P('radio-lead', 'radio AM'));
add('octavedessous', P('double-octave', 'octave dessous'));
add('demon monstre', P('adlib-grave', 'voix grave (démon)'));
add('quinte', P('adlib-quinte', 'ad-libs à la quinte'));
// Rôles
add('lead principale principal couplet', R('lead', 'voix lead'));
add('back backs choeur choeurs backing', R('back', 'backs'));
add('double doubles doublage', R('double', 'doubles'));
add('adlib adlibs', R('adlib', 'ad-libs'));
add('harmonie harmonies harmo harmos', R('harmony', 'harmonies'));

/** Macro opposée (pour « moins … »). */
export const OPPOSITE: Partial<Record<OneKnobMacro, OneKnobMacro>> = {
  brillance: 'chaleur', chaleur: 'brillance', espace: 'presence', presence: 'espace',
};

/** Mots vides (ni compris, ni signalés). */
const STOP = new Set(('je veux voudrais ma mon mes ta ton tes sa son ses la le les l un une des de du d et ou avec mais plus moins '
  + 'voix son sonne sonner rend rends rendre mets met mettre fais fait faire donne donner qui que quoi sur dans pour par en au aux a '
  + 'c est ce cette ca cela comme style genre type effet effets un peu bit tres trop piste pistes truc chose me moi stp svp please y '
  + 'aussi encore tout toute tous toutes peu jamais quand vers etre avoir ai as se s n ne').split(/\s+/));

export interface DescribedSound {
  /** Phrase d'origine. */
  text: string;
  /** Preset choisi (null : garder la chaîne de la piste). */
  presetId: string | null;
  style: VoicePresetStyle | null;
  role: VoicePresetRole | null;
  /** Position de chaque macro demandée (0-1). */
  macros: Partial<Record<OneKnobMacro, number>>;
  /** Envoi d'écho ajouté (gain linéaire) ; réverbes coupées. */
  echo: number;
  dry: boolean;
  /** Mots compris (dans l'ordre) et ce qu'ils font. */
  matched: { word: string; meaning: string; amount?: number; negated?: boolean }[];
  /** Mots non compris (hors mots vides). */
  ignored: string[];
  /** Résumé lisible (« Trap lead · Brillance 60 % · Présence 60 % · écho +0,05 »). */
  summary: string;
}

export interface DescribeContext {
  /** Rôle de la piste visée (sinon déduit de la phrase, sinon lead). */
  role?: VoicePresetRole | null;
  /** Preset déjà posé sur la piste. */
  currentPresetId?: string | null;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/** Lit une phrase et renvoie le preset et les réglages correspondants (déterministe, sans IA). */
export function describeSound(text: string, ctx: DescribeContext = {}): DescribedSound {
  let t = ` ${norm(text)} `.replace(/[^a-z0-9 ]+/g, ' ');
  for (const [re, w] of PHRASES) t = t.replace(re, w);
  const tokens = t.split(/\s+/).filter(Boolean);
  // Mot d'origine (accents compris) pour l'affichage : « écho » plutôt que « echo ».
  const orig: Record<string, string> = {};
  for (const w of (text || '').toLowerCase().split(/[^\p{L}\p{N}&]+/u)) if (w) { const k = norm(w).replace(/[^a-z0-9]+/g, ''); if (k && !orig[k]) orig[k] = w; }
  const shown = (tok: string) => DISPLAY[tok] || orig[tok] || tok;
  const out: DescribedSound = { text, presetId: null, style: null, role: null, macros: {}, echo: 0, dry: false, matched: [], ignored: [], summary: '' };
  let preset: string | null = null;
  let pendingAmount: number | null = null, pendingNeg = false, pendingAge = 99;
  for (const tok of tokens) {
    pendingAge++;
    if (pendingAge > 3) { pendingAmount = null; pendingNeg = false; }
    if (tok in MODIFIERS) { pendingAmount = Math.max(pendingAmount ?? 0, MODIFIERS[tok]); pendingAge = 0; if (tok === 'plus') pendingNeg = false; continue; }
    if (NEGATORS.has(tok)) { pendingNeg = true; pendingAge = 0; continue; }
    const e = LEXICON[tok];
    if (!e) { if (!STOP.has(tok) && tok.length > 1 && !/^\d+$/.test(tok)) out.ignored.push(shown(tok)); continue; }
    const amount = pendingAmount ?? DEFAULT_INTENSITY;
    const neg = pendingNeg;
    switch (e.kind) {
      case 'macro': {
        if (neg) {
          out.macros[e.macro] = 0;
          const opp = OPPOSITE[e.macro];
          if (opp) out.macros[opp] = Math.max(out.macros[opp] || 0, Math.round(amount * 0.6 * 100) / 100);
          if (e.macro === 'espace') out.dry = amount >= 0.6 || out.dry;
          out.matched.push({ word: shown(tok), meaning: `moins : ${macroDef(e.macro).name.toLowerCase()}`, amount: 0, negated: true });
        } else {
          out.macros[e.macro] = Math.max(out.macros[e.macro] || 0, amount);
          out.matched.push({ word: shown(tok), meaning: e.meaning, amount });
        }
        break;
      }
      case 'echo':
        if (neg) { out.echo = -1; out.matched.push({ word: shown(tok), meaning: 'sans écho', negated: true }); }
        else { out.echo = Math.max(out.echo, Math.round(amount * 0.3 * 1000) / 1000); out.matched.push({ word: shown(tok), meaning: e.meaning, amount }); }
        break;
      case 'dry':
        out.dry = true; out.macros.espace = 0; out.matched.push({ word: shown(tok), meaning: e.meaning });
        break;
      case 'style': if (!neg) { out.style = e.style; out.matched.push({ word: shown(tok), meaning: e.meaning }); } break;
      case 'role': if (!neg) { out.role = e.role; out.matched.push({ word: shown(tok), meaning: e.meaning }); } break;
      case 'preset': if (!neg) { preset = e.preset; out.matched.push({ word: shown(tok), meaning: e.meaning }); } break;
    }
    pendingAmount = null; pendingNeg = false;
  }
  // Choix du preset : preset précis > style + rôle > preset de la piste (sans style) > rôle (trap).
  const role: VoicePresetRole = out.role || ctx.role || (preset ? findVoicePreset(preset)!.role : 'lead');
  if (preset) {
    const p = findVoicePreset(preset)!;
    // « robot » sur des ad-libs : l'ad-lib trap (autotune instantané) plutôt que le lead robot.
    out.presetId = p.role === role || p.role === 'lead' && role === 'lead' ? p.id : (pickPreset(p.style, role)?.id || p.id);
  } else if (out.style) {
    out.presetId = pickPreset(out.style, role)?.id || null;
  } else if (!ctx.currentPresetId) {
    out.presetId = pickPreset('trap', role)?.id || 'trap-lead';
  } else if (out.role && findVoicePreset(ctx.currentPresetId)?.role !== out.role) {
    const cur = findVoicePreset(ctx.currentPresetId);
    out.presetId = pickPreset(cur?.style || 'trap', role)?.id || null;
  }
  if (out.presetId) { const p = findVoicePreset(out.presetId)!; out.style = out.style || p.style; }
  out.role = role;
  out.summary = summarize(out, ctx);
  return out;
}

/** Preset d'un style pour un rôle ; à défaut, le même rôle en trap, puis le lead du style. */
export function pickPreset(style: VoicePresetStyle, role: VoicePresetRole): VoicePreset | undefined {
  return voicePresetsFor({ style, role })[0] || voicePresetsFor({ style: 'trap', role })[0] || voicePresetsFor({ style, role: 'lead' })[0];
}

function summarize(d: DescribedSound, ctx: DescribeContext): string {
  const parts: string[] = [];
  const p = d.presetId ? findVoicePreset(d.presetId) : findVoicePreset(ctx.currentPresetId);
  if (d.presetId && p) parts.push(`preset « ${p.name} »`);
  else if (p) parts.push(`chaîne actuelle (« ${p.name} »)`);
  for (const [m, v] of Object.entries(d.macros)) parts.push(`${macroDef(m as OneKnobMacro).name} ${pct(v as number)}`);
  if (d.echo > 0) parts.push(`écho +${String(d.echo).replace('.', ',')}`);
  if (d.echo < 0) parts.push('écho coupé');
  if (d.dry) parts.push('réverbes coupées');
  return parts.join(' · ') || 'rien de reconnu';
}

export interface ApplyDescribedOptions extends ApplyVoicePresetOptions, OneKnobOptions {}

/**
 * Applique une description à une piste : preset (si la phrase en choisit un), puis les
 * macros du One Knob, puis l'écho et les réverbes. Pur : une seule modification de piste.
 */
export function applyDescribedSound(track: Track, d: DescribedSound, opts: ApplyDescribedOptions): { track: Track; notes: string[] } {
  let t = track;
  const notes: string[] = [];
  const returns = opts.returns || opts.allTracks.filter(x => Object.values(SEND_IDS).includes(x.id as any)).map(x => x.id);
  if (d.presetId) {
    const p = findVoicePreset(d.presetId)!;
    const r = applyVoicePreset(t, p, { ...opts, keepFader: !!track.voiceChain?.presetId && findVoicePreset(track.voiceChain.presetId)?.role === p.role });
    t = r.track; notes.push(...r.notes);
  }
  let last: OneKnobMacro | null = null;
  for (const [m, v] of Object.entries(d.macros)) {
    t = applyOneKnob(t, m as OneKnobMacro, v as number, { ...opts, returns }).track;
    last = m as OneKnobMacro;
  }
  if (last) t = { ...t, voiceChain: { ...(t.voiceChain || {}), macro: last } };
  if (d.echo !== 0 || d.dry) {
    const sends = (t.sends || []).map(s => ({ ...s }));
    const setSend = (id: string, fn: (v: number) => number) => {
      const s = sends.find(x => x.id === id);
      if (s) { s.level = Math.max(0, Math.min(1, Math.round(fn(s.level) * 1000) / 1000)); if (s.level > 0) s.isEnabled = true; }
      else if (returns.includes(id)) { const v = Math.max(0, Math.min(1, fn(0))); if (v > 0) sends.push({ id, level: Math.round(v * 1000) / 1000, isEnabled: true }); }
    };
    if (d.echo > 0) setSend(SEND_IDS.delay, v => v + d.echo);
    if (d.echo < 0) setSend(SEND_IDS.delay, () => 0);
    if (d.dry) { setSend(SEND_IDS.verbShort, () => 0); setSend(SEND_IDS.verbLong, () => 0); }
    t = { ...t, sends };
  }
  return { track: t, notes };
}

/**
 * Fonction simple pour le chat : lit la phrase pour une piste et renvoie la piste
 * modifiée + une phrase de compte rendu. `track` absente : seulement la lecture.
 */
export function decrireTonSon(texte: string, track?: Track | null, opts?: ApplyDescribedOptions): { description: DescribedSound; track?: Track; compteRendu: string } {
  const role = track ? (findVoicePreset(track.voiceChain?.presetId)?.role || roleFromTrackName(track.name)) : null;
  const description = describeSound(texte, { role, currentPresetId: track?.voiceChain?.presetId || null });
  const nothing = !description.matched.length;
  if (!track || !opts || nothing) {
    return { description, compteRendu: nothing ? `Je n'ai reconnu aucun mot de son dans « ${texte} » (essaie : brillante, chaude, en avant, compressée, écho, réverbe, large, saturée, autotune, trap, R&B…).` : description.summary };
  }
  const r = applyDescribedSound(track, description, opts);
  const extra = description.ignored.length ? ` (mots non pris en compte : ${description.ignored.slice(0, 6).join(', ')})` : '';
  return { description, track: r.track, compteRendu: `${track.name} (${ROLE_NAMES[description.role || 'lead'].toLowerCase()}) : ${description.summary}${extra}.${r.notes.length ? ` ${r.notes.join(' ; ')}.` : ''}` };
}
