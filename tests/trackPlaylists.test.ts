import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));
vi.mock('../services/SessionCloud', () => ({ call: async () => ({}), sha1: async () => 'hash', CHUNK: 1024 * 1024 }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

import { contentBufferIds, contentOf, sigOf } from '../services/Collab';
import { trackBufferIds } from '../utils/freeze';
import {
  activePlaylistName, applyIncomingPlaylists, createPlaylist, deletePlaylist, hasPlaylists, inactivePlaylistClips, nextPlaylistName,
  packPlaylists, playlistsOf, renamePlaylist, sanitizeIncomingPlaylists, stepPlaylist, switchPlaylist, toggleRecentPlaylist, unpackPlaylists,
} from '../utils/trackPlaylists';
import { contentDelta, knownOf, mergeClips, metaSigOf, noteMerged, noteSent, pendingClipIds, KnownContent } from '../utils/collabContent';
import { LwwClock } from '../utils/collabMerge';
import type { Clip, Track } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

const lead = (): Track => makeTrack({
  id: 'lead', name: 'LEAD A',
  clips: [makeClip({ id: 'c1', start: 0, duration: 4, bufferId: 'b1' }), makeClip({ id: 'c2', start: 4, duration: 4, bufferId: 'b2', gain: 0.5 })],
  takeMeta: [{ n: 1, name: 'Couplet' }],
});

describe('playlists de piste (Pro Tools : New / Duplicate Playlist)', () => {
  it('une piste simple a une seule playlist, à son nom', () => {
    const t = lead();
    expect(hasPlaylists(t)).toBe(false);
    expect(activePlaylistName(t)).toBe('LEAD A');
    expect(playlistsOf(t).list).toHaveLength(1);
  });

  it('noms : LEAD A.01, LEAD A.02… (le plus grand + 1)', () => {
    expect(nextPlaylistName('LEAD A', ['LEAD A'])).toBe('LEAD A.01');
    expect(nextPlaylistName('LEAD A', ['LEAD A', 'LEAD A.01', 'LEAD A.07'])).toBe('LEAD A.08');
    expect(nextPlaylistName('V(1)', ['V(1).03'])).toBe('V(1).04');
  });

  it('nouvelle playlist : vide, active ; l’ancienne garde ses clips et ses couloirs', () => {
    const r = createPlaylist(lead(), { stamp: 's' });
    expect(r.name).toBe('LEAD A.01');
    expect(r.track.clips).toEqual([]);
    expect(r.track.takeMeta).toBeUndefined();
    expect(r.track.activePlaylistId).toBe(r.id);
    const main = r.track.playlists!.find(p => p.id !== r.id)!;
    expect(main.name).toBe('LEAD A');
    expect(main.clips.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(main.takeMeta).toEqual([{ n: 1, name: 'Couplet' }]);
    // L'entrée active ne garde jamais de clips (ils sont dans Track.clips).
    expect(r.track.playlists!.find(p => p.id === r.id)!.clips).toEqual([]);
  });

  it('dupliquer : copie avec de NOUVEAUX identifiants de clips, même son ; modifier la copie ne touche pas l’originale', () => {
    const r = createPlaylist(lead(), { duplicate: true, stamp: 's' });
    expect(r.track.clips.map(c => c.bufferId)).toEqual(['b1', 'b2']);
    expect(r.track.clips.map(c => c.gain)).toEqual([undefined, 0.5]);
    expect(r.track.clips.every(c => !['c1', 'c2'].includes(c.id))).toBe(true);
    expect(r.track.takeMeta).toEqual([{ n: 1, name: 'Couplet' }]);
    const edited: Track = { ...r.track, clips: r.track.clips.map(c => ({ ...c, gain: 2 })) };
    const back = switchPlaylist(edited, playlistsOf(edited).list[0].id);
    expect(back.clips.map(c => [c.id, c.gain])).toEqual([['c1', undefined], ['c2', 0.5]]);
    // Et la version éditée est gardée.
    const again = switchPlaylist(back, r.id);
    expect(again.clips.every(c => c.gain === 2)).toBe(true);
  });

  it('basculer : suivante / précédente sans boucler, Maj+← entre les deux dernières', () => {
    let t = createPlaylist(lead(), { stamp: 'a' }).track;          // LEAD A.01 (active, vide)
    t = createPlaylist(t, { duplicate: true, stamp: 'b' }).track;  // LEAD A.02 (copie de .01 = vide)
    expect(activePlaylistName(t)).toBe('LEAD A.02');
    expect(stepPlaylist(t, 1)).toBe(t);                            // déjà la dernière
    t = stepPlaylist(t, -1);
    expect(activePlaylistName(t)).toBe('LEAD A.01');
    t = stepPlaylist(t, -1);
    expect(activePlaylistName(t)).toBe('LEAD A');
    expect(t.clips.map(c => c.id)).toEqual(['c1', 'c2']);
    t = toggleRecentPlaylist(t);
    expect(activePlaylistName(t)).toBe('LEAD A.01');
    t = toggleRecentPlaylist(t);
    expect(activePlaylistName(t)).toBe('LEAD A');
  });

  it('renommer ; supprimer une version qui ne joue pas (jamais l’active) ; la liste reste pour la collaboration', () => {
    const r = createPlaylist(lead(), { stamp: 'a' });
    let t = renamePlaylist(r.track, r.id, '  Version clean ');
    expect(activePlaylistName(t)).toBe('Version clean');
    expect(deletePlaylist(t, r.id)).toBe(t);
    const mainId = playlistsOf(t).list[0].id;
    t = deletePlaylist(t, mainId);
    expect(t.playlists).toHaveLength(1);
    expect(hasPlaylists(t)).toBe(false);
    expect(inactivePlaylistClips(t)).toEqual([]);
  });

  it('les sons des playlists rangées restent en mémoire (trackBufferIds) et voyagent (contentBufferIds)', () => {
    const t = createPlaylist(lead(), { stamp: 'a' }).track;
    expect(trackBufferIds(t).sort()).toEqual(['b1', 'b2']);
    expect(contentBufferIds(t).sort()).toEqual(['b1', 'b2']);
  });
});

describe('sauvegarde (.zip) : les clips rangés passent par le chemin des autres puis reviennent', () => {
  it('pack / unpack : aller-retour exact, et sans playlist l’état n’est pas copié', () => {
    const plain = { tracks: [lead()] };
    expect(packPlaylists(plain)).toBe(plain);
    const t = createPlaylist(lead(), { stamp: 'a' }).track;
    const state = { tracks: [t] };
    const packed = packPlaylists(state);
    expect(packed.tracks[0].clips.map((c: Clip) => c.id)).toEqual(['c1', 'c2']);
    expect(packed.tracks[0].playlists.every((p: any) => p.clips.length === 0)).toBe(true);
    // Comme ProjectIO : JSON, puis les clips gagnent leur audioRef, puis on remet en place.
    const json = JSON.parse(JSON.stringify(packed));
    json.tracks[0].clips.forEach((c: any) => { c.audioRef = `audio/${c.bufferId}.wav`; delete c.bufferId; });
    unpackPlaylists(json);
    expect(json.tracks[0].clips).toEqual([]);
    const main = json.tracks[0].playlists.find((p: any) => p.name === 'LEAD A');
    expect(main.clips.map((c: any) => [c.id, c.audioRef])).toEqual([['c1', 'audio/b1.wav'], ['c2', 'audio/b2.wav']]);
    expect(main.clips.every((c: any) => !('__playlist' in c))).toBe(true);
    // L'état d'origine n'a pas bougé.
    expect(t.playlists!.find(p => p.name === 'LEAD A')!.clips.map(c => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('collaboration : les playlists voyagent dans l’op « content »', () => {
  const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

  it('piste sans playlist : contenu identique à une ancienne version (aucun champ en plus)', () => {
    const t = lead();
    expect('playlists' in wire(contentOf(t))).toBe(false);
  });

  it('contenu : liste, active, clips des rangées (sans son) ; la réception les remet tels quels', () => {
    const t = createPlaylist(lead(), { duplicate: true, stamp: 'a' }).track;
    const c = wire(contentOf(t));
    expect(c.playlists.active).toBe(t.activePlaylistId);
    expect(c.playlists.list.map((p: any) => [p.name, p.clips.length])).toEqual([['LEAD A', 2], ['LEAD A.01', 0]]);
    const got = makeTrack({ id: 'lead', name: 'LEAD A', clips: wire(t.clips) });
    applyIncomingPlaylists(got, sanitizeIncomingPlaylists(c.playlists));
    expect(got.activePlaylistId).toBe(t.activePlaylistId);
    expect(playlistsOf(got).list.map(p => p.name)).toEqual(['LEAD A', 'LEAD A.01']);
    expect(switchPlaylist(got, playlistsOf(got).list[0].id).clips.map(x => x.id)).toEqual(['c1', 'c2']);
    // Une ancienne version (champ absent) : on garde les nôtres.
    applyIncomingPlaylists(got, sanitizeIncomingPlaylists(undefined));
    expect(got.playlists).toHaveLength(2);
    // Donnée abîmée : jamais de clip sans durée, jamais deux fois le même identifiant.
    const bad = sanitizeIncomingPlaylists({ active: 'zz', list: [{ id: 'x', name: 'X', clips: [{ id: 'k', start: 0, duration: 0 }] }, { id: 'x' }, 7, { id: 'y', name: '', clips: 'non' }] });
    expect(bad!.list.map(p => [p.id, p.name, p.clips.length])).toEqual([['x', 'X', 0], ['y', 'Playlist', 0]]);
    expect(bad!.active).toBe('x');
  });

  it('basculer de playlist change l’empreinte du contenu (l’autre est prévenu)', () => {
    const t = createPlaylist(lead(), { stamp: 'a' }).track;
    const s = switchPlaylist(t, playlistsOf(t).list[0].id);
    expect(sigOf(contentOf(s))).not.toBe(sigOf(contentOf(t)));
  });

  /**
   * Convergence : deux personnes sur la même piste ; l'une crée / bascule des
   * playlists pendant que l'autre retouche un clip. Les opérations arrivent dans
   * n'importe quel ordre (et en double) : à la fin, mêmes clips, même liste.
   */
  it('convergence : mêmes clips et mêmes playlists chez tous, quel que soit l’ordre d’arrivée', () => {
    interface Op { seq: number; author: string; content: any; changed: string[]; removed: string[]; meta: boolean }
    class Peer {
      t: Track; known: KnownContent; lww = new LwwClock(); seen = new Set<number>();
      constructor(public name: string, t0: Track) { this.t = wire(t0); this.known = knownOf(metaSigOf(contentOf(this.t)), this.t.clips); }
      flush(ops: Op[], seq: { n: number }): void {
        const content = wire(contentOf(this.t));
        const d = contentDelta(this.known, metaSigOf(content), this.t.clips);
        if (!d.changed.length && !d.removed.length && !d.meta) return;
        const o: Op = { seq: ++seq.n, author: this.name, content, changed: d.changed, removed: d.removed, meta: d.meta };
        ops.push(o); this.seen.add(o.seq);
        [...d.changed, ...d.removed].forEach(id => this.lww.note(`clip:${id}`, o.seq));
        if (d.meta) this.lww.note('cmeta', o.seq);
        this.known = noteSent(this.known, { meta: metaSigOf(content), clips: this.t.clips, changed: d.changed, removed: d.removed });
      }
      receive(o: Op) {
        if (this.seen.has(o.seq)) return;
        this.seen.add(o.seq);
        const pending = pendingClipIds(this.known, this.t.clips);
        const localMetaPending = this.known.meta !== metaSigOf(wire(contentOf(this.t)));
        const metaOk = o.meta && !localMetaPending && this.lww.accept('cmeta', o.seq);
        const r = mergeClips(this.t.clips, o.content.clips, o, id => this.lww.accept(`clip:${id}`, o.seq), pending);
        const next: Track = { ...this.t, clips: r.clips };
        if (metaOk) applyIncomingPlaylists(next, sanitizeIncomingPlaylists(o.content.playlists));
        this.t = next;
        this.known = noteMerged(this.known, r.taken, r.dropped, metaOk ? metaSigOf(o.content) : undefined);
      }
      view() {
        return {
          clips: [...this.t.clips].sort((a, b) => (a.id < b.id ? -1 : 1)).map(c => `${c.id}:${c.start}:${c.gain ?? 1}`),
          active: this.t.activePlaylistId ?? null,
          list: (this.t.playlists || []).map(p => `${p.id}:${p.name}:${p.clips.map(c => c.id).sort().join(',')}`),
        };
      }
    }
    for (let trial = 0; trial < 40; trial++) {
      const rnd = (() => { let s = 1234 + trial * 7919; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
      const base = lead();
      const A = new Peer('ingé', base), B = new Peer('artiste', base);
      const ops: Op[] = []; const seq = { n: 0 };
      // A : duplique la playlist (copie de travail) et y retouche le gain ; B : retouche un clip de l'originale.
      A.t = createPlaylist(A.t, { duplicate: true, stamp: `a${trial}` }).track;
      A.t = { ...A.t, clips: A.t.clips.map((c, i) => (i === 0 ? { ...c, gain: 1.5 } : c)) };
      A.flush(ops, seq);
      B.t = { ...B.t, clips: B.t.clips.map(c => (c.id === 'c2' ? { ...c, start: 5 } : c)) };
      B.flush(ops, seq);
      // Livraison dans le désordre, avec doublons, puis rattrapage complet dans l'ordre du journal.
      const shuffled = [...ops, ...ops].sort(() => rnd() - 0.5);
      for (const o of shuffled) { if (o.author !== 'ingé') A.receive(o); if (o.author !== 'artiste') B.receive(o); }
      for (const o of ops) { A.receive(o); B.receive(o); }
      // Chacun renvoie ce qu'il a fusionné de nouveau, jusqu'au calme.
      for (let round = 0; round < 4; round++) {
        const before = ops.length;
        A.flush(ops, seq); B.flush(ops, seq);
        for (const o of ops.slice(before)) { A.receive(o); B.receive(o); }
      }
      expect(A.view()).toEqual(B.view());
      // Les deux ont les deux versions et entendent la même (celle créée par l'ingé, avec sa retouche).
      expect(B.view().list).toHaveLength(2);
      expect(B.t.activePlaylistId).toBe(B.t.playlists![1].id);
      expect(B.t.clips.some(c => c.gain === 1.5)).toBe(true);
      // L'originale rangée a gardé ses deux clips.
      expect(B.t.playlists![0].clips.map(c => c.id).sort()).toEqual(['c1', 'c2']);
    }
  });
});
