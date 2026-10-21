/**
 * AudioSuite (R6) : appliquer un effet NOVA ou un VST du PC à un clip seul, ou
 * aux clips d'une plage, avec des poignées — Pro Tools « AudioSuite », Logic
 * « Traitement de fichier », Ableton : effet puis « Consolidate », FL « Edison ».
 *
 * Non destructif : la prise d'origine est gardée (« Revenir à l'original »).
 * VST : rendu hors ligne par le pont. Une seule étape d'annulation (découpe aux
 * bords de la plage comprise) ; en collaboration, le son traité part comme un
 * clip audio normal.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Clip, DAWState, PluginInstance, PluginType, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import {
  audioSuiteBlock, audioSuitePatch, audioSuiteRegion, audioSuiteRevertPatch, clipsForRange, DEFAULT_HANDLE, patchClip, stepLabel,
} from '../utils/clipProcess';
import { processRegion } from '../services/Bounce';
import { listPluginPresets } from '../services/PresetStore';
import { PluginPreset, withSoundSettings } from '../utils/presets';
import { defaultBuiltinParams } from '../utils/sessionTemplate';
import { getRegisteredPlugin } from '../engine/pluginRegistry';
import { novaBridge } from '../services/NovaBridge';
import { pluginState } from '../utils/trackStructure';
import { pluginDisplayName } from '../utils/pluginLabel';
import { DEFAULT_REPAIR_OPTIONS, repairBlock, repairedSomething, repairNothingFound, repairPatch, repairStepName, repairSummary, STRENGTH_LABELS, type HumMode, type RepairOptions, type RepairStrength } from '../utils/repair';
import { bufferOf, channelsOf, runRepair } from '../services/VoiceRepair';
import { openNovaWindow } from '../utils/novaWindows';

interface Props {
  open: boolean;
  /** Clips visés ; ou une plage (les clips y sont coupés aux bords). */
  targets?: { trackId: string; clipId: string }[];
  range?: { start: number; end: number; trackIds: string[] };
  /** Onglet ouvert d'office (« Réparer la voix » depuis le menu du clip). */
  initialSource?: Source;
  tracks: Track[];
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
}

/** Effets NOVA proposés (le plus courant d'abord). */
const NOVA_FX: { type: PluginType; label: string }[] = [
  { type: 'PROEQ12', label: 'Égaliseur 12 bandes' },
  { type: 'COMPRESSOR', label: 'Compresseur' },
  { type: 'DEESSER', label: 'De-esser' },
  { type: 'REVERB', label: 'Réverbe' },
  { type: 'DELAY', label: 'Écho / délai' },
  { type: 'VOCALSATURATOR', label: 'Saturation' },
  { type: 'CHORUS', label: 'Chorus' },
  { type: 'DOUBLER', label: 'Doubleur' },
  { type: 'DENOISER', label: 'Gate de bruit' },
  { type: 'STEREOSPREADER', label: 'Élargisseur stéréo' },
  { type: 'LIMITER', label: 'Limiteur' },
  { type: 'VOICESHIFT', label: 'Voix grave / aiguë' },
  { type: 'LOFI', label: 'Lo-fi / téléphone' },
  { type: 'DJFILTER', label: 'Filtre DJ' },
];

const notify = (text: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: text })); } catch { /* hors navigateur */ } };
const has = (id: string) => !!audioBufferRegistry.get(id);
const INSTRUMENTS = new Set(['SAMPLER', 'DRUM_SAMPLER', 'MELODIC_SAMPLER', 'DRUM_RACK_UI']);

const novaPlugin = (type: PluginType): PluginInstance => ({
  id: `audiosuite-${type}`, type, name: NOVA_FX.find(f => f.type === type)?.label || type, isEnabled: true, latency: 0,
  params: getRegisteredPlugin(type)?.defaultParams() || defaultBuiltinParams(type),
});

export type Source = 'track' | 'nova' | 'vst' | 'repair';

const REPAIR_KEY = 'nova_repair_options';
const loadRepair = (): RepairOptions => {
  try { const v = JSON.parse(localStorage.getItem(REPAIR_KEY) || 'null'); if (v && typeof v === 'object') return { ...DEFAULT_REPAIR_OPTIONS, ...v }; } catch { /* stockage indisponible */ }
  return DEFAULT_REPAIR_OPTIONS;
};

const AudioSuiteDialog: React.FC<Props> = ({ open, targets, range, initialSource, tracks, setState, onClose }) => {
  const [source, setSource] = useState<Source>('nova');
  const [insertId, setInsertId] = useState<string>('');
  const [novaType, setNovaType] = useState<PluginType>('COMPRESSOR');
  const [vstPath, setVstPath] = useState<string>('');
  const [presets, setPresets] = useState<PluginPreset[]>([]);
  const [presetId, setPresetId] = useState<string>('');
  const [handle, setHandle] = useState(DEFAULT_HANDLE);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [repair, setRepair] = useState<RepairOptions>(loadRepair);
  const setRep = (patch: Partial<RepairOptions>) => setRepair(r => { const n = { ...r, ...patch }; try { localStorage.setItem(REPAIR_KEY, JSON.stringify(n)); } catch { /* stockage indisponible */ } return n; });

  // Clips visés (plage : ceux qu'elle touche).
  const resolved = useMemo(() => {
    if (range) {
      return range.trackIds.flatMap(tid => {
        const t = tracks.find(x => x.id === tid);
        return (t?.clips || []).filter(c => !c.isMuted && !c.notes && c.start < range.end && c.start + c.duration > range.start).map(c => ({ track: t!, clip: c }));
      });
    }
    return (targets || []).map(r => { const t = tracks.find(x => x.id === r.trackId); const c = t?.clips.find(x => x.id === r.clipId); return t && c ? { track: t, clip: c } : null; }).filter(Boolean) as { track: Track; clip: Clip }[];
  }, [range, targets, tracks]);
  const hostTrack = resolved[0]?.track;
  const inserts = (hostTrack?.plugins || []).filter(p => !INSTRUMENTS.has(p.type));
  const bridgeOn = novaBridge.isConnected();
  const vstList = useMemo(() => (bridgeOn ? novaBridge.getCachedPlugins().filter(p => !p.isInstrument) : []), [bridgeOn, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const revertable = resolved.filter(r => !!r.clip.audioSuite);

  useEffect(() => {
    if (!open) return;
    setError(null); setBusy(null); setInfo(null);
    setSource(initialSource || (inserts.length ? 'track' : 'nova'));
    setInsertId(inserts[0]?.id || '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plugin choisi (réglages compris).
  const chosen: PluginInstance | null = useMemo(() => {
    if (source === 'track') { const p = inserts.find(x => x.id === insertId); return p ? { ...p, isEnabled: true, isInactive: undefined } : null; }
    if (source === 'nova') return novaPlugin(novaType);
    const v = vstList.find(x => x.path === vstPath);
    return v ? { id: `audiosuite-vst`, type: 'VST3', name: v.name, isEnabled: true, latency: 0, params: { name: v.name, vendor: v.vendor, localPath: v.path, pluginName: v.pluginName ?? null } } : null;
  }, [source, insertId, novaType, vstPath, inserts, vstList]);

  useEffect(() => {
    if (!open || !chosen || source === 'track') { setPresets([]); setPresetId(''); return; }
    let alive = true;
    listPluginPresets(chosen).then(l => { if (alive) { setPresets(l); setPresetId(''); } }).catch(() => { if (alive) setPresets([]); });
    return () => { alive = false; };
  }, [open, source, novaType, vstPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);
  if (!open) return null;

  const blocked = resolved.map(r => (source === 'repair' ? repairBlock(r.clip) : audioSuiteBlock(r.clip))).find(Boolean) || null;
  const repairNone = !repair.declip && !repair.clicks && repair.hum === 'off' && !repair.plosives;

  // Réparer la voix (écart 7) : calcul sur l'appareil, dans un Worker ; seuls les clips où un
  // défaut a été trouvé changent (les autres restent tels quels, sans étape inutile).
  const applyRepair = async () => {
    setError(null); setInfo(null);
    if (repairNone) { setError('Coche au moins une réparation.'); return; }
    if (!resolved.length) { setError('Aucun clip audio à réparer.'); return; }
    if (blocked) { setError(blocked); return; }
    try {
      const work = new Map<string, Clip[]>();
      const jobs: { trackId: string; clip: Clip }[] = [];
      if (range) {
        for (const tid of range.trackIds) {
          const t = tracks.find(x => x.id === tid);
          if (!t) continue;
          const r = clipsForRange(t.clips, range.start, range.end);
          if (!r.targetIds.length) continue;
          work.set(tid, r.clips);
          r.clips.filter(c => r.targetIds.includes(c.id)).forEach(c => jobs.push({ trackId: tid, clip: c }));
        }
      } else resolved.forEach(r => jobs.push({ trackId: r.track.id, clip: r.clip }));
      const patches = new Map<string, Partial<Clip>>();
      const summaries: string[] = [];
      const name = repairStepName(repair);
      for (let i = 0; i < jobs.length; i++) {
        const { clip } = jobs[i];
        const label = `Réparation ${jobs.length > 1 ? `${i + 1}/${jobs.length} ` : ''}: ${clip.name}`;
        setBusy(`${label}…`);
        const buf = clip.buffer || audioBufferRegistry.get(clip.bufferId!);
        if (!buf) throw new Error(`Le son de « ${clip.name} » n'est pas chargé.`);
        const reg = audioSuiteRegion(clip, buf.duration, handle);
        const sr = buf.sampleRate;
        const from = Math.round(reg.from * sr), to = Math.round(reg.to * sr);
        const res = await runRepair(channelsOf(buf, from, to), sr, repair, (pct, m) => setBusy(`${label} · ${m} ${pct} %`));
        if (!repairedSomething(res.stats)) continue;
        const id = `rep-${clip.id}-${Date.now().toString(36)}`;
        audioBufferRegistry.register(bufferOf(res.channels, sr), id);
        patches.set(clip.id, repairPatch(clip, { newBufferId: id, from: from / sr, name }));
        summaries.push(repairSummary(res.stats));
      }
      if (!patches.size) { setInfo(repairNothingFound(repair)); return; }
      setState(prev => ({
        ...prev,
        tracks: prev.tracks.map(t => {
          const base = work.get(t.id) || t.clips;
          if (!work.has(t.id) && !base.some(c => patches.has(c.id))) return t;
          return { ...t, clips: base.map(c => (patches.has(c.id) ? patchClip(c, patches.get(c.id)!) : c)) };
        }),
      }));
      notify(`🩹 ${patches.size > 1 ? `${patches.size} clips réparés` : 'Voix réparée'} : ${summaries[0]}${summaries.length > 1 ? '…' : ''}. L'original est gardé (menu du clip → « Revenir à l'original »), Ctrl+Z pour annuler.`);
      onClose();
    } catch (e: any) {
      setError(`La réparation n'a pas abouti : ${e?.message || e}. Le clip n'a pas été modifié.`);
    } finally { setBusy(null); }
  };

  const apply = async () => {
    if (source === 'repair') { await applyRepair(); return; }
    setError(null);
    if (!chosen) { setError('Choisis un effet.'); return; }
    if (!resolved.length) { setError('Aucun clip audio à traiter.'); return; }
    if (blocked) { setError(blocked); return; }
    const preset = presets.find(p => p.id === presetId);
    const plugin = preset ? withSoundSettings(chosen, preset.params).plugin : chosen;
    const fxName = plugin.type === 'VST3' ? String(plugin.params?.name || plugin.name) : pluginDisplayName(plugin);
    const step = { type: plugin.type, name: stepLabel(plugin.type, fxName, preset?.name), ...(preset ? { preset: preset.name } : {}), at: Date.now() };
    try {
      // Plage : les clips sont d'abord coupés aux bords (en mémoire), puis traités.
      const work = new Map<string, Clip[]>(); // piste -> nouvelle liste de clips
      const jobs: { trackId: string; clip: Clip }[] = [];
      if (range) {
        for (const tid of range.trackIds) {
          const t = tracks.find(x => x.id === tid);
          if (!t) continue;
          const r = clipsForRange(t.clips, range.start, range.end);
          if (!r.targetIds.length) continue;
          work.set(tid, r.clips);
          r.clips.filter(c => r.targetIds.includes(c.id)).forEach(c => jobs.push({ trackId: tid, clip: c }));
        }
      } else resolved.forEach(r => jobs.push({ trackId: r.track.id, clip: r.clip }));
      const patches = new Map<string, Partial<Clip>>();
      for (let i = 0; i < jobs.length; i++) {
        const { trackId, clip } = jobs[i];
        setBusy(`Traitement ${i + 1}/${jobs.length} : ${clip.name}…`);
        const buf = clip.buffer || audioBufferRegistry.get(clip.bufferId!);
        if (!buf) throw new Error(`Le son de « ${clip.name} » n'est pas chargé.`);
        const reg = audioSuiteRegion(clip, buf.duration, handle);
        const sr = buf.sampleRate;
        const from = Math.round(reg.from * sr);
        const to = Math.round(reg.to * sr);
        const host = tracks.find(t => t.id === trackId)!;
        const out = await processRegion(buf, from, to, [plugin], host, m => setBusy(m));
        const id = `as-${clip.id}-${Date.now().toString(36)}`;
        audioBufferRegistry.register(out, id);
        patches.set(clip.id, audioSuitePatch(clip, { newBufferId: id, from: from / sr, step }));
      }
      setState(prev => ({
        ...prev,
        tracks: prev.tracks.map(t => {
          const base = work.get(t.id) || t.clips;
          if (!work.has(t.id) && !base.some(c => patches.has(c.id))) return t;
          return { ...t, clips: base.map(c => (patches.has(c.id) ? patchClip(c, patches.get(c.id)!) : c)) };
        }),
      }));
      notify(`🎛️ Traitement « ${step.name} » appliqué à ${patches.size} clip${patches.size > 1 ? 's' : ''}. L'original est gardé : menu du clip → « Revenir à l'original ». Ctrl+Z pour annuler.`);
      onClose();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(null); }
  };

  const revert = () => {
    const patches = new Map<string, Partial<Clip>>();
    let missing = 0;
    for (const r of revertable) { const p = audioSuiteRevertPatch(r.clip, has); if (p) patches.set(r.clip.id, p); else missing++; }
    if (!patches.size) { setError('La prise d’origine n’est pas sur cet appareil (projet reçu en collaboration).'); return; }
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (t.clips.some(c => patches.has(c.id)) ? { ...t, clips: t.clips.map(c => (patches.has(c.id) ? patchClip(c, patches.get(c.id)!) : c)) } : t)) }));
    notify(`↩️ ${patches.size} clip${patches.size > 1 ? 's' : ''} revenu${patches.size > 1 ? 's' : ''} à l'original${missing ? ` (${missing} sans prise d'origine sur cet appareil)` : ''}.`);
    onClose();
  };

  const tab = (s: Source, label: string, title: string, disabled = false) => (
    <button type="button" role="tab" aria-selected={source === s} disabled={disabled} onClick={() => setSource(s)} title={title}
      className={`flex-1 min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] rounded-lg px-2 text-[12px] font-bold disabled:opacity-40 ${source === s ? 'bg-cyan-500 text-black hover:bg-cyan-400' : 'text-nv-muted hover:bg-nv-accent/10'}`}>{label}</button>
  );
  const sel = 'w-full rounded-lg border border-nv-line bg-nv-well px-2 py-2 text-[12px] text-nv-ink';

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Traitement de clip" data-testid="audiosuite-dialog" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-md space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-black">Traitement de clip</h2>
            <p className="text-[11px] text-nv-muted" title="Logic : Traitement de fichier · Ableton : effet puis Consolidate · FL : Edison">
              Traite {resolved.length} clip{resolved.length > 1 ? 's' : ''}{range ? ' de la plage' : ''} avec un effet, comme le traitement hors ligne des studios. L'original est gardé.
            </p>
          </div>
          <button type="button" disabled={!!busy} onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>

        <div role="tablist" className="flex gap-1 rounded-xl bg-nv-well p-1">
          {tab('track', 'Effet de la piste', 'Un insert de la piste, avec ses réglages actuels', !inserts.length)}
          {tab('nova', 'Effet NOVA', 'Un effet NOVA, réglage par défaut ou un de tes presets')}
          {tab('vst', 'VST du PC', bridgeOn ? 'Un VST3 de ton PC, rendu hors ligne par le pont' : 'Connecte le pont VST (appli Windows Nova Studio)', !bridgeOn)}
          {tab('repair', 'Réparer la voix', 'Plosives, clics de bouche, bourdonnement secteur, saturation : calculé sur ton appareil')}
        </div>

        {source === 'repair' && (
          <div className="space-y-2" data-testid="repair-panel">
            {([
              ['plosives', 'Plosives (« p », « b » qui tapent)', 'Le grave sous 120 Hz baisse seulement pendant le souffle ; la voix au-dessus n’est pas touchée'],
              ['clicks', 'Clics de bouche', 'Petits claquements de salive ou de langue (moins de 4 ms), rebouchés à partir de la voix autour'],
              ['declip', 'Saturation (crêtes écrêtées)', 'La voix a saturé l’entrée : les crêtes coupées à plat sont reconstruites'],
            ] as [keyof RepairOptions, string, string][]).map(([k, label, hint]) => (
              <label key={k} className="flex items-start gap-2 text-[12px]" title={hint}>
                <input type="checkbox" checked={!!repair[k]} onChange={e => setRep({ [k]: e.target.checked } as Partial<RepairOptions>)} className="mt-0.5 h-4 w-4 accent-cyan-500" data-testid={`repair-${k}`} />
                <span><span className="font-bold">{label}</span><span className="block text-[11px] text-nv-muted">{hint}</span></span>
              </label>
            ))}
            <label className="flex items-center justify-between gap-2 text-[12px]" title="Ronflement du secteur (50 Hz en Europe, 60 Hz en Amérique du Nord) et ses harmoniques : câble, alimentation, ampli">
              <span className="font-bold">Bourdonnement secteur</span>
              <select value={repair.hum} onChange={e => setRep({ hum: e.target.value as HumMode })} aria-label="Bourdonnement secteur" data-testid="repair-hum"
                className="min-w-0 max-w-[60%] rounded-lg border border-nv-line bg-nv-well px-2 py-1 [@media(pointer:coarse)]:min-h-[44px] text-[12px] text-nv-ink">
                <option value="auto">Auto (50 ou 60 Hz)</option>
                <option value="50">50 Hz (Europe)</option>
                <option value="60">60 Hz (Amérique du Nord)</option>
                <option value="off">Ne pas toucher</option>
              </select>
            </label>
            <div role="radiogroup" aria-label="Sensibilité" className="flex gap-1 rounded-xl bg-nv-well p-1">
              {(['light', 'medium', 'strong'] as RepairStrength[]).map(k => (
                <button key={k} type="button" role="radio" aria-checked={repair.strength === k} onClick={() => setRep({ strength: k })} title={STRENGTH_LABELS[k].hint}
                  className={`flex-1 min-h-[32px] [@media(pointer:coarse)]:min-h-[44px] rounded-lg text-[12px] font-bold ${repair.strength === k ? 'bg-cyan-500 text-black' : 'text-nv-muted hover:bg-nv-accent/10'}`}>{STRENGTH_LABELS[k].label}</button>
              ))}
            </div>
            <p className="text-[11px] text-nv-muted">{STRENGTH_LABELS[repair.strength].hint} Si rien n’est trouvé, le clip ne change pas.</p>
            {resolved.length === 1 && !range && (
              <button type="button" disabled={!!busy} data-testid="open-spectral"
                onClick={() => { openNovaWindow('spectral-editor', { targets: [{ trackId: resolved[0].track.id, clipId: resolved[0].clip.id }] }); onClose(); }}
                className="w-full rounded-lg border border-nv-line px-3 py-2 [@media(pointer:coarse)]:min-h-[44px] text-left text-[12px] hover:bg-nv-accent/10" title="Voir le spectre du clip et effacer un bruit précis (toux, téléphone, chaise) à la main">
                <i className="fas fa-chart-area mr-2 text-cyan-400" />Éditeur spectral… <span className="text-nv-muted">(effacer un bruit précis à la main)</span>
              </button>
            )}
          </div>
        )}

        {source === 'track' && (
          <select value={insertId} onChange={e => setInsertId(e.target.value)} aria-label="Effet de la piste" className={sel} data-testid="audiosuite-insert">
            {inserts.map((p, i) => <option key={p.id} value={p.id}>{i + 1}. {p.type === 'VST3' ? (p.params?.name || p.name) : pluginDisplayName(p)}{pluginState(p) !== 'active' ? ' (désactivé sur la piste)' : ''}</option>)}
          </select>
        )}
        {source === 'nova' && (
          <select value={novaType} onChange={e => setNovaType(e.target.value as PluginType)} aria-label="Effet NOVA" className={sel} data-testid="audiosuite-nova">
            {NOVA_FX.map(f => <option key={f.type} value={f.type}>{f.label}</option>)}
          </select>
        )}
        {source === 'vst' && (
          <select value={vstPath} onChange={e => setVstPath(e.target.value)} aria-label="VST du PC" className={sel}>
            <option value="">Choisis un plugin…</option>
            {vstList.map(v => <option key={`${v.path}#${v.pluginName || ''}`} value={v.path}>{v.name}{v.vendor ? ` · ${v.vendor}` : ''}</option>)}
          </select>
        )}
        {source !== 'track' && source !== 'repair' && (
          <select value={presetId} onChange={e => setPresetId(e.target.value)} aria-label="Preset" className={sel} data-testid="audiosuite-preset"
            title="Tes presets de cet effet (fenêtre de l'effet → Presets)">
            <option value="">{source === 'vst' ? 'Réglage du plugin par défaut' : 'Réglage par défaut'}</option>
            {presets.map(p => <option key={p.id} value={p.id}>★ {p.name}</option>)}
          </select>
        )}

        <label className="flex items-center justify-between gap-2 text-[12px]" title="« Handle Length » — du son avant / après le clip passe dans l'effet, pour pouvoir rallonger le clip ensuite">
          <span>Poignées (avant / après le clip)</span>
          <select value={handle} onChange={e => setHandle(Number(e.target.value))} aria-label="Poignées" className="rounded-lg border border-nv-line bg-nv-well px-2 py-1 [@media(pointer:coarse)]:min-h-[44px] text-[12px] text-nv-ink">
            {[0, 0.5, 1, 2, 5].map(h => <option key={h} value={h}>{h} s</option>)}
          </select>
        </label>

        {blocked && <p role="alert" className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">{blocked}</p>}
        {busy && <p role="status" className="text-[12px] text-nv-muted"><i className="fas fa-circle-notch animate-spin mr-2" />{busy}</p>}
        {error && <p role="alert" className="rounded-lg bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">{error}</p>}
        {info && <p role="status" data-testid="repair-info" className="rounded-lg bg-cyan-500/10 px-2 py-1.5 text-[12px] text-nv-ink">{info}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!!busy || (source === 'repair' ? repairNone : !chosen) || !!blocked || !resolved.length} onClick={() => void apply()} data-testid="audiosuite-run"
            className="min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] flex-1 rounded-xl bg-cyan-500 px-4 text-[13px] font-bold text-black hover:bg-cyan-400 disabled:opacity-40">
            <i className={`fas ${source === 'repair' ? 'fa-band-aid' : 'fa-wand-magic-sparkles'} mr-2`} />{source === 'repair' ? 'Réparer' : 'Traiter'}
          </button>
          {revertable.length > 0 && (
            <button type="button" disabled={!!busy} onClick={revert} data-testid="audiosuite-revert" title="Remet la prise d'origine, à la même place (revenir au clip d'origine dans la liste des clips)"
              className="min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] rounded-xl border border-nv-line px-4 text-[13px] font-bold hover:bg-nv-accent/10">
              <i className="fas fa-rotate-left mr-2" />Revenir à l'original
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AudioSuiteDialog;
