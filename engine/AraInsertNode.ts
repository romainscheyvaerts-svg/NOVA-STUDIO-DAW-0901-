import { PluginInstance } from '../types';
import type { AraPluginKey } from '../types';
import { novaBridge } from '../services/NovaBridge';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { AraDocument, AraMusic, araDocSignature } from '../utils/araInsert';
import { VSTPluginNode, VST_PREBUFFER_FRAMES } from './VSTPluginNode';

/**
 * Melodyne / VocAlign en INSERT sur une piste, comme dans Pro Tools (pont v12).
 *
 * Un VSTPluginNode dont l'instance sur le pont est un insert ARA (bridge-python/ara_insert.py,
 * hôte natif nova-ara-host/) :
 *  - le document ARA de la piste (setDocument) est envoyé au pont à chaque édition : les sons
 *    qu'il n'a pas encore sont envoyés une fois (ARA_INSERT_SOURCE), puis le document
 *    (ARA_INSERT_DOC) ; l'hôte n'applique que ce qui a changé ;
 *  - lecture : l'effet suit la ligne de temps (followsTimeline / syncTimeline, comme le gate
 *    rythmique) ; chaque bloc envoyé porte la position du morceau de son entrée, le plugin joue
 *    les clips de la piste à cette position (retouches entendues en direct, sans rendu). Sa
 *    latence (pré-tampon du worklet + plugin) est compensée par le moteur comme pour un VST ;
 *  - export / gel / bounce : renderRange (rendu hors ligne de la piste à travers le plugin) ;
 *  - éditeur : ancré dans la fenêtre de l'appli (dock), flottant ou masqué.
 * État du plugin (stateB64) = archive ARA (retouches) + état VST3 : relu avant chaque sauvegarde
 * comme un VST (syncState).
 */

export interface AraInsertInfo {
  pluginId: string;
  kind: AraPluginKey;
  /** Document envoyé au pont (version de l'hôte), ou erreur de synchronisation. */
  docVersion: number;
  regions: number;
  syncing: boolean;
  syncError: string | null;
  /** Sons envoyés au plugin (une fois chacun). */
  sources: number;
  /** VocAlign (capture transparente) : en cours, faite, en attente du guide, erreur. */
  capture: { state: string; seconds?: number; error?: string } | null;
  dock: 'docked' | 'floating' | 'hidden';
}

/** Inserts ARA vivants (panneau de l'éditeur, QA). */
export const liveAraInserts = new Map<string, AraInsertNode>();
const araListeners = new Set<() => void>();
export const onAraInsertsChange = (cb: () => void) => { araListeners.add(cb); return () => { araListeners.delete(cb); }; };
const notifyAra = () => araListeners.forEach(cb => { try { cb(); } catch { /* */ } });

/** Délai de regroupement des éditions (un glisser de clip en continu = un seul envoi). */
const SYNC_DEBOUNCE_MS = 60;

export class AraInsertNode extends VSTPluginNode {
  public readonly kind: AraPluginKey;
  private doc: AraDocument | null = null;
  private music: AraMusic | null = null;
  /** VocAlign : clips de la piste guide (la lead). */
  private guide: Pick<AraDocument, 'sources' | 'regions'> | null = null;
  /** VocAlign (capture transparente) : état de la capture sur le pont. */
  private capture: { state: string; seconds?: number; error?: string } | null = null;
  private wantedSig = '';
  private sentSig = '';
  private uploaded = new Set<string>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private syncError: string | null = null;
  private docVersion = 0;
  private selection: string[] = [];
  private sentSelection = '';
  private dockWanted: { mode: 'dock' | 'float' | 'hide'; parent?: number; x: number; y: number; w: number; h: number; visible: boolean } = { mode: 'hide', x: 0, y: 0, w: 0, h: 0, visible: false };
  private dockState: AraInsertInfo['dock'] = 'hidden';
  private origin: { origin: number; at?: number } | null = null;
  private eventsUnsub: (() => void) | null = null;
  private stopListener = () => { this.worklet?.port.postMessage({ type: 'tlstop' }); };
  private readyWaiters: (() => void)[] = [];

  constructor(ctx: BaseAudioContext, plugin: PluginInstance) {
    super(ctx, plugin);
    this.kind = plugin.params?.ara === 'vocalign' ? 'vocalign' : 'melodyne';
    const realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    if (!realtime) return;
    liveAraInserts.set(plugin.id, this);
    if (typeof window !== 'undefined') window.addEventListener('nova:transport-stop', this.stopListener);
    notifyAra();
  }

  // --- Ligne de temps (moteur : syncChainTimeline) --------------------------------------

  /** Effet calé sur le morceau : le moteur lui donne l'origine de la lecture. */
  public get followsTimeline(): boolean { return true; }

  /**
   * `origin` = instant du contexte qui correspond au début du morceau, MOINS l'avance de
   * compensation des effets qui suivent ; `at` = instant d'un bouclage (sinon : départ).
   */
  public syncTimeline(origin: number, at?: number) {
    if (!Number.isFinite(origin)) return;
    this.origin = { origin, at };
    this.postTimeline();
  }

  private postTimeline() {
    const w = this.worklet;
    if (!w || !this.origin) return;
    const sr = this.ctx.sampleRate;
    const { origin, at } = this.origin;
    w.port.postMessage({
      type: 'timeline', reset: at === undefined,
      from: Math.round((at ?? this.ctx.currentTime) * sr), origin: Math.round(origin * sr),
      latency: VST_PREBUFFER_FRAMES + this.pluginLatencySamples,
    });
  }

  protected updateLatency(notify: boolean) {
    super.updateLatency(notify);
    this.worklet?.port.postMessage({ type: 'tllatency', latency: VST_PREBUFFER_FRAMES + this.pluginLatencySamples });
  }

  // --- Chargement sur le pont --------------------------------------------------------

  protected loadExtras() { return { ara: this.kind }; }

  protected onActivated(slotId: string, node: AudioWorkletNode) {
    node.port.postMessage({ type: 'ara', on: true });
    node.port.postMessage({ type: 'tllatency', latency: VST_PREBUFFER_FRAMES + this.pluginLatencySamples });
    // Nouvelle instance sur le pont : document renvoyé en entier, fenêtre et sélection reposées.
    this.uploaded.clear();
    this.sentSig = '';
    this.sentSelection = '';
    this.docVersion = 0;
    this.eventsUnsub?.();
    this.eventsUnsub = novaBridge.onAraInsertEvent(slotId, (e) => this.onBridgeEvent(e));
    if (this.origin) this.postTimeline();
    this.scheduleSync(0);
    const waiters = this.readyWaiters.splice(0);
    waiters.forEach(fn => fn());
    notifyAra();
  }

  protected onDeactivated() {
    this.eventsUnsub?.();
    this.eventsUnsub = null;
    this.dockState = 'hidden';
    notifyAra();
  }

  private onBridgeEvent(e: any) {
    // Le plugin demande le transport (bouton lecture, clic sur sa règle) : NOVA joue.
    if (e?.event === 'transport_request' && typeof window !== 'undefined') {
      try { window.dispatchEvent(new CustomEvent('nova:ara-transport', { detail: { kind: e.kind, value: e.value, pluginId: this.plugin.id } })); } catch { /* */ }
    }
    if (e?.event === 'capture') { this.capture = { state: String(e.state || ''), seconds: e.seconds, error: e.error }; notifyAra(); }
    if (e?.event === 'editor_opened') { this.dockState = e.mode === 'float' ? 'floating' : e.visible === false ? 'hidden' : 'docked'; notifyAra(); }
    if (e?.event === 'editor_closed') { this.dockState = 'hidden'; this.dockWanted = { ...this.dockWanted, mode: 'hide', visible: false }; notifyAra(); }
  }

  // --- Document de la piste ----------------------------------------------------------

  /** Document ARA de la piste (clips, sons) et contexte musical : envoyé si quelque chose a changé. */
  setDocument(doc: AraDocument, music: AraMusic | null, guide?: Pick<AraDocument, 'sources' | 'regions'> | null) {
    const sig = araDocSignature(doc, music) + (guide ? JSON.stringify([guide.sources.map(s => s.id), guide.regions]) : '');
    this.doc = doc;
    this.music = music;
    this.guide = guide || null;
    if (sig === this.wantedSig) return;
    this.wantedSig = sig;
    this.scheduleSync(SYNC_DEBOUNCE_MS);
  }

  getDocument(): AraDocument | null { return this.doc; }

  private scheduleSync(ms: number) {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => { this.syncTimer = null; void this.flushDocument(); }, ms);
  }

  /** Attend que le document courant soit appliqué par le plugin (QA, export). */
  async whenSynced(timeoutMs = 120000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.status === 'active' && !this.syncing && !this.syncTimer && this.sentSig === this.wantedSig && this.wantedSig) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  }

  private async flushDocument() {
    const slotId = this.slotId;
    const doc = this.doc;
    if (!doc || !slotId || this.status !== 'active') return;
    if (this.syncing) { this.scheduleSync(SYNC_DEBOUNCE_MS); return; }
    const sig = this.wantedSig;
    if (sig === this.sentSig) { this.flushSelection(); return; }
    this.syncing = true;
    notifyAra();
    try {
      const body = { sources: doc.sources, regions: doc.regions, track: doc.track, ...(this.music || {}), ...(this.guide ? { guide: this.guide } : {}) };
      let r = await novaBridge.araInsertDoc(slotId, body);
      if (!r.applied && r.missing?.length) {
        for (const id of r.missing) {
          const b = audioBufferRegistry.get(id);
          if (!b) throw new Error('Son du clip introuvable : rouvre le projet');
          const channels = Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => b.getChannelData(c));
          const name = doc.sources.find(s => s.id === id)?.name || this.guide?.sources.find(s => s.id === id)?.name || 'Son';
          await novaBridge.araInsertSource(slotId, { id, name, sampleRate: b.sampleRate, channels });
          this.uploaded.add(id);
        }
        r = await novaBridge.araInsertDoc(slotId, body);
      }
      if (!r.applied) throw new Error('Le plugin n’a pas reçu les sons de la piste');
      if (this.slotId !== slotId) return;
      this.docVersion = Number(r.version) || this.docVersion + 1;
      this.sentSig = sig;
      this.syncError = null;
      if (typeof r.latency_samples === 'number' && r.latency_samples !== this.pluginLatencySamples) {
        this.pluginLatencySamples = r.latency_samples;
        this.updateLatency(true);
      }
      this.flushSelection(true);
    } catch (e: any) {
      this.syncError = e?.message || 'Document ARA non envoyé';
    } finally {
      this.syncing = false;
      notifyAra();
      if (this.wantedSig !== this.sentSig && !this.syncError) this.scheduleSync(SYNC_DEBOUNCE_MS);
    }
  }

  // --- Sélection et éditeur --------------------------------------------------------------

  /** L'éditeur suit la sélection : ces clips (vide : toute la piste). */
  setSelection(clipIds: string[]) {
    this.selection = clipIds.slice();
    this.flushSelection();
  }

  private flushSelection(force = false) {
    const slotId = this.slotId;
    if (!slotId || this.status !== 'active' || !this.docVersion) return;
    const sig = this.selection.join('|');
    if (!force && sig === this.sentSelection) return;
    this.sentSelection = sig;
    novaBridge.araInsertSelect(slotId, this.selection).catch(() => { this.sentSelection = ''; });
  }

  /** Attend l'instance sur le pont (fenêtre demandée pendant le chargement). */
  private ready(timeoutMs = 120000): Promise<boolean> {
    if (this.status === 'active' && this.slotId) return Promise.resolve(true);
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.readyWaiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  /**
   * Éditeur ancré dans la fenêtre de l'appli (Windows) : `parent` = HWND de la page,
   * rectangle en pixels physiques (rectangle CSS × devicePixelRatio).
   */
  async dockEditor(parent: number, rect: { x: number; y: number; w: number; h: number }, visible = true): Promise<any> {
    this.dockWanted = { mode: 'dock', parent, ...rect, visible };
    if (!(await this.ready())) throw new Error('Plugin pas encore chargé sur le pont');
    const r = await novaBridge.araInsertEditor(this.slotId!, { mode: this.dockState === 'docked' ? 'bounds' : 'dock', parent, ...rect, visible })
      .catch(() => novaBridge.araInsertEditor(this.slotId!, { mode: 'dock', parent, ...rect, visible }));
    // pending : le plugin attend le premier son de la piste (évènement editor_opened).
    this.dockState = r?.pending ? 'hidden' : visible ? 'docked' : 'hidden';
    notifyAra();
    return r;
  }

  /** Repère du panneau déplacé / redimensionné (rien si l'éditeur n'est pas ancré). */
  setDockBounds(rect: { x: number; y: number; w: number; h: number }, visible = true) {
    if (this.dockWanted.mode !== 'dock' || !this.slotId || this.status !== 'active') return;
    this.dockWanted = { ...this.dockWanted, ...rect, visible };
    novaBridge.araInsertEditor(this.slotId, { mode: 'bounds', ...rect, visible }).then(() => {
      this.dockState = visible ? 'docked' : 'hidden';
      notifyAra();
    }).catch(() => { /* panneau refermé entre-temps */ });
  }

  /** « Détacher » : fenêtre flottante du plugin. */
  async floatEditor(): Promise<void> {
    this.dockWanted = { ...this.dockWanted, mode: 'float', visible: true };
    if (!(await this.ready())) throw new Error('Plugin pas encore chargé sur le pont');
    const r = await novaBridge.araInsertEditor(this.slotId!, { mode: 'float' });
    this.dockState = r?.pending ? 'hidden' : 'floating';
    notifyAra();
  }

  async hideEditor(release = false): Promise<void> {
    this.dockWanted = { ...this.dockWanted, mode: 'hide', visible: false };
    this.dockState = 'hidden';
    notifyAra();
    if (this.slotId && this.status === 'active') await novaBridge.araInsertEditor(this.slotId, { mode: 'hide', release }).catch(() => undefined);
  }

  /** Bouton « ouvrir » d'un insert (mixeur) : la fenêtre flottante si rien n'est ancré. */
  async openEditor(): Promise<void> { await this.floatEditor(); }

  // --- Rendu (export, gel, bounce, « Commit ») ---------------------------------------------

  /** La piste à travers le plugin, hors ligne, sur [start, start + duration[ (temps du morceau). */
  async renderRange(start: number, duration: number, sampleRate: number): Promise<Float32Array[]> {
    if (!(await this.ready(30000)) || !this.slotId) throw new Error(`${this.plugin.name || 'Le plugin'} n'est pas chargé : connecte le pont VST sur le PC qui l'a.`);
    await this.whenSynced(60000);
    return novaBridge.araInsertRender(this.slotId, start, duration, sampleRate);
  }

  getAraInfo(): AraInsertInfo {
    return {
      pluginId: this.plugin.id, kind: this.kind, docVersion: this.docVersion, regions: this.doc?.regions.length || 0,
      syncing: this.syncing || !!this.syncTimer, syncError: this.syncError, sources: this.uploaded.size, dock: this.dockState, capture: this.capture,
    };
  }

  dispose() {
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    if (typeof window !== 'undefined') window.removeEventListener('nova:transport-stop', this.stopListener);
    this.eventsUnsub?.();
    if (liveAraInserts.get(this.plugin.id) === this) liveAraInserts.delete(this.plugin.id);
    super.dispose();
    notifyAra();
  }
}
