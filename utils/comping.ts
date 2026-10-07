import { Clip, CrossfadeCurve, TrackType } from '../types';
import { takeNumberOf } from './takes';

/**
 * Comping « à la souris » : Quick Swipe Comping de Logic, comping des
 * Playlists de Pro Tools. Logique pure, testée dans tests/comping.test.ts.
 *
 * Modèle : l'audio de chaque prise reste dans les clips de la piste (clips
 * portant `takeNumber`). Pour une prise, ses clips recollés forment des
 * « morceaux » (TakeSpan) : tout l'audio disponible dans son couloir. Le comp
 * est une suite de passages (CompSegment) : « de 4 s à 6 s, la prise 2 ».
 *
 * Comper = changer les passages, puis reconstruire les clips de prises :
 *   - dans chaque passage, la prise choisie est audible ;
 *   - partout ailleurs, ses clips restent là mais mutés (rien n'est effacé :
 *     le couloir garde la prise entière, on peut revenir dessus) ;
 *   - aux raccords entre deux prises, un crossfade à puissance égale centré
 *     sur la jonction (utils/fades : chevauchement + fondus complémentaires),
 *     sans jamais sortir de l'audio enregistré de chaque prise.
 * Les clips qui ne sont pas des prises (beat, voix importée) ne bougent pas.
 * Une seule mise à jour de la piste : une seule étape d'annulation.
 */

/** Crossfade posé aux raccords du comp (s). */
export const COMP_XFADE_SEC = 0.02;
/** Fondu anti-clic aux bords d'un passage sans voisin (s). */
export const COMP_EDGE_FADE = 0.005;
/** Plus petit passage gardé (s) : en dessous, un balayage est ignoré. */
export const MIN_COMP_SEC = 0.05;
const EPS = 1e-6;
/** Arrondi au nanoseconde : pas de 0,020000000000000018 dans le projet. */
const r9 = (x: number) => Math.round(x * 1e9) / 1e9;
/** Deux pièces d'une même prise plus proches que ça sont recollées (s). */
const JOIN_TOL = 0.002;

export interface TakeSpan {
  /** Identifiant stable du morceau (id de son premier clip). */
  key: string;
  n: number;
  start: number;
  end: number;
  /** Instant du projet où tombe l'offset 0 de l'audio (start − offset). */
  anchor: number;
  /** Clip modèle (bufferId, gain, nom, couleur…). */
  base: Clip;
  fadeIn: number;
  fadeOut: number;
  fadeInCurve?: CrossfadeCurve;
  fadeOutCurve?: CrossfadeCurve;
}

export interface CompSegment { start: number; end: number; n: number; span: string }

export interface CompOptions {
  /** Longueur des crossfades aux raccords (défaut 20 ms). */
  xfade?: number;
  curve?: CrossfadeCurve;
  /** Fabrique d'identifiants des nouveaux clips. */
  newId?: (base: string) => string;
}

const srcKey = (c: Clip) => c.bufferId || c.audioRef || c.id;
const endOf = (c: { start: number; duration: number }) => c.start + c.duration;

/** Clip audio de prise que le comp sait gérer (pas de MIDI, ni d'audio inversé ou étiré). */
export function isCompClip(c: Clip): boolean {
  return takeNumberOf(c) !== null && c.type !== TrackType.MIDI && !c.notes && !c.isReversed && !c.warp
    && !!(c.bufferId || c.buffer || c.audioRef);
}

/** Morceaux continus de chaque prise (pièces d'une même prise recollées). */
export function takeSpans(clips: Clip[]): TakeSpan[] {
  const groups = new Map<string, Clip[]>();
  for (const c of clips) {
    if (!isCompClip(c)) continue;
    const n = takeNumberOf(c)!;
    const anchor = c.start - (c.offset || 0);
    const k = `${n}|${srcKey(c)}|${anchor.toFixed(5)}|${(c.gain ?? 1).toFixed(5)}`;
    const g = groups.get(k);
    if (g) g.push(c); else groups.set(k, [c]);
  }
  const out: TakeSpan[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.start - b.start || endOf(b) - endOf(a));
    let cur: TakeSpan | null = null;
    for (const c of list) {
      if (cur && c.start <= cur.end + JOIN_TOL) {
        if (endOf(c) > cur.end + EPS) { cur.end = endOf(c); cur.fadeOut = c.fadeOut || 0; cur.fadeOutCurve = c.fadeOutCurve; }
        continue;
      }
      cur = {
        key: c.id, n: takeNumberOf(c)!, start: c.start, end: endOf(c), anchor: c.start - (c.offset || 0), base: c,
        fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, fadeInCurve: c.fadeInCurve, fadeOutCurve: c.fadeOutCurve,
      };
      out.push(cur);
    }
  }
  return out.sort((a, b) => a.n - b.n || a.start - b.start);
}

/** Morceau d'origine d'un clip de prise. */
function spanOf(spans: TakeSpan[], c: Clip): TakeSpan | undefined {
  const n = takeNumberOf(c);
  const anchor = c.start - (c.offset || 0);
  return spans.find(s => s.n === n && srcKey(s.base) === srcKey(c) && Math.abs(s.anchor - anchor) < 1e-4
    && Math.abs((s.base.gain ?? 1) - (c.gain ?? 1)) < 1e-4 && c.start >= s.start - EPS && endOf(c) <= s.end + EPS);
}

/**
 * Comp actuel, lu dans les clips : passages audibles de chaque prise. Un
 * crossfade compte pour moitié de chaque côté (le raccord est au milieu) ;
 * deux prises audibles l'une sur l'autre (anciens projets) : la plus récente.
 */
export function readComp(clips: Clip[], spans: TakeSpan[] = takeSpans(clips)): CompSegment[] {
  const parts = clips.filter(c => isCompClip(c) && !c.isMuted)
    .map(c => { const sp = spanOf(spans, c); return { c, n: takeNumberOf(c)!, s: c.start, e: endOf(c), span: sp?.key, sp }; })
    .filter(p => p.span && p.e - p.s > EPS)
    .sort((a, b) => a.s - b.s);
  // Raccords en crossfade : le raccord est au milieu du chevauchement, sauf si
  // le crossfade a dû glisser contre le bord de l'audio d'une prise (le
  // raccord est alors ce bord).
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length && parts[j].s < parts[i].e; j++) {
      const a = parts[i], b = parts[j];
      const contains = (x: typeof a, y: typeof a) => x.s <= y.s + EPS && x.e >= y.e - EPS;
      if (contains(a, b) || contains(b, a) || a.e - b.s > 0.5) continue;
      const J = near(b.s, b.sp!.start) ? b.s : near(a.e, a.sp!.end) ? a.e : (b.s + a.e) / 2;
      a.e = Math.min(a.e, J); b.s = Math.max(b.s, J);
    }
  }
  // Balayage : sur chaque intervalle élémentaire, la prise la plus récente.
  const cuts = Array.from(new Set(parts.flatMap(p => [p.s, p.e]))).sort((x, y) => x - y);
  const segs: CompSegment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a < EPS) continue;
    let best: (typeof parts)[number] | null = null;
    for (const p of parts) if (p.s <= a + EPS && p.e >= b - EPS && (!best || p.n > best.n)) best = p;
    if (!best) continue;
    const last = segs[segs.length - 1];
    if (last && last.span === best.span && Math.abs(last.end - a) < EPS) last.end = b;
    else segs.push({ start: a, end: b, n: best.n, span: best.span! });
  }
  return segs;
}

/** Remplace le comp sur [a, b] par les morceaux donnés (déjà découpés à [a, b]). */
function overwrite(segs: CompSegment[], a: number, b: number, add: CompSegment[]): CompSegment[] {
  const out: CompSegment[] = [];
  for (const s of segs) {
    if (s.end <= a + EPS || s.start >= b - EPS) { out.push(s); continue; }
    if (s.start < a - EPS) out.push({ ...s, end: a });
    if (s.end > b + EPS) out.push({ ...s, start: b });
  }
  out.push(...add.filter(s => s.end - s.start > EPS));
  return out.sort((x, y) => x.start - y.start);
}

/**
 * Reconstruit les clips de prises d'après le comp. Les identifiants sont
 * gardés quand une pièce ne bouge pas (la lecture en cours n'est pas coupée).
 */
export function rebuildTakeClips(clips: Clip[], spans: TakeSpan[], segs: CompSegment[], opts: CompOptions = {}): Clip[] {
  const L = Math.max(0, opts.xfade ?? COMP_XFADE_SEC);
  const curve: CrossfadeCurve = opts.curve || 'EQUAL_POWER';
  let k = 0;
  const stamp = Date.now().toString(36);
  const gen = opts.newId || ((base: string) => `${base}-k${stamp}${k++}`);
  const byKey = new Map(spans.map(s => [s.key, s]));
  segs = segs.filter(s => byKey.has(s.span)).sort((a, b) => a.start - b.start);

  // Fenêtre de crossfade de chaque raccord (entre segs[i] et segs[i + 1]).
  const win: ({ S: number; E: number } | null)[] = [];
  for (let i = 0; i + 1 < segs.length; i++) {
    const l = segs[i], r = segs[i + 1];
    if (Math.abs(l.end - r.start) > 1e-4 || l.span === r.span) { win.push(null); continue; }
    const A = byKey.get(l.span)!, B = byKey.get(r.span)!;
    const J = l.end;
    const lo = Math.max(B.start, l.start + 0.001);
    const hi = Math.min(A.end, r.end - 0.001);
    const len = Math.min(L, hi - lo);
    if (!(len >= 0.001)) { win.push({ S: J, E: J }); continue; }
    const S = r9(Math.min(Math.max(J - len / 2, lo), hi - len));
    win.push({ S, E: r9(S + len) });
  }

  const existing = new Map<string, string>();
  const geo = (n: number, s: number, d: number, m: boolean) => `${n}|${s.toFixed(5)}|${d.toFixed(5)}|${m ? 1 : 0}`;
  for (const c of clips) if (isCompClip(c)) existing.set(geo(takeNumberOf(c)!, c.start, c.duration, !!c.isMuted), c.id);
  const used = new Set<string>();
  const piece = (sp: TakeSpan, s: number, e: number, muted: boolean, fi: number, fo: number, fic?: CrossfadeCurve, foc?: CrossfadeCurve): Clip => {
    const g = geo(sp.n, s, e - s, muted);
    let id = existing.get(g);
    if (!id || used.has(id)) id = !used.has(sp.key) && Math.abs(s - sp.start) < EPS ? sp.key : gen(sp.key);
    used.add(id);
    const d = r9(e - s);
    const c: Clip = { ...sp.base, id, start: s, duration: d, offset: r9(s - sp.anchor), isMuted: muted };
    c.fadeIn = r9(Math.max(0, Math.min(fi, d)));
    c.fadeOut = r9(Math.max(0, Math.min(fo, d - c.fadeIn)));
    if (fic) c.fadeInCurve = fic; else delete c.fadeInCurve;
    if (foc) c.fadeOutCurve = foc; else delete c.fadeOutCurve;
    if (!muted) delete c.isMuted;
    return c;
  };

  const audible: Clip[] = [];
  const muted: Clip[] = [];
  for (const sp of spans) {
    const mine = segs.map((s, i) => ({ s, i })).filter(x => x.s.span === sp.key);
    // Passages audibles, élargis aux crossfades.
    for (const { s, i } of mine) {
      const wl = i > 0 ? win[i - 1] : null;
      const wr = i < win.length ? win[i] : null;
      const st = wl ? wl.S : s.start;
      const en = wr ? wr.E : s.end;
      const atStart = Math.abs(st - sp.start) < EPS, atEnd = Math.abs(en - sp.end) < EPS;
      const fi = wl ? wl.E - wl.S : atStart ? sp.fadeIn : COMP_EDGE_FADE;
      const fo = wr ? wr.E - wr.S : atEnd ? sp.fadeOut : COMP_EDGE_FADE;
      const fic = wl && fi > 0 ? curve : atStart && !wl ? sp.fadeInCurve : undefined;
      const foc = wr && fo > 0 ? curve : atEnd && !wr ? sp.fadeOutCurve : undefined;
      if (en - st > EPS) audible.push(piece(sp, st, en, false, fi || (wl ? 0.002 : 0), fo || (wr ? 0.002 : 0), fic, foc));
    }
    // Le reste du morceau : muté (le couloir garde la prise entière).
    let cur = sp.start;
    const holes = mine.map(x => x.s).sort((a, b) => a.start - b.start);
    const pushMuted = (a: number, b: number) => {
      if (b - a <= EPS) return;
      const fi = Math.abs(a - sp.start) < EPS ? sp.fadeIn : COMP_EDGE_FADE;
      const fo = Math.abs(b - sp.end) < EPS ? sp.fadeOut : COMP_EDGE_FADE;
      muted.push(piece(sp, a, b, true, fi, fo,
        Math.abs(a - sp.start) < EPS ? sp.fadeInCurve : undefined, Math.abs(b - sp.end) < EPS ? sp.fadeOutCurve : undefined));
    };
    for (const h of holes) { pushMuted(cur, Math.max(cur, h.start)); cur = Math.max(cur, h.end); }
    pushMuted(cur, sp.end);
  }
  const others = clips.filter(c => !isCompClip(c));
  muted.sort((a, b) => (takeNumberOf(a)! - takeNumberOf(b)!) || a.start - b.start);
  audible.sort((a, b) => a.start - b.start);
  return [...others, ...muted, ...audible];
}

/** Partie de [a, b] couverte par l'audio de la prise n (morceaux découpés). */
export function takeCoverage(spans: TakeSpan[], n: number, a: number, b: number): CompSegment[] {
  return spans.filter(s => s.n === n && s.end > a + EPS && s.start < b - EPS)
    .map(s => ({ start: Math.max(a, s.start), end: Math.min(b, s.end), n, span: s.key }));
}

export interface CompResult {
  clips: Clip[];
  /** Zone réellement prise (bornée à l'audio de la prise), null si rien. */
  zone: { start: number; end: number } | null;
  changed: boolean;
}

/**
 * Balayage sur le couloir de la prise n, de a à b : ce passage passe dans la
 * piste principale (les autres prises s'y taisent), avec des crossfades aux
 * raccords. Hors de [a, b], le comp ne change pas.
 */
export function compSwipe(clips: Clip[], n: number, a: number, b: number, opts: CompOptions = {}): CompResult {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const spans = takeSpans(clips);
  const cov = takeCoverage(spans, n, lo, hi);
  if (!cov.length) return { clips, zone: null, changed: false };
  const za = Math.min(...cov.map(s => s.start)), zb = Math.max(...cov.map(s => s.end));
  if (zb - za < MIN_COMP_SEC) return { clips, zone: null, changed: false };
  const before = readComp(clips, spans);
  const segs = overwrite(before, za, zb, cov);
  const next = rebuildTakeClips(clips, spans, segs, opts);
  return { clips: next, zone: { start: za, end: zb }, changed: true };
}

/** Garde toute la prise n (sur toute sa longueur). */
export function compWholeTake(clips: Clip[], n: number, opts: CompOptions = {}): CompResult {
  const spans = takeSpans(clips).filter(s => s.n === n);
  if (!spans.length) return { clips, zone: null, changed: false };
  return compSwipe(clips, n, Math.min(...spans.map(s => s.start)), Math.max(...spans.map(s => s.end)), opts);
}

/**
 * Tap sur un couloir (sans glisser) : remplace le passage du comp qui passe à
 * cet instant (entre deux raccords), comme un clic dans un couloir de Logic.
 * Sans comp à cet endroit : le morceau de la prise qui contient l'instant.
 */
export function compTapRange(clips: Clip[], n: number, t: number): { start: number; end: number } | null {
  const spans = takeSpans(clips);
  const own = spans.find(s => s.n === n && t >= s.start - EPS && t <= s.end + EPS);
  if (!own) return null;
  const seg = readComp(clips, spans).find(s => t >= s.start - EPS && t < s.end);
  if (seg && seg.n !== n) return { start: Math.max(seg.start, own.start), end: Math.min(seg.end, own.end) };
  return { start: own.start, end: own.end };
}

/** Prise entendue à l'instant t (null : aucune). */
export function takeAt(clips: Clip[], t: number): number | null {
  const seg = readComp(clips).find(s => t >= s.start - EPS && t < s.end);
  return seg ? seg.n : null;
}

/** Durée (s) pendant laquelle chaque prise est entendue dans le comp. */
export function compUsage(clips: Clip[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of readComp(clips)) m.set(s.n, (m.get(s.n) || 0) + (s.end - s.start));
  return m;
}

/**
 * Raccords du comp (changements de prise) avec leur fenêtre de crossfade :
 * utile à l'affichage et aux preuves (pas de clic au raccord).
 */
export function compJunctions(clips: Clip[]): { at: number; from: number; to: number }[] {
  const segs = readComp(clips);
  const out: { at: number; from: number; to: number }[] = [];
  for (let i = 0; i + 1 < segs.length; i++) {
    if (Math.abs(segs[i].end - segs[i + 1].start) < 1e-4 && segs[i].span !== segs[i + 1].span) out.push({ at: segs[i].end, from: segs[i].n, to: segs[i + 1].n });
  }
  return out;
}
