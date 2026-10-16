/**
 * Lot 7 · Notifications : réglages, moment de la demande, capacités de l'appareil, liens (utils/pushPrefs.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  ASK_GAP_MS, ASK_MAX, DEFAULT_PREFS, EMPTY_ASK, PREF_KEYS, PREF_LABELS, askText, b64urlToBytes, bytesToB64url, isVapidPublicKey,
  normalizePrefs, parseAskMemory, parseNotifTarget, prefAllows, prefsSummary, pushSupport, shouldAsk, stripNotifParams, togglePref,
  type AskContext, type SupportEnv,
} from '../utils/pushPrefs';
import { prefAllows as serverPrefAllows, NOTIF_TYPES } from '../supabase/functions/nova-push/messages';

const NOW = 1_760_000_000_000;
// Point P-256 de démonstration (clé publique de TEST, pas une clé du projet) : 0x04 || X || Y.
const TEST_PUB = bytesToB64url(new Uint8Array([4, ...Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 255)]));

describe('réglages', () => {
  it('par défaut : tout activé ; ligne partielle ou abîmée complétée', () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({ takes: false, comments: 'oui' as any })).toEqual({ ...DEFAULT_PREFS, takes: false });
  });

  it('même règle que le serveur pour chaque type', () => {
    const combos = [DEFAULT_PREFS, { ...DEFAULT_PREFS, enabled: false }, { ...DEFAULT_PREFS, versions: false, takes: false }];
    for (const p of combos) for (const t of NOTIF_TYPES) expect(prefAllows(p, t), `${t} ${JSON.stringify(p)}`).toBe(serverPrefAllows(p, t));
    expect(prefAllows(null, 'comment')).toBe(false);
  });

  it('tout couper puis rallumer garde les choix par type', () => {
    const p1 = togglePref(DEFAULT_PREFS, 'takes', false);
    const off = togglePref(p1, 'enabled', false);
    expect(off).toMatchObject({ enabled: false, takes: false, comments: true });
    expect(togglePref(off, 'enabled', true)).toEqual(p1);
  });

  it('rallumer un type quand tout était coupé rallume le général', () => {
    const off = togglePref(DEFAULT_PREFS, 'enabled', false);
    expect(togglePref(off, 'comments', true).enabled).toBe(true);
    expect(togglePref(off, 'comments', false).enabled).toBe(false);
  });

  it('résumé lisible', () => {
    expect(prefsSummary(DEFAULT_PREFS)).toBe('Tout est activé');
    expect(prefsSummary({ ...DEFAULT_PREFS, enabled: false })).toBe('Tout est coupé');
    expect(prefsSummary({ ...DEFAULT_PREFS, takes: false })).toBe('3 types sur 4');
    expect(prefsSummary({ ...DEFAULT_PREFS, comments: false, versions: false, invites: false })).toBe('1 type sur 4');
    expect(prefsSummary({ ...DEFAULT_PREFS, comments: false, versions: false, invites: false, takes: false })).toBe('Aucun type choisi');
  });

  it('4 types, chacun avec un libellé et une aide', () => {
    expect(PREF_KEYS).toEqual(['comments', 'versions', 'invites', 'takes']);
    for (const k of PREF_KEYS) { expect(PREF_LABELS[k].label.length).toBeGreaterThan(3); expect(PREF_LABELS[k].help.length).toBeGreaterThan(10); }
    expect(PREF_LABELS.takes.label).toBe('Prises reçues');
  });
});

describe('quand demander', () => {
  const ctx = (o: Partial<AskContext> = {}): AskContext => ({
    available: true, loggedIn: true, permission: 'default', subscribed: false, busy: false, memory: { ...EMPTY_ASK }, now: NOW, ...o,
  });

  it('au bon moment : disponible, connecté, jamais demandé', () => {
    expect(shouldAsk(ctx())).toBe(true);
  });

  it('jamais si la fonction est cachée, sans compte, pendant une prise, ou déjà activé', () => {
    expect(shouldAsk(ctx({ available: false }))).toBe(false);
    expect(shouldAsk(ctx({ loggedIn: false }))).toBe(false);
    expect(shouldAsk(ctx({ busy: true }))).toBe(false);
    expect(shouldAsk(ctx({ subscribed: true }))).toBe(false);
  });

  it('navigateur qui a refusé ou ne sait pas : on ne harcèle pas', () => {
    expect(shouldAsk(ctx({ permission: 'denied' }))).toBe(false);
    expect(shouldAsk(ctx({ permission: 'unsupported' }))).toBe(false);
    // Déjà autorisé à ce navigateur mais pas abonné (autre compte…) : la carte peut proposer.
    expect(shouldAsk(ctx({ permission: 'granted' }))).toBe(true);
  });

  it('au plus 2 fois, 14 jours d’écart, jamais après « Ne plus demander »', () => {
    expect(shouldAsk(ctx({ memory: { shown: 1, lastAt: NOW - 1000, never: false } }))).toBe(false);
    expect(shouldAsk(ctx({ memory: { shown: 1, lastAt: NOW - ASK_GAP_MS - 1, never: false } }))).toBe(true);
    expect(shouldAsk(ctx({ memory: { shown: ASK_MAX, lastAt: 0, never: false } }))).toBe(false);
    expect(shouldAsk(ctx({ memory: { shown: 0, lastAt: 0, never: true } }))).toBe(false);
  });

  it('mémoire lue sans planter', () => {
    expect(parseAskMemory(null)).toEqual(EMPTY_ASK);
    expect(parseAskMemory('{pas du json')).toEqual(EMPTY_ASK);
    expect(parseAskMemory('{"shown":1.7,"lastAt":5,"never":true}')).toEqual({ shown: 1, lastAt: 5, never: true });
  });

  it('une phrase claire selon le moment', () => {
    expect(askText('collab', 'Nina').title).toBe('Être prévenu quand Nina commente ou t’envoie une prise ?');
    expect(askText('collab').title).toContain('ton équipe');
    expect(askText('comment').title).toBe('Être prévenu quand on répond à ton commentaire ?');
    expect(askText('comment').detail).toMatch(/tu coupes quand tu veux/i);
    // Mode simple : la question courte (une ligne).
    expect(askText('comment').short).toBe('Être prévenu des réponses, même NOVA fermée ?');
    expect(askText('collab', 'Nina').short).toBe('Être prévenu quand Nina t’envoie quelque chose ?');
    for (const t of ['comment', 'collab'] as const) expect(askText(t).short.length).toBeLessThan(askText(t).title.length + 1);
  });
});

describe('ce que l’appareil sait faire', () => {
  const env = (o: Partial<SupportEnv> = {}): SupportEnv => ({
    desktopApp: false, serviceWorker: true, pushManager: true, notification: true, ios: false, standalone: false, secure: true, ...o,
  });
  it('navigateur moderne : Web Push', () => expect(pushSupport(env())).toBe('push'));
  it('appli Windows (pas de service worker) : tant que l’appli est ouverte', () => {
    expect(pushSupport(env({ desktopApp: true, serviceWorker: false, pushManager: false }))).toBe('desktop');
    expect(pushSupport(env({ desktopApp: true, notification: false }))).toBe('unsupported');
  });
  it('iPhone : seulement l’appli installée sur l’écran d’accueil', () => {
    expect(pushSupport(env({ ios: true }))).toBe('ios-install');
    expect(pushSupport(env({ ios: true, standalone: true }))).toBe('push');
  });
  it('page non sécurisée ou navigateur sans Push : caché', () => {
    expect(pushSupport(env({ secure: false }))).toBe('unsupported');
    expect(pushSupport(env({ pushManager: false }))).toBe('unsupported');
  });
});

describe('clés et liens', () => {
  it('base64url aller-retour', () => {
    const b = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(b64urlToBytes(bytesToB64url(b)))).toEqual(Array.from(b));
    expect(bytesToB64url(null)).toBe('');
  });

  it('clé publique reconnue (65 octets, 0x04), le reste refusé', () => {
    expect(isVapidPublicKey(TEST_PUB)).toBe(true);
    expect(isVapidPublicKey('')).toBe(false);
    expect(isVapidPublicKey(null)).toBe(false);
    expect(isVapidPublicKey('x'.repeat(87))).toBe(false); // mauvais premier octet
    expect(isVapidPublicKey(TEST_PUB.slice(0, 40))).toBe(false);
  });

  it('cible d’une notification lue dans l’adresse', () => {
    expect(parseNotifTarget('?session=abcdefgh1234.secret&nova_s=abcdefgh1234&nova_c=cm-1&nova_at=72.5'))
      .toEqual({ sessionId: 'abcdefgh1234', commentId: 'cm-1', versionId: null, at: 72.5 });
    expect(parseNotifTarget('?nova_v=mv-2&nova_s=abcdefgh1234')).toMatchObject({ versionId: 'mv-2', at: null });
    expect(parseNotifTarget('?session=abc')).toBeNull();
    expect(parseNotifTarget('?nova_s=PAS-VALIDE&nova_c=<script>')).toBeNull();
    expect(parseNotifTarget('?nova_c=cm-1&nova_at=-4').at).toBeNull();
  });

  it('paramètres retirés une fois traités (le reste de l’adresse gardé)', () => {
    expect(stripNotifParams('https://nova.test/?session=abc.def&nova_s=abcdefgh1234&nova_c=cm-1&nova_at=3#x')).toBe('/?session=abc.def#x');
    expect(stripNotifParams('https://nova.test/?nova_c=cm-1')).toBe('/');
  });
});
