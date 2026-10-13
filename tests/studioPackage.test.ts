import { describe, expect, it } from 'vitest';
import { buildStudioNotes, defaultBookingDate, estimateStemsBytes, noteLine, sizeLabel, studioNotesText } from '../utils/studioPackage';

const reg = <T,>(v: T) => ({ v, s: { t: 1, c: 0, by: 'x' } });
const comment = (id: string, t: number, text: string, o: Record<string, any> = {}) => ({
  id, authorKey: 'u:nina', authorName: o.who || 'Nina', createdAt: 1, pos: reg({ t, end: o.end ?? null }), trackId: o.trackId ?? null,
  text: reg(text), status: reg({ s: o.resolved ? 'resolved' : 'open' }), archived: reg(!!o.archived),
  replies: (o.replies || []).map((r: any, i: number) => ({ id: `r${i}`, authorKey: 'u:max', authorName: r.who, createdAt: 2 + i, text: reg(r.text) })),
});

const STATE: any = {
  name: 'Séance du 13 octobre', bpm: 92, projectKey: 'La mineur',
  tracks: [{ id: 'voix', name: 'Voix lead', clips: [], comment: 'SM7B, préampli à 40 %' }, { id: 'beat', name: 'Beat', clips: [] }],
  markers: [{ id: 'm1', name: 'Refrain', time: 32, type: 'REGION', endTime: 48 }, { id: 'm2', name: '', time: 5 }],
  lyrics: 'J\'arrive au studio\nMax lance le beat',
  projectNotes: { mix: 'Voix devant, pas trop de reverb', general: '' },
  timelineComments: [
    comment('c2', 72, 'le « s » siffle', { trackId: 'voix', replies: [{ who: 'Max', text: 'je mets un de-esser' }] }),
    comment('c1', 12.4, 'intro trop longue', { resolved: true }),
    comment('c3', 90, 'vieux commentaire', { archived: true }),
  ],
};

describe('Envoyer au studio · notes horodatées', () => {
  it('commentaires (sans les archivés) et repères, dans l\'ordre du morceau ; puis notes de piste, de séance, paroles', () => {
    const n = buildStudioNotes(STATE);
    expect(n.timed).toBe(3);
    expect(n.notes.map(x => [x.kind, x.t])).toEqual([
      ['commentaire', 12.4], ['repere', 32], ['commentaire', 72], ['piste', null], ['seance', null], ['paroles', null],
    ]);
    expect(n.notes[2]).toMatchObject({ who: 'Nina', track: 'Voix lead', status: 'ouvert', replies: [{ who: 'Max', text: 'je mets un de-esser' }] });
    expect(n.notes[0].status).toBe('resolu');
    expect(n).toMatchObject({ title: 'Séance du 13 octobre', bpm: 92, key: 'La mineur' });
  });

  it('texte lisible pour l\'ingé, avec la demande de réservation', () => {
    const txt = studioNotesText(buildStudioNotes(STATE), { service: 'enregistrement', date: '2026-10-23', slot: 'soir', hours: 3, name: 'Nina', phone: '+32 470 12 34 56', message: 'Refrain à refaire' });
    expect(txt).toContain('Séance du 13 octobre · 92 BPM · La mineur');
    expect(txt).toContain('Demande : Enregistrement avec un ingé son · 2026-10-23 (soir) · 3 h · Nina · +32 470 12 34 56');
    expect(txt).toContain('[0:12,4] Nina : intro trop longue (réglé)');
    expect(txt).toContain('[0:32 → 0:48] Repère : Refrain');
    expect(txt).toContain('[1:12] Nina (Voix lead) : le « s » siffle');
    expect(txt).toContain('↳ Max : je mets un de-esser');
    expect(txt).toContain('Piste « Voix lead » : SM7B, préampli à 40 %');
    expect(txt).toContain('Consignes de mix : Voix devant, pas trop de reverb');
    expect(txt).toContain("PAROLES\nJ'arrive au studio");
    expect(txt).not.toContain('vieux commentaire');
  });

  it('aperçus et tailles lisibles', () => {
    const n = buildStudioNotes(STATE);
    expect(noteLine(n.notes[2])).toBe('1:12 · Nina : le « s » siffle');
    expect(noteLine(n.notes[1])).toBe('0:32 → 0:48 · Repère : Refrain');
    expect(sizeLabel(512)).toBe('1 Ko');
    expect(sizeLabel(5 * 1048576)).toBe('5,0 Mo');
    expect(sizeLabel(3 * 1024 ** 3)).toBe('3,0 Go');
    expect(estimateStemsBytes(10, 180, 48000)).toBe(Math.round(10 * 180 * 48000 * 6 * 0.6));
    expect(defaultBookingDate(new Date(2026, 9, 30))).toBe('2026-11-02');
  });

  it('projet sans notes : rien d\'inventé', () => {
    const n = buildStudioNotes({ name: '', bpm: 120, tracks: [], markers: [], lyrics: '', projectNotes: undefined, timelineComments: undefined } as any);
    expect(n).toMatchObject({ title: 'Projet', notes: [], timed: 0 });
  });
});
