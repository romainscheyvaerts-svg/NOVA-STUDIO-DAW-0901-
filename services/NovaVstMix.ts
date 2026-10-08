/**
 * Nova (le chat du studio) pilote les plugins VST3 TIERS du PC pour mixer.
 *
 * Actions (AIAction) traitées ici, appelées par executeAIAction (App) — elles viennent
 * des commandes locales (utils/novaCommands) ou de l'IA (api/chat.ts) :
 *   VST_MIX        { intent: "mix spatial et saturé avec beaucoup de delay", trackId? }
 *   VST_LIST       { category? }                       plugins installés par catégorie
 *   VST_SHOW_PARAMS{ trackId?, plugin }                réglages lus sur le plugin (valeurs texte)
 *   VST_SET_PARAM  { trackId?, plugin, param, value }  réglage par nom / rôle (ratio, mix…) et valeur
 *   VST_REMOVE     { trackId?, plugin }                retirer un plugin posé
 *   VST_MOVE       { trackId?, plugin, toIndex }       réordonner
 *   VST_MIX_FALLBACK { pluginId, reason }              plugin qui a échoué → effet de NOVA
 * Garde-fous : jamais d'ouverture de fenêtre de plugin, jamais de plugin non installé /
 * exclu / sans licence ; tout passe par l'historique (Annuler) ; pont absent : effets
 * intégrés de NOVA, dit clairement.
 */
import type { AIAction, DAWState, PluginInstance, Track } from '../types';
import { novaBridge } from './NovaBridge';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { autotunePrefs } from './AutotuneVst';
import { installedForMix, introspectMissing, loadKnowledge, pluginsByCategory } from './VstKnowledgeBase';
import { describeIntent, findMixStyle, parseMixIntent, suggestStyles } from '../utils/mixStyles';
import { estimateLoudDb, KnownPlugin, planVoiceMix } from '../utils/mixPlanner';
import { applyMixPlan } from '../utils/mixApply';
import { CATEGORY_LABEL_FR, classifyPlugin, paramRoles, toSetting, unitOf } from '../utils/vstKnowledge';
import { liveVstNodes, novaVstEvents } from '../engine/VSTPluginNode';
import { isVoiceTrack } from '../utils/vocalRoles';
import { toVstParams } from '../utils/autotuneVst';
import { enforceRemoteMixRule, installedForRemote, RemoteMixRule } from '../utils/remoteInge';
import { calibrateNova, novaTargetFor, vstCalibrationSpec } from '../utils/grCalibration';
import { ANALOG_SPECS } from '../engine/analogCompParams';

export interface NovaVstCtx {
  getState: () => DAWState;
  /** Une seule étape d'historique. */
  mutate: (fn: (draft: DAWState) => void) => void;
  notify: (msg: string) => void;
  post: (content: string, choices?: { label: string; action?: AIAction; actions?: AIAction[] }[]) => void;
  /** Repli sans pont : style de mix intégré de NOVA. */
  applyBuiltinStyle: (styleId: string) => void;
  /**
   * Mode « Ingé à distance », côté ingé : effets temporels toujours en envoi,
   * et pendant l'enregistrement reverbs / délais de NOVA seulement.
   */
  remoteRule?: () => RemoteMixRule | null;
}

export const VST_ACTIONS = new Set(['VST_MIX', 'VST_LIST', 'VST_SHOW_PARAMS', 'VST_SET_PARAM', 'VST_REMOVE', 'VST_MOVE', 'VST_MIX_FALLBACK']);

const bridgeReady = () => novaBridge.isConnected() && !!novaBridge.getBridgeState().paramsText;

const voiceOf = (st: DAWState, trackId?: string): Track | undefined => {
  const voices = st.tracks.filter(isVoiceTrack);
  return voices.find(t => t.id === trackId) || voices.find(t => t.id === st.selectedTrackId)
    || voices.find(t => t.id === 'track-rec-main' && t.clips.length) || voices.find(t => t.clips.length) || voices[0];
};

/** Niveau des passages forts de la voix, d'après ses prises (null : pas encore de prise). */
const loudOf = (t: Track): number | null => {
  for (const c of t.clips) {
    const b = c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined;
    if (b) return estimateLoudDb(b.getChannelData(0), b.sampleRate);
  }
  return null;
};

const findVst = (t: Track, ref: string): PluginInstance | undefined => {
  const q = String(ref || '').toLowerCase();
  return t.plugins.find(p => p.id === ref)
    || t.plugins.find(p => p.type === 'VST3' && (p.name || '').toLowerCase().includes(q))
    || t.plugins.find(p => p.type === 'VST3' && classifyPlugin(p.params?.name || p.name, p.params?.vendor || '').category === q)
    || t.plugins.find(p => p.type === 'VST3' && CATEGORY_LABEL_FR[classifyPlugin(p.params?.name || p.name).category]?.toLowerCase().includes(q));
};

/**
 * Calage « réduction cible » des compresseurs de la voix et de son bus après
 * un Mix auto (règle maison : 5 dB max au VU sur la voix et le FET de bus,
 * 2 dB sur l'optique de bus). Effets NOVA : calés sur place ; VST : par le
 * pont (rendu hors ligne + dichotomie). Le son de référence est la voix
 * elle-même (clips de la piste) ; sur le bus, c'est une approximation.
 */
export async function calibrateMixCompressors(ctx: NovaVstCtx, voiceId: string, busId: string | null, opts: { waitMs?: number } = {}): Promise<string[]> {
  const { audioEngine } = await import('../engine/AudioEngine');
  const src = audioEngine.getTrackSourceAudio(voiceId, 60);
  if (!src) return [];
  const lines: string[] = [];
  const deadline = Date.now() + (opts.waitMs ?? 45000);
  for (const tid of [voiceId, busId]) {
    if (!tid) continue;
    const onBus = tid !== voiceId;
    const t = ctx.getState().tracks.find(x => x.id === tid);
    if (!t) continue;
    for (const pl of t.plugins.filter(p => p.isEnabled)) {
      try {
        if (ANALOG_SPECS[pl.type]) {
          const spec = ANALOG_SPECS[pl.type];
          const target = novaTargetFor(pl.type, onBus);
          const r = await calibrateNova(pl.type, { ...spec.defaults, ...(pl.params || {}) }, src.channels, src.sampleRate, target);
          ctx.mutate(d => { const q = d.tracks.find(x => x.id === tid)?.plugins.find(x => x.id === pl.id); if (q) q.params = { ...q.params, [spec.driveParam]: r.value }; });
          lines.push(`${r.reached ? '✅' : '⚠️'} ${spec.name} (${t.name}) : ${r.grDb.toFixed(1).replace('.', ',')} dB max au VU (cible ${target} dB)${r.reached ? '' : ` — ${r.why}`}`);
        } else if (pl.type === 'VST3' && /comp/.test(String(pl.params?.novaSlot || ''))) {
          const node = liveVstNodes.get(pl.id);
          let slot = node?.getSlotId() || null;
          while (!slot && Date.now() < deadline) { await new Promise(res => setTimeout(res, 500)); slot = liveVstNodes.get(pl.id)?.getSlotId() || null; }
          if (!slot || !novaBridge.getBridgeState().calibrateGr) continue;
          const names = toVstParams(await novaBridge.getParams(slot)).map(x => x.name);
          const spec = vstCalibrationSpec(pl.params?.name || pl.name, names, onBus);
          if (!spec) continue;
          const r = await novaBridge.calibrateGr({ slotId: slot, param: spec.param, lo: spec.lo, hi: spec.hi, sense: spec.sense, targetDb: spec.targetDb, sampleRate: src.sampleRate, channels: src.channels });
          // Enregistré dans le projet (Annuler, réouverture) : même chemin que VST_SET_PARAM.
          ctx.mutate(d => {
            const q = d.tracks.find(x => x.id === tid)?.plugins.find(x => x.id === pl.id);
            if (!q) return;
            const prev = (q.params?.novaSettings || []) as any[];
            q.params = { ...q.params, novaSettings: [...prev.filter(x => x.name !== spec.param), { name: spec.param, real: r.value }] };
          });
          lines.push(`${r.reached ? '✅' : '⚠️'} ${pl.name} (${t.name}) : ${spec.label} ${r.text ?? r.value} → ${r.grDb.toFixed(1).replace('.', ',')} dB max au VU (cible ${spec.targetDb} dB)${r.reached ? '' : ` — ${r.why}`}`);
        }
      } catch (e: any) {
        lines.push(`⚠️ ${pl.name} : calage impossible (${e?.message || e})`);
      }
    }
  }
  if (lines.length) ctx.post(`🎯 Compresseurs calés sur ta voix (règle maison : 5 dB max au VU, 2 dB sur l’optique de bus) :\n${lines.join('\n')}`);
  return lines;
}

/** Relectures envoyées par les plugins après réglage : résumées dans le chat. */
const watchReadback = (ctx: NovaVstCtx, ids: string[]) => {
  if (!ids.length) return;
  const pending = new Set(ids);
  const lines: string[] = [];
  const failures: string[] = [];
  const off = novaVstEvents.on(r => {
    if (!pending.has(r.pluginId)) return;
    pending.delete(r.pluginId);
    if (r.failed) failures.push(`${r.name} : ${r.failed === 'license' ? 'licence ou démo' : 'ne se charge pas'}`);
    else {
      const key = r.readback.filter(x => /ratio|threshold|thresh|mix|frequency|decay|feedback|drive|shape|gain/i.test(x.name)).slice(0, 6);
      lines.push(`${r.ok ? '✅' : '⚠️'} ${r.name} : ${key.map(x => `${x.name.replace(/_/g, ' ')} = ${x.text}`).join(', ') || 'réglé'}`);
    }
    if (!pending.size) finish();
  });
  const timer = setTimeout(() => finish(), 90000);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    off();
    clearTimeout(timer);
    if (lines.length) ctx.post(`🔎 Réglages relus sur tes plugins :\n${lines.join('\n')}`);
    if (failures.length) ctx.post(`↩️ Repli sur les effets de NOVA pour : ${failures.join(' ; ')}.`);
  };
};

export async function handleNovaVstAction(a: AIAction, ctx: NovaVstCtx): Promise<void> {
  const p = (a.payload || {}) as any;
  const st = ctx.getState();
  switch (a.action) {
    case 'VST_LIST': {
      if (!bridgeReady()) { ctx.post('Le pont VST n’est pas connecté : connecte-le dans l’onglet VST (ou ouvre Nova Studio pour Windows) pour que j’utilise tes plugins.'); return; }
      await loadKnowledge();
      const list = installedForMix();
      const by = pluginsByCategory(list.filter(x => !x.unavailable));
      const order = ['eq', 'compressor', 'deesser', 'saturation', 'reverb', 'delay', 'autotune', 'limiter', 'channel-strip', 'modulation', 'gate', 'filter', 'stereo', 'pitch', 'amp', 'utility', 'other'];
      const want = p.category ? String(p.category) : null;
      const lines = order.filter(c => by.has(c) && (!want || c === want)).map(c => {
        const arr = by.get(c)!;
        return `• ${CATEGORY_LABEL_FR[c as keyof typeof CATEGORY_LABEL_FR]} (${arr.length}) : ${arr.slice(0, 8).map(x => `${x.name}${x.vendor ? ` (${x.vendor})` : ''}`).join(', ')}${arr.length > 8 ? '…' : ''}`;
      });
      const off = list.filter(x => x.unavailable).length;
      ctx.post(`🎛️ Tes plugins VST utilisables (${list.length - off}) :\n${lines.join('\n')}${off ? `\n(${off} non disponibles : licence, démo ou plantage ; et les plugins exclus dans l’onglet VST)` : ''}`);
      return;
    }

    case 'VST_MIX': {
      const intentText = String(p.intent || p.style || '').trim();
      const intent = parseMixIntent(intentText);
      const voice = voiceOf(st, p.trackId);
      if (!voice) { ctx.post('Je ne trouve pas de piste voix à mixer.'); return; }
      if (intent.unknown) {
        const sug = suggestStyles(st.beatGenre, st.bpm);
        ctx.post(`Quel son tu veux sur ta voix ? Je te propose :\n${sug.map(s => `${s.emoji} ${s.label} : ${s.description}`).join('\n')}\nTu peux aussi les combiner (« spatial et saturé »).`,
          sug.map(s => ({ label: `${s.emoji} ${s.label}`, action: { action: 'VST_MIX', payload: { intent: s.label, trackId: voice.id } } as AIAction })));
        return;
      }
      if (!bridgeReady()) {
        // Repli : style intégré le plus proche.
        const main = intent.styles.map(s => s.id).find(id => ['trap', 'drill', 'rnb', 'radio', 'neutre'].includes(id));
        const map: Record<string, string> = { trap: 'trap-autotune', drill: 'drill', rnb: 'chant-rnb', radio: 'telephone', neutre: 'rap-clair' };
        if (main) ctx.applyBuiltinStyle(map[main]);
        ctx.post(`Le pont VST n’est pas connecté : ${main ? `j’ai appliqué le style « ${findMixStyle(main)!.label} » avec les effets de NOVA` : 'je ne peux pas utiliser tes plugins'}. Connecte le pont (onglet VST) et redemande-moi pour un mix sur tes plugins.`);
        return;
      }
      await loadKnowledge();
      let installed: KnownPlugin[] = installedForMix();
      if (await introspectMissing(installed, 2)) installed = installedForMix();
      const rule = ctx.remoteRule?.() || null;
      installed = installedForRemote(installed, rule);
      const loud = loudOf(voice);
      const plan = enforceRemoteMixRule(planVoiceMix({
        installed, dims: intent.dims, tweakOnly: intent.tweakOnly, tuneSpeed: intent.tuneSpeed,
        voice: { id: voice.id, name: voice.name, plugins: voice.plugins },
        bus: (() => { const b = st.tracks.find(t => t.id === (voice.outputTrackId || 'bus-vox') && t.id !== 'master') || st.tracks.find(t => t.id === 'bus-vox'); return b ? { id: b.id, name: b.name, plugins: b.plugins } : null; })(),
        sendTracks: st.tracks.filter(t => t.id.startsWith('send-')).map(t => ({ id: t.id, name: t.name, plugins: t.plugins })),
        loudDb: loud ?? undefined, bpm: st.bpm,
      }), rule);
      ctx.mutate(d => { applyMixPlan(d, plan, { voiceTrackIds: [voice.id] }); });
      const vstCount = plan.tracks.reduce((n, t) => n + t.vst.length, 0);
      ctx.post(
        `🎚️ Mix « ${describeIntent(intent)} » sur ${voice.name}${loud !== null ? ` (passages forts mesurés à ${loud} dBFS)` : ''} :\n${plan.summary.map(x => `• ${x}`).join('\n')}`
        + (plan.warnings.length ? `\n⚠️ ${plan.warnings.join('\n⚠️ ')}` : '')
        + `\nTout est annulable : dis « annule » ou Ctrl+Z.${vstCount ? ' Je relis les réglages sur les plugins dès qu’ils sont chargés.' : ''}`,
        [{ label: '↩️ Annuler ce mix', action: { action: 'UNDO', payload: {} } as AIAction }],
      );
      // Les nouveaux plugins : ids connus après l'application (posés par applyMixPlan).
      setTimeout(() => {
        const after = ctx.getState();
        const ids = after.tracks.flatMap(t => t.plugins.filter(x => x.type === 'VST3' && x.params?.novaSlot && x.isEnabled).map(x => x.id));
        watchReadback(ctx, ids.filter(id => !!liveVstNodes.get(id) || true));
        // Puis calage « réduction cible » des compresseurs (voix et bus).
        const busId = after.tracks.find(t => t.id === (voice.outputTrackId || 'bus-vox') && t.id !== 'master')?.id || null;
        calibrateMixCompressors(ctx, voice.id, busId).catch(() => { /* le mix reste appliqué */ });
      }, 0);
      return;
    }

    case 'VST_SHOW_PARAMS': {
      const t = st.tracks.find(x => x.id === p.trackId) || voiceOf(st);
      const pl = t && findVst(t, p.plugin || '');
      const node = pl && liveVstNodes.get(pl.id);
      const slot = node?.getSlotId();
      if (!pl || !slot) { ctx.post(`Je ne trouve pas ce plugin chargé${t ? ` sur ${t.name}` : ''}.`); return; }
      const raw = toVstParams(await novaBridge.getParams(slot));
      const cls = classifyPlugin(pl.params?.name || pl.name, pl.params?.vendor || '', raw);
      const roles = paramRoles(cls.category === 'channel-strip' ? 'compressor' : cls.category, raw) as Record<string, string>;
      const keyNames = new Set(Object.values(roles));
      const shown = (keyNames.size ? raw.filter(x => keyNames.has(x.name)) : raw).slice(0, 14);
      ctx.post(`🔎 ${pl.name} sur ${t!.name} :\n${shown.map(x => `• ${x.displayName || x.name} = ${x.text}`).join('\n')}`);
      return;
    }

    case 'VST_SET_PARAM': {
      const t = st.tracks.find(x => x.id === p.trackId) || voiceOf(st);
      const pl = t && findVst(t, p.plugin || '');
      const node = pl && liveVstNodes.get(pl.id);
      const slot = node?.getSlotId();
      if (!t || !pl || !slot) { ctx.post('Je ne trouve pas ce plugin chargé sur la piste.'); return; }
      const raw = toVstParams(await novaBridge.getParams(slot));
      const cls = classifyPlugin(pl.params?.name || pl.name, pl.params?.vendor || '', raw);
      const roles = paramRoles(cls.category === 'channel-strip' ? 'compressor' : cls.category, raw) as Record<string, string>;
      const ref = String(p.param || '').toLowerCase();
      const prm = raw.find(x => x.name === roles[ref]) || raw.find(x => x.name.toLowerCase() === ref) || raw.find(x => (x.displayName || x.name).toLowerCase().includes(ref));
      if (!prm) { ctx.post(`${pl.name} n’a pas de réglage « ${p.param} ».`); return; }
      // Règle maison : compresseur sur une voix = ratio 2:1.
      let value = p.value;
      if (/ratio/i.test(prm.name) && isVoiceTrack(t) && Number(String(value).replace(/:.*$/, '')) !== 2) {
        ctx.post('Sur une voix, je garde le ratio à 2:1 (règle du studio).');
        value = 2;
      }
      const num = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
      const setting = typeof value === 'string' && prm.values?.some(v => v.toLowerCase() === value.toLowerCase())
        ? { name: prm.name, text: prm.values.find(v => v.toLowerCase() === value.toLowerCase())!, why: 'demande' }
        : Number.isFinite(num) ? toSetting(prm, { value: num, unit: /ratio/i.test(prm.name) ? 'ratio' : unitOf(prm) === 'none' ? 'none' : unitOf(prm) }, 'demande') : { name: prm.name, text: String(value), why: 'demande' };
      if (!setting) { ctx.post(`Cette valeur n’est pas possible sur ${pl.name} (${prm.displayName || prm.name}).`); return; }
      // Déclaratif : enregistré dans le projet (Annuler), appliqué et relu par le nœud.
      const prev = (pl.params?.novaSettings || []) as any[];
      const next = [...prev.filter(x => x.name !== setting.name), { name: setting.name, ...(setting.text !== undefined ? { text: setting.text } : {}), ...(setting.real !== undefined ? { real: setting.real } : {}) }];
      ctx.mutate(d => { const tr = d.tracks.find(x => x.id === t.id); const q = tr?.plugins.find(x => x.id === pl.id); if (q) q.params = { ...q.params, novaSettings: next, novaSlot: q.params?.novaSlot || 'tone' }; });
      watchReadback(ctx, [pl.id]);
      ctx.notify(`🎛️ ${pl.name} : ${prm.displayName || prm.name} → ${setting.text ?? setting.real}`);
      return;
    }

    case 'VST_REMOVE': case 'VST_MOVE': {
      const t = st.tracks.find(x => x.id === p.trackId) || voiceOf(st);
      const pl = t && findVst(t, p.plugin || '');
      if (!t || !pl) { ctx.post('Je ne trouve pas ce plugin sur la piste.'); return; }
      ctx.mutate(d => {
        const tr = d.tracks.find(x => x.id === t.id);
        if (!tr) return;
        const i = tr.plugins.findIndex(x => x.id === pl.id);
        if (i < 0) return;
        const [it] = tr.plugins.splice(i, 1);
        if (a.action === 'VST_MOVE') tr.plugins.splice(Math.max(0, Math.min(tr.plugins.length, Number(p.toIndex) || 0)), 0, it);
        else tr.plugins.forEach(x => { if (x.params?.novaPausedBy === 'vst' && !x.isEnabled) { x.isEnabled = true; delete x.params.novaPausedBy; } });
      });
      ctx.post(a.action === 'VST_MOVE' ? `↕️ ${pl.name} déplacé.` : `🗑️ ${pl.name} retiré de ${t.name} (les effets de NOVA mis en pause reprennent). Annuler pour le remettre.`);
      return;
    }

    case 'VST_MIX_FALLBACK': {
      // Plugin posé par Nova qui n'a pas pu servir : retiré, l'effet de NOVA reprend.
      const id = String(p.pluginId || '');
      const t = st.tracks.find(x => x.plugins.some(y => y.id === id));
      const pl = t?.plugins.find(y => y.id === id);
      if (!t || !pl) return;
      const key = `${pl.params?.localPath}#${pl.params?.pluginName || pl.params?.name || pl.name}`;
      autotunePrefs.markUnavailable(key, p.reason === 'license' ? 'Demande une licence ou est en démo' : 'Ne se charge pas');
      ctx.mutate(d => {
        const tr = d.tracks.find(x => x.id === t.id);
        if (!tr) return;
        tr.plugins = tr.plugins.filter(x => x.id !== id);
        tr.plugins.forEach(x => { if (x.params?.novaPausedBy === 'vst' && !x.isEnabled) { x.isEnabled = true; delete x.params.novaPausedBy; } });
      });
      return;
    }
  }
}
