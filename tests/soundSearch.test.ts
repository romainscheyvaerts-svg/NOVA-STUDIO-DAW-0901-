import { describe, expect, it } from 'vitest';
import rawKits from '../data/drum-kits/index.json';
import { parseKitIndex } from '../utils/drumKitLibrary';
import {
  bpmCompatible, buildSoundIndex, keyCompatible, loopEntries, parseLoopRef, searchSounds, SOUND_GENRES, SOUND_TYPES, type SoundEntry,
} from '../utils/soundSearch';
import { buildPalette, paletteGenre } from '../utils/loopPalette';
import { BEAT_GENRES } from '../utils/beatRecipes';
import { scalePitchClasses } from '../utils/scales';
import { loopContent } from '../utils/soundPlace';
import { chordPcs } from '../utils/beatStarter';

const ix = parseKitIndex(rawKits as any);
const index = buildSoundIndex(ix);
const pc = (n: number) => ((n % 12) + 12) % 12;

describe('index du navigateur de sons (lot 5a)', () => {
  it('contient les kits NOVA, la batterie du studio, les 6 instruments et les boucles NOVA', () => {
    expect(index.filter(e => e.ref.startsWith('kit:')).length).toBe(ix.sounds.length);
    expect(index.filter(e => e.ref.startsWith('lib:')).length).toBeGreaterThan(50);
    expect(index.filter(e => e.kind === 'instrument').length).toBe(6);
    expect(index.filter(e => e.kind === 'loop').length).toBe(loopEntries().length);
    expect(new Set(index.map(e => e.id)).size).toBe(index.length);
    for (const t of SOUND_TYPES) expect(index.some(e => e.type === t.id), t.id).toBe(true);
    for (const g of SOUND_GENRES) expect(index.some(e => e.genres.includes(g.id)), g.id).toBe(true);
  });

  it('aucune adresse de fichier n’est affichée (nom, détail) : sons protégés', () => {
    for (const e of index) {
      expect(`${e.name} ${e.detail}`, e.id).not.toMatch(/\/(drums|instruments|kits|lib)\b|\.wav|\.nks|\.ogg|\.flac|https?:/i);
    }
  });

  it('recherche : texte, type, genre, favoris', () => {
    const kicks = searchSounds(index, { type: 'kick' });
    expect(kicks.length).toBeGreaterThan(100);
    expect(kicks.every(e => e.type === 'kick')).toBe(true);
    expect(searchSounds(index, { text: 'kick 12' }).some(e => e.name === 'Kick 12')).toBe(true);
    expect(searchSounds(index, { text: 'drill', type: 'chords' }).every(e => e.type === 'chords' && e.genres.some(g => g.startsWith('drill')))).toBe(true);
    expect(searchSounds(index, { text: 'mineur', type: 'chords', key: { root: 9, scale: 'MINOR' } }).every(e => e.key?.root === 9 && e.key.scale !== 'MAJOR')).toBe(true);
    const fav = new Set([kicks[0].id]);
    expect(searchSounds(index, { favs: fav }).map(e => e.id)).toEqual([kicks[0].id]);
    expect(searchSounds(index, { text: 'zzzz' })).toEqual([]);
  });

  it('BPM ±15 % (et half / double time) et tonalité (ou relative) ne trient que les boucles', () => {
    expect(bpmCompatible(140, 140)).toBe(true);
    expect(bpmCompatible(140, 70)).toBe(true);
    expect(bpmCompatible(106, 120)).toBe(true);
    expect(bpmCompatible(75, 140)).toBe(true); // 70 × 2 ≈ 140
    expect(bpmCompatible(90, 120)).toBe(false);
    expect(keyCompatible({ root: 9, scale: 'MINOR' }, { root: 0, scale: 'MAJOR' })).toBe(true);
    expect(keyCompatible({ root: 0, scale: 'MAJOR' }, { root: 9, scale: 'PHRYGIAN' })).toBe(true);
    expect(keyCompatible({ root: 9, scale: 'MINOR' }, { root: 9, scale: 'MAJOR' })).toBe(false);
    const r = searchSounds(index, { bpm: 140, key: { root: 9, scale: 'MINOR' } });
    for (const e of r.filter(x => x.kind === 'loop')) {
      expect(bpmCompatible(e.bpm!, 140)).toBe(true);
      if (e.key) expect(keyCompatible(e.key, { root: 9, scale: 'MINOR' })).toBe(true);
    }
    expect(r.some(e => e.kind === 'oneshot')).toBe(true);
  });

  it('recherche en 200 ms au plus sur 5 000 entrées', () => {
    const big: SoundEntry[] = [];
    while (big.length < 5000) big.push(...index.map((e, i) => ({ ...e, id: `${e.id}#${big.length + i}` })));
    big.length = 5000;
    const queries = [{ text: 'kick' }, { text: '808 fa', type: '808' as const }, { genre: 'drill-uk' as const, bpm: 140 }, { text: 'accords la mineur', key: { root: 9, scale: 'MINOR' as const } }];
    const t0 = performance.now();
    for (const q of queries) searchSounds(big, q);
    const ms = (performance.now() - t0) / queries.length;
    expect(ms).toBeLessThan(200);
  });

  it('chaque boucle se lit (référence valide) et ses notes sont dans sa tonalité ou ses accords', () => {
    for (const e of loopEntries()) {
      expect(parseLoopRef(e.ref), e.ref).not.toBeNull();
      const c = loopContent(e.ref, e.bpm || 120, ix);
      expect(c, e.ref).not.toBeNull();
      if (e.type === 'drums') { expect(c!.dm!.rows.some(r => r.steps.some(v => v > 0))).toBe(true); continue; }
      const scale = scalePitchClasses(e.key!.root, e.key!.scale);
      for (const n of c!.notes) {
        const ch = c!.chords.find(x => n.start >= x.start - 1e-6 && n.start < x.end - 1e-6);
        expect(scale.has(pc(n.pitch)) || (!!ch && chordPcs(ch.root, ch.quality).includes(pc(n.pitch))), `${e.ref} ${n.pitch}`).toBe(true);
      }
    }
  });
});

describe('Palette (lot 5b)', () => {
  it('ne propose JAMAIS une boucle hors tonalité, ni hors tempo (24 tonalités × 6 tempos × 5 graines)', () => {
    for (let root = 0; root < 12; root++) for (const scale of ['MINOR', 'MAJOR'] as const) for (const bpm of [70, 90, 106, 120, 140, 160]) for (let seed = 1; seed <= 5; seed++) {
      const key = { root, scale };
      const p = buildPalette(index, { bpm, key, seed, count: 5 });
      expect(p.items.length, `${root}${scale} ${bpm}`).toBeGreaterThanOrEqual(2);
      expect(p.items.length).toBeLessThanOrEqual(5);
      for (const e of p.items) {
        expect(e.kind).toBe('loop');
        if (e.key) expect(keyCompatible(e.key, key), `${e.ref} pour ${root}${scale}`).toBe(true);
        expect(bpmCompatible(e.bpm!, bpm), `${e.ref} à ${bpm}`).toBe(true);
      }
    }
  });

  it('2 à 5 boucles, batterie + accords + la 808 de la MÊME suite ; le dé change la palette', () => {
    for (const count of [2, 3, 4, 5]) expect(buildPalette(index, { bpm: 140, key: { root: 9, scale: 'MINOR' }, count }).items.length).toBe(count);
    const p = buildPalette(index, { bpm: 140, key: { root: 9, scale: 'MINOR' }, count: 3, seed: 2 });
    expect(p.items.map(e => e.type)).toEqual(['drums', 'chords', 'bassline']);
    const c = parseLoopRef(p.items[1].ref)!, b = parseLoopRef(p.items[2].ref)!;
    expect(c.t === 'chords' && b.t === '808' && c.prog === b.prog && c.root === b.root).toBe(true);
    const sigs = new Set([1, 2, 3, 4, 5, 6].map(seed => buildPalette(index, { bpm: 140, key: { root: 9, scale: 'MINOR' }, seed }).items.map(e => e.id).join('|')));
    expect(sigs.size).toBeGreaterThan(1);
  });

  it('genre déduit du tempo, tonalité proposée quand le projet n’en a pas', () => {
    expect(paletteGenre(90)).toBe('boombap');
    expect(paletteGenre(106)).toBe('afro');
    expect(paletteGenre(140, 'rnb')).toBe('rnb');
    const p = buildPalette(index, { bpm: 106, key: null, seed: 1 });
    expect(p.genre).toBe('afro');
    expect(p.key).toEqual({ root: BEAT_GENRES.find(g => g.id === 'afro')!.defaultRoot, scale: 'MAJOR' });
  });
});
