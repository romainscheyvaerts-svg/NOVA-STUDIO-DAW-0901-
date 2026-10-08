import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { applyMixFields, changedFields, fieldSigsOf, LwwClock, mixFieldsOf, touchesAutomation } from '../utils/collabMerge';
import { sessionPrint, printDiff } from '../utils/collabFingerprint';
import { applyClipsUndo, clipsUndo, joinLabels, mixFieldLabel, pushHistory } from '../utils/collabHistory';

/**
 * Automation (R7/R8/R9) et tranche (trim, phase, mono, largeur) en
 * collaboration : avant, réglées chez l'ingé, elles ne partaient jamais.
 * Couloir par couloir, dernière écriture gagne ; convergence vérifiée par
 * l'empreinte de session.
 */

const T = (o: Partial<Track> = {}): Track => ({ id: 'voix', name: 'Voix', type: 'AUDIO' as any, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...o });
const lane = (id: string, pts: [number, number][], expanded = true) => ({ id, parameterName: 'volume', color: '#0ff', isExpanded: expanded, min: 0, max: 1.5,
  points: pts.map(([time, value], i) => ({ id: `${id}-${i}`, time, value })) });

/** Un participant : sa piste, ce qu'il sait déjà, son horloge. */
class Peer {
  t: Track;
  known: Record<string, string>;
  lww = new LwwClock();
  constructor(t: Track) { this.t = JSON.parse(JSON.stringify(t)); this.known = fieldSigsOf(mixFieldsOf(this.t)); }
  edit(fn: (t: Track) => void) { fn(this.t); }
  outgoing() { const f = changedFields(this.known, mixFieldsOf(this.t)); this.known = { ...this.known, ...fieldSigsOf(f) }; return f; }
  /** Notre envoi est enregistré (numéro du journal) : comme onSent dans App. */
  sent(fields: Record<string, unknown>, seq: number) { Object.keys(fields).forEach(f => this.lww.note(`${this.t.id}:${f}`, seq)); }
  receive(fields: Record<string, unknown>, seq: number) {
    const t = this.t;
    applyMixFields(t, fields, f => this.lww.accept(`${t.id}:${f}`, seq));
    this.known = { ...this.known, ...fieldSigsOf(Object.fromEntries(Object.keys(fields).map(k => [k, (mixFieldsOf(t) as any)[k]]))) };
  }
}

describe('automation et tranche en collaboration', () => {
  it("l'automation écrite par l'ingé arrive chez l'artiste ; l'état déplié reste local", () => {
    const max = new Peer(T()), lina = new Peer(T());
    max.edit(t => { t.automationMode = 'read'; t.automationLanes = [lane('a', [[0, 0.9], [6, 0.5]])] as any; });
    const f = max.outgoing();
    expect(touchesAutomation(f)).toBe(true);
    lina.receive(f, 10);
    expect(lina.t.automationMode).toBe('read');
    expect(lina.t.automationLanes.map(l => l.points.map(p => p.value))).toEqual([[0.9, 0.5]]);
    // Plié chez Lina : rien ne part (affichage local).
    lina.edit(t => { t.automationLanes[0].isExpanded = false; });
    expect(lina.outgoing()).toEqual({});
    expect(sessionPrint({ tracks: [lina.t] } as any).sig).toBe(sessionPrint({ tracks: [max.t] } as any).sig);
  });

  it('deux couloirs modifiés en même temps par deux personnes : les deux gardés, même résultat', () => {
    const base = T({ automationLanes: [lane('a', [[0, 1]]), lane('b', [[0, 1]])] as any });
    const max = new Peer(base), lina = new Peer(base);
    max.edit(t => { t.automationLanes[0].points = [{ id: 'x', time: 1, value: 0.2 }] as any; });
    lina.edit(t => { t.automationLanes[1].points = [{ id: 'y', time: 2, value: 0.7 }] as any; });
    const fm = max.outgoing(), fl = lina.outgoing();
    lina.receive(fm, 11); max.receive(fl, 12);
    expect(sessionPrint({ tracks: [lina.t] } as any).sig).toBe(sessionPrint({ tracks: [max.t] } as any).sig);
    expect(lina.t.automationLanes[0].points[0].value).toBe(0.2);
    expect(max.t.automationLanes[1].points[0].value).toBe(0.7);
  });

  it('même réglage de tranche des deux côtés : le plus récent du journal gagne partout (ordre d’arrivée indifférent)', () => {
    const a = new Peer(T()), b = new Peer(T());
    a.edit(t => { t.stereoWidth = 0.5; t.phaseInvert = true; });
    b.edit(t => { t.stereoWidth = 1.6; });
    const fa = a.outgoing(), fb = b.outgoing();
    // b est plus récent (seq 21) ; a l'a reçu avant d'envoyer… ou après : même fin.
    a.sent(fa, 20); b.sent(fb, 21);
    b.receive(fa, 20); a.receive(fb, 21);
    const c = new Peer(T());
    c.receive(fb, 21); c.receive(fa, 20); // arrivées dans le désordre
    for (const p of [a, b, c]) { expect(p.t.stereoWidth).toBe(1.6); }
    expect(printDiff(sessionPrint({ tracks: [a.t] } as any), sessionPrint({ tracks: [c.t] } as any))).toEqual([]);
  });

  it('couloir supprimé par l’un : supprimé chez l’autre ; valeurs bornées à la réception', () => {
    const base = T({ automationLanes: [lane('a', [[0, 1]]), lane('b', [[0, 1]])] as any });
    const max = new Peer(base), lina = new Peer(base);
    max.edit(t => { t.automationLanes = t.automationLanes.filter(l => l.id !== 'b'); });
    lina.receive(max.outgoing(), 30);
    expect(lina.t.automationLanes.map(l => l.id)).toEqual(['a']);
    lina.receive({ strip: { inputTrimDb: 99, stereoWidth: -4, phaseInvert: 'oui' } }, 31);
    expect(lina.t.inputTrimDb).toBe(24);
    expect(lina.t.stereoWidth).toBe(0);
    expect(lina.t.phaseInvert).toBeUndefined();
  });
});

describe('historique « qui a changé quoi »', () => {
  it('libellés lisibles et annulation des clips', () => {
    expect(joinLabels(['le volume', 'le panoramique', mixFieldLabel('plugin:c1', () => 'COMPRESSOR')])).toBe('le volume, le panoramique et l’effet COMPRESSOR'.replace('’', "'"));
    const before = [{ id: 'a', start: 0, gain: 1 }, { id: 'b', start: 2 }] as any;
    const u = clipsUndo('voix', before, [{ id: 'a', start: 0, gain: 0.5 }, { id: 'n', start: 5 }] as any, ['b'])!;
    expect(u.kind).toBe('clips');
    const after = [{ id: 'a', start: 0, gain: 0.5 }, { id: 'n', start: 5 }] as any;
    expect(applyClipsUndo(after, u as any).map((c: any) => `${c.id}:${c.gain ?? ''}`).sort()).toEqual(['a:1', 'b:']);
    const h = pushHistory(pushHistory([], { id: 'x', seq: 2, at: 0, who: 'Max', role: 'engineer', text: 't' }), { id: 'y', seq: 5, at: 0, who: 'Max', role: 'engineer', text: 'u' });
    expect(h.map(e => e.id)).toEqual(['y', 'x']);
  });
});
