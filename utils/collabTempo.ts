/**
 * Collaboration (R2) : le tempo, la mesure et la piste tempo voyagent chez les
 * autres membres de la session (opération « tempo » du journal, la dernière
 * écriture gagne). Avant R2, changer le tempo ne partait chez personne : l'ingé
 * et l'artiste n'avaient plus la même grille ni le même clic.
 */
import type { DAWState, TimeSignature } from '../types';
import { tempoSignature, type TempoEvent } from './tempoMap';

export interface TempoOp { bpm: number; timeSignature: TimeSignature; tempoEvents: TempoEvent[] }

export const tempoOpOf = (s: Pick<DAWState, 'bpm' | 'timeSignature' | 'tempoEvents'>): TempoOp => ({
  bpm: s.bpm,
  timeSignature: { numerator: s.timeSignature?.numerator || 4, denominator: s.timeSignature?.denominator || 4 },
  tempoEvents: (s.tempoEvents || []).map(e => ({ ...e })),
});

export const tempoOpSig = (o: Pick<TempoOp, 'bpm' | 'timeSignature' | 'tempoEvents'>): string => tempoSignature(o.bpm, o.timeSignature, o.tempoEvents);

/** Opération reçue, nettoyée (valeurs hors bornes ou mal formées ignorées). Null si inutilisable. */
export function sanitizeTempoOp(raw: unknown): TempoOp | null {
  const r = raw as Record<string, any> | null;
  if (!r || typeof r !== 'object') return null;
  const bpm = Number(r.bpm);
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) return null;
  const n = Number(r.timeSignature?.numerator), d = Number(r.timeSignature?.denominator);
  const ts: TimeSignature = { numerator: Number.isInteger(n) && n >= 1 && n <= 32 ? n : 4, denominator: [1, 2, 4, 8, 16, 32].includes(d) ? d : 4 };
  const events: TempoEvent[] = (Array.isArray(r.tempoEvents) ? r.tempoEvents : []).slice(0, 512).flatMap((e: any) => {
    const bar = Math.round(Number(e?.bar));
    if (!Number.isFinite(bar) || bar < 0 || bar > 100000) return [];
    const ev: TempoEvent = { id: typeof e.id === 'string' ? e.id.slice(0, 64) : `tempo-${bar}`, bar };
    const b = Number(e.bpm);
    if (Number.isFinite(b) && b >= 20 && b <= 999) ev.bpm = b;
    const en = Number(e.numerator), ed = Number(e.denominator);
    if (Number.isInteger(en) && en >= 1 && en <= 32 && [1, 2, 4, 8, 16, 32].includes(ed)) { ev.numerator = en; ev.denominator = ed; }
    return [ev];
  });
  return { bpm, timeSignature: ts, tempoEvents: events };
}

/** Applique l'opération à l'état (même référence si rien ne change). */
export function applyTempoOp<S extends Pick<DAWState, 'bpm' | 'timeSignature' | 'tempoEvents'>>(state: S, op: TempoOp): S {
  if (tempoOpSig(tempoOpOf(state)) === tempoOpSig(op)) return state;
  return { ...state, bpm: op.bpm, timeSignature: op.timeSignature, tempoEvents: op.tempoEvents };
}
