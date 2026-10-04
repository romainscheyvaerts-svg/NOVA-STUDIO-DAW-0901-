import { PluginInstance } from '../types';
import { AutoTuneNode } from '../plugins/AutoTunePlugin';
import { VSTPluginNode, VstNodeStatus } from './VSTPluginNode';
import { novaBridge } from '../services/NovaBridge';
import { autotuneLive, autotunePrefs, effectiveAutotune, paramCache } from '../services/AutotuneVst';
import {
  AutotuneCandidate, keyLabel, NovaScale, readbackMatches, resolveAutotuneSettings, toVstParams,
} from '../utils/autotuneVst';

/**
 * Effet « AUTOTUNE » d'une piste : l'autotune du PC (Antares Auto-Tune Pro,
 * Slate MetaTune… via le pont VST) quand l'artiste l'a choisi, sinon celui de NOVA.
 *
 * Même place dans la chaîne que l'autotune de NOVA (les styles de mix et la chaîne
 * voix ne changent pas : c'est ce nœud qui décide du moteur). Repli automatique et
 * silencieux sur l'autotune de NOVA :
 *  - pont déconnecté ou plugin planté (pont fermé) ;
 *  - licence / démo (chargement discret : aucune fenêtre ne surgit ; le plugin est
 *    noté « non disponible » et le suivant dans l'ordre de préférence est essayé) ;
 *  - gamme impossible à régler ou réglage non confirmé à la relecture ;
 *  - pendant la prise (piste armée) : le pont ajoute ~45 ms (tampon de 2 048
 *    échantillons + plugin), trop pour s'entendre ; l'autotune de NOVA en mode
 *    basse latence (~4 ms), réglé sur la MÊME gamme, sert de retour casque, et
 *    l'autotune du PC reprend à la lecture ;
 *  - export / gel (contexte hors ligne) : le pont ne peut pas y être attendu.
 *
 * Tonalité, gamme, vitesse (retune), naturel et dosage sont recopiés sur le plugin
 * à chaque changement (beat, tonalité, style), puis RELUS (valeurs texte du pont v7).
 * Qualité : « faible latence » par défaut (Auto-Tune Pro : mode Low Latency,
 * 2 670 → 112 échantillons annoncés) ou « qualité maximale » (réglage de l'onglet VST).
 */
export class HybridAutoTuneNode {
  public readonly input: GainNode;
  public readonly output: GainNode;
  /** Prêt pour un rendu hors ligne (worklet de l'autotune de NOVA chargé). */
  public readonly ready: Promise<void>;

  private ctx: BaseAudioContext;
  private plugin: PluginInstance;
  private nova: AutoTuneNode;
  private vst: VSTPluginNode | null = null;
  private vstUnsub: (() => void) | null = null;
  private cand: AutotuneCandidate | null = null;
  private quality = autotunePrefs.get().quality;
  private params: Record<string, any> = {};
  private monitoring = false;
  private vstReady = false;
  private applying = false;
  private reapply = false;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private fallback: string | null = null;
  private route: 'nova' | 'vst' = 'nova';
  private latencyListener: (() => void) | null = null;
  private unsubs: (() => void)[] = [];
  private disposed = false;
  private readonly realtime: boolean;

  constructor(ctx: BaseAudioContext, plugin: PluginInstance) {
    this.ctx = ctx;
    this.plugin = plugin;
    this.params = { ...(plugin.params || {}) };
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.nova = new AutoTuneNode(ctx as AudioContext);
    this.ready = this.nova.ready;
    this.input.connect(this.nova.input);
    this.nova.output.connect(this.output);
    this.realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    if (!this.realtime) return;
    this.unsubs.push(autotunePrefs.subscribe(() => this.syncCandidate()));
    this.unsubs.push(novaBridge.subscribe(() => this.publish()));
    this.syncCandidate();
  }

  // --- Contrat des effets du moteur --------------------------------------------

  get latency(): number {
    if (this.route === 'vst' && this.vst) return this.vst.latency;
    return this.nova.latency;
  }

  setLatencyListener(cb: (() => void) | null) { this.latencyListener = cb; }

  /** Visualisation de la fenêtre de l'autotune (analyse de l'autotune de NOVA). */
  setStatusCallback(cb: (data: any) => void) { this.nova.setStatusCallback(cb); }

  updateParams(p: Record<string, any>) {
    if (!p) return;
    const before = this.params;
    this.params = { ...this.params, ...p };
    this.nova.updateParams(p);
    if ('lowLatency' in p) {
      const mon = !!p.lowLatency;
      if (mon !== this.monitoring) { this.monitoring = mon; this.reroute(); }
    }
    const keys = ['rootKey', 'scale', 'speed', 'humanize', 'mix'];
    if (keys.some(k => k in p && p[k] !== before[k]) && this.vst) this.scheduleApply(60);
    else this.publish();
  }

  dispose() {
    this.disposed = true;
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.dropVst();
    autotuneLive.set(this.plugin.id, null);
    try { this.input.disconnect(); } catch { /* */ }
    try { this.output.disconnect(); } catch { /* */ }
    (this.nova as any).dispose?.();
  }

  // --- Interne -----------------------------------------------------------------

  /** Autotune du PC à utiliser (choix, disponibilité, ordre de préférence). */
  private syncCandidate() {
    if (this.disposed) return;
    const want = effectiveAutotune();
    const quality = autotunePrefs.get().quality;
    if (want?.key === this.cand?.key && this.vst) {
      if (quality !== this.quality) { this.quality = quality; this.scheduleApply(0); }
      this.publish();
      return;
    }
    this.quality = quality;
    this.dropVst();
    this.cand = want;
    this.fallback = null;
    if (want) {
      const vst = new VSTPluginNode(this.ctx, {
        id: `${this.plugin.id}::autotune-pc`, name: want.name, type: 'VST3', isEnabled: true, latency: 0,
        params: { localPath: want.path, pluginName: want.pluginName },
      }, { quiet: true });
      this.vst = vst;
      vst.setLatencyListener(() => { if (this.route === 'vst') this.latencyListener?.(); this.publish(); });
      this.vstUnsub = vst.onStatus(s => this.onVstStatus(s));
      // Le pont est peut-être déjà connecté : le nœud s'y charge tout seul.
      if (novaBridge.isConnected()) this.onVstStatus(vst.getInfo().status);
    }
    this.reroute();
  }

  private dropVst() {
    this.vstUnsub?.();
    this.vstUnsub = null;
    if (this.vst) {
      try { this.input.disconnect(this.vst.input); } catch { /* */ }
      try { this.vst.output.disconnect(this.output); } catch { /* */ }
      this.vst.dispose();
      this.vst = null;
    }
    this.vstReady = false;
    this.cand = null;
  }

  private onVstStatus(s: VstNodeStatus) {
    if (this.disposed || !this.vst || !this.cand) return;
    if (s === 'active') {
      this.scheduleApply(0);
    } else if (s === 'error') {
      const info = this.vst.getInfo();
      const cand = this.cand;
      this.vstReady = false;
      this.reroute();
      // Noté « non disponible » : NOVA passe tout seul au suivant (ex. MetaTune).
      autotunePrefs.markUnavailable(cand.key, info.licenseRequired
        ? 'Demande une licence ou une activation'
        : `Ne se charge pas${info.error ? ` (${info.error})` : ''}`);
    } else if (s === 'offline') {
      this.vstReady = false;
      this.fallback = novaBridge.isConnected() ? null : 'pont VST déconnecté';
      this.reroute();
    } else {
      this.publish();
    }
  }

  private scheduleApply(delay: number) {
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => { this.applyTimer = null; void this.apply(); }, delay);
  }

  /** Recopie tonalité / gamme / style sur le plugin, relit, puis l'écoute bascule. */
  private async apply() {
    const vst = this.vst;
    const cand = this.cand;
    if (!vst || !cand || this.disposed) return;
    const slot = vst.getSlotId();
    if (!slot) return;
    if (this.applying) { this.reapply = true; return; }
    this.applying = true;
    this.publish();
    try {
      if (!novaBridge.getBridgeState().paramsText) {
        this.fail('pont VST à mettre à jour (version 7)');
        return;
      }
      let raw = paramCache.get(cand.path);
      if (!raw) {
        raw = await novaBridge.getParams(slot);
        paramCache.set(cand.path, raw);
      }
      const scale = (String(this.params.scale || 'CHROMATIC').toUpperCase()) as NovaScale;
      const r = resolveAutotuneSettings(cand.name, toVstParams(raw), {
        root: Number(this.params.rootKey) || 0, scale,
        speed: Number(this.params.speed ?? 0.1), humanize: Number(this.params.humanize ?? 0.2), mix: Number(this.params.mix ?? 1),
        lowLatency: this.quality !== 'max-quality',
      });
      if (r.keyMethod === 'none' && scale !== 'CHROMATIC') {
        autotunePrefs.markUnavailable(cand.key, 'Ne permet pas de régler la gamme automatiquement');
        return;
      }
      const res = await novaBridge.setParams(slot, r.settings);
      if (this.vst !== vst) return;
      const bad = r.verify.filter(v => {
        const got = res.results.find(x => x.name === v.name);
        return !got || !got.ok || !readbackMatches(v.expect, got.text || '');
      });
      if (bad.length) {
        console.warn('[Autotune du PC] réglage non confirmé', bad.map(b => b.name), res.results);
        this.fail('le plugin a refusé la gamme');
        return;
      }
      this.vstReady = true;
      this.fallback = null;
      this.retries = 0;
      this.reroute();
    } catch (e: any) {
      if (this.vst === vst) {
        this.fail(e?.message || 'réglage impossible');
        // Pont occupé (plusieurs plugins à charger) : on réessaie, NOVA joue en attendant.
        if (this.retries < 4 && vst.getInfo().status === 'active') { this.retries++; this.scheduleApply(3000 * this.retries); }
      }
    } finally {
      this.applying = false;
      this.publish();
      if (this.reapply) { this.reapply = false; this.scheduleApply(0); }
    }
  }

  private fail(reason: string) {
    this.vstReady = false;
    this.fallback = reason;
    this.reroute();
  }

  /** Qui traite le son : le plugin du PC (réglé, chargé, pas en prise) ou NOVA. */
  private reroute() {
    const want: 'nova' | 'vst' = (this.vst && this.vstReady && !this.monitoring && this.vst.getInfo().status === 'active') ? 'vst' : 'nova';
    if (want !== this.route) {
      const vst = this.vst;
      if (want === 'vst' && vst) {
        try { this.input.disconnect(this.nova.input); } catch { /* */ }
        this.input.connect(vst.input);
        vst.output.connect(this.output);
      } else {
        if (vst) {
          try { this.input.disconnect(vst.input); } catch { /* */ }
          try { vst.output.disconnect(this.output); } catch { /* */ }
        }
        this.input.connect(this.nova.input);
      }
      this.route = want;
      this.latencyListener?.();
    }
    this.publish();
  }

  /** Badge de la piste voix. */
  private publish() {
    if (this.disposed || !this.realtime) return;
    const info = this.vst?.getInfo();
    let fallback: string | null = null;
    if (this.cand && this.route === 'nova') {
      if (this.monitoring) fallback = 'prise de voix : retour sans latence';
      else if (!novaBridge.isConnected()) fallback = 'pont VST déconnecté';
      else fallback = this.fallback;
    }
    autotuneLive.set(this.plugin.id, {
      engine: this.route,
      pluginName: this.cand?.name || null,
      vendor: this.cand?.vendor || null,
      keyText: keyLabel(Number(this.params.rootKey) || 0, String(this.params.scale || 'CHROMATIC')),
      fallback,
      loading: !!this.cand && this.route === 'nova' && !fallback && (info?.status === 'loading' || this.applying),
      latencyMs: Math.round(this.latency * 1000),
    });
  }
}
