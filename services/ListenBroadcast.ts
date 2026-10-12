import { catalogSupabase } from './supabase';
import { CollabRtc, type RtcSignal } from './CollabRtc';
import { listListenLinks, type SessionKey } from './ListenLinks';
import { listenersOf, randomKey, visitorsOf, type ListenLinkInfo } from '../utils/listenLink';

/**
 * Côté INGÉ : diffusion du mix aux clients des liens d'écoute (« comme
 * Audiomovers »). Pour chaque lien actif qui autorise le direct, l'ingé
 * rejoint le canal Supabase Realtime du lien (présence « host »), voit qui
 * veut écouter (présence « listener », want) et lui envoie son mix par WebRTC
 * (services/CollabRtc : Opus stéréo 510 kb/s, sans traitement de voix), au
 * plus MAX_LISTENERS_PER_LINK clients par lien.
 *
 * Un lien révoqué ou expiré n'est plus servi : la liste est relue toutes les
 * 20 s (et tout de suite après une révocation), l'expiration est vérifiée
 * toutes les 5 s ; on quitte alors son canal et les clients sont coupés.
 *
 * Service unique (singleton) : la diffusion continue panneau fermé.
 */

export interface ListenLinkLive { visitors: number; listening: number; connected: number }
export interface ListenHostState {
  on: boolean;
  starting: boolean;
  error: string | null;
  /** Par lien (id) : clients sur la page, qui écoutent, reliés en WebRTC. */
  links: Record<string, ListenLinkLive>;
}

interface Chan { link: ListenLinkInfo; key: string; ch: ReturnType<typeof catalogSupabase.channel>; rtc: CollabRtc; allowed: Set<string>; visitors: number }

const REFRESH_MS = 20_000;
const TICK_MS = 5_000;

export class ListenHost {
  private session: SessionKey | null = null;
  private name = '';
  private stream: MediaStream | null = null;
  private links: ListenLinkInfo[] = [];
  private chans = new Map<string, Chan>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private subs = new Set<(s: ListenHostState) => void>();
  private st: ListenHostState = { on: false, starting: false, error: null, links: {} };

  state(): ListenHostState { return this.st; }
  subscribe(cb: (s: ListenHostState) => void): () => void { this.subs.add(cb); cb(this.st); return () => { this.subs.delete(cb); }; }
  private emit(patch: Partial<ListenHostState>) {
    this.st = { ...this.st, ...patch };
    this.subs.forEach(cb => { try { cb(this.st); } catch { /* */ } });
  }

  /** Séance et nom de l'ingé ; une autre séance arrête la diffusion. */
  configure(session: SessionKey | null, name: string) {
    if (this.session && (!session || session.id !== this.session.id)) this.stop();
    this.session = session;
    this.name = name.slice(0, 40);
  }

  /** Liens actifs connus (réponse de listen_list / listen_create). */
  setLinks(links: ListenLinkInfo[]) {
    this.links = links.slice();
    if (this.st.on) this.sync();
  }

  async start(getStream: () => Promise<MediaStream | null>): Promise<boolean> {
    if (this.st.on || this.st.starting) return this.st.on;
    if (!this.session) { this.emit({ error: "Ouvre d'abord une séance en ligne (Collaborer)." }); return false; }
    this.emit({ starting: true, error: null });
    let stream: MediaStream | null = null;
    try { stream = await getStream(); } catch { stream = null; }
    if (!stream || !stream.getAudioTracks().length) {
      this.emit({ starting: false, error: "Le moteur audio n'est pas prêt : lance la lecture une fois, puis réessaie." });
      return false;
    }
    this.stream = stream;
    this.emit({ on: true, starting: false });
    this.sync();
    this.ticks = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    return true;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const id of [...this.chans.keys()]) this.leave(id);
    this.stream = null;
    this.emit({ on: false, starting: false, links: {} });
  }

  /** Lien révoqué ici : on le quitte tout de suite (sans attendre la relecture). */
  forget(linkId: string) {
    this.links = this.links.filter(l => l.id !== linkId);
    if (this.chans.has(linkId)) this.leave(linkId);
  }

  private tick() {
    this.ticks++;
    this.sync();
    if (this.session && this.ticks % Math.round(REFRESH_MS / TICK_MS) === 0) {
      const s = this.session;
      void listListenLinks(s).then(list => { if (this.session === s) this.setLinks(list); }).catch(() => { /* réseau : on garde la liste connue */ });
    }
  }

  private sync() {
    if (!this.st.on || !this.stream) return;
    const now = Date.now();
    const want = new Map(this.links.filter(l => l.live && Date.parse(l.expires_at) > now).map(l => [l.id, l]));
    for (const id of [...this.chans.keys()]) if (!want.has(id)) this.leave(id);
    want.forEach((l, id) => { if (!this.chans.has(id)) this.join(l); });
    this.recount();
  }

  private join(link: ListenLinkInfo) {
    const key = randomKey('h');
    const ch = catalogSupabase.channel(link.channel, { config: { broadcast: { self: false }, presence: { key } } });
    const c: Chan = { link, key, ch, rtc: null as unknown as CollabRtc, allowed: new Set(), visitors: 0 };
    c.rtc = new CollabRtc({
      me: key,
      send: (sig: RtcSignal) => {
        try { void Promise.resolve(ch.send({ type: 'broadcast', event: 'rtc', payload: sig })).catch(() => { /* */ }); return true; } catch { return false; }
      },
      // Le client n'envoie rien : un flux reçu de lui est ignoré.
      onRemote: () => { /* lecture seule */ },
      onState: () => this.recount(),
    });
    ch.on('broadcast', { event: 'rtc' }, ({ payload }) => {
      const sig = payload as RtcSignal;
      // Seulement les clients présents qui ont demandé à écouter, et seulement ce qui nous est adressé.
      if (!sig || sig.to !== key || !c.allowed.has(sig.from)) return;
      void c.rtc.handle(sig);
    });
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as Record<string, Array<Record<string, unknown>>>;
      const ls = listenersOf(state);
      c.allowed = new Set(ls);
      c.visitors = visitorsOf(state);
      c.rtc.setPeers(ls);
      this.recount();
    });
    ch.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        try { void Promise.resolve(ch.track({ role: 'host', live: true, name: this.name })).catch(() => { /* réessayé à la reconnexion */ }); } catch { /* */ }
      }
    });
    if (this.stream) c.rtc.setLocal('mix', this.stream, []);
    this.chans.set(link.id, c);
  }

  private leave(id: string) {
    const c = this.chans.get(id);
    if (!c) return;
    this.chans.delete(id);
    try { c.rtc.close(); } catch { /* */ }
    try { void Promise.resolve(c.ch.untrack()).catch(() => { /* */ }); } catch { /* */ }
    try { void catalogSupabase.removeChannel(c.ch); } catch { /* */ }
    this.recount();
  }

  private recount() {
    const links: Record<string, ListenLinkLive> = {};
    this.chans.forEach((c, id) => {
      const states = Object.values(c.rtc.connectionStates());
      links[id] = { visitors: c.visitors, listening: c.allowed.size, connected: states.filter(s => s === 'connected').length };
    });
    if (JSON.stringify(links) !== JSON.stringify(this.st.links)) this.emit({ links });
  }
}

export const listenHost = new ListenHost();
