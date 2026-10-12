import { catalogSupabase } from './supabase';
import { CollabRtc, type RtcHealth, type RtcQuality, type RtcSignal } from './CollabRtc';
import { hostOf, randomKey } from '../utils/listenLink';

/**
 * Côté CLIENT (page d'écoute, sans compte) : rejoint le canal du lien,
 * annonce sa présence (« listener ») et reçoit le mix de l'ingé par WebRTC.
 * Il n'envoie AUCUN son et ne peut rien écrire : la signalisation ne sert
 * qu'à établir la liaison.
 *
 *  - « En direct » : l'ingé est sur le canal et diffuse (présence « host », live) ;
 *  - Écouter : présence want = true → l'ingé envoie une offre ; sans son au bout
 *    de 4 s, on lui redemande (reprise), puis toutes les 4 s.
 */

export interface ReceiverState {
  channel: 'connecting' | 'live' | 'down';
  host: { live: boolean; name: string } | null;
  want: boolean;
  stream: MediaStream | null;
  health: RtcHealth | null;
  quality: RtcQuality | null;
}

const RESYNC_MS = 4000;

export class ListenReceiver {
  readonly key = randomKey('l');
  private ch: ReturnType<typeof catalogSupabase.channel> | null = null;
  private rtc: CollabRtc | null = null;
  private hostKey: string | null = null;
  private wantSince = 0;
  private lastResync = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  st: ReceiverState = { channel: 'connecting', host: null, want: false, stream: null, health: null, quality: null };

  constructor(private channelName: string, private onChange: (s: ReceiverState) => void) {}

  private emit(patch: Partial<ReceiverState>) {
    this.st = { ...this.st, ...patch };
    try { this.onChange(this.st); } catch { /* */ }
  }

  start() {
    const ch = catalogSupabase.channel(this.channelName, { config: { broadcast: { self: false }, presence: { key: this.key } } });
    this.ch = ch;
    this.rtc = new CollabRtc({
      me: this.key,
      send: (sig: RtcSignal) => {
        try { void Promise.resolve(ch.send({ type: 'broadcast', event: 'rtc', payload: sig })).catch(() => { /* */ }); return true; } catch { return false; }
      },
      onRemote: (peer, kind, stream) => {
        if (kind !== 'mix' || (this.hostKey && peer !== this.hostKey)) return;
        this.emit({ stream: stream && stream.getAudioTracks().length ? stream : null, ...(stream ? {} : { health: null, quality: null }) });
      },
    });
    ch.on('broadcast', { event: 'rtc' }, ({ payload }) => {
      const sig = payload as RtcSignal;
      if (!sig || sig.to !== this.key || !/^h-/.test(String(sig.from))) return;
      if (this.hostKey && sig.from !== this.hostKey) return;
      void this.rtc?.handle(sig);
    });
    ch.on('presence', { event: 'sync' }, () => {
      const h = hostOf(ch.presenceState() as Record<string, Array<Record<string, unknown>>>);
      this.hostKey = h?.key || null;
      this.emit({ host: h ? { live: h.live, name: h.name } : null });
    });
    ch.subscribe((status: string) => {
      if (this.closed) return;
      if (status === 'SUBSCRIBED') {
        this.emit({ channel: 'live' });
        this.track();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        this.emit({ channel: 'down' });
      }
    });
    this.timer = setInterval(() => { void this.tick(); }, 1000);
  }

  private track() {
    try { void Promise.resolve(this.ch?.track({ role: 'listener', want: this.st.want })).catch(() => { /* réessayé à la reconnexion */ }); } catch { /* */ }
  }

  /** Écouter (true) ou arrêter (false). */
  setWant(on: boolean) {
    if (on === this.st.want) return;
    this.wantSince = on ? Date.now() : 0;
    this.lastResync = 0;
    this.emit({ want: on, ...(on ? {} : { stream: null, health: null, quality: null }) });
    this.track();
  }

  private async tick() {
    const rtc = this.rtc;
    if (!rtc || this.closed) return;
    const now = Date.now();
    if (this.st.want && this.st.host?.live && this.hostKey && !this.st.stream && now - this.wantSince > RESYNC_MS && now - this.lastResync > RESYNC_MS) {
      this.lastResync = now;
      rtc.requestResync(this.hostKey);
    }
    if (this.st.stream && this.hostKey) {
      const health = await rtc.health(this.hostKey, 'mix');
      this.emit({ health, quality: rtc.quality(this.hostKey, 'mix') });
    }
  }

  stop() {
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.rtc?.close(); } catch { /* */ }
    if (this.ch) {
      try { void Promise.resolve(this.ch.untrack()).catch(() => { /* */ }); } catch { /* */ }
      try { void catalogSupabase.removeChannel(this.ch); } catch { /* */ }
    }
    this.ch = null;
    this.rtc = null;
  }
}
