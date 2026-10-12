import { describe, expect, it } from 'vitest';
import {
  appBase, contentSummary, errorCodeOf, expiresIn, fmtClock, hostOf, listenErrorView, listenersOf, listenUrl,
  LISTEN_TTL_OPTIONS, MAX_LISTENERS_PER_LINK, parseListenToken, PUBLIC_APP_BASE, randomKey, visitorsOf,
} from '../utils/listenLink';

const TOKEN = 'AbCdEfGhJkMnPqRsTuVwXyZ234567892'.slice(0, 32);

describe('lien d\'écoute : adresse et jeton', () => {
  it('le jeton est dans le fragment (#t=…), jamais envoyé au serveur', () => {
    const url = listenUrl(TOKEN, 'https://nova-studio-daw-0901.vercel.app/');
    expect(url).toBe(`https://nova-studio-daw-0901.vercel.app/ecoute.html#t=${TOKEN}`);
    expect(new URL(url).search).toBe('');
    expect(parseListenToken(new URL(url).hash)).toBe(TOKEN);
    expect(listenUrl(TOKEN, 'http://127.0.0.1:3433')).toBe(`http://127.0.0.1:3433/ecoute.html#t=${TOKEN}`);
  });

  it('jeton seul accepté ; tronqué, trop long, absent ou bizarre → null (page « Lien incomplet »)', () => {
    expect(parseListenToken(`#${TOKEN}`)).toBe(TOKEN);
    expect(parseListenToken(`#t=${TOKEN}&x=1`)).toBe(TOKEN);
    expect(parseListenToken(`#t=${TOKEN.slice(0, 31)}`)).toBeNull();
    expect(parseListenToken(`#t=${TOKEN}A`)).toBeNull();
    expect(parseListenToken('')).toBeNull();
    expect(parseListenToken(null)).toBeNull();
    expect(parseListenToken('#t=<script>alert(1)</script>')).toBeNull();
  });

  it('adresse de l\'appli : celle de la page, l\'adresse publique dans l\'application Windows', () => {
    expect(appBase({ origin: 'https://nova-studio-daw-0901.vercel.app', pathname: '/' }, false, '/')).toBe('https://nova-studio-daw-0901.vercel.app/');
    expect(appBase({ origin: 'https://romainscheyvaerts-svg.github.io', pathname: '/NOVA-STUDIO-DAW-0901-/' }, false, '/NOVA-STUDIO-DAW-0901-/'))
      .toBe('https://romainscheyvaerts-svg.github.io/NOVA-STUDIO-DAW-0901-/');
    expect(appBase({ origin: 'http://127.0.0.1:8765', pathname: '/' }, true)).toBe(PUBLIC_APP_BASE);
    expect(appBase({ origin: 'file://', pathname: '/x' }, false)).toBe(PUBLIC_APP_BASE);
    expect(appBase(null, false)).toBe(PUBLIC_APP_BASE);
  });
});

describe('lien d\'écoute : textes', () => {
  it('durées proposées : 24 h, 7 jours, 30 jours', () => {
    expect(LISTEN_TTL_OPTIONS.map(o => o.hours)).toEqual([24, 168, 720]);
    expect(LISTEN_TTL_OPTIONS.map(o => o.label)).toEqual(['24 h', '7 jours', '30 jours']);
  });

  it('« expire dans … »', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(expiresIn('2026-10-12T10:12:00Z', now)).toBe('expire dans 12 min');
    expect(expiresIn('2026-10-13T09:00:00Z', now)).toBe('expire dans 23 h');
    expect(expiresIn('2026-10-19T10:00:00Z', now)).toBe('expire dans 7 j');
    expect(expiresIn('2026-10-12T09:59:00Z', now)).toBe('expiré');
    expect(expiresIn('pas une date', now)).toBe('expiré');
  });

  it('position et contenu', () => {
    expect(fmtClock(72)).toBe('1:12');
    expect(fmtClock(5.9)).toBe('0:05');
    expect(fmtClock(-3)).toBe('0:00');
    expect(contentSummary({ live: true, versions: false, comments: true })).toBe('Mix en direct · Commentaires');
    expect(contentSummary({ live: false, versions: false, comments: false })).toBe('Rien');
  });

  it('chaque erreur a un titre clair et dit quoi faire (expiré, désactivé, mot de passe, réseau…)', () => {
    expect(errorCodeOf(410, 'expired')).toBe('expired');
    expect(errorCodeOf(410, 'revoked')).toBe('revoked');
    expect(errorCodeOf(410, undefined)).toBe('expired');
    expect(errorCodeOf(404, undefined)).toBe('unknown');
    expect(errorCodeOf(401, 'password_required')).toBe('password_required');
    expect(errorCodeOf(undefined, 'network')).toBe('network');
    expect(errorCodeOf(500, 'bizarre')).toBe('network');
    expect(listenErrorView('expired', 'Ce lien a expiré le 12/10/2026 18:00.')).toMatchObject({ title: 'Ce lien a expiré', retry: false });
    expect(listenErrorView('revoked').title).toBe('Ce lien a été désactivé');
    expect(listenErrorView('revoked').text).toMatch(/nouveau lien/);
    expect(listenErrorView('password_required').password).toBe(true);
    expect(listenErrorView('password_wrong').password).toBe(true);
    expect(listenErrorView('network').retry).toBe(true);
    expect(listenErrorView('missing').text).toMatch(/en entier/);
    for (const c of ['unknown', 'expired', 'revoked', 'gone', 'password_required', 'password_wrong', 'locked', 'missing', 'network'] as const) {
      const v = listenErrorView(c);
      expect(v.title.length).toBeGreaterThan(3);
      expect(v.text.length).toBeGreaterThan(10);
    }
  });
});

describe('lien d\'écoute : présence sur le canal', () => {
  const state = {
    'h-inge01': [{ role: 'host', live: true, name: 'Max' }],
    'l-aaaaaa1': [{ role: 'listener', want: true }],
    'l-bbbbbb2': [{ role: 'listener', want: false }],
    'l-cccccc3': [{ role: 'listener', want: false }, { role: 'listener', want: true }],
    'u:intrus': [{ role: 'listener', want: true }],
    'l-dddddd4': [{ role: 'host', live: true }],
  };

  it('l\'ingé : présent, diffuse ou non, son nom', () => {
    expect(hostOf(state as any)).toEqual({ key: 'h-inge01', live: true, name: 'Max' });
    expect(hostOf({ 'h-x': [{ role: 'host', live: false }] })).toEqual({ key: 'h-x', live: false, name: '' });
    expect(hostOf({ 'l-aaaaaa1': [{ role: 'listener', want: true }] })).toBeNull();
    expect(hostOf({})).toBeNull();
  });

  it('seuls les clients (clé « l-… ») qui veulent écouter reçoivent le mix ; au plus 10 par lien', () => {
    expect(listenersOf(state as any)).toEqual(['l-aaaaaa1', 'l-cccccc3']);
    expect(visitorsOf(state as any)).toBe(3);
    const many: Record<string, any[]> = {};
    for (let i = 0; i < 25; i++) many[`l-k${String(i).padStart(6, '0')}`] = [{ role: 'listener', want: true }];
    expect(listenersOf(many)).toHaveLength(MAX_LISTENERS_PER_LINK);
  });

  it('clés aléatoires : préfixe h- (ingé) ou l- (client), l\'ingé est « poli » (h < l)', () => {
    const a = randomKey('l'), b = randomKey('l'), h = randomKey('h');
    expect(a).toMatch(/^l-[a-z0-9]{12}$/);
    expect(a).not.toBe(b);
    expect(h < a).toBe(true);
  });
});
