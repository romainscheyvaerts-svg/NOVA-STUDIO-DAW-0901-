/**
 * Choix de l'autotune (celui du PC via le pont VST, ou celui de NOVA) et état
 * en direct de chaque autotune de piste (pour le badge « Auto-Tune Pro · F# mineur »).
 *
 * - Le choix est fait UNE fois (fenêtre AutotuneChoiceModal), mémorisé dans ce
 *   navigateur / cette appli (localStorage), modifiable dans l'onglet VST.
 * - Ordre de préférence (Romain) : Antares Auto-Tune Pro, puis les autres Antares,
 *   Slate MetaTune, Waves Tune, les autres ; l'autotune de NOVA en dernier recours.
 * - Un plugin qui demande une licence, est en démo ou plante est noté
 *   « non disponible » (sans fenêtre) : NOVA passe au suivant, sinon à son autotune.
 * - Qualité : « faible latence » par défaut (réglage de Romain), ou « qualité maximale ».
 */
import {
  AutotuneCandidate, DEFAULT_EXCLUSIONS, ExclusionList, detectAutotunes, ScannedPlugin,
} from '../utils/autotuneVst';

export type AutotuneQuality = 'low-latency' | 'max-quality';

export interface AutotuneChoice {
  /** 'vst' : un autotune du PC ; 'nova' : celui de NOVA (choix explicite). */
  mode: 'vst' | 'nova';
  key?: string;
  name?: string;
  vendor?: string;
  decidedAt: number;
}

export interface AutotunePrefs {
  choice: AutotuneChoice | null;
  quality: AutotuneQuality;
  exclusions: ExclusionList;
  /** Plugins notés « non disponibles » (clé → raison), jamais rechargés tout seuls. */
  unavailable: Record<string, string>;
}

const LS_KEY = 'nova.autotuneVst.v1';

const defaults = (): AutotunePrefs => ({
  choice: null, quality: 'low-latency',
  exclusions: { vendors: [...DEFAULT_EXCLUSIONS.vendors], plugins: [...DEFAULT_EXCLUSIONS.plugins], allow: [...DEFAULT_EXCLUSIONS.allow] },
  unavailable: {},
});

const load = (): AutotunePrefs => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return defaults();
    const p = JSON.parse(raw);
    const d = defaults();
    return {
      choice: p.choice && (p.choice.mode === 'vst' || p.choice.mode === 'nova') ? p.choice : null,
      quality: p.quality === 'max-quality' ? 'max-quality' : 'low-latency',
      exclusions: p.exclusions && Array.isArray(p.exclusions.vendors) ? {
        vendors: p.exclusions.vendors.map(String), plugins: (p.exclusions.plugins || []).map(String), allow: (p.exclusions.allow || []).map(String),
      } : d.exclusions,
      unavailable: p.unavailable && typeof p.unavailable === 'object' ? p.unavailable : {},
    };
  } catch {
    return defaults();
  }
};

let prefs: AutotunePrefs = load();
let scanned: ScannedPlugin[] = [];
let detected: AutotuneCandidate[] = [];
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(cb => { try { cb(); } catch { /* écouteur fautif */ } });
const save = () => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch { /* stockage indisponible : choix gardé pour la session */ }
};

const redetect = () => {
  detected = detectAutotunes(scanned, { exclusions: prefs.exclusions, unavailable: prefs.unavailable });
};

export const autotunePrefs = {
  get: (): AutotunePrefs => prefs,
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },

  /** Liste des plugins du pont (à chaque connexion / nouvelle lecture). */
  setScanned(list: ScannedPlugin[]) { scanned = list || []; redetect(); emit(); },
  detected: (): AutotuneCandidate[] => detected,
  hasScan: () => scanned.length > 0,

  setChoice(c: AutotuneChoice | null) { prefs = { ...prefs, choice: c }; save(); emit(); },
  setQuality(q: AutotuneQuality) { prefs = { ...prefs, quality: q }; save(); emit(); },
  setExclusions(ex: ExclusionList) { prefs = { ...prefs, exclusions: ex }; save(); redetect(); emit(); },

  /** Plugin inutilisable (licence, démo, plantage, gamme non réglable) : NOVA passe au suivant. */
  markUnavailable(key: string, reason: string) {
    if (prefs.unavailable[key] === reason) return;
    prefs = { ...prefs, unavailable: { ...prefs.unavailable, [key]: reason } };
    save(); redetect(); emit();
  },
  /** « Réessayer » : le plugin est de nouveau proposé (après activation de sa licence). */
  clearUnavailable(key?: string) {
    const u = { ...prefs.unavailable };
    if (key) delete u[key]; else Object.keys(u).forEach(k => delete u[k]);
    prefs = { ...prefs, unavailable: u };
    save(); redetect(); emit();
  },

  /** Faut-il poser la question ? (pont connecté, au moins un autotune, pas encore de choix) */
  needsChoice: (): boolean => prefs.choice === null && detected.some(c => !c.unavailable && c.followsKey),

  /** Tests : repartir de zéro. */
  _reset() { prefs = defaults(); scanned = []; detected = []; save(); emit(); },
};

/**
 * Autotune du PC à utiliser maintenant : celui choisi s'il est disponible, sinon le
 * suivant dans l'ordre de préférence (bascule automatique, ex. Auto-Tune Pro sans
 * licence → MetaTune). null : autotune de NOVA (choix « NOVA », aucun autotune,
 * pas encore de choix).
 */
export const effectiveAutotune = (): AutotuneCandidate | null => {
  const c = prefs.choice;
  if (!c || c.mode !== 'vst') return null;
  const usable = detected.filter(x => !x.unavailable && x.followsKey);
  return usable.find(x => x.key === c.key) || usable.find(x => x.name === c.name && x.vendor === c.vendor) || usable[0] || null;
};

// ─── État en direct (badge des pistes voix) ───────────────────────────────────

export interface AutotuneLiveInfo {
  /** Moteur qui traite le son en ce moment. */
  engine: 'vst' | 'nova';
  /** Nom et éditeur du plugin du PC prévu (même si NOVA a repris la main). */
  pluginName: string | null;
  vendor: string | null;
  /** « F# mineur » */
  keyText: string;
  /** Pourquoi NOVA traite le son à la place du plugin (null si le plugin traite). */
  fallback: string | null;
  /** En cours de chargement / réglage. */
  loading: boolean;
  latencyMs: number;
}

const live = new Map<string, AutotuneLiveInfo>();
const liveListeners = new Set<() => void>();

export const autotuneLive = {
  get: (pluginId: string) => live.get(pluginId) || null,
  set(pluginId: string, info: AutotuneLiveInfo | null) {
    if (info) live.set(pluginId, info); else live.delete(pluginId);
    liveListeners.forEach(cb => { try { cb(); } catch { /* */ } });
  },
  subscribe(cb: () => void) { liveListeners.add(cb); return () => { liveListeners.delete(cb); }; },
};

/** Cache des paramètres lus par plugin (chemin) : l'introspection n'est faite qu'une fois. */
export const paramCache = new Map<string, any[]>();
