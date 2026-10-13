import { describe, expect, it } from 'vitest';
import { fmtHitTime, hitNotice, hitWhere, isExplicitWordQuery, parseWordQuery, searchTakeWords, wordMatchCost } from '../utils/voiceSearch';
import { makeClip, makeTrack } from './helpers/fixtures';
import type { ClipTranscript } from '../types';

/** Mots d'une phrase, posés à partir de t0 (0,4 s par mot, temps du son). */
const words = (text: string, t0: number, step = 0.4) => text.split(' ').map((w, i) => ({ w, s: t0 + i * step, e: t0 + i * step + 0.3, ...(i === 0 ? { b: true } : {}) }));
const tr = (ws: ReturnType<typeof words>, bufferId: string): ClipTranscript => ({ version: 1, language: 'fr', model: 'large-v3-turbo', words: ws, bufferId, at: 1 });

const T1 = [...words("Je me suis senti comme avant, bloqué,", 1), ...words("J'arrive, j'arrive, ouvre la porte", 5)];
const T2 = [...words('Tu prends toute la place', 0.5), ...words("Et quand j'arrive tout s'efface", 3)];

const project = () => {
  const p1 = makeClip({ id: 'p1', name: 'Prise 1', takeNumber: 1, start: 10, offset: 0, duration: 12, bufferId: 'b1', transcript: tr(T1, 'b1') });
  // Prise 2 : non retenue dans le comp (mutée), rognée de 2 s au début.
  const p2 = makeClip({ id: 'p2', name: 'Prise 2', takeNumber: 2, start: 40, offset: 2, duration: 8, isMuted: true, bufferId: 'b2', transcript: tr(T2, 'b2') });
  const lead = makeTrack({ id: 'lead', name: 'Lead', clips: [p1, p2], takeMeta: [{ n: 2, name: 'Prise propre' }] });
  // Autre playlist (non active) de la piste « Back ».
  const old = makeClip({ id: 'old', name: 'Back v1', start: 60, offset: 0, duration: 10, bufferId: 'b3', transcript: tr(words("Oui j'arrive bientôt", 1), 'b3') });
  const back = makeTrack({ id: 'back', name: 'Back', clips: [], activePlaylistId: 'pl-a', playlists: [{ id: 'pl-a', name: 'BACK', clips: [] }, { id: 'pl-b', name: 'BACK.01', clips: [old] }] });
  return [lead, back];
};

describe('B7 · recherche d’un mot dans les prises', () => {
  it('lit la demande : verbe, guillemets, ponctuation', () => {
    expect(parseWordQuery('trouver "j\'arrive"')).toEqual(["j'arrive"]);
    expect(parseWordQuery('chercher « J’arrive »')).toEqual(["j'arrive"]);
    expect(parseWordQuery('  ouvre la porte ')).toEqual(['ouvre', 'la', 'porte']);
    expect(isExplicitWordQuery('trouver arrive')).toBe(true);
    expect(isExplicitWordQuery('"porte"')).toBe(true);
    expect(isExplicitWordQuery('exporter')).toBe(false);
  });

  it('compare sans casse ni apostrophe, tolère une faute sur un mot long, accepte un mot en cours de frappe', () => {
    expect(wordMatchCost("j'arrive", "j'arrive")).toBe(0);
    expect(wordMatchCost("j'arrive", 'jarrive')).toBe(0);
    expect(wordMatchCost('bloque', 'bloquer')).toBe(0.5);
    expect(wordMatchCost('la', 'le')).toBe(1);
    expect(wordMatchCost('arr', "arrive", true)).toBe(0.25);
    expect(wordMatchCost('arr', "arrive", false)).toBe(1);
  });

  it('« trouver "j\'arrive" » : chaque endroit chanté, au temps du morceau, prise entendue d’abord', () => {
    const hits = searchTakeWords(project(), 'trouver "j\'arrive"');
    expect(hits.map(h => [h.clipId, h.t])).toEqual([
      ['p1', 15], ['p1', 15.4], // prise 1 (entendue), 10 + 5 s et 10 + 5,4 s
      ['p2', 41.8], // prise 2 mutée : mot à 3,8 s du son, clip rogné de 2 s → 40 + 1,8
      ['old', 61.4], // autre playlist en dernier
    ]);
    const [a, , c, d] = hits;
    expect(a).toMatchObject({ trackName: 'Lead', take: 'Prise 1', audible: true, exact: true, text: "J'arrive,", after: "j'arrive, ouvre la" });
    expect(a.before).toBe('comme avant, bloqué,');
    expect(c).toMatchObject({ take: 'Prise propre', audible: false });
    expect(d).toMatchObject({ playlist: 'BACK.01', trackId: 'back', audible: false });
    expect(hitWhere(a)).toBe('Lead · Prise 1 · 0:15.0');
    expect(hitNotice(a)).toContain('Espace pour écouter');
    expect(hitNotice(c)).toContain('mutée');
    expect(hitNotice(d)).toContain('autre playlist');
  });

  it('plusieurs mots : la suite entière, dans l’ordre', () => {
    const hits = searchTakeWords(project(), 'ouvre la porte');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ clipId: 'p1', text: 'ouvre la porte', exact: true });
    expect(hits[0].t).toBeCloseTo(15.8, 5);
    expect(hits[0].e).toBeCloseTo(16.9, 5);
    expect(searchTakeWords(project(), 'porte la ouvre')).toHaveLength(0);
  });

  it('un mot rogné hors du clip, un son remplacé ou un clip inversé ne sont pas proposés', () => {
    const [lead, back] = project();
    // « Tu prends toute la place » est avant le rognage de la prise 2 (0,5 à 2,1 s du son).
    expect(searchTakeWords([lead, back], 'prends toute').length).toBe(0);
    const swapped = { ...lead, clips: lead.clips.map(c => (c.id === 'p1' ? { ...c, bufferId: 'autre' } : c)) };
    expect(searchTakeWords([swapped], 'ouvre la porte')).toHaveLength(0);
    const reversed = { ...lead, clips: lead.clips.map(c => (c.id === 'p1' ? { ...c, isReversed: true } : c)) };
    expect(searchTakeWords([reversed], 'ouvre la porte')).toHaveLength(0);
  });

  it('faute de transcription tolérée, mais l’exact passe devant', () => {
    const hits = searchTakeWords(project(), 'bloquer');
    expect(hits[0]).toMatchObject({ clipId: 'p1', exact: false, text: 'bloqué,' });
    expect(searchTakeWords(project(), 'a')).toEqual([]);
    expect(searchTakeWords(project(), 'arrive', { limit: 2 })).toHaveLength(2);
  });

  it('formate le temps', () => {
    expect(fmtHitTime(72.44)).toBe('1:12.4');
    expect(fmtHitTime(5)).toBe('0:05.0');
  });
});
