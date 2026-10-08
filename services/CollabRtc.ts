/**
 * Audio en direct entre collaborateurs (WebRTC), par-dessus le canal de la
 * session (Supabase Realtime sert seulement à se trouver : « signalisation ») :
 *
 *  - TALKBACK : la voix au micro, comme le bouton talkback d'une console
 *    (maintenir pour parler) ; annulation d'écho et réduction de bruit du
 *    navigateur, pour ne pas renvoyer le mix dans le micro ;
 *  - ÉCOUTE DU MIX DE L'INGÉ (comme Audiomovers) : la sortie master de l'ingé
 *    part en Opus stéréo haut débit (jusqu'à 510 kb/s, sans traitement de
 *    voix), l'artiste l'entend en quasi direct (≈ 0,1 à 0,3 s), même sur un
 *    téléphone, sans avoir les VST de l'ingé.
 *
 * Une connexion par paire de participants (2 à 4 personnes : maillage).
 * Négociation « parfaite » (MDN) : le plus petit identifiant est « poli » et
 * cède en cas d'offres croisées. Chaque flux annonce sa nature (talk / mix)
 * dans la signalisation.
 *
 * Limites (documentées) : sans serveur TURN, deux réseaux très fermés
 * (certains réseaux d'entreprise, 4G avec NAT symétrique) peuvent ne pas se
 * joindre ; l'audio de la session reste alors disponible par le journal
 * (prises, gels) et le chat. Rien ne transite par nos serveurs.
 */

export type RtcKind = 'talk' | 'mix';

export interface RtcSignal {
  /** Expéditeur et destinataire (clé de membre, une par appareil). */
  from: string;
  to: string;
  type: 'offer' | 'answer' | 'ice' | 'bye';
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  /** Nature de chaque flux envoyé (identifiant du MediaStream → talk / mix). */
  kinds?: Record<string, RtcKind>;
}

export interface CollabRtcOptions {
  me: string;
  /** Envoie un message de signalisation (direct de la session). Faux : direct coupé. */
  send: (sig: RtcSignal) => boolean;
  onRemote: (peer: string, kind: RtcKind, stream: MediaStream | null) => void;
  onState?: (peer: string, state: RTCPeerConnectionState) => void;
  iceServers?: RTCIceServer[];
  /** Fabrique (tests). */
  createPc?: (cfg: RTCConfiguration) => RTCPeerConnection;
}

export const DEFAULT_ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/**
 * Opus en stéréo haut débit pour la musique (le navigateur part sur de la voix
 * mono ~32 kb/s). On garde la correction d'erreurs (FEC) et 10 ms de trame.
 */
export function musicOpusSdp(sdp: string): string {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  const want = 'stereo=1;sprop-stereo=1;maxaveragebitrate=510000;useinbandfec=1;minptime=10';
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (_all, params: string) => {
      const keep = params.split(';').map(s => s.trim()).filter(s => s && !/^(stereo|sprop-stereo|maxaveragebitrate|useinbandfec|minptime)=/i.test(s));
      return `a=fmtp:${pt} ${[...keep, want].join(';')}`;
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${want}`);
}

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Flux reçus de l'autre, par identifiant, et leur nature annoncée. */
  kinds: Record<string, RtcKind>;
  senders: Map<RtcKind, RTCRtpSender>;
  remote: Map<string, MediaStream>;
}

export class CollabRtc {
  private peers = new Map<string, Peer>();
  private local = new Map<RtcKind, MediaStream>();
  private closed = false;

  constructor(private o: CollabRtcOptions) {}

  /** Participants joignables (clés de membre) : on se relie à chacun (une connexion par paire). */
  setPeers(keys: string[]) {
    if (this.closed) return;
    const want = new Set(keys.filter(k => k && k !== this.o.me));
    for (const k of [...this.peers.keys()]) if (!want.has(k)) this.drop(k, true);
    // Seulement s'il y a quelque chose à envoyer : sinon c'est l'autre qui appelle.
    // Un nouvel arrivant reçoit tout de suite ce qu'on diffuse (talkback ouvert, mix).
    if (this.local.size) want.forEach(k => { const isNew = !this.peers.has(k); const p = this.ensure(k); if (isNew) this.local.forEach((_s, kind) => this.attach(p, kind)); });
  }

  /** Commence à envoyer un flux (micro du talkback, ou mix master). */
  setLocal(kind: RtcKind, stream: MediaStream | null, peers: string[]) {
    if (this.closed) return;
    if (stream) this.local.set(kind, stream); else this.local.delete(kind);
    const targets = new Set([...peers.filter(k => k && k !== this.o.me), ...this.peers.keys()]);
    targets.forEach(k => this.attach(this.ensure(k), kind));
  }

  isSending(kind: RtcKind): boolean { return this.local.has(kind); }
  connectionStates(): Record<string, RTCPeerConnectionState> {
    const out: Record<string, RTCPeerConnectionState> = {};
    this.peers.forEach((p, k) => { out[k] = p.pc.connectionState; });
    return out;
  }

  private ensure(key: string): Peer {
    let p = this.peers.get(key);
    if (p) return p;
    const make = this.o.createPc || ((cfg: RTCConfiguration) => new RTCPeerConnection(cfg));
    const pc = make({ iceServers: this.o.iceServers || DEFAULT_ICE });
    p = { pc, polite: this.o.me < key, makingOffer: false, ignoreOffer: false, kinds: {}, senders: new Map(), remote: new Map() };
    const peer = p;
    this.peers.set(key, p);
    pc.onicecandidate = (e) => { this.o.send({ from: this.o.me, to: key, type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null }); };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription({ type: 'offer', sdp: musicOpusSdp(offer.sdp || '') });
        this.o.send({ from: this.o.me, to: key, type: 'offer', sdp: pc.localDescription?.sdp, kinds: this.localKinds() });
      } catch (e) {
        console.warn('[CollabRtc] offre', e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      peer.remote.set(stream.id, stream);
      const kind = peer.kinds[stream.id] || 'talk';
      this.o.onRemote(key, kind, stream);
      e.track.onended = () => this.o.onRemote(key, kind, null);
      // Flux retiré par l'autre (il arrête le talkback / l'écoute) : plus de piste vivante.
      stream.onremovetrack = () => { if (!stream.getTracks().length) this.o.onRemote(key, kind, null); };
    };
    pc.onconnectionstatechange = () => {
      this.o.onState?.(key, pc.connectionState);
      if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch { /* */ } }
    };
    return p;
  }

  private localKinds(): Record<string, RtcKind> {
    const out: Record<string, RtcKind> = {};
    this.local.forEach((s, k) => { out[s.id] = k; });
    return out;
  }

  private attach(p: Peer, kind: RtcKind) {
    const stream = this.local.get(kind);
    const old = p.senders.get(kind);
    if (!stream) {
      if (old) { try { p.pc.removeTrack(old); } catch { /* */ } p.senders.delete(kind); }
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    if (old) {
      if (old.track === track) return;
      try { p.pc.removeTrack(old); } catch { /* */ }
    }
    const sender = p.pc.addTrack(track, stream);
    p.senders.set(kind, sender);
    if (kind === 'mix') {
      try {
        const params = sender.getParameters();
        params.encodings = (params.encodings && params.encodings.length ? params.encodings : [{}]).map(e => ({ ...e, maxBitrate: 510000 }));
        void sender.setParameters(params).catch(() => { /* navigateur sans réglage de débit */ });
      } catch { /* */ }
    }
  }

  /** Message de signalisation reçu (direct de la session). */
  async handle(sig: RtcSignal) {
    if (this.closed || !sig || sig.to !== this.o.me || sig.from === this.o.me) return;
    if (sig.type === 'bye') { this.drop(sig.from, false); return; }
    const p = this.ensure(sig.from);
    if (sig.kinds) Object.assign(p.kinds, sig.kinds);
    try {
      if (sig.type === 'offer' || sig.type === 'answer') {
        const offerCollision = sig.type === 'offer' && (p.makingOffer || p.pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && offerCollision;
        if (p.ignoreOffer) return;
        await p.pc.setRemoteDescription({ type: sig.type, sdp: sig.sdp || '' });
        if (sig.type === 'offer') {
          // On envoie aussi ce qu'on a (talkback ouvert de notre côté).
          this.local.forEach((_s, k) => this.attach(p, k));
          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription({ type: 'answer', sdp: musicOpusSdp(answer.sdp || '') });
          this.o.send({ from: this.o.me, to: sig.from, type: 'answer', sdp: p.pc.localDescription?.sdp, kinds: this.localKinds() });
        }
      } else if (sig.type === 'ice') {
        try { await p.pc.addIceCandidate(sig.candidate || undefined); } catch (e) { if (!p.ignoreOffer) throw e; }
      }
    } catch (e) {
      console.warn('[CollabRtc] signalisation', sig.type, e);
    }
  }

  private drop(key: string, notify: boolean) {
    const p = this.peers.get(key);
    if (!p) return;
    this.peers.delete(key);
    p.remote.forEach((_s, id) => this.o.onRemote(key, p.kinds[id] || 'talk', null));
    try { p.pc.close(); } catch { /* */ }
    if (notify) this.o.send({ from: this.o.me, to: key, type: 'bye' });
  }

  close() {
    for (const k of [...this.peers.keys()]) this.drop(k, true);
    this.local.clear();
    this.closed = true;
  }
}
