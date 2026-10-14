import { describe, it, expect } from 'vitest';
import {
  analyzeAudio, runChecks, summarize, checkLoudness, checkTruePeak, checkClipping, checkSilenceStart, checkSilenceEnd, checkDc, checkMono,
  checkFormat, checkDuration, checkMetadata, checkCover, checkLicence, platformOf, gainForPeak, gainToward, applyGainDb, removeDc,
  trimPoints, applyTrim, ceilingFor, splitTitle, sentenceCase, stripEmoji, isValidIsrc, splitNames, SEUILS,
  type DistMeta, type AudioStats,
} from '../utils/distributionCheck';
import { levelWithLimiter } from '../utils/distributionLevel';

/**
 * Lot 12 · contrôle avant distribution : chaque feu est vérifié sur un signal de test
 * (écrêté, blancs, DC, hors phase, trop fort, trop faible…), puis sa correction.
 */
const SR = 44100;
const sine = (sec: number, amp: number, f = 997, sr = SR, phase = 0) => {
  const n = Math.round(sec * sr), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr + phase);
  return x;
};
const cat = (...parts: Float32Array[]) => { const o = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const zeros = (sec: number) => new Float32Array(Math.round(sec * SR));
/** Bruit pseudo-aléatoire reproductible. */
const noise = (sec: number, amp: number, seed = 1) => { let s = seed >>> 0; const n = Math.round(sec * SR), x = new Float32Array(n); for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = amp * ((s / 4294967296) * 2 - 1); } return x; };
/** Bruit « musical » (pas d'écrêtage, pas de plateau), stéréo corrélé. */
const music = (sec: number, amp = 0.25) => { const a = noise(sec, amp, 7), b = noise(sec, amp * 0.3, 9); return [a, a.map((v, i) => v * 0.9 + b[i])]; };
const spotify = platformOf('spotify');
const meta = (p: Partial<DistMeta> = {}): DistMeta => ({ title: 'Nuit blanche', artist: 'Lennon', featuring: '', composers: 'Romain Dupont', producers: '', year: '2026', isrc: '', explicit: false, ...p });

describe('mesures (analyzeAudio)', () => {
  it('sinus propre : loudness BS.1770 cohérente, crête, ni blanc ni DC, mono compatible', () => {
    const s = analyzeAudio([sine(5, 0.5), sine(5, 0.5)], SR);
    // Sinus 1 kHz à −6 dBFS en stéréo : ≈ −6,0 + (−3) + 3 + 0,7 (pondération K) − 0,691 ≈ −6,7 LUFS (pyloudnorm : −6,7).
    expect(s.lufs).toBeGreaterThan(-7.5);
    expect(s.lufs).toBeLessThan(-5.5);
    expect(s.truePeak).toBeCloseTo(-6.02, 0);
    expect(s.overs).toBe(0);
    expect(s.leadSilence).toBeLessThan(0.01);
    expect(s.tailSilence).toBeLessThan(0.01);
    expect(Math.abs(s.dc[0])).toBeLessThan(1e-3);
    expect(s.isMono).toBe(true);
  });
});

describe('écrêtage numérique', () => {
  it('échantillons au-delà de 0 dB : rouge, « Corriger » les ramène sous le plafond', () => {
    const ch = [sine(3, 1.5), sine(3, 1.5)];
    const s = analyzeAudio(ch, SR);
    expect(s.overs).toBeGreaterThan(1000);
    const c = checkClipping(s);
    expect(c.level).toBe('error');
    expect(c.fix?.id).toBe('peak');
    applyGainDb(ch, gainForPeak(s, ceilingFor(s, spotify)));
    const after = analyzeAudio(ch, SR);
    expect(after.overs).toBe(0);
    expect(checkClipping(after).level).toBe('ok');
    expect(checkTruePeak(after, spotify).level).toBe('ok');
  });
  it('plateaux (son déjà écrêté dans le mix, sous 0 dB) : orange, sans correction automatique', () => {
    const x = sine(2, 3).map(v => Math.max(-0.9, Math.min(0.9, v)));
    const c = checkClipping(analyzeAudio([x, x], SR));
    expect(c.level).toBe('warn');
    expect(c.fix).toBeUndefined();
    expect(c.message).toMatch(/clipper|saturation/);
  });
  it('bruit musical sans plateau : vert', () => {
    expect(checkClipping(analyzeAudio(music(3), SR)).level).toBe('ok');
  });
});

describe('crête vraie', () => {
  it('au-dessus de 0 dBTP : rouge ; entre −1 et 0 : orange ; sous −1 : vert', () => {
    expect(checkTruePeak(analyzeAudio([sine(2, 1.05)], SR), platformOf('apple')).level).toBe('error');
    const w = checkTruePeak(analyzeAudio([sine(2, 0.95)], SR), platformOf('apple'));
    expect(w.level).toBe('warn');
    expect(w.fix?.id).toBe('peak');
    expect(checkTruePeak(analyzeAudio([sine(2, 0.8)], SR), platformOf('apple')).level).toBe('ok');
  });
  it('Spotify : master plus fort que −14 LUFS → crête −2 dBTP conseillée', () => {
    const s = analyzeAudio([sine(3, 0.83), sine(3, 0.83)], SR); // ≈ −1,6 dBTP, bien plus fort que −14 LUFS
    expect(ceilingFor(s, spotify)).toBe(SEUILS.spotifyLoudCeiling);
    const c = checkTruePeak(s, spotify);
    expect(c.level).toBe('warn');
    expect(c.message).toMatch(/−2 dBTP/);
  });
  it('signal à pic entre les échantillons (fs/4, phase 45°) : la crête vraie dépasse la crête échantillon', () => {
    const x = sine(1, 1, SR / 4, SR, Math.PI / 4);
    const s = analyzeAudio([x], SR);
    expect(20 * Math.log10(s.samplePeak)).toBeCloseTo(-3, 0);
    // 0 dBTP en vrai (BS.1770, ×4) : l'interpolation cubique de loudness.ts lisait −1,07.
    expect(s.truePeak).toBeGreaterThan(-0.5);
  });
});

describe('loudness par plateforme', () => {
  it('−9 LUFS pour Spotify : orange, « va le baisser de 5 dB, ce n\'est pas grave »', () => {
    const ch = [sine(5, 0.5), sine(5, 0.5)];
    const s0 = analyzeAudio(ch, SR);
    applyGainDb(ch, -9 - s0.lufs);
    const s = analyzeAudio(ch, SR);
    expect(s.lufs).toBeCloseTo(-9, 1);
    const c = checkLoudness(s, spotify);
    expect(c.level).toBe('warn');
    expect(c.message).toMatch(/−9,0 LUFS/);
    expect(c.message).toMatch(/baisser de 5,0 dB/);
    expect(c.message).toMatch(/pas grave/);
    expect(c.fix).toBeUndefined();
  });
  it('trop faible : orange avec « Monter vers −14 LUFS » ; le gain simple suffit si la crête le permet', () => {
    const ch = [sine(5, 0.05), sine(5, 0.05)];
    const s = analyzeAudio(ch, SR);
    const c = checkLoudness(s, spotify);
    expect(c.level).toBe('warn');
    expect(c.fix?.id).toBe('loudness_up');
    const g = gainToward(s, spotify.lufs, spotify.ceiling);
    expect(g.limitedByPeak).toBe(false);
    applyGainDb(ch, g.gainDb);
    expect(checkLoudness(analyzeAudio(ch, SR), spotify).level).toBe('ok');
  });
  it('crête qui bloque le gain : le limiteur NOVA amène vers la cible sans dépasser −1 dBTP', async () => {
    // Fond musical faible avec une attaque très forte par seconde : un simple gain ne peut pas monter.
    const x = noise(6, 0.06, 21);
    for (let i = 0; i < x.length; i += SR) for (let k = 0; k < 8; k++) x[i + k] = 0.95;
    const ch = [x, new Float32Array(x)];
    const s = analyzeAudio(ch, SR);
    expect(gainToward(s, -14, -1).limitedByPeak).toBe(true);
    const r = await levelWithLimiter(ch, SR, -14, -1);
    expect(r.lufs).toBeGreaterThan(-15.5);
    expect(r.truePeak).toBeLessThanOrEqual(-0.95);
  });
  it('silence : rouge', () => {
    expect(checkLoudness(analyzeAudio([zeros(2)], SR), spotify).level).toBe('error');
  });
});

describe('blancs au début et à la fin', () => {
  it('2 s avant, 3 s après : orange, « Couper » garde un souffle et la fin de réverbe', () => {
    let ch = [cat(zeros(2), sine(3, 0.3), zeros(3)), cat(zeros(2), sine(3, 0.3), zeros(3))];
    const s = analyzeAudio(ch, SR);
    expect(s.leadSilence).toBeCloseTo(2, 2);
    expect(s.tailSilence).toBeCloseTo(3, 2);
    expect(checkSilenceStart(s).level).toBe('warn');
    expect(checkSilenceStart(s).fix?.id).toBe('trim_start');
    expect(checkSilenceEnd(s).level).toBe('warn');
    ch = applyTrim(ch, trimPoints(s, SR, ch[0].length, { start: true, end: false }), SR);
    const s1 = analyzeAudio(ch, SR);
    expect(s1.leadSilence).toBeCloseTo(SEUILS.keepHead, 2);
    expect(checkSilenceStart(s1).level).toBe('ok');
    ch = applyTrim(ch, trimPoints(s1, SR, ch[0].length, { start: false, end: true }), SR);
    const s2 = analyzeAudio(ch, SR);
    expect(s2.tailSilence).toBeLessThanOrEqual(SEUILS.keepTail + 0.01);
    expect(checkSilenceEnd(s2).level).toBe('ok');
    expect(s2.duration).toBeCloseTo(3 + SEUILS.keepHead + SEUILS.keepTail, 1);
  });
  it('plus de 10 s de blanc à la fin : rouge (piste cachée, remplissage)', () => {
    expect(checkSilenceEnd(analyzeAudio([cat(sine(2, 0.3), zeros(12))], SR)).level).toBe('error');
  });
  it('0,3 s de blanc : vert', () => {
    const s = analyzeAudio([cat(zeros(0.3), sine(2, 0.3), zeros(0.3))], SR);
    expect(checkSilenceStart(s).level).toBe('ok');
    expect(checkSilenceEnd(s).level).toBe('ok');
  });
});

describe('DC offset', () => {
  it('décalage de 0,05 : rouge ; 0,005 : orange ; « Recentrer » le retire', () => {
    const x = sine(2, 0.3).map(v => v + 0.05);
    const ch = [x, new Float32Array(x)];
    const s = analyzeAudio(ch, SR);
    expect(s.dc[0]).toBeCloseTo(0.05, 3);
    expect(checkDc(s).level).toBe('error');
    expect(checkDc(analyzeAudio([sine(2, 0.3).map(v => v + 0.005)], SR)).level).toBe('warn');
    removeDc(ch);
    expect(checkDc(analyzeAudio(ch, SR)).level).toBe('ok');
  });
  it('un DC ne fausse pas la détection des blancs', () => {
    const x = cat(zeros(2), sine(2, 0.3), zeros(1)).map(v => v + 0.01);
    expect(analyzeAudio([x], SR).leadSilence).toBeCloseTo(2, 1);
  });
});

describe('compatibilité mono (corrélation de phase)', () => {
  it('droite = −gauche (hors phase) : rouge, le morceau disparaît en mono', () => {
    const x = music(3)[0];
    const s = analyzeAudio([x, x.map(v => -v)], SR);
    expect(s.correlation).toBeCloseTo(-1, 3);
    expect(s.monoLossDb!).toBeLessThan(-60);
    const c = checkMono(s);
    expect(c.level).toBe('error');
    expect(c.message).toMatch(/opposition de phase/);
  });
  it('stéréo très large (peu corrélée) : orange', () => {
    const a = noise(3, 0.3, 3), b = noise(3, 0.3, 5);
    const s = analyzeAudio([a, a.map((v, i) => 0.12 * v + b[i])], SR);
    expect(s.correlation!).toBeGreaterThan(0);
    expect(s.correlation!).toBeLessThan(SEUILS.corrWarn);
    expect(checkMono(s).level).toBe('warn');
  });
  it('passages en opposition de phase dans un morceau sinon normal : orange', () => {
    const a = noise(10, 0.3, 11);
    const r = a.map((v, i) => (i > 7.5 * SR ? -v : v));
    const s = analyzeAudio([a, r], SR);
    expect(s.negWindows).toBeGreaterThan(SEUILS.negWindowsWarn);
    expect(checkMono(s).level).not.toBe('ok');
  });
  it('stéréo normale : vert ; mono (G = D) : vert', () => {
    expect(checkMono(analyzeAudio(music(3), SR)).level).toBe('ok');
    const x = sine(2, 0.4);
    const s = analyzeAudio([x, new Float32Array(x)], SR);
    expect(s.isMono).toBe(true);
    expect(checkMono(s).level).toBe('ok');
  });
});

describe('format, durée', () => {
  it('44,1 / 48 kHz en 16 ou 24 bits : vert ; 96 kHz : orange (CD Baby) ; 32 bits : orange', () => {
    expect(checkFormat({ sampleRate: 44100, bits: 24, channels: 2 }).level).toBe('ok');
    expect(checkFormat({ sampleRate: 48000, bits: 16, channels: 2 }).level).toBe('ok');
    const hr = checkFormat({ sampleRate: 96000, bits: 24, channels: 2 });
    expect(hr.level).toBe('warn');
    expect(hr.fix?.id).toBe('rate');
    expect(checkFormat({ sampleRate: 44100, bits: 32, channels: 2 }).fix?.id).toBe('bits');
    expect(checkFormat({ sampleRate: 44100, bits: 24, channels: 2, projectRate: 96000 }).message).toMatch(/converti depuis 96 kHz/);
  });
  it('durées : 20 s orange, 3 min vert, 11 min orange, 45 s orange pour TikTok seulement', () => {
    const st = (d: number) => ({ duration: d }) as AudioStats;
    expect(checkDuration(st(20), spotify).level).toBe('warn');
    expect(checkDuration(st(180), spotify).level).toBe('ok');
    expect(checkDuration(st(660), spotify).level).toBe('warn');
    expect(checkDuration(st(45), platformOf('tiktok')).level).toBe('warn');
    expect(checkDuration(st(45), spotify).level).toBe('ok');
    expect(checkDuration(st(0.5), spotify).level).toBe('error');
  });
});

describe('métadonnées', () => {
  const lv = (m: DistMeta, id: string) => checkMetadata(m, new Date(2026, 9, 14)).find(c => c.id === id)!;
  it('infos complètes : tout vert', () => {
    expect(checkMetadata(meta(), new Date(2026, 9, 14)).every(c => c.level === 'ok')).toBe(true);
  });
  it('titre vide, artiste vide, explicite non répondu : rouges bloquants', () => {
    for (const [m, id] of [[meta({ title: ' ' }), 'title'], [meta({ artist: '' }), 'artist'], [meta({ explicit: null }), 'explicit']] as const) {
      const c = lv(m, id);
      expect(c.level).toBe('error');
      expect(c.blocking).toBe(true);
    }
  });
  it('« feat. » et « prod. » dans le titre : orange, sortis vers les bons champs', () => {
    expect(lv(meta({ title: 'Nuit blanche (feat. Kalia)' }), 'title').fix?.id).toBe('title_feat');
    expect(splitTitle('Nuit blanche (feat. Kalia)', 'feat')).toEqual(['Nuit blanche', 'Kalia']);
    expect(splitTitle('Nuit blanche ft. Kalia & Rems', 'feat')).toEqual(['Nuit blanche', 'Kalia & Rems']);
    expect(lv(meta({ title: 'Nuit blanche [prod. by Zed]' }), 'title').fix?.id).toBe('title_prod');
    expect(splitTitle('Nuit blanche [prod. by Zed]', 'prod')).toEqual(['Nuit blanche', 'Zed']);
    expect(lv(meta({ artist: 'Lennon feat. Kalia' }), 'artist').fix?.id).toBe('artist_feat');
  });
  it('MAJUSCULES, emojis, mentions promo : orange', () => {
    expect(lv(meta({ title: 'NUIT BLANCHE' }), 'title').fix?.id).toBe('title_caps');
    expect(sentenceCase('NUIT BLANCHE')).toBe('Nuit blanche');
    expect(lv(meta({ title: 'Nuit blanche 🔥' }), 'title').fix?.id).toBe('title_emoji');
    expect(stripEmoji('Nuit 🔥 blanche ❤️')).toBe('Nuit blanche');
    expect(lv(meta({ title: 'Nuit blanche (Explicit)' }), 'title').level).toBe('warn');
    expect(lv(meta({ title: 'Drake Type Beat 140 BPM' }), 'title').level).toBe('warn');
  });
  it('ISRC : facultatif, format vérifié', () => {
    expect(lv(meta({ isrc: '' }), 'isrc').level).toBe('ok');
    expect(isValidIsrc('FR-Z03-26-00001')).toBe(true);
    expect(lv(meta({ isrc: 'FR-Z03-26-00001' }), 'isrc').value).toBe('FRZ032600001');
    expect(lv(meta({ isrc: 'FRZ03' }), 'isrc').level).toBe('error');
  });
  it('année et auteurs', () => {
    expect(lv(meta({ year: '26' }), 'year').level).toBe('error');
    expect(lv(meta({ year: '2031' }), 'year').level).toBe('error');
    expect(lv(meta({ year: '2027' }), 'year').level).toBe('ok');
    expect(lv(meta({ composers: '' }), 'composers').level).toBe('warn');
    expect(lv(meta({ composers: 'Romain Dupont, Kalia' }), 'composers').message).toMatch(/Kalia/);
    expect(splitNames('Romain Dupont & Lina Haddad et Zed / Max')).toEqual(['Romain Dupont', 'Lina Haddad', 'Zed', 'Max']);
  });
});

describe('pochette', () => {
  const c = (w: number, h = w, bytes = 2e6, mime = 'image/jpeg') => checkCover({ width: w, height: h, mime, bytes });
  it('aucune : orange ; 3000² : vert ; non carrée : rouge + recadrer', () => {
    expect(checkCover(null).level).toBe('warn');
    expect(c(3000).level).toBe('ok');
    const r = c(3000, 2000);
    expect(r.level).toBe('error');
    expect(r.fix?.id).toBe('cover_square');
  });
  it('trop petite : jamais agrandie (Apple, Spotify) ; trop grande : réduite', () => {
    expect(c(1000).level).toBe('error');
    expect(c(1000).fix).toBeUndefined();
    expect(c(2000).level).toBe('warn');
    expect(c(2000).fix).toBeUndefined();
    expect(c(4000).fix?.id).toBe('cover_square');
    expect(c(3000, 3000, 12e6).level).toBe('warn');
    expect(c(3000, 3000, 1e6, 'image/gif').level).toBe('error');
  });
});

describe('licence (décision du serveur, comme l\'export)', () => {
  const acc = (p: Record<string, unknown>) => ({ unlocked: false, via: null, reason: null, missing: [], login_required: false, ...p }) as any;
  it('instru du catalogue non achetée : rouge bloquant, « Acheter la licence »', () => {
    const c = checkLicence({ admin: false, hasCatalog: true, access: acc({ reason: 'catalogue_non_achete', missing: [{ id: '12', title: 'NOCTAMBULE' }] }) });
    expect(c.level).toBe('error');
    expect(c.blocking).toBe(true);
    expect(c.fix).toEqual({ id: 'buy_licence', label: 'Acheter la licence' });
    expect(c.message).toMatch(/NOCTAMBULE/);
  });
  it('export à payer : rouge « Débloquer l\'export » ; erreur réseau : orange « Réessayer » ; en cours : bloquant', () => {
    expect(checkLicence({ admin: false, hasCatalog: false, access: acc({ reason: 'paiement' }) }).fix?.id).toBe('unlock_export');
    expect(checkLicence({ admin: false, hasCatalog: false, access: acc({ reason: 'erreur' }) }).fix?.id).toBe('retry_licence');
    expect(checkLicence({ admin: false, hasCatalog: false, access: null }).blocking).toBe(true);
  });
  it('licence achetée : vert, avec le rappel Content ID ; admin : vert', () => {
    const ok = checkLicence({ admin: false, hasCatalog: true, access: acc({ unlocked: true, via: 'licence' }) });
    expect(ok.level).toBe('ok');
    expect(ok.message).toMatch(/Content ID/);
    expect(checkLicence({ admin: true, hasCatalog: true, access: null }).level).toBe('ok');
  });
});

describe('ensemble', () => {
  it('runChecks : licence, son, format, infos ; résumé et blocage', () => {
    const stats = analyzeAudio(music(40), SR);
    const base = { platform: spotify, format: { sampleRate: 44100, bits: 24, channels: 2 }, cover: { width: 3000, height: 3000, mime: 'image/jpeg', bytes: 1e6 }, now: new Date(2026, 9, 14) };
    const ok = runChecks({ ...base, stats, meta: meta(), licence: { admin: false, hasCatalog: true, access: { unlocked: true, via: 'licence', reason: null, missing: [], login_required: false } } });
    expect(ok.map(c => c.id)).toEqual(['licence', 'loudness', 'truepeak', 'clipping', 'silence_start', 'silence_end', 'dc', 'mono', 'format', 'duration', 'cover', 'title', 'artist', 'isrc', 'year', 'composers', 'explicit']);
    expect(summarize(ok).ready).toBe(true);
    const ko = runChecks({ ...base, stats, meta: meta({ explicit: null }), licence: { admin: false, hasCatalog: true, access: { unlocked: false, via: null, reason: 'catalogue_non_achete', missing: [], login_required: false } } });
    const s = summarize(ko);
    expect(s.ready).toBe(false);
    expect(s.blocking.map(c => c.id)).toEqual(['licence', 'explicit']);
    // Avant la mesure : pas de feux audio, les infos et la licence sont déjà là.
    expect(runChecks({ ...base, stats: null, meta: meta(), licence: { admin: true, hasCatalog: false, access: null } }).some(c => c.group === 'audio')).toBe(false);
  });
});
