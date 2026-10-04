import type { BridgePlugin, SetParamsResult } from './NovaBridge';
import { toVstParams } from '../utils/autotuneVst';
import { classifyPlugin } from '../utils/vstKnowledge';

/**
 * Collaboration « En direct » : l'ingé règle à distance les VST hébergés par le
 * pont du PC de L'ARTISTE (comme s'il était à côté de lui).
 *
 *  vst_catalog    artiste → ingé : plugins VST installés sur le PC de l'artiste
 *  vst_params_get ingé → artiste : lire les réglages d'un VST chargé chez l'artiste
 *  vst_params     artiste → ingé : réglages lus (valeurs texte du plugin)
 *  vst_param      ingé → artiste : régler des paramètres (par nom, valeur texte / réelle)
 *  vst_param_ack  artiste → ingé : valeurs RELUES sur le plugin + nouvel état
 *
 * Le réglage est appliqué par le pont de l'artiste (NovaBridge.setParams, v7),
 * relu, puis l'état du plugin est enregistré dans son projet. L'ingé reçoit
 * les valeurs relues et l'état : son prochain envoi de mix ne le réécrase pas.
 */

export const LIVE_VST_KINDS = new Set(['vst_catalog', 'vst_param', 'vst_param_ack', 'vst_params_get', 'vst_params']);

export interface VstCatalogEntry { name: string; vendor: string; path: string; pluginName: string | null; category: string }

/** Plugins d'effet installés chez l'artiste (liste du pont), pour l'ingé. */
export const catalogOf = (plugins: BridgePlugin[]): VstCatalogEntry[] =>
  plugins.filter(p => p.isInstrument !== true && !!p.path).slice(0, 400).map(p => ({
    name: p.name, vendor: p.vendor || '', path: p.path, pluginName: p.pluginName ?? null,
    category: classifyPlugin(p.name, p.vendor).category,
  }));

export interface VstParamSetting { name: string; text?: string; real?: number; value?: number }
export interface VstParamRequest { reqId: string; trackId: string; pluginId: string; params: VstParamSetting[] }
export interface VstParamAck {
  reqId: string;
  pluginId: string;
  ok: boolean;
  results: SetParamsResult['results'];
  stateB64?: string;
  error?: string;
}
export interface VstParamInfo { name: string; displayName?: string; text: string; values?: string[] }
export interface VstParamsReply { reqId: string; pluginId: string; ok: boolean; parameters?: VstParamInfo[]; error?: string }

/** Ce dont l'artiste a besoin pour appliquer (injecté : testable sans pont). */
export interface LiveVstDeps {
  isConnected: () => boolean;
  paramsText: () => boolean;
  slotOf: (pluginId: string) => string | null;
  setParams: (slot: string, params: VstParamSetting[]) => Promise<SetParamsResult>;
  getParams: (slot: string) => Promise<any[]>;
  /** Relit l'état du plugin (et l'enregistre dans le projet de l'artiste). */
  syncState: (pluginId: string) => Promise<string | null>;
}

const unavailable = (deps: LiveVstDeps, pluginId: string): { slot: string } | { error: string } => {
  if (!deps.isConnected()) return { error: "Le pont VST de l'artiste n'est pas connecté : il doit ouvrir NOVA Studio pour Windows." };
  if (!deps.paramsText()) return { error: "Le pont VST de l'artiste est trop ancien (version 7 nécessaire) : il doit le mettre à jour." };
  const slot = deps.slotOf(pluginId);
  if (!slot) return { error: "Ce plugin n'est pas chargé chez l'artiste (installé sur son PC ? piste dégelée ?)." };
  return { slot };
};

const clean = (params: unknown): VstParamSetting[] =>
  (Array.isArray(params) ? params : []).slice(0, 32).filter((p: any) => p && typeof p.name === 'string' && p.name.length <= 120).map((p: any) => ({
    name: p.name,
    ...(typeof p.text === 'string' ? { text: p.text.slice(0, 60) } : {}),
    ...(typeof p.real === 'number' && Number.isFinite(p.real) ? { real: p.real } : {}),
    ...(typeof p.value === 'number' && Number.isFinite(p.value) ? { value: Math.max(0, Math.min(1, p.value)) } : {}),
  }));

/** Artiste : applique le réglage demandé par l'ingé sur SON pont, relit et renvoie. */
export async function applyRemoteVstParams(req: VstParamRequest, deps: LiveVstDeps): Promise<VstParamAck> {
  const base = { reqId: String(req.reqId), pluginId: String(req.pluginId) };
  const u = unavailable(deps, base.pluginId);
  if ('error' in u) return { ...base, ok: false, results: [], error: u.error };
  const params = clean(req.params);
  if (!params.length) return { ...base, ok: false, results: [], error: 'Aucun réglage valable.' };
  try {
    const res = await deps.setParams(u.slot, params);
    const stateB64 = await deps.syncState(base.pluginId).catch(() => null);
    return { ...base, ok: res.results.length > 0 && res.results.every(r => r.ok), results: res.results, ...(stateB64 ? { stateB64 } : {}) };
  } catch (e: any) {
    return { ...base, ok: false, results: [], error: e?.message || 'Réglage refusé par le plugin.' };
  }
}

/** Artiste : réglages actuels d'un VST chargé (valeurs texte), pour l'ingé. */
export async function readRemoteVstParams(req: { reqId: string; pluginId: string }, deps: LiveVstDeps): Promise<VstParamsReply> {
  const base = { reqId: String(req.reqId), pluginId: String(req.pluginId) };
  const u = unavailable(deps, base.pluginId);
  if ('error' in u) return { ...base, ok: false, error: u.error };
  try {
    const parameters = toVstParams(await deps.getParams(u.slot)).slice(0, 300)
      .map(p => ({ name: p.name, ...(p.displayName ? { displayName: p.displayName } : {}), text: p.text, ...(p.values?.length ? { values: p.values.slice(0, 40) } : {}) }));
    return { ...base, ok: true, parameters };
  } catch (e: any) {
    return { ...base, ok: false, error: e?.message || 'Lecture impossible.' };
  }
}

/** Ingé : attente des réponses de l'artiste, par numéro de demande. */
export class VstRemoteRequests<T = any> {
  private pending = new Map<string, { resolve: (v: T) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private n = 0;

  create(timeoutMs = 25000): { reqId: string; promise: Promise<T> } {
    const reqId = `${Date.now().toString(36)}-${(this.n++).toString(36)}`;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("L'artiste n'a pas répondu : son pont VST est-il ouvert (NOVA Studio pour Windows) ?"));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
    });
    return { reqId, promise };
  }

  /** Réponse reçue : true si elle était attendue. */
  resolve(reqId: string, value: T): boolean {
    const p = this.pending.get(reqId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    p.resolve(value);
    return true;
  }

  size() { return this.pending.size; }
}
