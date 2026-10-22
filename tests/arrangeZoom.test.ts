import { describe, it, expect } from 'vitest';
import { clampZoom, fitRange, scrollForAnchor, sliderToZoom, zoomAnchor, zoomMaxFor, zoomToSlider, ZOOM_MAX, ZOOM_MIN, MAX_CONTENT_PX } from '../utils/arrangeZoom';
import { visibleEnvelope, visibleSamples } from '../utils/waveformPeaks';

/** Zoom de l'arrangement (tour « édition et navigation », 22/10/2026). */
describe('bornes du zoom', () => {
  it('un morceau de 3 min 30 tient dans 1 264 px ; le plus près = 1 échantillon par pixel à 48 kHz', () => {
    expect(1264 / 210).toBeGreaterThan(ZOOM_MIN);
    expect(clampZoom(1264 / 210)).toBeCloseTo(1264 / 210, 6);
    expect(clampZoom(1e9)).toBe(ZOOM_MAX);
    expect(ZOOM_MAX).toBe(48000);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
  });
  it('largeur du contenu sous la limite de Chrome, même pour un long morceau', () => {
    expect(zoomMaxFor(300) * 300).toBeLessThanOrEqual(MAX_CONTENT_PX);
    expect(zoomMaxFor(3600) * 3600).toBeLessThanOrEqual(MAX_CONTENT_PX + 1);
    expect(clampZoom(48000, 3600)).toBeCloseTo(MAX_CONTENT_PX / 3600, 6);
  });
  it('valeur non finie : zoom par défaut', () => {
    expect(clampZoom(NaN)).toBe(40);
  });
});

describe('curseur logarithmique', () => {
  it('aller-retour fidèle et bornes', () => {
    for (const z of [1, 4, 40, 300, 3000, 48000]) expect(sliderToZoom(zoomToSlider(z)) / z).toBeGreaterThan(0.99);
    expect(zoomToSlider(ZOOM_MIN)).toBe(0);
    expect(zoomToSlider(ZOOM_MAX)).toBe(1000);
  });
});

describe('ancre du zoom au clavier', () => {
  it('tête de lecture visible : elle reste au même pixel', () => {
    const a = zoomAnchor({ playhead: 40, scrollLeft: 36 * 100, viewWidth: 1264, zoom: 100 });
    expect(a).toEqual({ time: 40, px: 400 });
    const z2 = 66.67;
    expect(40 * z2 - scrollForAnchor(a, z2)).toBeCloseTo(400, 6);
  });
  it('tête de lecture hors écran : le milieu de la vue reste au milieu', () => {
    const a = zoomAnchor({ playhead: 0, scrollLeft: 6000, viewWidth: 1000, zoom: 100 });
    expect(a.time).toBeCloseTo(65, 6);
    expect(a.px).toBe(500);
    expect(scrollForAnchor(a, 200)).toBe(65 * 200 - 500);
  });
});

describe('cadrage d’une plage (Z)', () => {
  it('la plage remplit la vue avec 5 % de marge', () => {
    const f = fitRange(10, 20, 1100);
    expect(f.zoom).toBeCloseTo(100, 6);
    expect(f.scroll).toBeCloseTo(9.5 * 100, 6);
  });
});

describe('forme d’onde au plus près', () => {
  const buf = (data: number[]) => ({ length: data.length, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => Float32Array.from(data) }) as unknown as AudioBuffer;
  it('moins d’un échantillon par pixel : l’enveloppe ne disparaît plus', () => {
    const b = buf([0.5, -0.5, 0.25, -0.25]);
    const env = visibleEnvelope(b, 0, 4, 40, 0, 40, false);
    expect(Math.min(...Array.from(env.slice(0, 40)))).toBeGreaterThan(0);
  });
  it('valeurs signées interpolées (passage à zéro visible)', () => {
    const b = buf([1 / 1.3, -1 / 1.3]);
    const v = Array.from(visibleSamples(b, 0, 2, 20, 0, 20, false).slice(0, 20));
    expect(v[0]).toBeCloseTo(1, 5);
    expect(v[19]).toBeCloseTo(-1, 5);
    expect(v.some(x => x > 0) && v.some(x => x < 0)).toBe(true);
    const r = Array.from(visibleSamples(b, 0, 2, 20, 0, 20, true).slice(0, 20));
    expect(r[0]).toBeCloseTo(-1, 5);
  });
});

import { fitTrackHeight, isCompactHeight, stepTrackHeight, TRACK_HEIGHTS } from '../utils/trackHeights';
describe('hauteur des pistes : Micro et Compacte', () => {
  it('Micro (24 px) et Compacte (44 px) existent, en-tête d’une ligne sous 72 px', () => {
    expect(TRACK_HEIGHTS[0].px).toBe(24);
    expect(stepTrackHeight(72, -1)).toBe(44);
    expect(stepTrackHeight(44, -1)).toBe(24);
    expect(isCompactHeight(44)).toBe(true);
    expect(isCompactHeight(72)).toBe(false);
  });
  it('Z sans sélection : 60 pistes dans 724 px = hauteur Micro ; 6 pistes = hauteur Moyenne au plus', () => {
    expect(fitTrackHeight(724, 60)).toBe(24);
    expect(fitTrackHeight(724, 20)).toBe(36);
    expect(fitTrackHeight(724, 6)).toBe(120);
  });
});
