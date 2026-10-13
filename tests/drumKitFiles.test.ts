import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isKitContainer, openKitContainer } from '../utils/drumKitCodec';
import { parseKitIndex, searchKitSounds, tuneToRoot, midiNoteName } from '../utils/drumKitLibrary';

/**
 * Kits NOVA : les fichiers publiés (public/drums/kits) et leur index (data/drum-kits/index.json),
 * produits par tools/kits/prepare_kits.py.
 * - Aucun nom d'origine (producteur, pack, fichier) dans ce qui est publié.
 * - Fichiers brouillés : ni FLAC ni WAV lisible tel quel (ni « fLaC » ni « RIFF » en tête).
 * - Une fois ouverts : un FLAC sans aucune métadonnée de la source.
 * - Budget : 300 Mo au plus.
 */

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'public', 'drums', 'kits');
const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'drum-kits', 'index.json'), 'utf-8'));
const ix = parseKitIndex(raw);
const files = readdirSync(DIR);

describe('Kits NOVA · fichiers publiés', () => {
  it('un fichier .nks par son de l’index, rien de plus, noms courts et sûrs', () => {
    expect(ix.sounds.length).toBeGreaterThan(1500);
    expect(files.length).toBe(ix.sounds.length);
    expect(new Set(files)).toEqual(new Set(ix.sounds.map(s => `${s.id}.nks`)));
    for (const f of files) expect(f).toMatch(/^[a-z0-9]+-[0-9a-f]{8}\.nks$/);
  });

  it('aucun fichier ne commence par fLaC ni RIFF (conteneur brouillé « NVK1 »)', () => {
    for (const f of files) {
      const b = readFileSync(join(DIR, f));
      const head = b.subarray(0, 4).toString('latin1');
      expect(head, f).not.toBe('fLaC');
      expect(head, f).not.toBe('RIFF');
      expect(isKitContainer(new Uint8Array(b)), f).toBe(true);
    }
  });

  it('taille totale sous le budget de 300 Mo (et égale à celle annoncée dans l’index)', () => {
    const total = files.reduce((n, f) => n + statSync(join(DIR, f)).size, 0);
    expect(total).toBe(raw.totalBytes);
    expect(total).toBeLessThan(300 * 1024 * 1024);
  });

  it('ouvert en mémoire : un vrai FLAC, sans aucune métadonnée de la source (pas de tags)', async () => {
    const pick = [files[0], files[Math.floor(files.length / 2)], files[files.length - 1]];
    for (const f of pick) {
      const b = readFileSync(join(DIR, f));
      const flac = new Uint8Array(await openKitContainer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
      expect(String.fromCharCode(...flac.subarray(0, 4))).toBe('fLaC');
      // Blocs de métadonnées FLAC : STREAMINFO (0), éventuellement PADDING (1), SEEKTABLE (3) et un
      // VORBIS_COMMENT (4) qui ne doit contenir AUCUN commentaire (seul le nom de l'encodeur).
      let p = 4, last = false;
      while (!last) {
        last = (flac[p] & 0x80) !== 0;
        const type = flac[p] & 0x7f;
        const len = (flac[p + 1] << 16) | (flac[p + 2] << 8) | flac[p + 3];
        expect([0, 1, 3, 4], `${f} bloc ${type}`).toContain(type);
        if (type === 4) {
          const dv = new DataView(flac.buffer, flac.byteOffset + p + 4, len);
          const vendorLen = dv.getUint32(0, true);
          expect(dv.getUint32(4 + vendorLen, true), `${f} : commentaires`).toBe(0);
        }
        p += 4 + len;
      }
    }
  });
});

describe('Kits NOVA · index', () => {
  const text = JSON.stringify(raw);
  it('aucune trace de l’origine : ni producteur, ni pack, ni nom de fichier, ni @', () => {
    expect(text).not.toMatch(/@|\.wav|\.asd|bwb|drumkeyz|bigwhite|big white|szn|wave ?4|zenhiser|ghosty|kshmr|chuki|lrs|ableton|starboy|loop/i);
  });
  it('noms génériques numérotés : « Kick 1 », « 808 12 »… et kits « Trap 3 », « Kit 2 »', () => {
    for (const s of ix.sounds) expect(s.name).toMatch(/^(Kick|Snare|Clap|Snap|Rim|Hi-hat|Open hat|Roll|Crash|Tom|Perc|Shaker|808|Bass|Fill|Vox|One-shot|Bongo|Conga|Djembé|Dundun|Balafon|Kalimba|Marimba|Udu) \d+$/);
    expect(ix.kits.length).toBeGreaterThan(20);
    for (const k of ix.kits) expect(k.name).toMatch(/^(Trap|Drill|Afro|Detroit \/ Jerk|Boom bap|Pop|Kit) \d+$/);
  });
  it('numéros uniques par catégorie (un son retiré laisse un trou, les autres gardent leur numéro), compteurs justes', () => {
    for (const c of ix.categories) {
      const nums = ix.sounds.filter(s => s.cat === c.id).map(s => s.num);
      expect(nums.length).toBe(c.count);
      expect(new Set(nums).size).toBe(nums.length);
      expect(Math.min(...nums)).toBeGreaterThanOrEqual(1);
    }
  });
  it('chaque kit a kick + snare et ne cite que des sons de l’index', () => {
    for (const k of ix.kits) {
      expect(k.pads.kick).toBeTruthy();
      expect(k.pads.snare || k.pads.clap).toBeTruthy();
      for (const id of Object.values(k.pads)) expect(ix.byId.has(id!)).toBe(true);
    }
  });
  it('808 et basses : hauteur connue pour presque toutes (réaccord sur la tonique)', () => {
    const pitched = ix.sounds.filter(s => s.cat === '808' || s.cat === 'bass');
    expect(pitched.filter(s => s.midi).length / pitched.length).toBeGreaterThan(0.95);
    for (const s of pitched) if (s.midi) expect(s.midi).toBeGreaterThanOrEqual(12);
  });
});

describe('Kits NOVA · recherche et accordage', () => {
  it('recherche : « kick 12 », catégorie, style, note en français', () => {
    expect(searchKitSounds(ix, { text: 'kick 12' }).map(s => s.name)).toEqual(['Kick 12']);
    expect(searchKitSounds(ix, { cat: 'conga' }).every(s => s.cat === 'conga')).toBe(true);
    expect(searchKitSounds(ix, { text: 'afro' }).length).toBeGreaterThan(50);
    const fa = searchKitSounds(ix, { text: '808 fa' });
    expect(fa.length).toBeGreaterThan(0);
    expect(fa.every(s => s.cat === '808' && /^F/.test(midiNoteName(s.midi!)))).toBe(true);
    expect(searchKitSounds(ix, { text: 'zzz' })).toEqual([]);
  });
  it('tuneToRoot : au plus près (-6 … +5 demi-tons)', () => {
    expect(tuneToRoot(30 /* F#1 */, 9 /* La */)).toBe(3);
    expect(tuneToRoot(33 /* A1 */, 9)).toBe(0);
    expect(tuneToRoot(36 /* C2 */, 7 /* Sol */)).toBe(-5);
    expect(tuneToRoot(36, 6 /* Fa# */)).toBe(-6);
    expect(tuneToRoot(24, 5)).toBe(5);
  });
});
