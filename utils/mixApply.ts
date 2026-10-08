/**
 * Application d'un plan de mix (utils/mixPlanner.ts) au projet, en UNE étape
 * d'historique (Annuler / Ctrl+Z / « annule » remet tout comme avant) :
 *  - plugins VST3 du PC insérés à leur place dans la chaîne (params.novaSettings =
 *    réglages par nom de paramètre, appliqués et relus au chargement par le pont,
 *    chargement discret : aucune fenêtre ne surgit) ;
 *  - un VST déjà posé par Nova au même emplacement est RÉGLÉ, pas dupliqué ;
 *  - l'effet de NOVA qui faisait la même chose est mis en pause (pas supprimé) ;
 *  - effets de NOVA en repli quand aucun VST adapté n'existe ;
 *  - envois des voix vers les retours reverb / délai.
 */
import type { DAWState, PluginInstance } from '../types';
import type { MixPlan, PlannedBuiltin, Slot } from './mixPlanner';
import { slotOfPlugin, SLOT_ORDER } from './mixPlanner';
import { isVoiceTrack } from './vocalRoles';

let seq = 0;
const newId = (slot: string) => `nova-${slot}-${Date.now().toString(36)}-${(seq++).toString(36)}`;


/** Effet de NOVA en repli (réglages minimaux sûrs : le reste vient des valeurs par défaut). */
const builtinPlugin = (b: PlannedBuiltin, existing?: PluginInstance): PluginInstance => {
  const params: Record<string, any> = { ...(existing?.params || {}), isEnabled: true, novaSlot: b.slot };
  if (b.type === 'COMPRESSOR') Object.assign(params, {
    threshold: b.params.threshold ?? -18, ratio: 2, knee: b.params.knee ?? 6, attack: b.params.attack ?? 0.005,
    release: b.params.release ?? 0.1, makeupGain: existing?.params?.makeupGain ?? 1.4, autoMakeup: false, mix: 1, mode: b.params.mode || 'FET',
  });
  if (b.type === 'DEESSER') Object.assign(params, { threshold: b.params.threshold ?? -40, frequency: b.params.frequency ?? 8000, q: 1.0, reduction: b.params.reduction ?? 0.5, mode: 'BELL', detection: b.params.detection ?? 'RELATIVE', relThreshold: b.params.relThreshold ?? -6, listen: 0 });
  if (b.type === 'VOCALSATURATOR') Object.assign(params, { drive: b.params.drive ?? 20, mix: b.params.mix ?? 0.35, tone: 0, eqLow: 0, eqMid: 0, eqHigh: 0, mode: b.params.mode || 'TAPE', outputGain: 1 });
  return {
    id: existing?.id || newId(b.slot), name: existing?.name || b.type, type: b.type as any, isEnabled: true,
    params, latency: existing?.latency || 0,
  };
};

const sortChain = (plugins: PluginInstance[]): PluginInstance[] =>
  plugins.map((p, i) => ({ p, i, s: slotOfPlugin(p) })).sort((a, b) => a.s - b.s || a.i - b.i).map(x => x.p);

export interface ApplyResult {
  inserted: number;
  updated: number;
  paused: number;
}

/** Applique le plan sur un brouillon Immer du projet. */
export const applyMixPlan = (draft: DAWState, plan: MixPlan, opts: { voiceTrackIds?: string[] } = {}): ApplyResult => {
  const res: ApplyResult = { inserted: 0, updated: 0, paused: 0 };
  for (const tp of plan.tracks) {
    const t = draft.tracks.find(x => x.id === tp.trackId);
    if (!t) continue;
    for (const v of tp.vst) {
      const existing = t.plugins.find(p => p.type === 'VST3' && p.params?.novaSlot === v.slot);
      const params = {
        name: v.plugin.name, vendor: v.plugin.vendor, localPath: v.plugin.path, pluginName: v.plugin.pluginName || undefined,
        novaSlot: v.slot as Slot, novaQuiet: true,
        novaSettings: v.settings.map(({ name, text, real }) => ({ name, ...(text !== undefined ? { text } : {}), ...(real !== undefined ? { real } : {}) })),
        novaSays: v.says,
      };
      if (existing && existing.params?.localPath === v.plugin.path) {
        // Même plugin déjà posé par Nova : on le règle (l'état du plugin est gardé).
        existing.params = { ...existing.params, ...params };
        existing.isEnabled = true;
        res.updated++;
      } else {
        if (existing) t.plugins = t.plugins.filter(p => p.id !== existing.id);
        t.plugins.push({ id: newId(v.slot), name: v.plugin.name, type: 'VST3', isEnabled: true, latency: 0, params });
        res.inserted++;
      }
    }
    // Style complet : les VST posés avant par Nova à des places que ce style ne veut
    // plus sont retirés, et les effets de NOVA qui ne servent plus sont mis en pause.
    if (!plan.tweakOnly && tp === plan.tracks[0]) {
      const wanted = new Set<string>([...tp.vst.map(x => x.slot), ...tp.builtin.map(x => x.slot)]);
      t.plugins = t.plugins.filter(p => !(p.type === 'VST3' && p.params?.novaSlot && !wanted.has(p.params.novaSlot)));
      const unwanted: Record<string, string> = { COMPRESSOR: 'comp1', DEESSER: 'deess', VOCALSATURATOR: 'sat', DOUBLER: 'width' };
      for (const p of t.plugins) {
        const slot = unwanted[p.type];
        if (slot && p.isEnabled && !wanted.has(slot) && !tp.pauseBuiltin.includes(p.id)) tp.pauseBuiltin.push(p.id);
      }
    }
    for (const id of tp.pauseBuiltin) {
      const p = t.plugins.find(x => x.id === id);
      if (p && p.isEnabled) { p.isEnabled = false; p.params = { ...p.params, novaPausedBy: 'vst' }; res.paused++; }
    }
    for (const b of tp.builtin) {
      if (b.type === 'PROEQ12') continue; // l'égaliseur de NOVA garde ses réglages (style de mix) : rien à forcer ici
      const existing = t.plugins.find(p => p.type === b.type && (p.params?.novaSlot === b.slot || (!p.params?.novaSlot && b.slot !== 'comp2' && b.slot !== 'comp1') || (b.slot === 'comp1' && p.type === 'COMPRESSOR' && !p.params?.novaSlot)));
      const pl = builtinPlugin(b, existing);
      if (existing) Object.assign(existing, pl); else { t.plugins.push(pl); res.inserted++; }
    }
    t.plugins = sortChain(t.plugins);
  }
  // Envois des voix vers les retours.
  if (plan.sends.length) {
    const voices = draft.tracks.filter(t => (opts.voiceTrackIds ? opts.voiceTrackIds.includes(t.id) : isVoiceTrack(t)));
    for (const t of voices) {
      for (const s of plan.sends) {
        const sd = t.sends.find(x => x.id === s.sendId);
        if (sd) { sd.level = s.level; sd.isEnabled = true; } else t.sends.push({ id: s.sendId, level: s.level, isEnabled: true });
      }
    }
  }
  // Autotune : vitesse / naturel / dosage demandés par le style (gamme : celle du projet).
  if (plan.autotune) {
    const voices = draft.tracks.filter(t => (opts.voiceTrackIds ? opts.voiceTrackIds.includes(t.id) : isVoiceTrack(t)));
    for (const t of voices) {
      const at = t.plugins.find(p => p.type === 'AUTOTUNE');
      const params = { ...plan.autotune, rootKey: draft.projectKey ?? 0, scale: draft.projectScale || 'CHROMATIC', isEnabled: true };
      if (at) { at.params = { ...at.params, ...params }; at.isEnabled = true; }
      else t.plugins.push({ id: newId('tune'), name: 'AUTOTUNE', type: 'AUTOTUNE', isEnabled: true, latency: 0, params });
      t.plugins = sortChain(t.plugins);
    }
  }
  void SLOT_ORDER;
  return res;
};
