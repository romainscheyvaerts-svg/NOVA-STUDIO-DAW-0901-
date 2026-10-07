import { describe, expect, it } from 'vitest';
import { novaAttention, tipPillLabel } from '../utils/novaAttention';

const pc = { isOpen: false, isRecording: false, isMobile: false };

describe('novaAttention (G1 : Nova ne s’ouvre plus seule)', () => {
  it('conseil après une prise : pastille, jamais d’ouverture', () => {
    expect(novaAttention('tip', pc)).toBe('pill');
    expect(novaAttention('tip', { ...pc, isRecording: true })).toBe('pill');
  });
  it('pendant une prise : aucun bandeau', () => {
    expect(novaAttention('notice', { ...pc, isRecording: true })).toBe('none');
    expect(novaAttention('tip', { ...pc, isMobile: true, isRecording: true })).toBe('none');
  });
  it('Nova déjà ouverte : rien de plus', () => {
    expect(novaAttention('tip', { ...pc, isOpen: true })).toBe('none');
    expect(novaAttention('notice', { ...pc, isOpen: true })).toBe('none');
  });
  it('annonce courte hors prise : bandeau', () => {
    expect(novaAttention('notice', pc)).toBe('toast');
    expect(novaAttention('tip', { ...pc, isMobile: true })).toBe('toast');
  });
  it('libellé', () => {
    expect(tipPillLabel(1)).toBe('1 conseil');
    expect(tipPillLabel(3)).toBe('3 conseils');
  });
});
