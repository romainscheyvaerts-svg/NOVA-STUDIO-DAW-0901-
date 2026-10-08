import { describe, expect, it } from 'vitest';
import { CollabRtc, musicOpusSdp, RtcSignal } from '../services/CollabRtc';

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
