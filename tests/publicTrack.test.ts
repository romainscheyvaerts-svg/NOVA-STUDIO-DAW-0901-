import { describe, expect, it } from 'vitest';
import {
  embedCode, embedUrl, fmtDuration, parsePublicLocation, playsText, publicErrorCode, publicErrorView, publicTrackUrl, publishChoices,
} from '../utils/publicTrack';

describe('Lot 9b · page publique d’un morceau', () => {
  it('adresses de la page et du lecteur intégrable', () => {
    expect(publicTrackUrl('abcde12345', 'https://nova.example')).toBe('https://nova.example/morceau.html?m=abcde12345');
    expect(embedUrl('abcde12345', 'https://nova.example/')).toBe('https://nova.example/morceau.html?m=abcde12345&embed=1');
    const code = embedCode('abcde12345', 'https://nova.example/', 'Nuit "blanche" <3');
    expect(code).toMatch(/^<iframe src="https:\/\/nova\.example\/morceau\.html\?m=abcde12345&embed=1"/);
    expect(code).toContain('title="Nuit &quot;blanche&quot; &lt;3 · NOVA Studio"');
    expect(code).not.toContain('<3');
    expect(parsePublicLocation('?m=abcde12345&embed=1')).toEqual({ id: 'abcde12345', embed: true });
    expect(parsePublicLocation('?m=ABC')).toEqual({ id: null, embed: false });
  });

  it('le morceau entier seulement si l’export est débloqué, sinon l’extrait (avec la raison)', () => {
    expect(publishChoices({ unlocked: true })).toEqual({ mix: true, why: null });
    expect(publishChoices({ unlocked: false, reason: 'catalogue_non_achete' }).why).toMatch(/instru du catalogue/);
    expect(publishChoices({ unlocked: false, reason: 'paiement' }).why).toMatch(/Nova Pro ou export/);
    expect(publishChoices(null).mix).toBe(false);
  });

  it('erreurs, durées, écoutes', () => {
    expect(publicErrorCode(410, 'unpublished')).toBe('unpublished');
    expect(publicErrorCode(410, undefined)).toBe('unpublished');
    expect(publicErrorCode(404, undefined)).toBe('unknown');
    expect(publicErrorView('unpublished').title).toMatch(/n’est plus publié/);
    expect(publicErrorView('network').retry).toBe(true);
    expect(fmtDuration(72)).toBe('1:12');
    expect(playsText(1)).toBe('1 écoute');
    expect(playsText(12)).toBe('12 écoutes');
  });
});
