import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../types';
import { LwwClock } from '../utils/collabMerge';
import {
  canonicalOrder, canSendContent, canSendMix, clipSig, contentAllowed, contentDelta, deleteAllowed, isEmptyDelta, KnownContent,
  knownOf, mergeClips, mixAllowed, noteMerged, noteSent, pendingClipIds, sanitizeSongField,
} from '../utils/collabContent';

/**
 * Convergence du contenu clip par clip (format cv:2) : plusieurs participants
 * éditent les clips d'une même piste en même temps (l'artiste enregistre et
 * déplace, l'ingé comp / gain / respirations), les opérations arrivent dans
 * n'importe quel ordre, parfois en double. À la fin, tout le monde a
 * exactement les mêmes clips, et aucune édition plus récente n'est perdue.
 */

const clip = (id: string, start: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, name: id, start, duration: 1, offset: 0, fadeIn: 0, fadeOut: 0, color: '#fff', type: 'AUDIO' as any, bufferId: `b-${id}`, ...extra });

interface Op { seq: number; author: string; clips: Clip[]; changed: string[]; removed: string[] }

class Server {
  seq = 100;
  ops: Op[] = [];
  post(author: string, clips: Clip[], changed: string[], removed: string[]): Op {
    const o = { seq: ++this.seq, author, clips: JSON.parse(JSON.stringify(clips)), changed: [...changed], removed: [...removed] };
    this.ops.push(o);
    return o;
  }
}

class Peer {
  clips: Clip[];
  known: KnownContent;
  lww = new LwwClock();
  seen = new Set<number>();
  constructor(public name: string, initial: Clip[]) {
    this.clips = JSON.parse(JSON.stringify(initial));
    this.known = knownOf('m', this.clips);
  }
  edit(fn: (clips: Clip[]) => Clip[]) { this.clips = fn(JSON.parse(JSON.stringify(this.clips))); }
  /** Envoie ce qui a changé depuis ce que tout le monde a (comme sendTrackContent). */
  flush(server: Server): Op | null {
    const d = contentDelta(this.known, 'm', this.clips);
    if (isEmptyDelta({ ...d, meta: false })) return null;
    const o = server.post(this.name, this.clips, d.changed, d.removed);
    this.seen.add(o.seq);
    [...d.changed, ...d.removed].forEach(id => this.lww.note(`clip:${id}`, o.seq));
    this.known = noteSent(this.known, { meta: 'm', clips: this.clips, changed: d.changed, removed: d.removed });
    return o;
  }
  receive(o: Op) {
    if (this.seen.has(o.seq)) return; // doublon (direct + rattrapage)
    this.seen.add(o.seq);
    const pending = pendingClipIds(this.known, this.clips);
    const r = mergeClips(this.clips, o.clips, o, id => this.lww.accept(`clip:${id}`, o.seq), pending);
    this.clips = r.clips;
    this.known = noteMerged(this.known, r.taken, r.dropped);
  }
  view() { return [...this.clips].sort((a, b) => (a.id < b.id ? -1 : 1)).map(c => `${c.id}:${clipSig(c)}`); }
}

/** Générateur pseudo-aléatoire (reproductible). */
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

const settle = (server: Server, peers: Peer[], rand: () => number) => {
  // Livraisons dans le désordre, avec doublons, jusqu'à ce que plus rien ne bouge.
  for (let round = 0; round < 30; round++) {
    const sent = peers.map(p => p.flush(server)).filter(Boolean);
    for (const p of peers) {
      const ops = [...server.ops].sort(() => rand() - 0.5);
      for (const o of ops) { p.receive(o); if (rand() < 0.2) p.receive(o); }
    }
    if (!sent.length && peers.every(p => !p.flush(server))) return round;
  }
  return -1;
};

describe('contenu clip par clip : convergence', () => {
  it("l'artiste déplace la phrase 2 pendant que l'ingé baisse la phrase 3 : les deux éditions restent partout", () => {
    const init = [clip('p1', 0), clip('p2', 2), clip('p3', 4)];
    const s = new Server();
    const lina = new Peer('lina', init), max = new Peer('max', init);
    lina.edit(cs => cs.map(c => (c.id === 'p2' ? { ...c, start: 2.5 } : c)));
    max.edit(cs => cs.map(c => (c.id === 'p3' ? { ...c, gain: 0.6 } : c)));
    const a = lina.flush(s)!, b = max.flush(s)!;
    lina.receive(b); max.receive(a);
    expect(lina.view()).toEqual(max.view());
    expect(lina.clips.find(c => c.id === 'p2')!.start).toBe(2.5);
    expect(lina.clips.find(c => c.id === 'p3')!.gain).toBe(0.6);
  });

  it("une nouvelle prise de l'artiste n'efface pas les retouches de l'ingé faites pendant ce temps", () => {
    const init = [clip('p1', 0)];
    const s = new Server();
    const lina = new Peer('lina', init), max = new Peer('max', init);
    max.edit(cs => cs.map(c => ({ ...c, gain: 0.8, fadeIn: 0.05, breaths: [{ start: 0.1, end: 0.3, gainDb: -12 }] })));
    lina.edit(cs => [...cs, clip('prise-2', 6)]);
    const e = max.flush(s)!;
    const a = lina.flush(s)!; // envoyé avant d'avoir reçu les retouches de l'ingé
    lina.receive(e); max.receive(a);
    expect(lina.view()).toEqual(max.view());
    expect(lina.clips.map(c => c.id).sort()).toEqual(['p1', 'prise-2']);
    expect(lina.clips.find(c => c.id === 'p1')!.gain).toBe(0.8);
  });

  it('même clip modifié des deux côtés : le plus récent du journal gagne, chez tous', () => {
    const init = [clip('p1', 0)];
    const s = new Server();
    const lina = new Peer('lina', init), max = new Peer('max', init);
    lina.edit(cs => cs.map(c => ({ ...c, start: 1 })));
    max.edit(cs => cs.map(c => ({ ...c, gain: 0.5 })));
    const a = lina.flush(s)!, b = max.flush(s)!; // b plus récent
    max.receive(a); lina.receive(b);
    expect(lina.view()).toEqual(max.view());
    expect(lina.clips[0].gain).toBe(0.5);
  });

  it('modification locale pas encore partie : jamais écrasée, elle part ensuite et gagne partout', () => {
    const init = [clip('p1', 0)];
    const s = new Server();
    const lina = new Peer('lina', init), max = new Peer('max', init);
    max.edit(cs => cs.map(c => ({ ...c, gain: 0.5 })));
    const b = max.flush(s)!;
    lina.edit(cs => cs.map(c => ({ ...c, start: 3 })));   // pas encore envoyé
    lina.receive(b);
    expect(lina.clips[0].start).toBe(3);                 // pas écrasé
    const a = lina.flush(s)!;
    max.receive(a);
    expect(lina.view()).toEqual(max.view());
    expect(max.clips[0].start).toBe(3);
  });

  it('clip supprimé chez l\'un, déplacé chez l\'autre en même temps : même résultat partout', () => {
    const init = [clip('p1', 0), clip('p2', 2)];
    const s = new Server();
    const lina = new Peer('lina', init), max = new Peer('max', init);
    max.edit(cs => cs.filter(c => c.id !== 'p2'));
    lina.edit(cs => cs.map(c => (c.id === 'p2' ? { ...c, start: 5 } : c)));
    const e = max.flush(s)!, a = lina.flush(s)!;
    max.receive(a); lina.receive(e);
    expect(lina.view()).toEqual(max.view());
    expect(lina.clips.some(c => c.id === 'p2')).toBe(true); // le déplacement (plus récent) gagne
  });

  it('opérations en double et dans le désordre (direct + rattrapage) : appliquées une fois, même résultat', () => {
    const init = [clip('p1', 0), clip('p2', 2)];
    const s = new Server();
    const peers = [new Peer('a', init), new Peer('b', init), new Peer('c', init)];
    peers[0].edit(cs => cs.map(c => (c.id === 'p1' ? { ...c, start: 0.25 } : c)));
    peers[1].edit(cs => [...cs, clip('n1', 8)]);
    peers[2].edit(cs => cs.filter(c => c.id !== 'p2'));
    const r = settle(s, peers, rng(7));
    expect(r).toBeGreaterThanOrEqual(0);
    expect(peers[1].view()).toEqual(peers[0].view());
    expect(peers[2].view()).toEqual(peers[0].view());
  });

  it('fuzz : 300 sessions à 3, éditions aléatoires en rafales, livraisons désordonnées → toujours la même chose partout', () => {
    for (let run = 0; run < 300; run++) {
      const rand = rng(1000 + run);
      const init = Array.from({ length: 4 }, (_, i) => clip(`c${i}`, i * 2));
      const s = new Server();
      const peers = [new Peer('a', init), new Peer('b', init), new Peer('c', init)];
      let n = 0;
      for (let burst = 0; burst < 6; burst++) {
        for (const p of peers) {
          const k = Math.floor(rand() * 3);
          for (let j = 0; j < k; j++) {
            const r = rand();
            p.edit(cs => {
              if (r < 0.25 || !cs.length) return [...cs, clip(`new-${p.name}-${n++}`, rand() * 10)];
              const i = Math.floor(rand() * cs.length);
              if (r < 0.4) return cs.filter((_, x) => x !== i);
              if (r < 0.7) return cs.map((c, x) => (x === i ? { ...c, start: Math.round(rand() * 100) / 10 } : c));
              return cs.map((c, x) => (x === i ? { ...c, gain: Math.round(rand() * 10) / 10 } : c));
            });
          }
          if (rand() < 0.5) p.flush(s);
        }
        // Livraison partielle : chacun reçoit une partie du journal, dans le désordre.
        for (const p of peers) for (const o of [...s.ops].sort(() => rand() - 0.5)) if (rand() < 0.6) p.receive(o);
      }
      expect(settle(s, peers, rand)).toBeGreaterThanOrEqual(0);
      const v = peers[0].view();
      expect(peers[1].view(), `session ${run}`).toEqual(v);
      expect(peers[2].view(), `session ${run}`).toEqual(v);
    }
  });
});

const T = (o: Partial<Track>): Track => ({ id: 't', name: 'T', type: 'AUDIO' as any, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
  volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...o });

describe('qui peut envoyer / accepter quoi', () => {
  const lina = { role: 'artist' as const, key: 'u:lina' };
  const sam = { role: 'artist' as const, key: 'u:sam' };
  const max = { role: 'engineer' as const, key: 'u:max' };
  const voixLina = T({ id: 'voix', collabOwner: 'artist', collabOwnerKey: 'u:lina', collabOwnerName: 'Lina' });
  const beat = T({ id: 'instrumental', name: 'Beat' });

  it("contenu : l'artiste sa piste, l'ingé les pistes des artistes (pas le beat), jamais un autre artiste", () => {
    expect(canSendContent(voixLina, lina)).toBe(true);
    expect(canSendContent(voixLina, sam)).toBe(false);
    expect(canSendContent(voixLina, max)).toBe(true);
    expect(canSendContent(beat, max)).toBe(false);
    expect(contentAllowed(voixLina, { role: 'engineer', memberKey: 'u:max:pc' }, true).ok).toBe(true);
    expect(contentAllowed(voixLina, { role: 'engineer', memberKey: 'u:max:pc' }, false).ok).toBe(false); // version complète : refusée
    expect(contentAllowed(voixLina, { role: 'artist', memberKey: 'u:sam:tel' }, true).ok).toBe(false);
    expect(contentAllowed(voixLina, { role: 'artist', memberKey: 'u:lina:tablette' }, true).ok).toBe(true); // 2e appareil de Lina
  });

  it('mix : l\'ingé partout, un artiste sur SES pistes et sur le beat, pas sur la voix de l\'autre', () => {
    expect(canSendMix(voixLina, lina)).toBe(true);
    expect(canSendMix(voixLina, sam)).toBe(false);
    expect(canSendMix(beat, sam)).toBe(true);
    expect(mixAllowed(voixLina, { role: 'artist', memberKey: 'u:lina:pc' })).toBe(true);
    expect(mixAllowed(voixLina, { role: 'artist', memberKey: 'u:sam:pc' })).toBe(false);
    expect(mixAllowed(voixLina, { role: 'engineer', memberKey: 'u:max:pc' })).toBe(true);
  });

  it('suppression : le propriétaire ; le beat seulement par l\'ingé', () => {
    expect(deleteAllowed(voixLina, { role: 'artist', memberKey: 'u:lina:pc' })).toBe(true);
    expect(deleteAllowed(voixLina, { role: 'engineer', memberKey: 'u:max:pc' })).toBe(false);
    expect(deleteAllowed(beat, { role: 'engineer', memberKey: 'u:max:pc' })).toBe(true);
    expect(deleteAllowed(beat, { role: 'artist', memberKey: 'u:sam:pc' })).toBe(false);
  });
});

describe('ordre des pistes', () => {
  const tr = (id: string, type = 'AUDIO') => T({ id, type: type as any });
  it('même ordre partout, quel que soit l\'ordre local, pour la même liste reçue', () => {
    const order = ['voix', 'beat', 'bus1', 'master'];
    const a = canonicalOrder([tr('beat'), tr('master', 'AUDIO'), tr('voix'), tr('bus1', 'BUS'), tr('new-b'), tr('new-a')], order);
    const b = canonicalOrder([tr('new-a'), tr('voix'), tr('new-b'), tr('bus1', 'BUS'), tr('beat'), tr('master', 'AUDIO')], order);
    expect(a.map(t => t.id)).toEqual(b.map(t => t.id));
    expect(a.map(t => t.id)).toEqual(['voix', 'beat', 'new-a', 'new-b', 'bus1', 'master']);
  });
});

describe('session : champs vérifiés', () => {
  it('tonalité, gamme, arrangements bornés ; valeurs abîmées ignorées', () => {
    expect(sanitizeSongField('projectKey', 9)).toBe(9);
    expect(sanitizeSongField('projectKey', 14)).toBeUndefined();
    expect(sanitizeSongField('projectScale', 'MINOR')).toBe('MINOR');
    expect(sanitizeSongField('arrangements', [{ id: 'a', sections: ['x', 3], name: 'Court' }, { bad: 1 }])).toEqual([{ id: 'a', name: 'Court', sections: ['x'], mutedClipIds: [] }]);
    expect(sanitizeSongField('lyrics', null)).toBeNull();
  });
});

describe('réparation d’un écart (version complète qui fait foi)', () => {
  it('le propriétaire renvoie tout : l’autre retire le clip en trop et reprend les valeurs', () => {
    const owner = [clip('a', 0, { gain: 0.5 }), clip('b', 2)];
    const other = [clip('a', 0, { gain: 0.9 }), clip('b', 2), clip('fantome', 4)];
    const lww = new LwwClock();
    const r = mergeClips(other, owner, { changed: ['a', 'b'], removed: [], full: true }, id => lww.accept(id, 50), new Set());
    expect(r.clips.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(r.clips.find(c => c.id === 'a')!.gain).toBe(0.5);
    // Un clip modifié ici et pas encore parti n'est jamais retiré.
    const r2 = mergeClips(other, owner, { changed: ['a'], full: true }, () => true, new Set(['fantome']));
    expect(r2.clips.some(c => c.id === 'fantome')).toBe(true);
  });
});

/**
 * Envois EN ROUTE : comme dans l'appli, on ne connaît notre numéro du journal qu'à la
 * réponse du serveur. Pendant ce temps, une version reçue d'un clip qu'on vient d'envoyer
 * est mise de côté, puis départagée à la réponse (App : deferredClipRef / onSent).
 */
class InflightPeer extends Peer {
  inflight: { clips: Clip[]; changed: string[]; removed: string[]; op: Op } | null = null;
  deferred = new Map<string, { seq: number; clip: Clip | null }>();
  /** Envoi : le serveur l'enregistre tout de suite (numéro attribué), la réponse arrive plus tard (ack). */
  startSend(server: Server) {
    if (this.inflight) return false;
    const d = contentDelta(this.known, 'm', this.clips);
    if (isEmptyDelta({ ...d, meta: false })) return false;
    const clips = JSON.parse(JSON.stringify(this.clips));
    const op = server.post(this.name, clips, d.changed, d.removed);
    this.seen.add(op.seq);
    this.inflight = { clips, changed: d.changed, removed: d.removed, op };
    return true;
  }
  ack(_server?: Server) {
    const f = this.inflight!;
    this.inflight = null;
    const o = f.op;
    [...f.changed, ...f.removed].forEach(id => this.lww.note(`clip:${id}`, o.seq));
    // Départage des versions reçues pendant l'envoi (comme onSent dans App).
    const sent = new Map(f.clips.map(c => [c.id, c]));
    const upsert: Clip[] = []; const drop: string[] = [];
    for (const id of [...f.changed, ...f.removed]) {
      const dd = this.deferred.get(id);
      if (!dd) continue;
      this.deferred.delete(id);
      if (dd.seq < o.seq) continue;
      const local = this.clips.find(c => c.id === id);
      const s = sent.get(id);
      if ((local && s && clipSig(local) !== clipSig(s)) || (!!local !== !!s)) continue;
      this.lww.accept(`clip:${id}`, dd.seq);
      if (dd.clip) upsert.push(dd.clip); else drop.push(id);
    }
    this.known = noteSent(this.known, { meta: 'm', clips: f.clips, changed: f.changed, removed: f.removed });
    if (upsert.length || drop.length) {
      this.known = noteMerged(this.known, upsert, drop);
      this.clips = this.clips.filter(c => !drop.includes(c.id));
      for (const u of upsert) { const i = this.clips.findIndex(c => c.id === u.id); if (i >= 0) this.clips[i] = { ...u }; else this.clips.push({ ...u }); }
    }
    return o;
  }
  receive(o: Op) {
    if (this.seen.has(o.seq)) return;
    this.seen.add(o.seq);
    const pending = pendingClipIds(this.known, this.clips);
    if (this.inflight) [...this.inflight.changed, ...this.inflight.removed].forEach(id => pending.add(id));
    const inc = new Map(o.clips.map(c => [c.id, c]));
    for (const id of [...o.changed, ...o.removed]) {
      if (!pending.has(id)) continue;
      const d = this.deferred.get(id);
      if (!d || d.seq < o.seq) this.deferred.set(id, { seq: o.seq, clip: inc.get(id) || null });
    }
    const r = mergeClips(this.clips, o.clips, o, id => this.lww.accept(`clip:${id}`, o.seq), pending);
    this.clips = r.clips;
    this.known = noteMerged(this.known, r.taken, r.dropped);
  }
}

describe('envois en route (numéro du journal connu à la réponse)', () => {
  it('Lina déplace la phrase 2, Max baisse la phrase 3, les deux envois se croisent : les deux restent', () => {
    const init = [clip('p1', 0), clip('p2', 2), clip('p3', 4)];
    const s = new Server();
    const lina = new InflightPeer('lina', init), max = new InflightPeer('max', init);
    lina.edit(cs => cs.map(c => (c.id === 'p2' ? { ...c, start: 2.5 } : c)));
    max.edit(cs => cs.map(c => (c.id === 'p3' ? { ...c, gain: 0.6 } : c)));
    lina.startSend(s); max.startSend(s);   // enregistrés 101 (Lina) et 102 (Max), réponses pas encore arrivées
    const [a, b] = s.ops.slice(-2);
    max.receive(a); lina.receive(b);         // chacun reçoit l'autre AVANT sa propre réponse
    lina.ack(); max.ack();
    expect(lina.view()).toEqual(max.view());
    expect(lina.clips.find(c => c.id === 'p2')!.start).toBe(2.5);
    expect(max.clips.find(c => c.id === 'p3')!.gain).toBe(0.6);
  });

  it('même clip, envois croisés : le plus récent du journal gagne chez les deux', () => {
    const init = [clip('p1', 0)];
    const s = new Server();
    const lina = new InflightPeer('lina', init), max = new InflightPeer('max', init);
    lina.edit(cs => cs.map(c => ({ ...c, start: 1 })));
    max.edit(cs => cs.map(c => ({ ...c, gain: 0.5 })));
    lina.startSend(s); max.startSend(s);   // 101 (Lina), 102 (Max : plus récent)
    const [a, b] = s.ops.slice(-2);
    lina.receive(b); max.receive(a);         // reçus pendant que les deux réponses sont en route
    lina.ack(); max.ack();
    expect(lina.view()).toEqual(max.view());
    expect(lina.clips[0].gain).toBe(0.5);
  });

  it('fuzz : 300 sessions à 3, envois en route qui se croisent, livraisons désordonnées → même résultat partout', () => {
    for (let run = 0; run < 300; run++) {
      const rand = rng(5000 + run);
      const init = Array.from({ length: 4 }, (_, i) => clip(`c${i}`, i * 2));
      const s = new Server();
      const peers = [new InflightPeer('a', init), new InflightPeer('b', init), new InflightPeer('c', init)];
      let n = 0;
      const deliver = (p: InflightPeer) => { for (const o of [...s.ops].sort(() => rand() - 0.5)) if (rand() < 0.5) p.receive(o); };
      for (let step = 0; step < 40; step++) {
        const p = peers[Math.floor(rand() * 3)];
        const r = rand();
        if (r < 0.35) {
          p.edit(cs => {
            const q = rand();
            if (q < 0.2 || !cs.length) return [...cs, clip(`new-${p.name}-${n++}`, rand() * 10)];
            const i = Math.floor(rand() * cs.length);
            if (q < 0.35) return cs.filter((_, x) => x !== i);
            if (q < 0.7) return cs.map((c, x) => (x === i ? { ...c, start: Math.round(rand() * 100) / 10 } : c));
            return cs.map((c, x) => (x === i ? { ...c, gain: Math.round(rand() * 10) / 10 } : c));
          });
        } else if (r < 0.55) p.startSend(s);
        else if (r < 0.75) { if (p.inflight) p.ack(); }
        else deliver(p);
      }
      // Fin : tout part, tout arrive.
      for (let round = 0; round < 30; round++) {
        let any = false;
        for (const p of peers) { if (p.inflight) { p.ack(); any = true; } if (p.startSend(s)) { p.ack(); any = true; } }
        for (const p of peers) for (const o of [...s.ops].sort(() => rand() - 0.5)) p.receive(o);
        if (!any) break;
      }
      const v = peers[0].view();
      expect(peers[1].view(), `session ${run}`).toEqual(v);
      expect(peers[2].view(), `session ${run}`).toEqual(v);
    }
  });
});
