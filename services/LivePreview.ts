import type { Clip, FreezeRef, Track } from '../types';
import { isTrackFrozen, isVst, lastVstIndex, pluginsSignature } from '../utils/freeze';

/**
 * Collaboration « En direct » : l'ingé ENTEND les VST du PC de l'artiste.
 *
 * Problème : l'ingé règle à distance un VST chargé sur le pont de l'artiste
 * (services/LiveVstRemote), mais lui n'a pas ce VST : chez lui la piste
 * passait sans effet (son « sec »).
 *
 * Solution (la plus fiable : elle réutilise le rendu hors temps réel du gel,
 * déjà éprouvé) :
 *  1. après un réglage à distance (ou un changement d'effets sur la piste),
 *     regroupé avec un délai d'~1 s, le pont de l'ARTISTE rend la piste sur
 *     une FENÊTRE du morceau (la boucle de l'ingé, sinon ~30 s autour de sa
 *     tête de lecture : un aperçu léger, ~5 Mo, plutôt que tout le morceau) ;
 *  2. le rendu part chez l'ingé (audio en morceaux SHA-1, opération
 *     « vst_preview ») ;
 *  3. chez l'ingé, il se pose sur la piste comme un rendu gelé ancré aux clips
 *     (la lecture suit les éditions de l'artiste) : il joue à la place du son
 *     sans VST. Hors de la fenêtre, la piste reste sans les VST de l'artiste.
 *
 * Un seul rendu à la fois par piste ; un réglage arrivé pendant un rendu en
 * relance un (le plus récent gagne). État clair chez l'ingé (« à jour »,
 * « en cours de calcul », pont de l'artiste qui ne répond pas → « Réessayer »).
 *
 * Opérations : vst_preview_get (ingé → artiste), vst_preview_state et
 * vst_preview (artiste → ingé). Ce module est pur (rendu, réseau injectés).
 */

export const LIVE_PREVIEW_KINDS = new Set(['vst_preview_get', 'vst_preview_state', 'vst_preview']);

export interface PreviewWindow { from: number; to: number }

/** Queue rendue après la fenêtre (effets d'insert : courte). */
export const PREVIEW_TAIL = 2;
/** Morceau court : rendu en entier. */
export const PREVIEW_FULL_UNDER = 45;
export const PREVIEW_SPAN = 30;
export const PREVIEW_MAX = 60;
/** Délai de regroupement des réglages avant un rendu. */
export const PREVIEW_DEBOUNCE_MS = 1000;
/** Sans aucune nouvelle de l'artiste : le pont ne répond pas. */
export const PREVIEW_TIMEOUT_MS = 45000;
/** Rendu commencé mais jamais arrivé (gros plugin, connexion lente). */
export const PREVIEW_RENDER_TIMEOUT_MS = 150000;

/** Piste dont un VST est hébergé chez l'artiste (chemin de plugin de son PC). */
export const hasArtistVst = (t: Track): boolean =>
  (t.plugins || []).some(p => isVst(p) && p.isEnabled && !!p.params?.localPath);

const trackEnd = (t: Track): number => (t.clips || []).reduce((m, c) => Math.max(m, c.start + c.duration), 0);

/**
 * Fenêtre d'aperçu : tout le morceau s'il est court ; sinon la boucle (si
 * elle est active et raisonnable), sinon ~30 s à partir de 2 s avant la tête
 * de lecture.
 */
export function previewWindow(o: { trackEnd: number; playhead: number; loop?: { start: number; end: number } | null }): PreviewWindow {
  const end = Math.max(0, o.trackEnd);
  if (end <= PREVIEW_FULL_UNDER) return { from: 0, to: end };
  if (o.loop && o.loop.end - o.loop.start >= 1) {
    const from = Math.max(0, Math.min(o.loop.start, end));
    const to = Math.min(end, from + Math.min(PREVIEW_MAX, o.loop.end - from));
    if (to - from >= 1) return { from, to };
  }
  let from = Math.max(0, (o.playhead || 0) - 2);
  let to = Math.min(end, from + PREVIEW_SPAN);
  if (to - from < PREVIEW_SPAN) from = Math.max(0, to - PREVIEW_SPAN);
  to = Math.min(end, Math.max(to, from + 1));
  return { from, to };
}

export const previewWindowOf = (t: Track, playhead: number, loop?: { start: number; end: number } | null): PreviewWindow =>
  previewWindow({ trackEnd: trackEnd(t), playhead, loop });

/**
 * Ancrages des clips dans un rendu qui COMMENCE à win.from (temps du rendu =
 * temps du morceau − win.from). Seule la partie d'un clip dans la fenêtre est
 * ancrée ; le reste joue en direct (sans les VST de l'artiste).
 */
export function anchorClipsToWindow(clips: Clip[], renderId: string, win: PreviewWindow): Record<string, FreezeRef> {
  const out: Record<string, FreezeRef> = {};
  for (const c of clips) {
    if (!c.bufferId || c.isReversed || c.notes || c.isFreezeSlice || c.isMuted) continue;
    const off = c.offset || 0;
    const cs = c.start;
    const ce = c.start + c.duration;
    const a = Math.max(cs, win.from);
    const b = Math.min(ce, win.to);
    if (b - a <= 0.001) continue;
    const cutStart = a > cs + 1e-6;
    const cutEnd = b < ce - 1e-6;
    out[c.id] = {
      renderId,
      anchor: (cs - off) - win.from,
      from: off + (a - cs),
      to: off + (b - cs),
      // Coupé par la fenêtre : le fondu d'origine n'est pas dans le rendu à cet endroit.
      fadeIn: cutStart ? 0 : (c.fadeIn || 0),
      fadeOut: cutEnd ? 0 : (c.fadeOut || 0),
      gain: c.gain ?? 1,
      srcClipId: c.id,
    };
  }
  return out;
}

// --- Opérations -------------------------------------------------------------------------------

export interface PreviewPayload {
  trackId: string;
  /** Rendu (clip qui commence à 0 dans son propre son ; voir anchorClipsToWindow). */
  clip: Clip;
  upTo: number;
  refs: Record<string, FreezeRef>;
  win: PreviewWindow;
}

/**
 * Ingé : pose l'aperçu sur la piste (brouillon Immer). Ne touche jamais un gel
 * fait par l'ingé lui-même avec SES VST. Renvoie le son de l'aperçu précédent
 * (à libérer), ou null si rien n'a été posé.
 */
export function applyPreviewOnEngineer(t: Track, p: PreviewPayload, now = Date.now()): { released: string[] } | null {
  if (isTrackFrozen(t) && !t.livePreview) return null; // gel de l'ingé : prioritaire
  const released: string[] = [];
  if (t.livePreview && t.frozenClip?.bufferId && t.frozenClip.bufferId !== p.clip.bufferId) released.push(t.frozenClip.bufferId);
  const upTo = Math.min(Math.max(-1, Math.floor(p.upTo)), (t.plugins || []).length - 1);
  t.isFrozen = true;
  t.frozenClip = { ...p.clip };
  t.frozenUpToPluginIndex = upTo;
  t.frozenClipIds = Object.keys(p.refs);
  t.frozenPluginSig = pluginsSignature(t.plugins || [], upTo);
  delete t.frozenSourceSig;
  delete t.frozenAuto;
  t.clips = (t.clips || []).map(c => {
    const ref = p.refs[c.id];
    if (ref) return { ...c, freezeRef: { ...ref } };
    if (c.freezeRef) { const { freezeRef: _f, ...rest } = c; return rest as Clip; }
    return c;
  });
  t.livePreview = { renderId: p.clip.id, from: p.win.from, to: p.win.to, at: now };
  return { released };
}

/** Ingé : retire l'aperçu (fin de la collaboration). Renvoie le son à libérer. */
export function clearPreviewOnEngineer(t: Track): string | null {
  if (!t.livePreview) return null;
  const renderId = t.livePreview.renderId;
  const buf = t.frozenClip?.id === renderId ? t.frozenClip.bufferId || null : null;
  if (t.frozenClip?.id === renderId) {
    t.isFrozen = false;
    delete t.frozenClip; delete t.frozenUpToPluginIndex; delete t.frozenClipIds; delete t.frozenPluginSig; delete t.frozenSourceSig;
  }
  t.clips = (t.clips || []).map(c => {
    if (c.freezeRef?.renderId !== renderId) return c;
    const { freezeRef: _f, ...rest } = c;
    return rest as Clip;
  });
  delete t.livePreview;
  return buf;
}

/** Artiste : la piste a-t-elle des VST à rendre ? (index du dernier, sinon -1) */
export const previewUpTo = (t: Track): number => (hasArtistVst(t) ? lastVstIndex(t) : -1);

// --- Artiste : rendus regroupés, un à la fois ---------------------------------------------

type Timer = ReturnType<typeof setTimeout>;

export interface PreviewSchedulerDeps {
  /** Rend la piste sur la fenêtre, envoie l'aperçu. */
  run: (trackId: string, win: PreviewWindow | undefined) => Promise<void>;
  /** Raison d'attendre (« enregistrement en cours »…), ou null : on peut rendre. */
  blockedReason?: () => string | null;
  onState: (trackId: string, state: 'rendering' | 'waiting' | 'error', message?: string) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

/**
 * Artiste : demandes d'aperçu regroupées (délai ~1 s depuis le DERNIER
 * réglage), un seul rendu à la fois par piste ; une demande arrivée pendant
 * un rendu en relance un après (avec la fenêtre la plus récente).
 */
export class PreviewScheduler {
  private timers = new Map<string, Timer>();
  private wins = new Map<string, PreviewWindow | undefined>();
  private running = new Set<string>();
  private again = new Set<string>();
  private blocked = new Set<string>();
  private readonly delay: number;
  private readonly setT: (fn: () => void, ms: number) => Timer;
  private readonly clearT: (t: Timer) => void;

  constructor(private deps: PreviewSchedulerDeps) {
    this.delay = deps.delayMs ?? PREVIEW_DEBOUNCE_MS;
    this.setT = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearT = deps.clearTimer || ((t) => clearTimeout(t));
  }

  request(trackId: string, win?: PreviewWindow) {
    if (win) this.wins.set(trackId, win);
    else if (!this.wins.has(trackId)) this.wins.set(trackId, undefined);
    const old = this.timers.get(trackId);
    if (old) this.clearT(old);
    this.timers.set(trackId, this.setT(() => { this.timers.delete(trackId); void this.fire(trackId); }, this.delay));
  }

  /** Ce qui attendait (enregistrement terminé…) repart. */
  resume() {
    const ids = [...this.blocked];
    this.blocked.clear();
    ids.forEach(id => this.request(id));
  }

  isBusy(trackId: string) { return this.running.has(trackId) || this.timers.has(trackId); }

  dispose() {
    this.timers.forEach(t => this.clearT(t));
    this.timers.clear();
    this.blocked.clear();
    this.again.clear();
  }

  private async fire(trackId: string) {
    if (this.running.has(trackId)) { this.again.add(trackId); return; }
    const why = this.deps.blockedReason?.() || null;
    if (why) { this.blocked.add(trackId); this.deps.onState(trackId, 'waiting', why); return; }
    this.running.add(trackId);
    this.deps.onState(trackId, 'rendering');
    try {
      await this.deps.run(trackId, this.wins.get(trackId));
    } catch (e: any) {
      this.deps.onState(trackId, 'error', e?.message || 'Rendu impossible');
    } finally {
      this.running.delete(trackId);
      if (this.again.delete(trackId)) void this.fire(trackId);
    }
  }
}

// --- Ingé : état de l'aperçu, piste par piste ----------------------------------------------

export type PreviewCode = 'pending' | 'rendering' | 'ready' | 'waiting' | 'error';
export interface PreviewState { code: PreviewCode; since: number; message?: string; win?: PreviewWindow }

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface PreviewView { label: string; tone: 'ok' | 'busy' | 'warn' | 'error'; retry: boolean }

/** Ce que voit l'ingé pour une piste. */
export function previewView(s: PreviewState | undefined): PreviewView | null {
  if (!s) return null;
  const range = s.win ? ` (${fmt(s.win.from)} – ${fmt(s.win.to)})` : '';
  switch (s.code) {
    case 'pending':
      return { label: "Aperçu du son de l'artiste : en cours de calcul…", tone: 'busy', retry: false };
    case 'rendering':
      return { label: "Aperçu du son de l'artiste : en cours de calcul sur son PC…", tone: 'busy', retry: false };
    case 'ready':
      return { label: `Aperçu du son de l'artiste : à jour${range}. Hors de ce passage, la piste joue sans ses VST.`, tone: 'ok', retry: false };
    case 'waiting':
      return { label: `Aperçu en attente : ${s.message || "l'artiste est occupé"}. Il partira tout seul ensuite.`, tone: 'warn', retry: true };
    default:
      return { label: s.message || "Aperçu impossible pour l'instant.", tone: 'error', retry: true };
  }
}

export const NO_ANSWER = "Le pont VST de l'artiste ne répond pas : il doit garder NOVA Studio pour Windows ouvert. Tu entends la piste sans ses VST en attendant.";

/** Ingé : suivi des aperçus (minuteries d'attente comprises). */
export class PreviewTracker {
  private states = new Map<string, PreviewState>();
  constructor(private now: () => number = Date.now) {}

  get(trackId: string) { return this.states.get(trackId); }
  all(): Record<string, PreviewState> { return Object.fromEntries(this.states); }

  /** On vient de demander (ou de provoquer) un nouvel aperçu. */
  expect(trackId: string, win?: PreviewWindow) {
    const cur = this.states.get(trackId);
    const keepRendering = cur?.code === 'rendering';
    this.states.set(trackId, { code: keepRendering ? 'rendering' : 'pending', since: keepRendering ? cur!.since : this.now(), ...(win || cur?.win ? { win: win || cur!.win } : {}) });
  }

  /** Nouvelle de l'artiste (rendu commencé, en attente, erreur). */
  remote(trackId: string, code: 'rendering' | 'waiting' | 'error', message?: string) {
    const cur = this.states.get(trackId);
    this.states.set(trackId, { code, since: this.now(), ...(message ? { message } : {}), ...(cur?.win ? { win: cur.win } : {}) });
  }

  ready(trackId: string, win: PreviewWindow) {
    this.states.set(trackId, { code: 'ready', since: this.now(), win });
  }

  forget(trackId: string) { this.states.delete(trackId); }
  clear() { this.states.clear(); }

  /** Délais dépassés → erreur claire. Renvoie vrai si un état a changé. */
  tick(): boolean {
    let changed = false;
    const t = this.now();
    this.states.forEach((s, id) => {
      const late = (s.code === 'pending' && t - s.since > PREVIEW_TIMEOUT_MS) || (s.code === 'rendering' && t - s.since > PREVIEW_RENDER_TIMEOUT_MS);
      if (late) { this.states.set(id, { code: 'error', since: t, message: NO_ANSWER, ...(s.win ? { win: s.win } : {}) }); changed = true; }
    });
    return changed;
  }
}
