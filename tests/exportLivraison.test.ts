import { describe, expect, it } from 'vitest';
import { safeFileName } from '../utils/exportNaming';
import { reportLine } from '../components/ExportQueueToast';

describe('Livraison : noms de fichiers et rapport de fin', () => {
  it('nom choisi gardé (accents, espaces), caractères interdits → tirets, jamais vide ni réservé', () => {
    expect(safeFileName('Titre: test / mix', 'Master')).toBe('Titre - test - mix');
    expect(safeFileName('Été 2026 (v2)')).toBe('Été 2026 (v2)');
    expect(safeFileName('  Mon son. ', 'x')).toBe('Mon son');
    expect(safeFileName('???', 'Master')).toBe('Master');
    expect(safeFileName('', 'Projet NOVA')).toBe('Projet NOVA');
    expect(safeFileName('CON')).toBe('CON_');
    expect(safeFileName('a\u0007b|c')).toBe('a b - c');
    expect(safeFileName('x'.repeat(300)).length).toBeLessThanOrEqual(120);
  });

  const job = (report: any, files = 1) => ({ id: '1', label: 'Mix', status: 'done', progress: 100, text: '', result: { report, files: Array(files).fill({}), download: { name: 'a.wav' } } }) as any;

  it('mix qui sature : averti, avec quoi faire (avant : seulement « crête vraie 0,1 dBTP »)', () => {
    const l = reportLine(job({ lufs: -9.8, truePeak: 0.1, lra: 0, gainDb: 0, sampleRate: 44100, seconds: 240 }));
    expect(l).toContain('⚠️ Ça sature');
    expect(l).toContain('Au plus fort sans saturer');
    expect(l).toContain('1,1 dB');
  });

  it('mix sous 0 dBTP : aucun avertissement ; stems qui saturent : la piste ou le bus', () => {
    expect(reportLine(job({ lufs: -14, truePeak: -1, lra: 5, gainDb: 0, sampleRate: 44100, seconds: 240 }))).not.toContain('⚠️');
    expect(reportLine(job({ lufs: NaN, truePeak: 2.3, lra: 0, gainDb: 0, sampleRate: 44100, seconds: 240 }, 6))).toContain('baisse la piste ou le bus');
  });
});
