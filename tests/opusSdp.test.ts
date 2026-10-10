import { describe, expect, it } from 'vitest';
import { mixQualityLabel, opusUseFor, splitSdp, streamsByMid, tuneOpusSdp } from '../utils/opusSdp';

/** Opus réglé section par section (mix en stéréo 510 kb/s, talkback en voix). */

const section = (mid: string, stream: string | null, fmtp = 'minptime=10;useinbandfec=1') =>
  `m=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=mid:${mid}\r\n${stream ? `a=msid:${stream} trk-${mid}\r\n` : ''}a=rtpmap:111 opus/48000/2\r\na=fmtp:111 ${fmtp}\r\na=rtpmap:63 red/48000/2\r\na=fmtp:63 111/111\r\n`;
const HEAD = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\n';
const fmtpOf = (sdp: string, mid: string) => {
  const s = splitSdp(sdp).sections.find(x => x.includes(`a=mid:${mid}\r\n`))!;
  return /a=fmtp:111 ([^\r\n]*)/.exec(s)![1];
};

describe('Opus par section', () => {
  it('le mix sur la 2e section (talkback ouvert avant) part aussi en stéréo 510 kb/s', () => {
    const sdp = HEAD + section('0', 'mic') + section('1', 'mixdest');
    const out = tuneOpusSdp(sdp, s => opusUseFor(s, { mic: 'talk', mixdest: 'mix' }, {}, new Map()));
    expect(fmtpOf(out, '1')).toBe('stereo=1;sprop-stereo=1;maxaveragebitrate=510000;useinbandfec=1;minptime=10');
    // Le talkback reste de la voix (mono, débit du navigateur).
    expect(fmtpOf(out, '0')).toBe('useinbandfec=1;minptime=10');
    // Le reste du SDP n'est pas touché.
    expect(out.startsWith(HEAD)).toBe(true);
    expect(out).toContain('a=fmtp:63 111/111');
  });

  it('sans réglage précis (par défaut) : TOUTES les sections audio en musique, plus seulement la 1re', () => {
    const out = tuneOpusSdp(HEAD + section('0', null) + section('1', null) + section('2', null));
    for (const mid of ['0', '1', '2']) expect(fmtpOf(out, mid)).toMatch(/stereo=1;sprop-stereo=1;maxaveragebitrate=510000/);
  });

  it("réponse de l'artiste : la section où l'ingé envoie son mix est en musique (sinon le décodeur est mono)", () => {
    const offer = HEAD + section('0', 'maxmic') + section('1', 'maxmix');
    const answer = HEAD + section('0', null) + section('1', null);
    const out = tuneOpusSdp(answer, s => opusUseFor(s, {}, { maxmic: 'talk', maxmix: 'mix' }, streamsByMid(offer)));
    expect(fmtpOf(out, '1')).toMatch(/^stereo=1;sprop-stereo=1;maxaveragebitrate=510000/);
    expect(fmtpOf(out, '0')).toBe('useinbandfec=1;minptime=10');
  });

  it("une même section qui porte le talkback de l'un et le mix de l'autre reste en musique", () => {
    const remote = HEAD + section('0', 'maxmix');
    const local = HEAD + section('0', 'linamic');
    const out = tuneOpusSdp(local, s => opusUseFor(s, { linamic: 'talk' }, { maxmix: 'mix' }, streamsByMid(remote)));
    expect(fmtpOf(out, '0')).toMatch(/stereo=1/);
  });

  it('une section repassée du mix à la voix perd les réglages de musique ; les autres paramètres sont gardés', () => {
    const sdp = HEAD + section('0', 'mic', 'stereo=1;sprop-stereo=1;maxaveragebitrate=510000;usedtx=0;useinbandfec=1;minptime=10');
    const out = tuneOpusSdp(sdp, s => opusUseFor(s, { mic: 'talk' }, {}, new Map()));
    expect(fmtpOf(out, '0')).toBe('usedtx=0;useinbandfec=1;minptime=10');
  });

  it('section sans ligne fmtp : ajoutée ; section vidéo ou sans Opus : inchangée', () => {
    const noFmtp = 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n';
    const video = 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=rtpmap:96 VP8/90000\r\n';
    const pcmu = 'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=mid:2\r\na=rtpmap:0 PCMU/8000\r\n';
    const out = tuneOpusSdp(HEAD + noFmtp + video + pcmu);
    expect(out).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=1;');
    expect(out).toContain(video);
    expect(out).toContain(pcmu);
  });

  it('msid lu aussi dans les lignes ssrc (anciens navigateurs)', () => {
    const sdp = HEAD + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\na=ssrc:42 msid:mic trk\r\n';
    expect(streamsByMid(sdp).get('0')).toEqual(['mic']);
  });
});

describe('qualité du mix reçu, en clair', () => {
  it('stéréo et débit ; mono signalé', () => {
    expect(mixQualityLabel({ stereo: true, kbps: 509 })).toEqual({ text: 'stéréo · 509 kb/s', warn: false });
    expect(mixQualityLabel({ stereo: false, kbps: 32 })).toEqual({ text: 'mono · 32 kb/s', warn: true });
    expect(mixQualityLabel({ stereo: null, kbps: null })).toBeNull();
    expect(mixQualityLabel(null)).toBeNull();
  });
});
