import { describe, expect, it } from 'vitest';
import {
  CABIN_STALE_MS, CabinDedup, cabinAckText, cabinButtons, cabinDecide, cabinLink, cabinPosition, nextClockOffset,
  sanitizeCabinAck, sanitizeCabinCommand, sanitizeCabinState, type CabinCommand, type CabinHostCtx,
} from '../utils/cabinRemote';
import { DEFAULT_GUEST_RIGHTS, sanitizeGuestRights } from '../utils/guestRights';

const ENG = 'u:max:pc';
const NINA = 'u:nina:tel';
const NOW = 1_800_000_000_000;
const cmd = (c: Partial<CabinCommand> = {}): CabinCommand => ({ id: `id${Math.random()}`, cmd: 'rec', from: NINA, to: ENG, at: NOW, ...c });
const ctx = (o: Partial<CabinHostCtx> = {}): CabinHostCtx => ({
  myKey: ENG, myRole: 'engineer', myName: 'Max', rights: { ...DEFAULT_GUEST_RIGHTS, remote: true },
  senderRole: 'artist', senderName: 'Nina', isRecording: false, isPlaying: false, countIn: false, busy: false,
  dedup: new CabinDedup(), now: NOW, ...o,
});

describe('télécommande de cabine · décision chez l\'ingé', () => {
  it('REC permis : la prise part, l\'ingé voit qui l\'a lancée', () => {
    const d = cabinDecide(cmd(), ctx());
    expect(d).toMatchObject({ action: 'record', ack: { ok: true, done: 'rec' } });
    expect(d!.log).toMatch(/Nina a lancé REC depuis la cabine/);
  });

  it('droit décidé par l\'ingé : sans « remote », rien ne part (refus expliqué)', () => {
    const d = cabinDecide(cmd(), ctx({ rights: DEFAULT_GUEST_RIGHTS }));
    expect(d).toMatchObject({ action: 'none', ack: { ok: false } });
    expect(d!.ack.reason).toMatch(/Max n'a pas activé la télécommande/);
    expect(cabinDecide(cmd(), ctx({ rights: null }))!.action).toBe('none');
  });

  it('pas pour moi (autre ingé, ou je ne suis pas ingé) : ignoré, sans accusé', () => {
    expect(cabinDecide(cmd({ to: 'u:autre:pc' }), ctx())).toBeNull();
    expect(cabinDecide(cmd(), ctx({ myRole: 'artist' }))).toBeNull();
  });

  it('expéditeur qui n\'est pas l\'artiste (beatmaker, inconnu) : refusé', () => {
    expect(cabinDecide(cmd(), ctx({ senderRole: 'beatmaker' }))!.ack.ok).toBe(false);
    expect(cabinDecide(cmd(), ctx({ senderRole: null }))!.ack.ok).toBe(false);
  });

  it('commande trop vieille (réseau revenu après coup) : refusée, rien ne part en retard', () => {
    const d = cabinDecide(cmd({ at: NOW - CABIN_STALE_MS - 1 }), ctx());
    expect(d).toMatchObject({ action: 'none', ack: { ok: false } });
    expect(d!.ack.reason).toMatch(/Rien n'a été lancé/);
    expect(cabinDecide(cmd({ at: NOW - 200 }), ctx())!.action).toBe('record');
  });

  it('double appui sur REC : une seule prise (même identifiant renvoyé, ou 2e appui rapproché)', () => {
    const c = ctx();
    const first = cmd({ id: 'a' });
    expect(cabinDecide(first, c)!.action).toBe('record');
    expect(cabinDecide(first, c)).toMatchObject({ action: 'none', ack: { ok: true, done: 'deja' } });
    expect(cabinDecide(cmd({ id: 'b' }), { ...c, now: NOW + 300 })).toMatchObject({ action: 'none', ack: { done: 'deja' } });
    // La prise démarre (armement) puis tourne : REC ne la relance pas, et ne l'ARRÊTE pas (pas de bascule).
    expect(cabinDecide(cmd({ id: 'c' }), { ...c, now: NOW + 2000, busy: true })!.action).toBe('none');
    expect(cabinDecide(cmd({ id: 'd' }), { ...c, now: NOW + 3000, isRecording: true, isPlaying: true })).toMatchObject({ action: 'none', ack: { ok: true, done: 'deja' } });
    expect(cabinDecide(cmd({ id: 'e' }), { ...c, now: NOW + 3500, countIn: true })!.action).toBe('none');
  });

  it('STOP pendant la prise ou le décompte ; à l\'arrêt : déjà fait', () => {
    expect(cabinDecide(cmd({ cmd: 'stop' }), ctx({ isRecording: true }))!.action).toBe('stop');
    expect(cabinDecide(cmd({ cmd: 'stop' }), ctx({ countIn: true }))!.action).toBe('stop');
    expect(cabinDecide(cmd({ cmd: 'stop' }), ctx({ isPlaying: true }))!.action).toBe('stop');
    expect(cabinDecide(cmd({ cmd: 'stop' }), ctx())).toMatchObject({ action: 'none', ack: { ok: true, done: 'deja' } });
  });

  it('Lecture et Début : refusés pendant la prise (expliqué), sinon exécutés', () => {
    expect(cabinDecide(cmd({ cmd: 'play' }), ctx())!.action).toBe('play');
    expect(cabinDecide(cmd({ cmd: 'play' }), ctx({ isPlaying: true }))!.ack.done).toBe('deja');
    expect(cabinDecide(cmd({ cmd: 'play' }), ctx({ isRecording: true }))!.ack).toMatchObject({ ok: false, reason: expect.stringMatching(/STOP/) });
    expect(cabinDecide(cmd({ cmd: 'home' }), ctx({ isPlaying: true }))!.action).toBe('home');
    expect(cabinDecide(cmd({ cmd: 'home' }), ctx({ isRecording: true }))!.ack.ok).toBe(false);
  });
});

describe('télécommande de cabine · messages et téléphone', () => {
  it('messages illisibles ou forgés ignorés', () => {
    expect(sanitizeCabinCommand({ id: 'a', cmd: 'delete_all', from: NINA, to: ENG, at: 1 })).toBeNull();
    expect(sanitizeCabinCommand({ id: 'a', cmd: 'rec', from: NINA, to: ENG })).toBeNull();
    expect(sanitizeCabinCommand(null)).toBeNull();
    expect(sanitizeCabinCommand({ id: 'a', cmd: 'rec', from: NINA, to: ENG, at: 5 })).toEqual({ id: 'a', cmd: 'rec', from: NINA, to: ENG, at: 5 });
    expect(sanitizeCabinState({ from: ENG, pos: -3, at: 1, rec: 'oui', ci: 2.4 })).toMatchObject({ pos: 0, rec: false, ci: 2, allowed: false, eng: "l'ingé" });
    expect(sanitizeCabinAck({ id: 'a', to: NINA, at: 1, ok: true, done: 'rm -rf' })).toEqual({ id: 'a', to: NINA, at: 1, ok: true });
  });

  it('le droit « remote » voyage avec les droits de l\'invité', () => {
    expect(sanitizeGuestRights({ limited: true, remote: true })!.remote).toBe(true);
    expect(sanitizeGuestRights({ limited: true, remote: 'oui' })!.remote).toBe(false);
  });

  it('position extrapolée pendant la lecture, figée à l\'arrêt', () => {
    expect(cabinPosition({ pos: 10, play: true, rec: false }, 1000, 3500)).toBeCloseTo(12.5);
    expect(cabinPosition({ pos: 10, play: false, rec: false }, 1000, 3500)).toBe(10);
  });

  it('liaison : ok, lente, perdue', () => {
    expect(cabinLink(null, 0)).toBe('attente');
    expect(cabinLink(1000, 2000)).toBe('ok');
    expect(cabinLink(1000, 4000)).toBe('lent');
    expect(cabinLink(1000, 7000)).toBe('perdu');
  });

  it('horloges décalées : le décalage suit le trajet le plus court', () => {
    let o = nextClockOffset(null, 10_000 + 5_000, 10_000 + 80); // ingé 5 s en avance, 80 ms de trajet
    expect(o).toBe(4920);
    o = nextClockOffset(o, 20_000 + 5_000, 20_000 + 20); // trajet plus court : suivi tout de suite
    expect(o).toBe(4980);
    o = nextClockOffset(o, 30_000 + 5_000, 30_000 + 900); // trajet lent : peu d'effet
    expect(o).toBeGreaterThan(4880);
  });

  it('boutons : coupés sans liaison sûre (raison claire), REC devient STOP pendant la prise', () => {
    const st = { rec: false, play: false, ci: null, allowed: true, eng: 'Max' };
    const ok = cabinButtons({ state: st, link: 'ok', online: true, engineerHere: true, pending: null });
    expect(ok).toMatchObject({ blocked: null, rec: { enabled: true, cmd: 'rec' }, play: { enabled: true, cmd: 'play' }, home: { enabled: true } });
    const off = cabinButtons({ state: st, link: 'ok', online: false, engineerHere: true, pending: null });
    expect(off.rec.enabled).toBe(false);
    expect(off.blocked).toMatch(/Pas de réseau/);
    expect(cabinButtons({ state: st, link: 'perdu', online: true, engineerHere: true, pending: null }).blocked).toMatch(/Liaison avec Max perdue/);
    expect(cabinButtons({ state: { ...st, allowed: false }, link: 'ok', online: true, engineerHere: true, pending: null }).blocked).toMatch(/pas activé/);
    expect(cabinButtons({ state: st, link: 'ok', online: true, engineerHere: false, pending: null }).blocked).toMatch(/pas dans la séance/);
    const rec = cabinButtons({ state: { ...st, rec: true, play: true }, link: 'ok', online: true, engineerHere: true, pending: null });
    expect(rec.rec).toMatchObject({ cmd: 'stop', label: '■ STOP', enabled: true });
    expect(rec.play.enabled).toBe(false);
    expect(rec.home.enabled).toBe(false);
    const counting = cabinButtons({ state: { ...st, ci: 3 }, link: 'ok', online: true, engineerHere: true, pending: null });
    expect(counting.rec.cmd).toBe('stop');
    expect(cabinButtons({ state: st, link: 'ok', online: true, engineerHere: true, pending: 'rec' }).rec.enabled).toBe(false);
  });

  it('phrases des accusés, sans jargon', () => {
    expect(cabinAckText({ ok: true, done: 'rec' }, 'Max')).toBe("● C'est parti chez Max");
    expect(cabinAckText({ ok: true, done: 'deja' }, 'Max')).toBe('✓ Déjà fait');
    expect(cabinAckText({ ok: false, reason: 'Non.' }, 'Max')).toBe('Non.');
  });
});

describe('télécommande de cabine · 📌 garder la prise', () => {
  it('hors prise : la dernière prise est gardée chez l’ingé (accusé « 📌 »)', () => {
    const d = cabinDecide(cmd({ cmd: 'keep' }), ctx({ hasTake: true }));
    expect(d).toMatchObject({ action: 'keep', ack: { ok: true, done: 'keep' } });
    expect(d!.log).toMatch(/Nina a gardé la dernière prise/);
    expect(cabinAckText({ ok: true, done: 'keep' }, 'Max')).toBe('📌 Prise gardée de côté chez Max');
  });
  it('pendant la prise, sans prise, sans droit : refusé avec la raison', () => {
    expect(cabinDecide(cmd({ cmd: 'keep' }), ctx({ isRecording: true }))).toMatchObject({ action: 'none', ack: { ok: false } });
    expect(cabinDecide(cmd({ cmd: 'keep' }), ctx({ hasTake: false }))!.ack.reason).toMatch(/Pas encore de prise/);
    expect(cabinDecide(cmd({ cmd: 'keep' }), ctx({ rights: DEFAULT_GUEST_RIGHTS }))!.action).toBe('none');
    expect(sanitizeCabinCommand({ id: 'a', cmd: 'keep', from: NINA, to: ENG, at: NOW })?.cmd).toBe('keep');
  });
  it('bouton du téléphone : coupé pendant la prise', () => {
    const live = { state: { rec: false, play: false, ci: null, allowed: true, eng: 'Max' }, link: 'ok' as const, online: true, engineerHere: true, pending: null };
    expect(cabinButtons(live).keep.enabled).toBe(true);
    expect(cabinButtons({ ...live, state: { ...live.state, rec: true } }).keep.enabled).toBe(false);
  });
});
