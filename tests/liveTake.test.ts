import { describe, expect, it } from 'vitest';
import { crc32, decodeSegment, encodeSegment, fromInt24, Pcm24Crc, segmentInfo, takeSum, toInt24 } from '../utils/liveTakeCodec';
import { LiveTakeAssembly, LiveTakeSender, LtItem, LtTransport, memoryLtStore, nextOrder, SegmentCutter, sanitizeLiveRef, withoutLive } from '../utils/liveTake';
import { arrivalAfterStop, judgeNetwork, rttStats, VERDICT_TEXT } from '../utils/netTest';

/** Générateur déterministe (mêmes « prises » à chaque passage). */
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

/** Une « voix » : harmoniques, vibrato, souffle, silences entre les phrases. */
const voice = (frames: number, sr = 48000, seed = 1, bits16 = true): Float32Array => {
  const r = rng(seed);
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const on = (t % 2.5) < 1.8 ? 1 : 0;
    const f0 = 180 + 8 * Math.sin(2 * Math.PI * 5 * t);
    let v = on * 0.4 * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t) + 0.25 * Math.sin(6 * Math.PI * f0 * t)) / 1.75;
    v += (r() - 0.5) * 0.002;
    x[i] = bits16 ? Math.round(v * 32767) / 32768 : v;
  }
  return x;
};
const ints = (x: Float32Array) => Int32Array.from(x, toInt24);

describe('codage sans perte d’un morceau de prise', () => {
  it('mono 16 bits : identique au bit près, et plus petit que le PCM 24 bits', () => {
    const x = ints(voice(48000 * 3));
    const enc = encodeSegment([x]);
    const dec = decodeSegment(enc);
    expect(dec.frames).toBe(x.length);
    expect(Array.from(dec.ints[0])).toEqual(Array.from(x));
    // Source 16 bits : ~16 bits utiles au plus, bien moins avec la prédiction.
    expect(enc.length).toBeLessThan(x.length * 3 * 0.5);
  });

  it('stéréo d’un micro mono (gauche = droite) : la différence ne coûte presque rien', () => {
    const l = ints(voice(48000 * 3, 48000, 2));
    const mono = encodeSegment([l]).length;
    const st = encodeSegment([l, l.slice()]);
    expect(st.length).toBeLessThan(mono * 1.1);
    const d = decodeSegment(st);
    expect(Array.from(d.ints[1])).toEqual(Array.from(l));
  });

  it('vraie stéréo 24 bits (sans bits inutilisés), bruit pur, silence, extrêmes : toujours exact', () => {
    const r = rng(7);
    const n = 48000;
    const a = ints(voice(n, 48000, 3, false));
    const b = Int32Array.from(a, (v, i) => Math.max(-0x800000, Math.min(0x7fffff, Math.round(v * 0.7 + (r() - 0.5) * 3000 + (i % 97)))));
    const noise = Int32Array.from({ length: n }, () => Math.floor(r() * 0x1000000) - 0x800000);
    const silence = new Int32Array(n);
    const ext = Int32Array.from({ length: 4096 }, (_, i) => (i % 2 ? 0x7fffff : -0x800000));
    for (const chs of [[a, b], [noise], [silence], [ext, ext.map(v => -v - 1)], [Int32Array.of(5)], [Int32Array.of(1, -1, 3)]]) {
      const enc = encodeSegment(chs);
      const dec = decodeSegment(enc);
      chs.forEach((c, k) => expect(Array.from(dec.ints[k])).toEqual(Array.from(c)));
      // Jamais plus gros que le PCM 24 bits (+ en-tête) : repli « tel quel » pour le bruit.
      expect(enc.length).toBeLessThanOrEqual(20 + chs[0].length * chs.length * 3 + 4);
    }
  });

  it('un morceau abîmé est refusé (somme de contrôle)', () => {
    const x = ints(voice(20000));
    const enc = encodeSegment([x]);
    for (const pos of [25, Math.floor(enc.length / 2), enc.length - 2]) {
      const bad = enc.slice();
      bad[pos] ^= 0x10;
      expect(() => decodeSegment(bad)).toThrow();
    }
    expect(() => decodeSegment(enc.slice(0, enc.length - 10))).toThrow();
    expect(segmentInfo(enc)?.frames).toBe(20000);
  });

  it('quantification 24 bits identique au WAV de la prise, somme de contrôle = CRC-32 des octets PCM', () => {
    expect(toInt24(1)).toBe(0x7fffff);
    expect(toInt24(-1)).toBe(-0x800000);
    expect(toInt24(2)).toBe(0x7fffff);
    expect(toInt24(0.5)).toBe(Math.round(0.5 * 0x7fffff));
    expect(fromInt24(-0x800000)).toBe(-1);
    // CRC-32 de référence (« 123456789 » → cbf43926).
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
    const x = Int32Array.of(1, -2, 0x7fffff, -0x800000);
    const bytes = new Uint8Array(12);
    x.forEach((s, i) => { bytes[3 * i] = s & 0xff; bytes[3 * i + 1] = (s >> 8) & 0xff; bytes[3 * i + 2] = (s >> 16) & 0xff; });
    expect(new Pcm24Crc().update([x]).value()).toBe(crc32(bytes));
  });
});

describe('découpage pendant la prise et recollage chez l’ingé', () => {
  const run = (nc: number, frames: number, chunk: number, from: number, seg = 48000) => {
    const chs = Array.from({ length: nc }, (_, c) => voice(frames, 48000, 10 + c));
    const asm = new LiveTakeAssembly('t1', 'voix', 'Nina');
    const cutter = new SegmentCutter(nc, seg, (i, s) => {
      const bytes = encodeSegment(s);
      asm.addMeta({ i, h: `h${i}`, n: s[0].length });
      asm.addBytes(i, bytes);
    });
    // Le journal de prise reçoit des morceaux de 8192 images (stéréo : entrelacé).
    for (let a = 0; a < frames; a += chunk) {
      const b = Math.min(frames, a + chunk);
      const x = new Float32Array((b - a) * nc);
      for (let i = a; i < b; i++) for (let c = 0; c < nc; c++) x[(i - a) * nc + c] = chs[c][i];
      cutter.push(x);
    }
    const n = cutter.flush();
    const take = chs.map(c => c.subarray(from));
    asm.setEnd({ t: 't1', n, from, frames: frames - from, ch: nc, sr: 48000, sum: takeSum(take) });
    return { asm, take, n };
  };

  it('mono : morceaux de 3 s, prise recollée au bit près (décompte et latence retirés)', () => {
    const { asm, take, n } = run(1, 48000 * 10 + 1234, 8192, 7000, 48000 * 3);
    expect(n).toBe(4);
    expect(asm.complete()).toBe(true);
    const out = asm.assemble()!;
    expect(out).not.toBeNull();
    expect(out.channels[0].length).toBe(take[0].length);
    for (let i = 0; i < take[0].length; i += 997) expect(toInt24(out.channels[0][i])).toBe(toInt24(take[0][i]));
    expect(takeSum(out.channels)).toBe(takeSum(take));
    expect(asm.peaks.length).toBeGreaterThan(200);
  });

  it('stéréo entrelacée : recollage exact', () => {
    const { asm, take } = run(2, 48000 * 5, 8192, 0, 48000 * 2);
    const out = asm.assemble()!;
    expect(takeSum(out.channels)).toBe(takeSum(take));
  });

  it('un morceau manquant : pas posée ; une somme fausse : refusée', () => {
    const { asm } = run(1, 48000 * 4, 4096, 100, 48000);
    asm.segs.delete(2);
    expect(asm.complete()).toBe(false);
    expect(asm.assemble()).toBeNull();
    const r2 = run(1, 48000 * 2, 4096, 0, 48000);
    r2.asm.setEnd({ ...r2.asm.end!, sum: '96000:00000000' });
    expect(r2.asm.assemble()).toBeNull();
  });

  it('un morceau abîmé en route est refusé à l’arrivée', () => {
    const asm = new LiveTakeAssembly('t', 'v', 'N');
    const enc = encodeSegment([ints(voice(9000))]);
    enc[enc.length - 3] ^= 1;
    expect(() => asm.addBytes(0, enc)).toThrow();
    expect(asm.segs.size).toBe(0);
  });
});

/** Serveur simulé : morceaux en ligne, journal (les doublons d'identifiant sont comptés). */
const fakeServer = () => {
  const parts = new Map<string, Uint8Array>();
  const ops: { kind: string; op: Record<string, any> }[] = [];
  let online = true;
  let loseReply = false;
  const t: LtTransport & { parts: typeof parts; ops: typeof ops; setOnline: (v: boolean) => void; loseNextReply: () => void } = {
    parts, ops,
    setOnline: (v) => { online = v; },
    loseNextReply: () => { loseReply = true; },
    session: () => 'sess',
    hash: async (b) => `${b.length}-${crc32(b).toString(16)}`,
    upload: async (ps) => { if (!online) throw new Error('hors ligne'); ps.forEach(p => parts.set(p.hash, p.bytes)); },
    send: async (kind, op) => {
      if (!online) throw new Error('hors ligne');
      ops.push({ kind, op });
      if (loseReply) { loseReply = false; throw new Error('réponse perdue'); }
    },
  };
  return t;
};

/** Ce que reçoit l'ingé : opérations dédoublonnées par identifiant (comme CollabClient), morceaux recollés. */
const receive = (srv: ReturnType<typeof fakeServer>) => {
  const seen = new Set<string>();
  const asm = new Map<string, LiveTakeAssembly>();
  let dupSegs = 0;
  for (const { kind, op } of srv.ops) {
    if (seen.has(op._id)) continue;
    seen.add(op._id);
    if (kind === 'take_seg') {
      const a = asm.get(op.t) || new LiveTakeAssembly(op.t, op.trackId, 'Nina');
      asm.set(op.t, a);
      for (const s of op.segs) { if (a.segs.has(s.i)) dupSegs++; a.addMeta(s); a.addBytes(s.i, srv.parts.get(s.h)!); }
    } else if (kind === 'take_end' && !op.cancel) asm.get(op.t)!.setEnd(op as any);
  }
  return { asm, dupSegs };
};

const makeTake = (sender: LiveTakeSender, take: string, x: Float32Array, segFrames: number, from: number) => {
  const cutter = new SegmentCutter(1, segFrames, (i, s) => {
    const bytes = encodeSegment(s);
    sender.enqueue({ key: `${take}:${i}`, session: 'sess', take, trackId: 'voix', kind: 'seg', order: nextOrder(), i, bytes, frames: s[0].length, ch: 1, sr: 48000 });
  });
  for (let a = 0; a < x.length; a += 8192) cutter.push(x.subarray(a, a + 8192));
  const n = cutter.flush();
  const ref = { t: take, n, from, frames: x.length - from, ch: 1, sr: 48000, sum: takeSum([x], from), b: `rec-${take}` };
  sender.enqueue({ key: `${take}:end`, session: 'sess', take, trackId: 'voix', kind: 'end', order: nextOrder(), ref });
  return ref;
};

describe('file d’envoi : reprise après coupure, onglet fermé, sans doublon et dans l’ordre', () => {
  it('coupure réseau au milieu : tout repart au retour, dans l’ordre, prise complète au bit près', async () => {
    const srv = fakeServer();
    const store = memoryLtStore();
    const s = new LiveTakeSender(store, srv, { batch: 3, maxBackoff: 20 });
    srv.setOnline(false);
    const x = voice(48000 * 8, 48000, 21);
    const ref = makeTake(s, 'tA', x, 48000, 3000);
    await new Promise(r => setTimeout(r, 30));
    expect(srv.ops.length).toBe(0);
    expect(store.items.size).toBe(ref.n + 1); // tout est gardé sur l'appareil
    expect(s.takeProgress('tA')!.waiting).toBe(true);
    srv.setOnline(true);
    s.kick();
    await s.idle();
    expect(store.items.size).toBe(0);
    const order = srv.ops.filter(o => o.kind === 'take_seg').flatMap(o => o.op.segs.map((g: any) => g.i));
    expect(order).toEqual([...Array(ref.n).keys()]);
    expect(srv.ops[srv.ops.length - 1].kind).toBe('take_end');
    const { asm } = receive(srv);
    expect(takeSum(asm.get('tA')!.assemble()!.channels)).toBe(ref.sum);
    const p = s.takeProgress('tA')!;
    expect(p.done).toBe(true);
    expect(p.sent).toBe(p.total);
  });

  it('réponse perdue : renvoi avec le même identifiant, appliqué une seule fois', async () => {
    const srv = fakeServer();
    const s = new LiveTakeSender(memoryLtStore(), srv, { batch: 2, maxBackoff: 5 });
    srv.loseNextReply();
    const x = voice(48000 * 5, 48000, 4);
    const ref = makeTake(s, 'tB', x, 48000, 0);
    for (let k = 0; k < 50 && !s.takeProgress('tB')!.done; k++) await new Promise(r => setTimeout(r, 10));
    const ids = srv.ops.map(o => o.op._id);
    expect(ids.length).toBeGreaterThan(new Set(ids).size); // un envoi en double sur le serveur…
    const { asm, dupSegs } = receive(srv);
    expect(dupSegs).toBe(0); // … jamais appliqué deux fois
    expect(takeSum(asm.get('tB')!.assemble()!.channels)).toBe(ref.sum);
  });

  it('onglet fermé pendant l’envoi : la page rouverte reprend ce qui reste, sans renvoyer ce qui est parti', async () => {
    const srv = fakeServer();
    const store = memoryLtStore();
    const s1 = new LiveTakeSender(store, srv, { batch: 1, maxBackoff: 5 });
    const x = voice(48000 * 9, 48000, 9);
    srv.setOnline(true);
    // Envoi coupé après 3 morceaux (l'onglet se ferme) : la suite reste sur l'appareil.
    let sends = 0;
    const send0 = srv.send;
    srv.send = async (k, op) => { if (++sends > 3) throw new Error('onglet fermé'); return send0(k, op); };
    const ref = makeTake(s1, 'tC', x, 48000, 500);
    await new Promise(r => setTimeout(r, 40));
    s1.dispose();
    const sentBefore = srv.ops.length;
    expect(sentBefore).toBe(3);
    expect(store.items.size).toBe(ref.n + 1 - 3);
    // Réouverture : nouvelle page, même appareil (même stockage).
    srv.send = send0;
    const s2 = new LiveTakeSender(store, srv, { batch: 4 });
    const restored = await s2.load();
    expect(restored.map(r => r.key)).toEqual([...[...Array(ref.n).keys()].slice(3).map(i => `tC:${i}`), 'tC:end']);
    s2.kick();
    await s2.idle();
    expect(store.items.size).toBe(0);
    const segIdx = srv.ops.filter(o => o.kind === 'take_seg').flatMap(o => o.op.segs.map((g: any) => g.i));
    expect(segIdx).toEqual([...Array(ref.n).keys()]); // aucun morceau envoyé deux fois
    const { asm } = receive(srv);
    expect(takeSum(asm.get('tC')!.assemble()!.channels)).toBe(ref.sum);
  });

  it('envoi en deux étages (adresse demandée d’avance) : annonces dans l’ordre, morceau déjà en ligne non renvoyé', async () => {
    const srv = fakeServer();
    const puts: string[] = [];
    const signs: string[] = [];
    const t: LtTransport = {
      ...srv,
      sign: async (h) => { signs.push(h); await new Promise(r => setTimeout(r, 2)); return srv.parts.has(h) ? null : { h }; },
      put: async (h, b) => { puts.push(h); await new Promise(r => setTimeout(r, 5)); srv.parts.set(h, b); },
    };
    const s = new LiveTakeSender(memoryLtStore(), t);
    const x = voice(48000 * 6, 48000, 33);
    // Un morceau déjà en ligne (envoyé avant une coupure dont la réponse s'est perdue).
    const first = encodeSegment([Int32Array.from(x.subarray(0, 48000), toInt24)]);
    srv.parts.set(await t.hash(first), first);
    const ref = makeTake(s, 'tP', x, 48000, 0);
    await s.idle();
    expect(puts.length).toBe(ref.n - 1);
    expect(signs.length).toBe(ref.n);
    const idx = srv.ops.filter(o => o.kind === 'take_seg').flatMap(o => o.op.segs.map((g: any) => g.i));
    expect(idx).toEqual([...Array(ref.n).keys()]);
    const { asm } = receive(srv);
    expect(takeSum(asm.get('tP')!.assemble()!.channels)).toBe(ref.sum);
  });

  it('progression : octets confirmés, « reçue par Max »', async () => {
    const srv = fakeServer();
    const s = new LiveTakeSender(memoryLtStore(), srv);
    makeTake(s, 'tD', voice(48000 * 4), 48000, 0);
    await s.idle();
    const p = s.takeProgress('tD')!;
    expect(p.ended && p.done).toBe(true);
    s.markReceived('tD', 'Max');
    s.markReceived('tD', 'Max');
    expect(s.takeProgress('tD')!.receivedBy).toEqual(['Max']);
  });

  it('références reçues : bornées ; audio des prises en direct retiré de l’envoi classique', () => {
    expect(sanitizeLiveRef({ t: 'a', n: 2, from: 0, frames: 10, ch: 1, sr: 48000, sum: '10:aa' })).not.toBeNull();
    expect(sanitizeLiveRef({ t: 'a', n: 0, from: 0, frames: 10, ch: 1, sr: 48000, sum: 'x' })).toBeNull();
    expect(sanitizeLiveRef({ t: 'a', n: 1, from: -1, frames: 10, ch: 1, sr: 48000, sum: 'x' })).toBeNull();
    expect(withoutLive({ a: 1, b: 2 }, { a: {} })).toEqual({ b: 2 });
    const it: LtItem = { key: 'k', session: 's', take: 't', trackId: 'v', kind: 'cancel', order: 1 };
    expect(it.kind).toBe('cancel');
  });
});

describe('test de connexion : verdict et prédiction', () => {
  const mono48 = { sampleRate: 48000, channels: 1 };
  it('fibre : parfaite, prise de 3 min ~2 s après STOP', () => {
    const v = judgeNetwork({ upKbps: 40000, rttMs: 15, lossPct: 0 }, mono48);
    expect(v.level).toBe('parfait');
    expect(v.title).toBe(VERDICT_TEXT.parfait);
    expect(v.arrivalSec).toBeLessThan(3);
  });
  it('4G : ça ira', () => {
    const v = judgeNetwork({ upKbps: 4000, rttMs: 140, lossPct: 0, jitterMs: 80 }, mono48);
    expect(v.level).toBe('ok');
    expect(v.arrivalSec).toBeLessThan(4);
  });
  it('très faible : trop faible, la prise arrive en retard (prédiction chiffrée)', () => {
    const v = judgeNetwork({ upKbps: 250, rttMs: 600, lossPct: 25 }, mono48);
    expect(v.level).toBe('faible');
    expect(v.title).toBe(VERDICT_TEXT.faible);
    expect(v.arrivalSec).toBeGreaterThan(120);
    expect(v.arrivalText).toMatch(/min/);
  });
  it('stéréo : besoin doublé ; 1 Mb/s suffit encore', () => {
    const st = { sampleRate: 48000, channels: 2 };
    expect(judgeNetwork({ upKbps: 1000, rttMs: 80, lossPct: 0 }, st).needKbps).toBe(864);
    expect(arrivalAfterStop({ upKbps: 1000, rttMs: 80, lossPct: 0 }, st)).toBeLessThan(5);
    expect(arrivalAfterStop({ upKbps: 500, rttMs: 80, lossPct: 0 }, st)).toBeGreaterThan(100);
  });
  it('allers-retours : médiane et écart', () => {
    expect(rttStats([100, 80, 90, 300, 85])).toEqual({ median: 90, jitter: 220 });
    expect(rttStats([])).toEqual({ median: 0, jitter: 0 });
  });
});
