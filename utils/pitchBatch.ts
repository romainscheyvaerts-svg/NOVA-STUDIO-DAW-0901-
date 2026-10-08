/**
 * Justesse (V19) : « Corriger tout » sur plusieurs clips d'un coup (sélection
 * de clips → menu → « Justesse : corriger tout (n clips) »).
 *
 * Même calcul que le bouton « Corriger tout dans la gamme » de l'éditeur,
 * clip par clip : analyse (worker), correction dosée (naturel ou robot),
 * rendu d'un nouveau son, prise d'origine gardée. Les notes retouchées à la
 * main dans l'éditeur gardent leur retouche. Rien n'est appliqué ici : les
 * changements reviennent ensemble, pour UN setState (une seule annulation).
 */
import type { Clip } from '../types';
import { audioBufferRegistry } from './audioBufferRegistry';
import type { PitchNote } from './pitchAnalysis';
import { autoCorrect, CorrectStyle, guessKey, hasEdits, NoteEdit } from './pitchCorrect';
import { analyzeRegion, AnalysisResult, clipRegion, correctedClipPatch, editingSource, editsForNotes, manualNotes, renderRegion, storeEdits } from './pitchEdit';

export interface PitchBatchTarget { trackId: string; clip: Clip }

export interface PitchBatchOptions {
  /** Dosage 0 → 1. */
  amount: number;
  style: CorrectStyle;
  /** Gamme du projet ; absente : devinée sur toutes les notes des clips. */
  key?: { root?: number; scale?: string };
  /** Progression : clip en cours (1…n). */
  onProgress?: (done: number, total: number, label: string) => void;
  /** Annulation demandée (fenêtre fermée). */
  cancelled?: () => boolean;
  /** Identifiants des nouveaux sons (tests). */
  makeId?: (clip: Clip) => string;
}

export interface PitchBatchResult {
  patches: { trackId: string; clipId: string; patch: Partial<Clip> }[];
  skipped: { trackId: string; clipId: string; name: string; reason: string }[];
  /** Notes corrigées (toutes les notes des clips traités). */
  notes: number;
  key?: { root?: number; scale?: string; guessed?: boolean };
}

/** Le clip peut-il passer dans la correction groupée ? (sinon : la raison, lisible) */
export function pitchBatchReason(c: Clip): string | null {
  if (c.type === 'MIDI' || c.notes) return 'clip MIDI';
  if (c.isReversed) return 'clip inversé';
  if (c.isFreezeSlice) return 'rendu gelé';
  const has = (id: string) => audioBufferRegistry.has(id);
  const src = editingSource(c, has);
  if (!src.bufferId || !audioBufferRegistry.get(src.bufferId)) return 'son pas encore chargé';
  return null;
}

const yieldUi = () => new Promise<void>(r => setTimeout(r, 0));

export async function correctClipsBatch(ctx: BaseAudioContext, targets: PitchBatchTarget[], o: PitchBatchOptions): Promise<PitchBatchResult> {
  const out: PitchBatchResult = { patches: [], skipped: [], notes: 0 };
  const has = (id: string) => audioBufferRegistry.has(id);
  type Job = { t: PitchBatchTarget; buffer: AudioBuffer; src: ReturnType<typeof editingSource>; region: { start: number; end: number }; an: AnalysisResult };
  const jobs: Job[] = [];
  const total = targets.length;

  // 1. Analyse de chaque clip.
  for (let i = 0; i < targets.length; i++) {
    if (o.cancelled?.()) return out;
    const t = targets[i];
    o.onProgress?.(i, total * 2, `Analyse de « ${t.clip.name} »…`);
    const reason = pitchBatchReason(t.clip);
    if (reason) { out.skipped.push({ trackId: t.trackId, clipId: t.clip.id, name: t.clip.name, reason }); continue; }
    const src = editingSource(t.clip, has);
    const buffer = audioBufferRegistry.get(src.bufferId!)!;
    const region = clipRegion({ offset: src.offset, duration: t.clip.duration }, buffer.duration);
    const an = await analyzeRegion(buffer, region.start, region.end);
    if (!an.notes.length) { out.skipped.push({ trackId: t.trackId, clipId: t.clip.id, name: t.clip.name, reason: 'aucune note chantée trouvée' }); continue; }
    jobs.push({ t, buffer, src, region, an });
    await yieldUi();
  }

  // 2. Gamme : celle du projet, sinon devinée sur TOUTES les notes (une seule gamme pour la session).
  let key = o.key && typeof o.key.root === 'number' && o.key.scale ? { ...o.key } : undefined;
  if (!key) {
    const all: PitchNote[] = jobs.flatMap(j => j.an.notes);
    const g = guessKey(all);
    key = g ? { ...g, guessed: true } as any : { root: undefined, scale: 'CHROMATIC' };
  }
  out.key = key;

  // 3. Correction et rendu, clip par clip.
  for (let i = 0; i < jobs.length; i++) {
    if (o.cancelled?.()) {
      // Fenêtre fermée en cours de route : rien n'est appliqué, les sons déjà rendus sont libérés.
      out.patches.forEach(p => { if (p.patch.bufferId) audioBufferRegistry.remove(p.patch.bufferId); });
      return { ...out, patches: [] };
    }
    const { t, buffer, src, region, an } = jobs[i];
    o.onProgress?.(total + i, total * 2, `Correction de « ${t.clip.name} »…`);
    const pe = src.fromOriginal ? t.clip.pitchEdit : undefined;
    const kept = editsForNotes(an.notes, pe?.edits, region.start);
    const manual = manualNotes(an.notes, pe?.edits, region.start);
    const auto = autoCorrect(an.notes, key!, o.amount, o.style);
    const edits: (NoteEdit | undefined)[] = an.notes.map((_, k) => (manual.has(k) ? kept[k] : o.amount > 0 ? auto[k] : undefined));
    if (!hasEdits(edits)) { out.skipped.push({ trackId: t.trackId, clipId: t.clip.id, name: t.clip.name, reason: 'déjà juste' }); continue; }
    const rendered = await renderRegion(ctx, buffer, region.start, region.end, an.track, an.notes, edits);
    const newBufferId = o.makeId ? o.makeId(t.clip) : `justesse-${t.clip.id}-${Date.now().toString(36)}${i}`;
    audioBufferRegistry.register(rendered, newBufferId);
    out.patches.push({
      trackId: t.trackId, clipId: t.clip.id,
      patch: correctedClipPatch(t.clip, {
        newBufferId, sourceBufferId: src.bufferId, sourceOffset: src.offset, regionStart: region.start,
        edits: storeEdits(an.notes, edits, region.start, manual), amount: o.amount, style: o.style, at: Date.now(),
      }),
    });
    out.notes += an.notes.length;
    await yieldUi();
  }
  o.onProgress?.(total * 2, total * 2, 'Terminé');
  return out;
}
