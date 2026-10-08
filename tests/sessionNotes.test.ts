import { describe, expect, it } from 'vitest';
import { applyNotesFields, changedNotes, notesCount, notesFieldsOf, noteValue, sanitizeNotesOp, withNote, withTrackComment } from '../utils/sessionNotes';
import { makeState, makeTrack } from './helpers/fixtures';

describe('R21 · notes de projet et commentaires de piste', () => {
  it('notes de projet ; les paroles sont celles du prompteur', () => {
    let s = makeState([makeTrack({ id: 'lead', name: 'LEAD' })]);
    s = withNote(s, 'mix', 'voix devant', 'Romain', 5);
    s = withNote(s, 'lyrics', 'Couplet 1');
    expect(s.projectNotes).toMatchObject({ mix: 'voix devant', updatedBy: 'Romain', updatedAt: 5 });
    expect(s.lyrics).toBe('Couplet 1');
    expect(noteValue(s, 'lyrics')).toBe('Couplet 1');
    expect(withNote(s, 'mix', 'voix devant')).toBe(s); // inchangé : même objet
  });

  it('commentaire de piste : posé, retiré si vide', () => {
    const t = withTrackComment(makeTrack({ id: 'a' }), 'SM7B  ');
    expect(t.comment).toBe('SM7B');
    expect('comment' in withTrackComment(t, '')).toBe(false);
  });

  it('collaboration : seuls les champs changés partent ; à l’arrivée le plus récent gagne, les nôtres en attente restent', () => {
    let s = makeState([makeTrack({ id: 'lead', name: 'LEAD' }), makeTrack({ id: 'back', name: 'BACK' })]);
    const known = notesFieldsOf(s);
    s = withNote(s, 'references', 'Réf : « Titre »');
    s = { ...s, tracks: s.tracks.map(t => (t.id === 'lead' ? withTrackComment(t, 'U87') : t)) };
    const out = changedNotes(known, notesFieldsOf(s));
    expect(out).toEqual({ 'p:references': 'Réf : « Titre »', 't:lead': 'U87' });
    // Chez l'autre : reçu et appliqué.
    const other = makeState([makeTrack({ id: 'lead', name: 'LEAD' }), makeTrack({ id: 'back', name: 'BACK' })]);
    const op = sanitizeNotesOp(JSON.parse(JSON.stringify({ fields: { ...out, 'x:bad': 'non', 't:lead2': 5 } })))!;
    expect(Object.keys(op).sort()).toEqual(['p:references', 't:lead']);
    const r = applyNotesFields(other, op);
    expect(r.state.projectNotes?.references).toBe('Réf : « Titre »');
    expect(r.state.tracks[0].comment).toBe('U87');
    expect(r.applied.sort()).toEqual(['p:references', 't:lead']);
    // Champ en attente ici : gardé ; champ plus ancien que le dernier appliqué : ignoré.
    const r2 = applyNotesFields(r.state, { 'p:references': 'vieux', 't:lead': 'vieux' }, k => k !== 't:lead', new Set(['p:references']));
    expect(r2.state.projectNotes?.references).toBe('Réf : « Titre »');
    expect(r2.state.tracks[0].comment).toBe('U87');
    expect(notesCount(r.state)).toBe(2);
  });
});
