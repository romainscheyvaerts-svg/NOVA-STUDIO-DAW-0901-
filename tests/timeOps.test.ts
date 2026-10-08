import { describe, expect, it } from 'vitest';
import { applyTimeOp, insertTempoTime, deleteTempoTime, sanitizeTimeOp, sectionsOf, nearestDrop, opIdGen, TimeOp } from '../utils/timeOps';
import { buildTempoMap, barToTime } from '../utils/tempoMap';
import { valueAtPoints } from '../utils/automationWrite';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import { DAWState, Track } from '../types';

/** 120 BPM 4/4 : 1 temps = 0,5 s, 1 mesure = 2 s. */
function song(): DAWState {
  const lane = { id: 'l-vol', parameterName: 'volume', color: '#fff', isExpanded: true, min: 0, max: 1,
    points: [{ id: 'p0', time: 0, value: 0.2 }, { id: 'p1', time: 6, value: 0.8 }, { id: 'p2', time: 10, value: 0.4 }] };
  const lead = makeTrack({ id: 'lead', name: 'LEAD', clips: [makeClip({ id: 'c-lead', start: 2, duration: 8 })], automationLanes: [lane] });
  const dbl = makeTrack({ id: 'dbl', name: 'DOUBLE', clips: [makeClip({ id: 'c-dbl', start: 2.01, duration: 7.98 })] });
  const beat = makeTrack({ id: 'beat', name: 'BEAT', clips: [makeClip({ id: 'c-beat', start: 0, duration: 16 })] });
  const master = makeTrack({ id: 'master', name: 'MASTER', clips: [] });
  return makeState([lead, dbl, beat, master], {
    markers: [
      { id: 'm-c', name: 'Couplet', time: 2, type: 'MARKER', color: '#22d3ee', number: 1 },
      { id: 'm-r', name: 'Refrain', time: 6, type: 'MARKER', color: '#f59e0b', number: 2 },
      { id: 'm-o', name: 'Outro', time: 10, type: 'MARKER', color: '#a855f7', number: 3 },
    ],
    chords: [
      { id: 'ch1', start: 0, end: 4, root: 0, quality: 'min' as any },
      { id: 'ch2', start: 4, end: 8, root: 5, quality: 'maj' as any },
    ],
    tempoEvents: [{ id: 'tp6', bar: 6, bpm: 90 }],
    loopStart: 6, loopEnd: 10,
  });
}

const op = (o: Partial<TimeOp> & { kind: TimeOp['kind'] }): TimeOp => ({ id: 'op1', ...o } as TimeOp);
const vol = (t: Track, at: number) => valueAtPoints([...t.automationLanes[0].points].sort((a, b) => a.time - b.time), at, 0);

describe('Insérer du temps (Pro Tools : Insert Silence / Insert Time)', () => {
  it('4 temps au milieu : clips, repères, accords, tempo, automation et boucle décalés exactement', () => {
    const s = song();
    const { state, report } = applyTimeOp(s, op({ kind: 'insert', at: 4, length: 2, tracks: 'all', rulers: true }));
    expect(report.exactTempo).toBe(true);
    // Clip coupé à 4 s : la 2e moitié recule de 2 s.
    const lead = state.tracks.find(t => t.id === 'lead')!;
    const parts = [...lead.clips].sort((a, b) => a.start - b.start);
    expect(parts.map(c => [c.start, c.duration])).toEqual([[2, 2], [6, 6]]);
    expect(parts[1].offset).toBeCloseTo(2, 9);
    // Repères : Couplet (2 s) reste, Refrain 6 → 8, Outro 10 → 12.
    expect(state.markers.map(m => m.time)).toEqual([2, 8, 12]);
    // Accords : ch2 commence pile à 4 → 6 ; ch1 (0–4) inchangé.
    expect(state.chords!.map(c => [c.start, c.end])).toEqual([[0, 4], [6, 10]]);
    // Tempo : le changement de la mesure 7 (index 6) passe à l'index 7, 2 s plus tard.
    expect(state.tempoEvents).toEqual([{ id: 'tp6', bar: 7, bpm: 90 }]);
    const before = barToTime(buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents), 6);
    const after = barToTime(buildTempoMap(state.bpm, state.timeSignature, state.tempoEvents), 7);
    expect(after - before).toBeCloseTo(2, 12);
    // Automation : la courbe d'avant 4 s ne bouge pas, plate pendant le blanc, puis décalée de 2 s.
    for (const t of [0, 1, 3.9]) expect(vol(lead, t)).toBeCloseTo(vol(s.tracks[0], t), 9);
    expect(vol(lead, 4.5)).toBeCloseTo(vol(s.tracks[0], 4), 9);
    expect(vol(lead, 5.9)).toBeCloseTo(vol(s.tracks[0], 4), 9);
    for (const t of [4.2, 5, 7, 9.5]) expect(vol(lead, t + 2)).toBeCloseTo(vol(s.tracks[0], t), 9);
    // Boucle 6–10 → 8–12.
    expect([state.loopStart, state.loopEnd]).toEqual([8, 12]);
  });

  it('2 temps sur une barre de mesure : une mesure de 2/4 est ajoutée, le reste du tempo suit exactement', () => {
    const s = song();
    const tp = insertTempoTime(s, 4, 1, opIdGen('x'));
    expect(tp.exact).toBe(true);
    const m0 = buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);
    const m1 = buildTempoMap(tp.bpm, tp.timeSignature, tp.tempoEvents);
    expect(m1.segments.some(x => x.num === 2 && x.time === 4)).toBe(true);
    // Barre de la mesure 3 (index 2, à 4 s) → 5 s ; changement à 90 BPM décalé d'1 s.
    expect(barToTime(m1, 3)).toBeCloseTo(5, 12);
    expect(barToTime(m1, 7)).toBeCloseTo(barToTime(m0, 6) + 1, 12);
  });

  it('au milieu d\'une mesure, un temps entier : la mesure s\'allonge (5/4), la suite est exacte', () => {
    const s = song();
    const tp = insertTempoTime(s, 3, 0.5, opIdGen('x'));
    expect(tp.exact).toBe(true);
    const m0 = buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);
    const m1 = buildTempoMap(tp.bpm, tp.timeSignature, tp.tempoEvents);
    expect(barToTime(m1, 6)).toBeCloseTo(barToTime(m0, 6) + 0.5, 12);
  });

  it('pistes sélectionnées seulement, sans les règles : les autres pistes et les repères ne bougent pas', () => {
    const s = song();
    const { state } = applyTimeOp(s, op({ kind: 'insert', at: 4, length: 2, tracks: ['lead', 'dbl'], rulers: false }));
    expect(state.tracks.find(t => t.id === 'beat')!.clips).toEqual(s.tracks.find(t => t.id === 'beat')!.clips);
    expect(state.markers).toBe(s.markers);
    expect(state.tempoEvents).toBe(s.tempoEvents);
    expect(state.tracks.find(t => t.id === 'dbl')!.clips.length).toBe(2);
  });
});

describe('Supprimer du temps (Pro Tools : Cut Time)', () => {
  it('une mesure entière : tout avance, le tempo suit exactement, insérer puis supprimer revient au départ', () => {
    const s = song();
    const ins = applyTimeOp(s, op({ kind: 'insert', at: 4, length: 2, tracks: 'all', rulers: true })).state;
    const del = applyTimeOp(ins, op({ id: 'op2', kind: 'delete', start: 4, end: 6, tracks: 'all', rulers: true }));
    expect(del.report.exactTempo).toBe(true);
    const st = del.state;
    expect(st.markers.map(m => m.time)).toEqual([2, 6, 10]);
    expect(st.chords!.map(c => [c.start, c.end])).toEqual([[0, 4], [4, 8]]);
    expect(st.tempoEvents).toEqual(s.tempoEvents);
    const lead = st.tracks.find(t => t.id === 'lead')!;
    // Deux morceaux recollés bout à bout (même son qu'avant).
    const parts = [...lead.clips].sort((a, b) => a.start - b.start);
    expect(parts[0].start + parts[0].duration).toBeCloseTo(parts[1].start, 9);
    expect(parts[1].offset).toBeCloseTo(2, 9);
    for (const t of [0, 3, 4.5, 6, 9]) expect(vol(lead, t)).toBeCloseTo(vol(s.tracks[0], t), 6);
  });

  it('un repère dans la plage disparaît ; la région qui la traverse raccourcit', () => {
    const s = { ...song(), markers: [{ id: 'r', name: 'Pont', time: 3, endTime: 9, type: 'REGION' as const, color: '#fff' }, { id: 'k', name: 'x', time: 5, type: 'MARKER' as const, color: '#fff' }] };
    const st = applyTimeOp(s, op({ kind: 'delete', start: 4, end: 6, tracks: 'all', rulers: true })).state;
    expect(st.markers).toEqual([{ id: 'r', name: 'Pont', time: 3, endTime: 7, type: 'REGION', color: '#fff' }]);
  });

  it('deux temps au milieu d\'une mesure : mesure recollée (2/4), exacte', () => {
    const s = song();
    const tp = deleteTempoTime(s, 2.5, 3.5, opIdGen('d'));
    expect(tp.exact).toBe(true);
    const m0 = buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);
    const m1 = buildTempoMap(tp.bpm, tp.timeSignature, tp.tempoEvents);
    expect(barToTime(m1, 6)).toBeCloseTo(barToTime(m0, 6) - 1, 12);
  });
});

describe('Sections depuis la règle (piste Arrangement, Logic / Studio One)', () => {
  it('sections tirées des repères ; dépôt aimanté sur les bords', () => {
    const s = song();
    const secs = sectionsOf(s);
    expect(secs.map(x => [x.name, x.start, x.end])).toEqual([['Couplet', 2, 6], ['Refrain', 6, 10], ['Outro', 10, 16]]);
    expect(nearestDrop(secs, 9.4, 16)).toBe(10);
  });

  it('dupliquer le Refrain après lui : la copie est identique (clips, automation, accords, tempo)', () => {
    const s = song();
    const { state, report } = applyTimeOp(s, op({ kind: 'section', mode: 'copy', start: 6, end: 10, to: 10 }));
    expect(report.exactTempo).toBe(true);
    const lead = state.tracks.find(t => t.id === 'lead')!;
    const orig = s.tracks[0];
    // Automation : [10, 14[ = [6, 10[ d'origine ; ce qui suivait recule de 4 s.
    for (const t of [0, 0.5, 1.5, 2.5, 3.5, 3.9]) expect(vol(lead, 10 + t)).toBeCloseTo(vol(orig, 6 + t), 6);
    for (const t of [10.5, 12, 15]) expect(vol(lead, t + 4)).toBeCloseTo(vol(orig, t), 6);
    // Clips : la copie lit le même audio (même offset) à 10 s.
    const piece = lead.clips.find(c => Math.abs(c.start - 10) < 1e-9)!;
    expect(piece.offset).toBeCloseTo(4, 9);
    expect(piece.duration).toBeCloseTo(4, 9);
    // Repères : Refrain recopié à 10 s, Outro reculé à 14 s.
    expect(state.markers.map(m => [m.name, m.time]).sort((a, b) => (a[1] as number) - (b[1] as number)))
      .toEqual([['Couplet', 2], ['Refrain', 6], ['Refrain', 10], ['Outro', 14]]);
    // Tempo : la section contient le passage à 90 BPM ? Non (mesure 7 = 12 s) : il recule de 2 mesures.
    expect(state.tempoEvents!.map(e => [e.bar, e.bpm])).toEqual([[8, 90]]);
    // Accords : ch2 (4–8) → la partie 6–8 est recopiée à 10–12.
    expect(state.chords!.some(c => c.start === 10 && c.end === 12 && c.root === 5)).toBe(true);
  });

  it('déplacer le Couplet après le Refrain : l\'ordre change, la durée totale aussi pareille', () => {
    const s = song();
    const { state } = applyTimeOp(s, op({ kind: 'section', mode: 'move', start: 2, end: 6, to: 10 }));
    const names = [...state.markers].sort((a, b) => a.time - b.time).map(m => [m.name, m.time]);
    expect(names).toEqual([['Refrain', 2], ['Couplet', 6], ['Outro', 10]]);
    const beat = state.tracks.find(t => t.id === 'beat')!;
    expect(beat.clips.reduce((a, c) => a + c.duration, 0)).toBeCloseTo(16, 9);
    expect(Math.max(...beat.clips.map(c => c.start + c.duration))).toBeCloseTo(16, 9);
  });

  it('section qui contient un changement de tempo : il est recopié avec elle', () => {
    const s = { ...song(), tempoEvents: [{ id: 'tp4', bar: 4, bpm: 90 }] };
    // Mesures 3-4 (index 2..3) à 120 puis 4..∞ à 90 ; section [4 s, 8 s + 0] = mesures 2-3 ; on copie [6, 10.666] = mesures 3-4 (120 puis 90).
    const m = buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);
    const a = barToTime(m, 3), b = barToTime(m, 5);
    const { state, report } = applyTimeOp(s, op({ kind: 'section', mode: 'copy', start: a, end: b, to: b }));
    expect(report.exactTempo).toBe(true);
    const m1 = buildTempoMap(state.bpm, state.timeSignature, state.tempoEvents);
    // La copie (mesures 5-6) : 120 puis 90 BPM, même durée que l'original.
    expect(barToTime(m1, 7) - barToTime(m1, 5)).toBeCloseTo(b - a, 12);
    expect(m1.segments.find(x => x.bar === 5)!.bpm).toBe(120);
    expect(m1.segments.find(x => x.bar === 6)!.bpm).toBe(90);
  });

  it('destination dans la section : rien ne bouge', () => {
    const s = song();
    expect(applyTimeOp(s, op({ kind: 'section', mode: 'move', start: 2, end: 6, to: 4 })).state).toBe(s);
  });
});

describe('Collaboration : une opération, même résultat chez tous', () => {
  it('JSON aller-retour, vérifiée, identifiants identiques', () => {
    const o = op({ kind: 'section', mode: 'copy', start: 6, end: 10, to: 10 });
    const wire = sanitizeTimeOp(JSON.parse(JSON.stringify(o)))!;
    expect(wire).toEqual(o);
    const a = applyTimeOp(song(), o).state;
    const b = applyTimeOp(song(), wire).state;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('opération invalide refusée', () => {
    expect(sanitizeTimeOp({ kind: 'insert', id: 'x', at: 'a', length: 1, tracks: 'all' })).toBeNull();
    expect(sanitizeTimeOp({ kind: 'section', id: 'x', mode: 'eval', start: 0, end: 1, to: 2 })).toBeNull();
    expect(sanitizeTimeOp({ kind: 'delete', start: 0, end: 1, tracks: 'all' })).toBeNull();
  });
});
