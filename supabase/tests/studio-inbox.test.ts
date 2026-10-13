/**
 * Tests de la fonction serveur studio-inbox (« Envoyer au studio », chantier 17),
 * chargée TELLE QUELLE (code Deno) avec le faux Supabase de supabase/tests/fakes.
 * Rien ne part sur le réseau, aucune base réelle n'est touchée.
 *
 * Ce qui est prouvé :
 *  - compte exigé, CORS, POST seulement ;
 *  - limites des fichiers (projet obligatoire, tailles, noms rendus sûrs, 2 Go) ;
 *  - adresses d'envoi signées dans le dossier du compte, jamais ailleurs ;
 *  - réservation créée SEULEMENT quand tous les fichiers sont arrivés, à la bonne
 *    taille (409 + liste des manquants sinon) ;
 *  - demande de réservation vérifiée (jour passé, durée, nom…) avec des phrases claires ;
 *  - double envoi : la même réservation, jamais deux ;
 *  - paquet d'un autre compte : introuvable ; boîte du studio réservée au studio ;
 *  - paquets abandonnés effacés après 48 h ; limites d'envoi par compte.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb, setCurrentDb, type FakeDb } from './fakes/supabase';
import { lastHandler } from './fakes/denoServe';
import { checkBooking, checkFiles, safeFileName, bookingReference } from '../functions/studio-inbox/rules';

const ENV: Record<string, string> = { SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_ROLE_KEY: 'service', STUDIO_ADMIN_EMAILS: 'studio@makemusic.test, autre@makemusic.test' };
(globalThis as any).Deno = { env: { get: (k: string) => ENV[k] } };

type Handler = (req: Request) => Promise<Response> | Response;
let fn: Handler;
beforeAll(async () => {
  await import('../functions/studio-inbox/index.ts');
  fn = lastHandler();
});

let db: FakeDb;
beforeEach(() => {
  db = createFakeDb();
  db.users['jwt.nina.ok'] = { id: 'u-nina', email: 'nina@example.com' };
  db.users['jwt.max.ok'] = { id: 'u-max', email: 'max@example.com' };
  db.users['jwt.studio.ok'] = { id: 'u-studio', email: 'studio@makemusic.test' };
  setCurrentDb(db);
});

const NOVA = 'https://nova-studio-daw-0901.vercel.app';
async function call(body: unknown, opts: { token?: string; origin?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: opts.origin ?? NOVA };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fn(new Request('http://fn.local/', { method: opts.method || 'POST', headers, body: opts.method && opts.method !== 'POST' ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}
const NINA = { token: 'jwt.nina.ok' };
const in10days = () => new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
const BOOKING = () => ({ service: 'enregistrement', date: in10days(), slot: 'soir', hours: 3, name: 'Nina', phone: '+32 470 12 34 56', message: 'Refrain à refaire' });
const FILES = [
  { kind: 'projet', name: 'Séance du 13 octobre.novaproj.zip', size: 1200 },
  { kind: 'stem', name: 'Voix lead.flac', size: 800 },
  { kind: 'stem', name: 'Beat.flac', size: 900 },
  { kind: 'notes', name: 'notes.json', size: 300 },
];

/** Dépôt simulé dans le stockage (ce que fait uploadToSignedUrl). */
function put(path: string, size: number) {
  const m = (db.storage['studio-packages'] ||= new Map());
  m.set(path, { size, created_at: new Date().toISOString() });
}
async function init(files = FILES) {
  const r = await call({ action: 'package_init', title: 'Séance du 13 octobre', bpm: 120, key: 'La mineur', files }, NINA);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as { package_id: string; uploads: { name: string; kind: string; path: string; token: string }[] };
}

describe('studio-inbox · règles partagées', () => {
  it('noms de fichiers sûrs (accents, chemins, caractères spéciaux)', () => {
    expect(safeFileName('Séance du 13 octobre.novaproj.zip')).toBe('Seance_du_13_octobre.novaproj.zip');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\x\\..\\.env')).toBe('env');
    expect(safeFileName('')).toBe('fichier');
  });
  it('fichiers : projet obligatoire, tailles bornées, noms uniques', () => {
    expect(checkFiles([]).ok).toBe(false);
    expect(checkFiles([{ kind: 'stem', name: 'a.flac', size: 10 }])).toMatchObject({ ok: false, error: expect.stringMatching(/projet manque/) });
    expect(checkFiles([{ kind: 'projet', name: 'p.zip', size: 0 }]).ok).toBe(false);
    expect(checkFiles([{ kind: 'projet', name: 'p.zip', size: 600 * 1048576 }]).ok).toBe(false);
    expect(checkFiles([{ kind: 'virus', name: 'p.exe', size: 1 }]).ok).toBe(false);
    const big = Array.from({ length: 5 }, (_, i) => ({ kind: i ? 'stem' : 'projet', name: `f${i}.flac`, size: 450 * 1048576 }));
    expect(checkFiles(big)).toMatchObject({ ok: false, error: expect.stringMatching(/trop lourd/) });
    const dup = checkFiles([{ kind: 'projet', name: 'p.zip', size: 1 }, { kind: 'stem', name: 'Voix.flac', size: 1 }, { kind: 'stem', name: 'voix.flac', size: 1 }]);
    expect(dup.ok && dup.files.map(f => f.name)).toEqual(['p.zip', 'Voix.flac', 'voix_2.flac']);
  });
  it('réservation : champs obligatoires, jour à venir, durée, phrases claires', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(checkBooking({ ...BOOKING(), date: '2026-10-20' }, now).ok).toBe(true);
    expect(checkBooking({ ...BOOKING(), date: '2026-10-13' }, now).ok).toBe(true);
    const past = checkBooking({ ...BOOKING(), date: '2026-10-12' }, now);
    expect(past.ok === false && past.errors.date).toMatch(/déjà passé/);
    const far = checkBooking({ ...BOOKING(), date: '2027-06-01' }, now);
    expect(far.ok === false && far.errors.date).toMatch(/180 jours/);
    const bad = checkBooking({ service: 'karaoke', date: 'demain', slot: 'nuit', hours: 0, name: ' ', phone: 'appelle-moi' }, now);
    expect(bad.ok === false && Object.keys(bad.errors).sort()).toEqual(['date', 'hours', 'name', 'phone', 'service', 'slot']);
    expect(bookingReference('7k2f9qabcdef')).toBe('MM-7K2F9Q');
  });
});

describe('studio-inbox · envoi d\'un paquet', () => {
  it('CORS, POST seulement, compte exigé (401, avec une phrase claire)', async () => {
    expect((await call(null, { method: 'OPTIONS' })).headers.get('access-control-allow-origin')).toBe(NOVA);
    expect((await call(null, { method: 'OPTIONS', origin: 'https://evil.example' })).headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
    expect((await call(null, { method: 'GET' })).status).toBe(405);
    const r = await call({ action: 'package_init', files: FILES });
    expect(r.status).toBe(401);
    expect(r.json.error).toMatch(/Connecte-toi/);
    expect(db.tables.studio_packages || []).toHaveLength(0);
  });

  it('init : paquet « envoi », une adresse signée par fichier, dans le dossier du compte', async () => {
    const r = await init();
    expect(r.package_id).toMatch(/^[a-z0-9]{12}$/);
    expect(r.uploads.map(u => u.name)).toEqual(['Seance_du_13_octobre.novaproj.zip', 'Voix_lead.flac', 'Beat.flac', 'notes.json']);
    for (const u of r.uploads) expect(u.path.startsWith(`u-nina/${r.package_id}/`)).toBe(true);
    const row = db.tables.studio_packages[0];
    expect(row).toMatchObject({ status: 'envoi', user_id: 'u-nina', title: 'Séance du 13 octobre', bpm: 120, total_bytes: 3200 });
    expect(db.tables.studio_booking_requests || []).toHaveLength(0);
  });

  it('submit : refusé tant qu\'un fichier manque ou est tronqué (409 + liste), puis réservation créée', async () => {
    const r = await init();
    put(r.uploads[0].path, 1200);
    put(r.uploads[1].path, 400); // envoi coupé à moitié
    const miss = await call({ action: 'package_submit', package_id: r.package_id, booking: BOOKING() }, NINA);
    expect(miss.status).toBe(409);
    expect(miss.json.missing).toEqual(['Voix_lead.flac', 'Beat.flac', 'notes.json']);
    expect(db.tables.studio_booking_requests || []).toHaveLength(0);
    // NOVA redemande des adresses pour les manquants seulement, et renvoie.
    const again = await call({ action: 'package_resign', package_id: r.package_id, names: miss.json.missing }, NINA);
    expect(again.json.uploads.map((u: any) => u.name)).toEqual(miss.json.missing);
    put(r.uploads[1].path, 800); put(r.uploads[2].path, 900); put(r.uploads[3].path, 300);
    const ok = await call({ action: 'package_submit', package_id: r.package_id, booking: BOOKING() }, NINA);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.booking).toMatchObject({ status: 'demande', service: 'enregistrement', slot: 'soir', hours: 3, name: 'Nina', date: in10days() });
    expect(ok.json.booking.reference).toMatch(/^MM-[A-Z0-9]{6}$/);
    expect(db.tables.studio_packages[0]).toMatchObject({ status: 'recu', booking_id: ok.json.booking.id });
    expect(db.tables.studio_booking_requests[0]).toMatchObject({ package_id: r.package_id, user_id: 'u-nina', phone: '+32 470 12 34 56', message: 'Refrain à refaire' });
  });

  it('double envoi (double clic, réponse perdue) : la MÊME réservation, jamais deux', async () => {
    const r = await init();
    r.uploads.forEach((u, i) => put(u.path, FILES[i].size));
    const [a, b] = await Promise.all([
      call({ action: 'package_submit', package_id: r.package_id, booking: BOOKING() }, NINA),
      call({ action: 'package_submit', package_id: r.package_id, booking: BOOKING() }, NINA),
    ]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.json.booking.id).toBe(b.json.booking.id);
    const c = await call({ action: 'package_submit', package_id: r.package_id, booking: BOOKING() }, NINA);
    expect(c.json).toMatchObject({ already: true, booking: { id: a.json.booking.id } });
    expect(db.tables.studio_booking_requests).toHaveLength(1);
  });

  it('demande incomplète : 400 avec les erreurs par champ, rien de créé', async () => {
    const r = await init();
    r.uploads.forEach((u, i) => put(u.path, FILES[i].size));
    const bad = await call({ action: 'package_submit', package_id: r.package_id, booking: { ...BOOKING(), date: '2020-01-01', name: '' } }, NINA);
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json.errors).sort()).toEqual(['date', 'name']);
    expect(db.tables.studio_booking_requests || []).toHaveLength(0);
    expect(db.tables.studio_packages[0].status).toBe('envoi');
  });

  it('paquet d\'un autre compte : introuvable (404), rien de lu ni d\'écrit', async () => {
    const r = await init();
    for (const action of ['package_submit', 'package_status', 'package_resign']) {
      const x = await call({ action, package_id: r.package_id, booking: BOOKING() }, { token: 'jwt.max.ok' });
      expect(x.status).toBe(404);
    }
    expect((await call({ action: 'package_status', package_id: '../../x' }, NINA)).status).toBe(400);
    expect(db.tables.studio_booking_requests || []).toHaveLength(0);
  });

  it('boîte du studio : réservée au studio (403), avec les fichiers et la réservation', async () => {
    const r = await init();
    r.uploads.forEach((u, i) => put(u.path, FILES[i].size));
    await call({ action: 'package_submit', package_id: r.package_id, booking: BOOKING() }, NINA);
    expect((await call({ action: 'studio_list' }, NINA)).status).toBe(403);
    const box = await call({ action: 'studio_list' }, { token: 'jwt.studio.ok' });
    expect(box.status).toBe(200);
    expect(box.json.packages).toHaveLength(1);
    const p = box.json.packages[0];
    expect(p).toMatchObject({ package_id: r.package_id, from: 'nina@example.com', booking: { status: 'demande', name: 'Nina', phone: '+32 470 12 34 56' } });
    expect(p.files.map((f: any) => f.kind)).toEqual(['projet', 'stem', 'stem', 'notes']);
    expect(p.files.every((f: any) => /^https:\/\/signed\.test\/u-nina\//.test(f.url))).toBe(true);
  });

  it('limites : 3 envois en cours au plus ; paquets abandonnés effacés après 48 h (fichiers compris)', async () => {
    const a = await init(); await init(); await init();
    const four = await call({ action: 'package_init', files: FILES }, NINA);
    expect(four.status).toBe(429);
    expect(four.json.error).toMatch(/envois en cours/);
    put(a.uploads[0].path, 1200);
    db.tables.studio_packages.forEach(p => { p.created_at = new Date(Date.now() - 49 * 3600000).toISOString(); });
    const fresh = await call({ action: 'package_init', files: FILES }, NINA);
    expect(fresh.status).toBe(200);
    expect(db.tables.studio_packages.map(p => p.id)).toEqual([fresh.json.package_id]);
    expect(db.storage['studio-packages'].has(a.uploads[0].path)).toBe(false);
  });
});
