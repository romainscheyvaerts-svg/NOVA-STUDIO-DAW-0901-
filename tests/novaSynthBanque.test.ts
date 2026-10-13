import { describe, expect, it } from 'vitest';
import { SYNTH_PRESETS, PRESET_CATEGORIES, presetSettings, previewNotesFor, calibratedLevel, presetById } from '../utils/novaSynthPresets';

/**
 * Banque du synthé NOVA : les 48 sons d'origine ne changent pas (empreinte de leurs
 * réglages complets relevée le 14/10/2026 avant l'ajout des nouveaux sons), et les
 * nouveaux sons sont complets, calibrés et nommés sans marque ni artiste.
 * Les mesures audio (niveau, crête, queue, clics) : qa/synthe_sons.py (vrai moteur).
 */
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };

const AVANT: Record<string, string> = {"rhodes-soul":"937ed0cd","rhodes-lofi":"cacdaa8e","piano-wurli":"cc1b83dc","piano-doux":"298ebcbf","keys-rnb":"122a6c34","orgue-gospel":"059c8c2b","nappe-chaude":"4f57d3bf","nappe-trap-sombre":"26e77152","nappe-aerienne":"ffab8438","nappe-verre":"f5549ca7","nappe-rnb-90s":"8aaa59ec","nappe-evolutive":"84115cb8","pluck-trap":"63cc0db0","pluck-doux":"e63bbc04","pluck-guitare":"c3231c2b","kalimba":"68b620c7","harpe":"ff1e75dd","lead-trap-glisse":"4f7c2151","lead-sifflet":"ff3d7acc","lead-supersaw":"08b6b5a7","lead-carre-retro":"fa9a1368","lead-rnb-sinus":"7c868ca6","lead-acide":"8ed74ceb","cloche-trap":"c50d0202","cloche-sombre":"562b610d","marimba":"2b1b1ddb","vibraphone":"c423d434","boite-a-musique":"09b6d220","cordes-ensemble":"2962b30a","cordes-pizz":"b5eecb49","violon-solo":"0d16b039","cordes-cinema":"48a32351","flute-trap":"f86af22a","flute-de-pan":"6d35a29b","cuivres-synth":"eb5a1aaa","choeur-ah":"9600bb05","choeur-ouh":"baa56de0","voix-angeliques":"a0de07ca","basse-sub":"3a7be672","basse-reese":"11cf53d1","basse-rnb":"9f904c5f","basse-pluck":"5047d8e1","arp-cristal":"a36626a8","arp-scie":"0fca2d27","arp-retro":"b7b3b6f2","arp-nuit":"f86bcb95","nova-saw-classique":"b5bc5e05","init":"dc96eddc"};

// Mots interdits dans les noms et descriptions : marques, synthés connus, artistes.
const INTERDITS = /serum|vital|juno|roland|korg|moog|yamaha|nord|sylenth|massive|omnisphere|nexus|spire|fl studio|ableton|metro|southside|travis|drake|carti|kanye|dre\b|snoop|burna|wizkid|rema|tems|kabza|maphorisa|skrillex|daft|yeat|ken carson|lil /i;

describe('Banque du synthé NOVA', () => {
  it('les 48 sons d\'origine sonnent exactement comme avant (réglages identiques)', () => {
    for (const [id, h] of Object.entries(AVANT)) {
      expect(presetById(id), id).toBeDefined();
      expect(fnv(JSON.stringify(presetSettings(id))), id).toBe(h);
    }
  });

  const nouveaux = SYNTH_PRESETS.filter(p => p.isNew);
  it('22 nouveaux sons, identifiants uniques, aucun ancien marqué « nouveau »', () => {
    expect(nouveaux).toHaveLength(22);
    expect(SYNTH_PRESETS).toHaveLength(70);
    expect(new Set(SYNTH_PRESETS.map(p => p.id)).size).toBe(SYNTH_PRESETS.length);
    for (const id of Object.keys(AVANT)) expect(presetById(id)!.isNew, id).toBeFalsy();
  });

  it('chaque catégorie a des sons, dont les deux nouvelles', () => {
    for (const c of PRESET_CATEGORIES) expect(SYNTH_PRESETS.some(p => p.cat === c), c).toBe(true);
    expect(SYNTH_PRESETS.filter(p => p.cat === 'Afro & Amapiano').length).toBeGreaterThanOrEqual(3);
    expect(SYNTH_PRESETS.filter(p => p.cat === 'Rage & Hyperpop').length).toBeGreaterThanOrEqual(3);
  });

  it('nouveaux sons : calibrés, noms neutres en français, aperçu jouable', () => {
    for (const p of nouveaux) {
      const lvl = calibratedLevel(p.id);
      expect(lvl, `${p.id} : volume calibré (qa/synthe_sons.py --calibrer)`).toBeGreaterThan(0);
      expect(lvl!).toBeLessThanOrEqual(1);
      expect(presetSettings(p.id).level).toBe(lvl);
      expect(`${p.name} ${p.tip}`, p.id).not.toMatch(INTERDITS);
      expect(p.tip.length, p.id).toBeGreaterThan(20);
      const notes = previewNotesFor(p.id);
      expect(notes.length, p.id).toBeGreaterThan(0);
      for (const n of notes) { expect(n).toBeGreaterThanOrEqual(24); expect(n).toBeLessThanOrEqual(96); }
    }
  });

  it('les sons d\'origine gardent leur aperçu', () => {
    expect(previewNotesFor('basse-sub')).toEqual([36]);
    expect(previewNotesFor('lead-trap-glisse')).toEqual([67]);
    expect(previewNotesFor('kalimba')).toEqual([60, 67, 70, 74]);
    expect(previewNotesFor('rhodes-soul')).toEqual([48, 55, 58, 62, 65]);
  });
});
