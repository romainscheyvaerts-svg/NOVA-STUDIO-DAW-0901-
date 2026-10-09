import { describe, expect, it, vi } from 'vitest';
import { CollabRtc, musicOpusSdp, OFFER_TIMEOUT_MS, RtcSignal } from '../services/CollabRtc';

/** Audio en direct (talkback, mix de l'ingé) : SDP musique et signalisation adressée. */

describe('Opus pour la musique', () => {
  it('stéréo, 510 kb/s, correction d’erreurs ; les autres réglages gardés', () => {
    const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;usedtx=0\r\n';
    const out = musicOpusSdp(sdp);
    expect(out).toMatch(/a=fmtp:111 [^\r\n]*stereo=1/);
    expect(out).toMatch(/maxaveragebitrate=510000/);
    expect(out).toMatch(/usedtx=0/);
    expect(out.match(/minptime/g)!.length).toBe(1);
  });
  it('sans ligne fmtp : elle est ajoutée ; sans Opus : rien ne change', () => {
    expect(musicOpusSdp('a=rtpmap:109 opus/48000/2\r\n')).toMatch(/a=fmtp:109 stereo=1/);
    expect(musicOpusSdp('a=rtpmap:0 PCMU/8000\r\n')).toBe('a=rtpmap:0 PCMU/8000\r\n');
  });
});

class FakePc {
  static all: FakePc[] = [];
  senders: any[] = [];
  closed = false;
  connectionState = 'new';
  signalingState = 'stable';
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: any = null; ontrack: any = null; onconnectionstatechange: any = null;
  localDescription: any = null;
  constructor() { FakePc.all.push(this); }
  addTrack(track: any) { const s = { track, getParameters: () => ({}), setParameters: async () => {} }; this.senders.push(s); queueMicrotask(() => this.onnegotiationneeded?.()); return s; }
  removeTrack(s: any) { this.senders = this.senders.filter(x => x !== s); }
  async createOffer() { return { type: 'offer', sdp: 'a=rtpmap:111 opus/48000/2\r\n' }; }
  async setLocalDescription(d: any) { this.localDescription = d; }
  close() { this.closed = true; }
  restartIce() {}
}

describe('signalisation', () => {
  it('talkback ouvert : chaque personne présente (et un nouvel arrivant) reçoit une offre adressée', async () => {
    FakePc.all = [];
    const sent: RtcSignal[] = [];
    const rtc = new CollabRtc({ me: 'u:max:pc', send: s => { sent.push(s); return true; }, onRemote: () => {}, createPc: () => new FakePc() as any });
    const track = { kind: 'audio', enabled: true };
    const stream = { id: 'mic', getAudioTracks: () => [track], getTracks: () => [track] } as any;
    rtc.setLocal('talk', stream, ['u:lina:pc']);
    await new Promise(r => setTimeout(r, 10));
    rtc.setPeers(['u:lina:pc', 'u:sam:tel']);
    await new Promise(r => setTimeout(r, 10));
    const offers = sent.filter(s => s.type === 'offer');
    expect(offers.map(o => o.to).sort()).toEqual(['u:lina:pc', 'u:sam:tel']);
    expect(offers[0].kinds).toEqual({ mic: 'talk' });
    expect(offers[0].sdp).toMatch(/stereo=1/);
    // Un message pour quelqu'un d'autre est ignoré.
    await rtc.handle({ from: 'u:lina:pc', to: 'u:sam:tel', type: 'bye' });
    expect(Object.keys(rtc.connectionStates()).sort()).toEqual(['u:lina:pc', 'u:sam:tel']);
    rtc.close();
    expect(FakePc.all.every(p => p.closed)).toBe(true);
  });
});

/** Connexion simulée avec les états de signalisation (offre en attente, retour arrière). */
class SigPc extends FakePc {
  offers: any[] = [];
  remoteDescription: any = null;
  receivers: any[] = [];
  async createOffer(opts?: any) { this.offers.push(opts || null); return { type: 'offer', sdp: 'a=rtpmap:111 opus/48000/2\r\n' }; }
  async setLocalDescription(d: any) {
    if (d.type === 'rollback') { this.signalingState = 'stable'; this.localDescription = null; return; }
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: any) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async createAnswer() { return { type: 'answer', sdp: 'a=rtpmap:111 opus/48000/2\r\n' }; }
  getReceivers() { return this.receivers; }
}

describe('mix en direct robuste', () => {
  const mic = () => { const track = { kind: 'audio', enabled: true, id: 't1' }; return { id: 'mix1', getAudioTracks: () => [track], getTracks: () => [track] } as any; };

  it('offre sans réponse (message égaré) : renvoyée avec redémarrage ICE, puis plus rien une fois la réponse reçue', async () => {
    vi.useFakeTimers();
    try {
      const pcs: SigPc[] = [];
      const sent: RtcSignal[] = [];
      const rtc = new CollabRtc({ me: 'u:max:pc', send: s => { sent.push(s); return true; }, onRemote: () => {}, createPc: () => { const p = new SigPc(); pcs.push(p); return p as any; } });
      rtc.setLocal('mix', mic(), ['u:lina:pc']);
      await vi.advanceTimersByTimeAsync(10);
      expect(sent.filter(s => s.type === 'offer')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS + 10);
      const offers = sent.filter(s => s.type === 'offer');
      expect(offers).toHaveLength(2);
      expect(pcs[0].offers[1]).toEqual({ iceRestart: true });
      expect(offers[1].kinds).toEqual({ mix1: 'mix' });
      await rtc.handle({ from: 'u:lina:pc', to: 'u:max:pc', type: 'answer', sdp: 'x' });
      expect(pcs[0].signalingState).toBe('stable');
      // Réponse en double (après un renvoi) : ignorée sans erreur.
      await rtc.handle({ from: 'u:lina:pc', to: 'u:max:pc', type: 'answer', sdp: 'x' });
      await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS * 3);
      expect(sent.filter(s => s.type === 'offer')).toHaveLength(2);
      rtc.close();
    } finally { vi.useRealTimers(); }
  });

  it('reprise demandée par l’artiste : l’ingé renvoie une offre neuve (redémarrage ICE)', async () => {
    const pcs: SigPc[] = [];
    const sent: RtcSignal[] = [];
    const rtc = new CollabRtc({ me: 'u:max:pc', send: s => { sent.push(s); return true; }, onRemote: () => {}, createPc: () => { const p = new SigPc(); pcs.push(p); return p as any; } });
    rtc.setLocal('mix', mic(), ['u:lina:pc']);
    await new Promise(r => setTimeout(r, 10));
    await rtc.handle({ from: 'u:lina:pc', to: 'u:max:pc', type: 'answer', sdp: 'x' });
    await rtc.handle({ from: 'u:lina:pc', to: 'u:max:pc', type: 'resync' });
    const offers = sent.filter(s => s.type === 'offer');
    expect(offers).toHaveLength(2);
    expect(pcs[0].offers[1]).toEqual({ iceRestart: true });
    // Côté artiste : la demande part vers l'ingé.
    const asked: RtcSignal[] = [];
    const lina = new CollabRtc({ me: 'u:lina:pc', send: s => { asked.push(s); return true; }, onRemote: () => {}, createPc: () => new SigPc() as any });
    lina.requestResync('u:max:pc');
    expect(asked).toEqual([{ from: 'u:lina:pc', to: 'u:max:pc', type: 'resync' }]);
    rtc.close(); lina.close();
  });

  it('ce qui arrive : son, silence (lecture à l’arrêt) ou rien (aucun paquet)', async () => {
    const pc = new SigPc();
    let remoteOnTrack: any = null;
    const rtc = new CollabRtc({ me: 'u:lina:pc', send: () => true, onRemote: () => {}, createPc: () => pc as any });
    await rtc.handle({ from: 'u:max:pc', to: 'u:lina:pc', type: 'offer', sdp: 'x', kinds: { mixS: 'mix' } });
    remoteOnTrack = pc.ontrack;
    const track = { id: 'rt', kind: 'audio', muted: false };
    const stream = { id: 'mixS', getTracks: () => [track], getAudioTracks: () => [track] } as any;
    remoteOnTrack({ streams: [stream], track });
    const st = { packetsReceived: 0, bytesReceived: 0, totalAudioEnergy: 0 };
    pc.receivers = [{ track, getStats: async () => new Map([['in', { type: 'inbound-rtp', ...st }]]) }];
    expect(await rtc.health('u:max:pc', 'mix')).toBe('attente');
    st.packetsReceived = 100; st.bytesReceived = 300;   // ~3 octets par paquet : du silence
    expect(await rtc.health('u:max:pc', 'mix')).toBe('silence');
    st.packetsReceived = 200; st.bytesReceived = 15300; st.totalAudioEnergy = 0.02;
    expect(await rtc.health('u:max:pc', 'mix')).toBe('son');
    expect(await rtc.health('u:max:pc', 'mix')).toBe('rien');   // plus aucun paquet
    expect(await rtc.health('u:sam:tel', 'mix')).toBe('rien');  // personne inconnue
    rtc.close();
  });
});
