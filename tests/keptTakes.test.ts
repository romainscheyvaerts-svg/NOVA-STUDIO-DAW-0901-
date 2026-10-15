import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));
vi.mock('../services/SessionCloud', () => ({ call: async () => ({}), sha1: async () => 'hash', CHUNK: 1024 * 1024 }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { contentOf } from '../services/Collab';
import {
  clearKept, colorKept, isKept, keepAside, keptCount, keptLanes, keptMetas, keptZoneHeight, KEPT_HEAD_H, lastTakeNumber,
  dropSlivers, nextStars, putKeptOnTrack, rateKept, sanitizeKept, starsLabel, takeOfClip, unkeep,
} from '../utils/keptTakes';
import { compSwipe, readComp } from '../utils/comping';
import { keepTake, listLanes, mergeIncomingTakeMeta, renameTake, deleteTake } from '../utils/playlists';
import { createPlaylist, switchPlaylist } from '../utils/trackPlaylists';
import { recordChange, UndoHistory } from '../utils/undoHistory';
import { repairProject } from '../utils/projectRepair';
import { Clip, TakeMeta, Track } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

/**
 * 📌 Prises gardées : une prise gardée EST une prise du comp (clips muets sous la
 * voix finale) ; seul le repère `takeMeta[].kept` s'ajoute. Tout le reste (écoute,
 * « Mettre sur la piste », comp depuis une ligne, sauvegarde, annulation,
 * collaboration) passe par les chemins existants.
 */

const take = (n: number, start: number, dur: number, over: Partial<Clip> = {}) =>
  makeClip({ id: `t${n}`, takeNumber: n, name: `Prise ${n}`, start, duration: dur, offset: 0, bufferId: `b${n}`, fadeIn: 0.01, fadeOut: 0.01, ...over });

/** 4 prises au même endroit (comme 4 REC d'affilée) : la dernière s'entend, les autres sont muettes. */
const session = (): Track => makeTrack({
  id: 'lead', name: 'Voix lead',
  clips: [take(1, 4, 20, { isMuted: true }), take(2, 4, 20, { isMuted: true }), take(3, 4, 20, { isMuted: true }), take(4, 4, 20), makeClip({ id: 'beat', name: 'Beat' })],
  takeMeta: [1, 2, 3, 4].map(n => ({ n, recordedAt: 1000 * n })),
});
/** Clips qu'on entend (le moteur et l'export sautent les clips muets). */
const audible = (t: Track) => t.clips.filter(c => !c.isMuted);
const audibleTakes = (t: Track) => audible(t).map(c => c.takeNumber).filter(Boolean);

describe('📌 garder, renommer, noter, colorer', () => {
  it('garder 3 prises : la zone grandit d’une ligne par prise, dans l’ordre où on les garde (en bas)', () => {
    const t = session();
    t.takeMeta = keepAside(t.takeMeta, 2, 10);
    expect(keptCount(t)).toBe(1);
    t.takeMeta = keepAside(t.takeMeta, 4, 20);
    t.takeMeta = keepAside(t.takeMeta, 1, 30);
    expect(keptLanes(t).map(l => l.n)).toEqual([2, 4, 1]);
    expect(keptZoneHeight({ kept: 3, open: true, armedWithTakes: true, laneH: 44 })).toBe(KEPT_HEAD_H + 3 * 44);
    expect(keptZoneHeight({ kept: 3, open: false, armedWithTakes: true, laneH: 44 })).toBe(KEPT_HEAD_H);
    expect(keptZoneHeight({ kept: 0, open: true, armedWithTakes: true, laneH: 44 })).toBe(KEPT_HEAD_H);
    expect(keptZoneHeight({ kept: 0, open: true, armedWithTakes: false, laneH: 44 })).toBe(0);
    // Garder deux fois la même : rien ne change (pas de ligne en double).
    const again = keepAside(t.takeMeta, 4, 99);
    expect(again).toBe(t.takeMeta);
    // Les autres infos de la prise sont gardées (heure d'enregistrement).
    expect(keptMetas(t).find(m => m.n === 2)?.recordedAt).toBe(2000);
  });

  it('garder ne touche jamais au son : mêmes clips, rien de plus audible', () => {
    const t = session();
    const before = JSON.stringify(t.clips);
    t.takeMeta = keepAside(keepAside(keepAside(t.takeMeta, 1, 1), 2, 2), 3, 3);
    expect(JSON.stringify(t.clips)).toBe(before);
    expect(audibleTakes(t)).toEqual([4]);
  });

  it('renommer (nom partagé avec le couloir), noter de 1 à 3 étoiles, couleur', () => {
    const t = session();
    t.takeMeta = keepAside(t.takeMeta, 3, 1);
    t.takeMeta = renameTake(t.takeMeta, 3, 'Refrain propre');
    t.takeMeta = rateKept(t.takeMeta, 3, 2);
    t.takeMeta = colorKept(t.takeMeta, 3, '#F472B6');
    const [l] = keptLanes(t);
    expect([l.name, l.stars, l.color]).toEqual(['Refrain propre', 2, '#f472b6']);
    expect(listLanes(t).find(x => x.n === 3)?.name).toBe('Refrain propre');
    expect(starsLabel(l.stars)).toBe('★★☆');
    // Même étoile touchée une 2e fois : la note s'enlève ; bornes 0..3.
    expect(nextStars(2, 2)).toBe(0);
    expect(nextStars(2, 3)).toBe(3);
    t.takeMeta = rateKept(t.takeMeta, 3, 9);
    expect(keptLanes(t)[0].stars).toBe(3);
    t.takeMeta = rateKept(t.takeMeta, 3, 0);
    expect(keptLanes(t)[0].stars).toBe(0);
    // Couleur invalide : retour à la couleur par défaut.
    t.takeMeta = colorKept(t.takeMeta, 3, 'rouge');
    expect(keptLanes(t)[0].color).toMatch(/^#[0-9a-f]{6}$/);
    // Noter une prise qui n'est pas gardée : rien.
    expect(rateKept(t.takeMeta, 1, 3).find(m => m.n === 1)?.kept).toBeUndefined();
  });

  it('retirer une ligne, vider la zone : les prises restent dans les couloirs', () => {
    const t = session();
    t.takeMeta = keepAside(keepAside(t.takeMeta, 1, 1), 2, 2);
    t.takeMeta = unkeep(t.takeMeta, 1);
    expect(keptLanes(t).map(l => l.n)).toEqual([2]);
    t.takeMeta = clearKept(t.takeMeta);
    expect(keptCount(t)).toBe(0);
    expect(listLanes(t).map(l => l.n)).toEqual([1, 2, 3, 4]);
    expect(t.takeMeta.find(m => m.n === 2)?.recordedAt).toBe(2000);
  });

  it('dernière prise (raccourci, bandeau, cabine) et prise d’un clip (glisser dans la zone)', () => {
    const t = session();
    expect(lastTakeNumber(t)).toBe(4);
    t.clips = [...t.clips, take(5, 30, 4)];
    expect(lastTakeNumber(t)).toBe(5); // plus récente sans heure : le numéro décide
    expect(lastTakeNumber(makeTrack({ clips: [makeClip({ id: 'x', name: 'Beat' })] }))).toBeNull();
    expect(takeOfClip(t.clips[1])).toBe(2);
    expect(takeOfClip(makeClip({ name: 'Beat' }))).toBeNull();
  });

  it('une prise supprimée quitte la zone (pas de ligne fantôme)', () => {
    const t = session();
    t.takeMeta = keepAside(keepAside(t.takeMeta, 2, 1), 3, 2);
    const r = deleteTake(t, 2);
    const after = { ...t, clips: r.clips, takeMeta: r.takeMeta };
    expect(keptLanes(after).map(l => l.n)).toEqual([3]);
    expect(isKept(after, 2)).toBe(false);
  });
});

describe('📌 choisir : écouter, mettre sur la piste, comp depuis une ligne', () => {
  it('« Mettre sur la piste » : la prise 2 gardée remplace la prise courante, les autres restent gardées', () => {
    const t = session();
    t.takeMeta = keepAside(keepAside(keepAside(t.takeMeta, 1, 1), 2, 2), 3, 3);
    t.clips = keepTake(t.clips, 2);
    expect(audibleTakes(t)).toEqual([2]);
    expect(keptLanes(t).map(l => [l.n, l.used > 0.05])).toEqual([[1, false], [2, true], [3, false]]);
  });

  it('« Mettre sur la piste » ne laisse pas dépasser un bout de l’ancienne prise (30 ms), mais garde un vrai passage', () => {
    // La prise 4 (entendue) finit 30 ms après la prise 2 : sans nettoyage, on entendrait 30 ms de la 4.
    const t = makeTrack({ id: 'lead', clips: [take(2, 0, 7, { isMuted: true }), take(4, 0, 7.03)] });
    expect(keepTake(t.clips, 2).filter(c => !c.isMuted).map(c => c.takeNumber)).toEqual([2, 4]);
    const put = putKeptOnTrack(t.clips, 2);
    expect(put.filter(c => !c.isMuted).map(c => c.takeNumber)).toEqual([2]);
    expect(readComp(put).map(s => s.n)).toEqual([2]);
    // La prise 4 reste entière dans son couloir (muette).
    expect(listLanes({ clips: put }).map(l => [l.n, l.end])).toEqual([[2, 7], [4, 7.03]]);
    // Un vrai passage (1 s) de la prise 4 après la fin de la 2 : gardé (c'est la voix).
    const long = makeTrack({ clips: [take(2, 0, 5, { isMuted: true }), take(4, 0, 6)] });
    expect(readComp(putKeptOnTrack(long.clips, 2)).map(s => s.n)).toEqual([2, 4]);
    // Bout coincé entre deux passages de la prise 2 : pas touché (comp voulu).
    expect(dropSlivers(compSwipe(keepTake(long.clips, 2), 4, 2, 2.1).clips, 2).filter(c => !c.isMuted).length).toBeGreaterThan(2);
  });

  it('comp depuis une ligne : un passage de la prise 3 dans la voix finale (crossfades), le reste ne bouge pas', () => {
    const t = session();
    t.takeMeta = keepAside(keepAside(t.takeMeta, 2, 1), 3, 2);
    t.clips = keepTake(t.clips, 2);
    const r = compSwipe(t.clips, 3, 10, 14);
    expect(r.changed).toBe(true);
    t.clips = r.clips;
    const segs = readComp(t.clips).map(s => [s.n, +s.start.toFixed(2), +s.end.toFixed(2)]);
    expect(segs).toEqual([[2, 4, 10], [3, 10, 14], [2, 14, 24]]);
    // Les prises gardées restent entières dans leur ligne (rien d'effacé).
    expect(keptLanes(t).map(l => [l.n, l.start, l.end])).toEqual([[2, 4, 24], [3, 4, 24]]);
  });

  it('export / mix : seules les prises de la piste principale jouent (les gardées sont muettes)', () => {
    const t = session();
    t.takeMeta = keepAside(keepAside(keepAside(t.takeMeta, 1, 1), 2, 2), 3, 3);
    // Sans rien choisir : la dernière prise seulement.
    expect(audibleTakes(t)).toEqual([4]);
    t.clips = keepTake(t.clips, 2);
    // Une seule prise audible à chaque instant (pas de doublage).
    const a = audible(t).filter(c => c.takeNumber);
    for (let x = 4; x < 24; x += 0.5) expect(a.filter(c => c.start <= x && x < c.start + c.duration).length).toBe(1);
  });
});

describe('📌 annulation, sauvegarde, collaboration, playlists', () => {
  it('annuler : chaque geste est une étape (l’état d’avant revient tel quel)', () => {
    const t0 = session();
    let h: UndoHistory<Track> = { past: [], present: t0, future: [] };
    const step = (next: Track) => { h = recordChange({ ...h, lastChangeAt: 0 }, next, 1000, { debounceMs: 400, limit: 50, clean: s => s }); };
    step({ ...h.present, takeMeta: keepAside(h.present.takeMeta, 3, 1) });
    step({ ...h.present, takeMeta: rateKept(h.present.takeMeta, 3, 3) });
    step({ ...h.present, clips: keepTake(h.present.clips, 3) });
    expect(h.past.length).toBe(3);
    expect(audibleTakes(h.present)).toEqual([3]);
    expect(audibleTakes(h.past[2])).toEqual([4]);
    expect(keptLanes(h.past[1])[0].stars).toBe(0);
    expect(keptCount(h.past[0])).toBe(0);
  });

  it('sauvegarde → rechargement (JSON + réparation du projet) : tout revient', () => {
    const t = session();
    t.takeMeta = keepAside(keepAside(keepAside(t.takeMeta, 1, 1), 2, 2), 3, 3);
    t.takeMeta = rateKept(colorKept(renameTake(t.takeMeta, 2, 'La bonne'), 2, '#34d399'), 2, 3);
    t.clips = keepTake(t.clips, 2);
    const saved = JSON.parse(JSON.stringify({ id: 'p', name: 'Séance', bpm: 90, tracks: [t] }));
    const { state } = repairProject(saved);
    const back = state!.tracks.find((x: Track) => x.id === 'lead') as Track;
    expect(keptLanes(back).map(l => [l.n, l.name, l.stars, l.color])).toEqual(keptLanes(t).map(l => [l.n, l.name, l.stars, l.color]));
    expect(audibleTakes(back)).toEqual([2]);
  });

  it('collaboration : le repère voyage dans l’op « content » (takeMeta), vérifié à la réception', () => {
    const t = session();
    t.takeMeta = keepAside(keepAside(t.takeMeta, 1, 111), 3, 222);
    t.takeMeta = rateKept(t.takeMeta, 3, 2);
    const wire = JSON.parse(JSON.stringify(contentOf(t)));
    const other = makeTrack({ id: 'lead', clips: wire.clips });
    other.takeMeta = mergeIncomingTakeMeta(undefined, wire.takeMeta);
    expect(keptLanes(other).map(l => [l.n, l.kept.at, l.stars])).toEqual([[1, 111, 0], [3, 222, 2]]);
    // Données abîmées : ignorées sans casser la piste.
    const bad = mergeIncomingTakeMeta(undefined, [{ n: 1, kept: { at: 'hier' } }, { n: 2, kept: { at: 5, stars: 12, color: 'javascript:' } }]) as TakeMeta[];
    expect(bad.find(m => m.n === 1)?.kept).toBeUndefined();
    expect(bad.find(m => m.n === 2)?.kept).toEqual({ at: 5, stars: 3 });
    expect(sanitizeKept(null)).toBeNull();
    // Contenu envoyé par une ancienne version (sans takeMeta) : nos repères restent.
    expect(mergeIncomingTakeMeta(t.takeMeta, undefined)).toBe(t.takeMeta);
  });

  it('playlists de piste : les prises gardées suivent leur playlist (rangées puis retrouvées)', () => {
    const t = session();
    t.takeMeta = keepAside(t.takeMeta, 2, 1);
    const { track: t2, id } = createPlaylist(t, { stamp: 'x', now: 1 });
    expect(keptCount(t2)).toBe(0); // nouvelle playlist vide : zone vide
    const back = switchPlaylist(t2, 'pl-main');
    expect(keptLanes(back).map(l => l.n)).toEqual([2]);
    expect(id).toBeTruthy();
  });
});
