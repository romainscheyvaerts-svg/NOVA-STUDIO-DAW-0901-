// @vitest-environment jsdom
/**
 * Signalements (« Signaler un bug / proposer une idée ») : tampon d'erreurs,
 * contexte sans secret, file hors ligne, anti-doublon.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sb = vi.hoisted(() => {
  const state = {
    inserted: [] as any[],
    uploads: [] as string[],
    insertImpl: null as null | ((row: any) => Promise<{ error: any }>),
    session: null as any,
    rpcRows: [] as any[],
    selectRows: [] as any[],
  };
  const client = {
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    from: (table: string) => ({
      insert: async (row: any) => {
        if (state.insertImpl) return state.insertImpl(row);
        if (state.inserted.some(r => r.ref === row.ref)) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        state.inserted.push({ table, ...row });
        return { error: null };
      },
      select: () => ({ order: () => ({ limit: async () => ({ data: state.selectRows, error: null }) }) }),
    }),
    storage: { from: () => ({ upload: async (path: string) => { state.uploads.push(path); return { error: null }; } }) },
    rpc: async () => ({ data: state.rpcRows, error: null }),
  };
  return { state, client };
});

vi.mock('../services/supabase', () => ({ catalogSupabase: sb.client, supabase: null }));

import { RingBuffer, consoleRing, actionRing, installConsoleRing, recordAction, recordConsole, redact, actionNameForElement, resetFeedbackLogs, CONSOLE_CAPACITY, ACTION_CAPACITY } from '../utils/feedbackLog';
import { collectFeedbackContext, setFeedbackAppState, describeBrowser } from '../utils/feedbackContext';
import {
  submitFeedback, flushFeedbackQueue, getQueue, getHistory, FeedbackError, fingerprintOf, newRef, formatRef,
  refreshFeedbackStatuses, __resetFeedbackForTests, getDeviceId,
} from '../services/feedback';
import { findConflicts, KEYMAP, chordFromEvent } from '../utils/keymap';
import { isFeedbackShortcut } from '../utils/feedbackShortcut';

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXNlY3JldC11c2VyIn0.SuperSecretSignatureXYZ123456';
const FAKE_REFRESH = 'rfr_9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa';

const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });

beforeEach(() => {
  localStorage.clear();
  resetFeedbackLogs();
  __resetFeedbackForTests();
  sb.state.inserted = []; sb.state.uploads = []; sb.state.insertImpl = null; sb.state.session = null; sb.state.rpcRows = []; sb.state.selectRows = [];
  setOnline(true);
  setFeedbackAppState(null);
});
afterEach(() => { vi.useRealTimers(); });

const draft = (over: Partial<Parameters<typeof submitFeedback>[0]> = {}) => ({
  category: 'bug' as const, title: 'Le son coupe', description: 'Pendant l’enregistrement', frequency: 'parfois' as const,
  email: '', context: collectFeedbackContext() as unknown as Record<string, unknown>, ...over,
});

describe('tampon des erreurs de la console', () => {
  it('garde les 30 dernières, de la plus ancienne à la plus récente', () => {
    for (let i = 0; i < 45; i++) recordConsole('error', [`erreur ${i}`]);
    const all = consoleRing.toArray();
    expect(all).toHaveLength(CONSOLE_CAPACITY);
    expect(all[0].message).toBe('erreur 15');
    expect(all[29].message).toBe('erreur 44');
  });

  it('RingBuffer générique', () => {
    const r = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach(n => r.push(n));
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
  });

  it('s’installe sur console.error / console.warn sans les empêcher de s’afficher', () => {
    const seen: unknown[][] = [];
    const origError = console.error, origWarn = console.warn;
    console.error = (...a: unknown[]) => { seen.push(a); };
    console.warn = (...a: unknown[]) => { seen.push(a); };
    try {
      installConsoleRing();
      console.error('Plantage du moteur', new Error('buffer vide'));
      console.warn('Attention latence');
      expect(seen).toHaveLength(2);
      const msgs = consoleRing.toArray().map(e => `${e.level}:${e.message}`);
      expect(msgs).toContain('error:Plantage du moteur Error: buffer vide');
      expect(msgs).toContain('warn:Attention latence');
    } finally {
      console.error = origError; console.warn = origWarn;
    }
  });

  it('masque jetons, clés, mots de passe et e-mails dans les messages', () => {
    recordConsole('error', [`Auth échouée Bearer ${FAKE_JWT} pour romain@exemple.com password=hunter22 apikey: sb_secret_abcdefghijklmnop`]);
    const m = consoleRing.toArray()[0].message;
    expect(m).not.toContain('eyJ');
    expect(m).not.toContain('SuperSecret');
    expect(m).not.toContain('romain@exemple.com');
    expect(m).not.toContain('hunter22');
    expect(m).not.toContain('sb_secret_');
    expect(redact('token=abcdef123456&x=1')).toBe('token=[masqué]&x=1');
  });

  it('les objets ne sont jamais recopiés, seulement leur forme', () => {
    recordConsole('error', ['Réponse :', { access_token: FAKE_JWT, user: { email: 'a@b.cd' } }]);
    const m = consoleRing.toArray()[0].message;
    expect(m).toContain('access_token');
    expect(m).not.toContain('eyJ');
    expect(m).not.toContain('a@b.cd');
  });
});

describe('journal des actions (anonyme)', () => {
  it('garde les 20 dernières, noms de commandes seulement', () => {
    for (let i = 0; i < 25; i++) recordAction(`edit:cmd${i}`);
    expect(actionRing.toArray()).toHaveLength(ACTION_CAPACITY);
    expect(actionRing.toArray()[0].action).toBe('edit:cmd5');
  });

  it('refuse le texte libre (noms de pistes, paroles…)', () => {
    recordAction('Renommer piste « Voix de Jean »');
    recordAction('je t’aime bébé');
    recordAction('');
    expect(actionRing.toArray()).toHaveLength(0);
  });

  it('un clic donne l’icône ou data-nova-target, jamais le texte du bouton', () => {
    document.body.innerHTML = '<button aria-label="Supprimer la piste Voix de Jean"><i class="fas fa-trash"></i> Voix de Jean</button><button data-nova-target="rec">REC</button><button>Texte seul</button>';
    const [a, b, c] = Array.from(document.querySelectorAll('button'));
    expect(actionNameForElement(a.querySelector('i'))).toBe('clic:fa-trash');
    expect(actionNameForElement(b)).toBe('clic:rec');
    expect(actionNameForElement(c)).toBeNull();
  });
});

describe('contexte joint : jamais de secret', () => {
  it('un faux jeton dans le stockage local n’est JAMAIS joint', () => {
    localStorage.setItem('sb-mxdrxpzxbgybchzzvpkf-auth-token', JSON.stringify({ access_token: FAKE_JWT, refresh_token: FAKE_REFRESH, user: { email: 'secret@exemple.com' } }));
    localStorage.setItem('nova_user', JSON.stringify({ password: 'motdepasse123' }));
    sessionStorage.setItem('jeton', FAKE_JWT);
    document.cookie = `session=${FAKE_REFRESH}`;
    // Même si une erreur l'a affiché dans la console…
    console.error(`Session expirée : ${FAKE_JWT} refresh_token=${FAKE_REFRESH}`);
    recordConsole('error', [`Session expirée : ${FAKE_JWT} refresh_token=${FAKE_REFRESH} motdepasse123`]);
    setFeedbackAppState(() => ({ mode: 'avance', view: 'ARRANGEMENT', trackCount: 4, collabRole: 'engineer', layout: 'ordinateur' }));
    const ctx = collectFeedbackContext();
    const json = JSON.stringify(ctx);
    expect(json).not.toContain(FAKE_JWT);
    expect(json).not.toContain('eyJhbGci');
    expect(json).not.toContain(FAKE_REFRESH);
    expect(json).not.toContain('secret@exemple.com');
    expect(json).not.toContain('sb-mxdrxpzxbgybchzzvpkf-auth-token');
    expect(ctx.studio).toEqual({ mode: 'avance', view: 'ARRANGEMENT', trackCount: 4, collabRole: 'engineer', mobileTab: null, layout: 'ordinateur' });
    expect(ctx.erreurs.length).toBeGreaterThan(0);
  });

  it('le mot de passe d’une erreur ne passe que s’il est étiqueté… donc on vérifie la forme générale', () => {
    recordConsole('error', ['Erreur password: "monSecret!" et key=ABCD1234']);
    const json = JSON.stringify(collectFeedbackContext());
    expect(json).not.toContain('monSecret');
    expect(json).not.toContain('ABCD1234');
  });

  it('le studio ne peut pas glisser de contenu (noms longs, objets)', () => {
    setFeedbackAppState(() => ({ view: `ARRANGEMENT ${FAKE_JWT}`, trackCount: 3.6, collabRole: { x: 1 } as any }));
    const ctx = collectFeedbackContext();
    expect(JSON.stringify(ctx)).not.toContain('eyJhbGci');
    expect(ctx.studio.trackCount).toBe(4);
    expect(ctx.studio.collabRole).toBeNull();
  });

  it('page : chemin sans paramètres (pas de lien de session)', () => {
    window.history.replaceState({}, '', `/studio?session=abc&token=${FAKE_JWT}#x`);
    expect(collectFeedbackContext().page).toBe('/studio');
  });

  it('version de l’appli Windows et navigateur lisible', () => {
    (window as any).__novaDesktop = { version: '1.4.0', ui: 'ui-abc123' };
    try {
      const ctx = collectFeedbackContext();
      expect(ctx.desktop).toEqual({ version: '1.4.0', ui: 'ui-abc123' });
    } finally { delete (window as any).__novaDesktop; }
    expect(describeBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')).toBe('Chrome 141 (Windows)');
    expect(describeBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari 18 (iPhone)');
  });
});

describe('envoi et file hors ligne', () => {
  it('en ligne : envoyé tout de suite, numéro de suivi, historique « reçu »', async () => {
    const res = await submitFeedback(draft());
    expect(res.status).toBe('envoye');
    expect(res.ref).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(sb.state.inserted).toHaveLength(1);
    const row = sb.state.inserted[0];
    expect(row).toMatchObject({ ref: res.ref, category: 'bug', title: 'Le son coupe', frequency: 'parfois', device_id: getDeviceId() });
    // Le client n'envoie jamais le statut, le compte ni la note admin (le serveur les impose).
    expect(row).not.toHaveProperty('status');
    expect(row).not.toHaveProperty('user_id');
    expect(row).not.toHaveProperty('admin_note');
    expect(getQueue()).toHaveLength(0);
    expect(getHistory()[0]).toMatchObject({ ref: res.ref, status: 'recu' });
  });

  it('hors ligne : gardé en file, numéro donné quand même, puis envoyé au retour du réseau', async () => {
    setOnline(false);
    const res = await submitFeedback(draft({ title: 'Hors ligne' }));
    expect(res.status).toBe('en_attente');
    expect(sb.state.inserted).toHaveLength(0);
    expect(getQueue().map(q => q.ref)).toEqual([res.ref]);
    expect(getHistory()[0].status).toBe('en_attente');

    setOnline(true);
    await flushFeedbackQueue({ force: true });
    expect(sb.state.inserted.map(r => r.ref)).toEqual([res.ref]);
    expect(getQueue()).toHaveLength(0);
    expect(getHistory()[0].status).toBe('recu');
  });

  it('erreur réseau : reste en file avec un délai croissant, puis repart', async () => {
    sb.state.insertImpl = async () => ({ error: { message: 'TypeError: Failed to fetch', code: '' } });
    const res = await submitFeedback(draft({ title: 'Réseau coupé' }));
    expect(res.status).toBe('en_attente');
    const q1 = getQueue()[0];
    expect(q1.attempts).toBe(1);
    expect(q1.nextTryAt).toBeGreaterThan(Date.now() + 20_000);
    // Pas encore l'heure : rien ne part.
    sb.state.insertImpl = null;
    await flushFeedbackQueue();
    expect(sb.state.inserted).toHaveLength(0);
    await flushFeedbackQueue({ force: true });
    expect(sb.state.inserted).toHaveLength(1);
    expect(getHistory()[0].status).toBe('recu');
  });

  it('limite anti-spam du serveur : gardé, nouvel essai dans une heure, message clair', async () => {
    sb.state.insertImpl = async () => ({ error: { code: 'P0001', message: 'nova_feedback_rate_limit: appareil' } });
    const res = await submitFeedback(draft({ title: 'Trop vite' }));
    expect(res.status).toBe('en_attente');
    expect(res.note).toMatch(/plus tard/);
    expect(getQueue()[0].nextTryAt).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('table pas encore créée (migration non appliquée) : rien n’est perdu', async () => {
    sb.state.insertImpl = async () => ({ error: { code: 'PGRST205', message: 'Could not find the table public.nova_feedback' } });
    const res = await submitFeedback(draft({ title: 'Avant migration' }));
    expect(res.status).toBe('en_attente');
    expect(getQueue()).toHaveLength(1);
  });

  it('capture : envoyée dans le bucket sous <appareil>/<ref>.jpg puis référencée', async () => {
    const png = 'data:image/jpeg;base64,' + btoa('pas vraiment un jpeg');
    const res = await submitFeedback(draft({ title: 'Avec capture', screenshot: png }));
    expect(sb.state.uploads).toEqual([`${getDeviceId()}/${res.ref}.jpg`]);
    expect(sb.state.inserted[0].screenshot_path).toBe(`${getDeviceId()}/${res.ref}.jpg`);
  });

  it('validation : titre trop court, e-mail invalide', async () => {
    await expect(submitFeedback(draft({ title: 'ab' }))).rejects.toMatchObject({ code: 'titre' });
    await expect(submitFeedback(draft({ email: 'pas-un-mail' }))).rejects.toMatchObject({ code: 'email' });
    expect(sb.state.inserted).toHaveLength(0);
  });
});

describe('anti-doublon', () => {
  it('le même signalement deux fois en 10 minutes est refusé (même avec accents / casse différents)', async () => {
    const first = await submitFeedback(draft({ title: 'Le son coupe', description: 'Pendant l’enregistrement' }));
    const err = await submitFeedback(draft({ title: '  le SON coupe ', description: 'pendant l’enregistrement' })).catch(e => e);
    expect(err).toBeInstanceOf(FeedbackError);
    expect(err.code).toBe('doublon');
    expect(err.ref).toBe(first.ref);
    expect(sb.state.inserted).toHaveLength(1);
    expect(fingerprintOf({ category: 'bug', title: 'Éé', description: '' })).toBe(fingerprintOf({ category: 'bug', title: 'ee', description: '' }));
  });

  it('après 10 minutes, on peut le renvoyer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    await submitFeedback(draft());
    vi.setSystemTime(new Date('2026-10-07T10:11:00Z'));
    await submitFeedback(draft());
    expect(sb.state.inserted).toHaveLength(2);
  });

  it('réponse perdue puis renvoi : le serveur répond « doublon » (23505) → compté comme envoyé, une seule ligne', async () => {
    let calls = 0;
    sb.state.insertImpl = async (row) => {
      calls++;
      if (calls === 1) { sb.state.inserted.push(row); return { error: { message: 'Failed to fetch', code: '' } }; }
      return { error: { code: '23505', message: 'duplicate key value violates unique constraint "nova_feedback_ref_key"' } };
    };
    const res = await submitFeedback(draft({ title: 'Réponse perdue' }));
    expect(res.status).toBe('en_attente');
    await flushFeedbackQueue({ force: true });
    expect(sb.state.inserted).toHaveLength(1);
    expect(getQueue()).toHaveLength(0);
    expect(getHistory()[0].status).toBe('recu');
  });

  it('deux envois simultanés de la file ne partent qu’une fois', async () => {
    setOnline(false);
    await submitFeedback(draft({ title: 'Simultané' }));
    setOnline(true);
    await Promise.all([flushFeedbackQueue({ force: true }), flushFeedbackQueue({ force: true })]);
    expect(sb.state.inserted).toHaveLength(1);
  });

  it('numéros de suivi : format lisible, sans 0 / O / 1 / I / L', () => {
    const refs = new Set(Array.from({ length: 500 }, newRef));
    expect(refs.size).toBe(500);
    for (const r of refs) expect(r).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(formatRef('K7P2QX4A')).toBe('K7P2-QX4A');
  });
});

describe('« Mes signalements » : statuts lus dans la table', () => {
  it('connecté : statuts de ses lignes (RLS), version de correction', async () => {
    const res = await submitFeedback(draft({ title: 'Bug corrigé' }));
    sb.state.session = { user: { id: 'u1', email: 'a@b.cd' } };
    sb.state.selectRows = [{ ref: res.ref, status: 'corrige', fixed_in_version: '2026.10.08', created_at: new Date().toISOString(), title: 'Bug corrigé', category: 'bug' }];
    await refreshFeedbackStatuses();
    expect(getHistory()[0]).toMatchObject({ ref: res.ref, status: 'corrige', fixedIn: '2026.10.08' });
  });

  it('invité : statuts par la fonction limitée à cet appareil', async () => {
    const res = await submitFeedback(draft({ title: 'Idée invitée', category: 'idee', frequency: null }));
    sb.state.rpcRows = [{ ref: res.ref, status: 'en_cours', fixed_in_version: null }];
    await refreshFeedbackStatuses();
    expect(getHistory()[0].status).toBe('en_cours');
  });
});

describe('raccourci clavier', () => {
  it('Ctrl+Maj+B, sans conflit dans la table des raccourcis', () => {
    expect(KEYMAP.find(s => s.id === 'nova.feedback')?.keys).toEqual(['ctrl+shift+b']);
    expect(findConflicts()).toEqual([]);
    expect(isFeedbackShortcut({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isFeedbackShortcut({ key: 'b', code: 'KeyB', ctrlKey: true })).toBe(false);
    expect(chordFromEvent({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true })).toBe('ctrl+shift+b');
    // Aucun raccourci (toutes tables) ne prend déjà Ctrl+Maj+B.
    expect(KEYMAP.filter(s => s.keys.includes('ctrl+shift+b')).map(s => s.id)).toEqual(['nova.feedback']);
  });
});
