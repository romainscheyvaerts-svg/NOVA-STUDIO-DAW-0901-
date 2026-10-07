/**
 * Melodyne et VocAlign (plugins ARA2) depuis un clip : « Ouvrir dans
 * Melodyne » et « Aligner avec VocAlign… ».
 *
 * Melodyne : le clip part à l'hôte ARA du pont, la fenêtre de Melodyne s'ouvre
 * sur le PC avec les notes déjà analysées. Romain retouche, puis « Valider »
 * ici : le son corrigé remplace celui du clip (l'original et les retouches sont
 * gardés pour rouvrir ou revenir en arrière).
 *
 * VocAlign : on choisit le guide (la lead) et les clips à caler (doubles,
 * backs, harmonies de la même section). Trois façons : fenêtre de VocAlign,
 * « en un clic » (réglages par défaut, sans fenêtre), ou l'alignement NOVA
 * (sans plugin, aussi sur le site).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import {
  ARA_BADGE_TOOLTIP, AraContext, AraPluginKey, alignCandidates, alignWindow, araAvailability, araClipPatch, araPersistentId,
  araRegion, araReopenInfo, araRevertPatch, araSource, archiveFor, clipInWindow, guessLeadTrack, windowRegionStart,
} from '../utils/araEdit';
import { sliceChannels } from '../utils/pitchEdit';
import { alignToGuide } from '../utils/vocalAlign';
import { novaBridge } from '../services/NovaBridge';
import { openNovaWindow } from '../utils/novaWindows';

export interface AraApply { trackId: string; clipId: string; patch: Partial<Clip> }

interface Props {
  open: boolean;
  plugin: AraPluginKey;
  trackId?: string;
  clipId?: string;
  tracks: Track[];
  bpm: number;
  onApply: (changes: AraApply[], message: string) => void;
  onClose: () => void;
}

const has = (id: string) => audioBufferRegistry.has(id);

/** Essais automatiques : fenêtre du plugin hors écran (localStorage « nova.ara.offscreen » = 1). */
const offscreenForTests = () => { try { return localStorage.getItem('nova.ara.offscreen') === '1'; } catch { return false; } };

const toBuffer = (channels: Float32Array[], sampleRate: number): AudioBuffer => {
  const b = new AudioBuffer({ length: Math.max(1, channels[0]?.length || 1), numberOfChannels: Math.max(1, channels.length), sampleRate });
  channels.forEach((c, i) => b.copyToChannel(c, i));
  return b;
};

const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));

/** État du pont pour les commandes ARA (lu à l'ouverture et quand le pont change). */
export function useAraContext(): AraContext {
  const [ctx, setCtx] = useState<AraContext>({ bridgeConnected: novaBridge.isConnected(), bridgeAra: !!novaBridge.getBridgeState().ara, plugins: {} });
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const st = novaBridge.getBridgeState();
      const base = { bridgeConnected: st.status === 'connected', bridgeAra: !!st.ara };
      if (!base.bridgeConnected || !base.bridgeAra) { if (alive) setCtx({ ...base, plugins: {} }); return; }
      try {
        const s = await novaBridge.araStatus();
        if (alive) setCtx({ ...base, bridgeAra: s.host, plugins: s.plugins });
      } catch { if (alive) setCtx({ ...base, plugins: {} }); }
    };
    refresh();
    const off = novaBridge.subscribe(() => { refresh(); });
    return () => { alive = false; off(); };
  }, []);
  return ctx;
}

const Badge = () => (
  <span title={ARA_BADGE_TOOLTIP} className="ml-2 rounded border border-fuchsia-400/50 bg-fuchsia-500/15 px-1.5 py-0.5 align-middle text-[10px] font-black tracking-wider text-fuchsia-200">ARA</span>
);

const AraDialog: React.FC<Props> = ({ open, plugin, trackId, clipId, tracks, bpm, onApply, onClose }) => {
  const ctx = useAraContext();
  const track = tracks.find(t => t.id === trackId);
  const clip = track?.clips.find(c => c.id === clipId);
  const [phase, setPhase] = useState<'idle' | 'sending' | 'open' | 'rendering' | 'done' | 'error'>('idle');
  const [info, setInfo] = useState<string>('');
  const [error, setError] = useState<string>('');
  const sessionRef = useRef<string | null>(null);
  const melRef = useRef<any>(null);
  const alignRef = useRef<any>(null);

  // ---- VocAlign : guide + clips à caler ----
  const [guideKey, setGuideKey] = useState<string>('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [how, setHow] = useState<'window' | 'oneclick' | 'nova'>('oneclick');

  const avail = araAvailability(plugin, ctx);
  const reopen = clip ? araReopenInfo(clip, ctx, has) : null;

  // Guide proposé : le clip cliqué s'il est sur une piste lead, sinon le clip de la lead qui le recouvre.
  const guideOptions = useMemo(() => {
    const out: { key: string; trackId: string; clipId: string; label: string }[] = [];
    for (const t of tracks) for (const c of t.clips || []) {
      if (!c.bufferId || c.notes?.length) continue;
      out.push({ key: `${t.id}::${c.id}`, trackId: t.id, clipId: c.id, label: `${t.name} — ${c.name}` });
    }
    return out;
  }, [tracks]);

  useEffect(() => {
    if (!open || plugin !== 'vocalign' || !track || !clip) return;
    const lead = guessLeadTrack(tracks, track.id);
    let g = `${track.id}::${clip.id}`;
    if (lead && /back|double|dbl|harmo|chœur|choeur|ad.?lib/i.test(track.name)) {
      const over = lead.clips.find(c => c.bufferId && Math.min(c.start + c.duration, clip.start + clip.duration) - Math.max(c.start, clip.start) > 0.3);
      if (over) g = `${lead.id}::${over.id}`;
    }
    setGuideKey(g);
    setHow(avail.enabled ? 'oneclick' : 'nova');
  }, [open, plugin, trackId, clipId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [gTrackId, gClipId] = guideKey.split('::');
  const candidates = useMemo(() => (plugin === 'vocalign' && gTrackId ? alignCandidates(tracks, gTrackId, gClipId) : []), [plugin, tracks, gTrackId, gClipId]);
  useEffect(() => {
    const next: Record<string, boolean> = {};
    candidates.forEach(c => { next[`${c.trackId}::${c.clipId}`] = c.suggested || (c.trackId === trackId && c.clipId === clipId); });
    setChecked(next);
  }, [candidates, trackId, clipId]);

  useEffect(() => {
    if (!open) { setPhase('idle'); setError(''); setInfo(''); }
  }, [open]);

  // Fermer la fenêtre de NOVA ferme la session (et la fenêtre du plugin).
  const close = useCallback(() => {
    const sid = sessionRef.current;
    sessionRef.current = null;
    if (sid) novaBridge.araClose(sid);
    onClose();
  }, [onClose]);

  useEffect(() => novaBridge.onAraEvent(e => {
    if (e.session_id !== sessionRef.current) return;
    if (e.event === 'editor_closed') setInfo(i => i.includes('fenêtre fermée') ? i : `${i} (fenêtre fermée : « Valider » garde tes retouches)`);
  }), []);

  // ---------------------------------------------------------------- Melodyne
  const openMelodyne = useCallback(async () => {
    if (!clip || !track) return;
    const src = araSource(clip, has);
    const buf = src.bufferId ? audioBufferRegistry.get(src.bufferId) : undefined;
    if (!buf) { setPhase('error'); setError("Le son de ce clip n'est pas chargé : relis le projet puis réessaie."); return; }
    const region = araRegion(clip, src.offset, buf.duration);
    const persistentId = araPersistentId(src.bufferId, clip.id, region);
    const sid = `melodyne-${clip.id}-${Date.now()}`;
    sessionRef.current = sid;
    setPhase('sending'); setError('');
    try {
      const r = await novaBridge.araOpen({
        sessionId: sid, plugin: 'melodyne', sampleRate: buf.sampleRate, tempo: bpm, archive: archiveFor(clip, persistentId), offscreen: offscreenForTests(),
        clips: [{ id: clip.id, name: clip.name.replace(/\s*\((Melodyne|calé|justesse)\)$/, ''), track: track.name, role: 'edit',
          start: region.songStart, persistentId, channels: sliceChannels(buf, region.start, region.end) }],
      });
      if (sessionRef.current !== sid) return;
      const n = r.notes[clip.id];
      setInfo(`${n?.count ?? 0} note${(n?.count ?? 0) > 1 ? 's' : ''} trouvée${(n?.count ?? 0) > 1 ? 's' : ''}`
        + (r.analysisSeconds && r.analysisSeconds >= 0.1 ? ` en ${r.analysisSeconds.toFixed(1).replace('.', ',')} s` : '')
        + (r.restored ? ' · tes retouches précédentes sont rechargées' : ''));
      setPhase('open');
      try { (window as any).__novaAraSession = sid; } catch { /* */ }
      melRef.current = { src, region, persistentId, pluginName: [r.pluginName, r.pluginVersion].filter(Boolean).join(' ') };
    } catch (e: any) {
      if (sessionRef.current !== sid) return;
      sessionRef.current = null;
      setPhase('error'); setError(e?.message || 'Melodyne ne répond pas');
    }
  }, [clip, track, bpm]);

  const validateMelodyne = useCallback(async () => {
    const sid = sessionRef.current;
    const c = melRef.current;
    if (!sid || !clip || !trackId || !c) return;
    setPhase('rendering');
    try {
      const res = await novaBridge.araCommit(sid);
      sessionRef.current = null;
      const r = res.renders.find(x => x.clipId === clip.id);
      if (!r) throw new Error('Melodyne n’a rendu aucun son');
      const newBufferId = `melodyne-${clip.id}-${Date.now()}`;
      audioBufferRegistry.register(toBuffer(r.channels, r.sampleRate), newBufferId);
      const patch = araClipPatch(clip, {
        plugin: 'melodyne', mode: 'ara', newBufferId, sourceBufferId: c.src.bufferId, sourceOffset: c.src.offset,
        regionStart: c.region.start, persistentId: c.persistentId, archive: res.archive, pluginName: c.pluginName, at: Date.now(),
      });
      onApply([{ trackId, clipId: clip.id, patch }], '🎛️ Melodyne : son corrigé appliqué. L’original et tes retouches sont gardés (clic droit → Ouvrir dans Melodyne pour retoucher).');
      onClose();
    } catch (e: any) {
      setPhase('error'); setError(e?.message || 'Rendu impossible');
    }
  }, [clip, trackId, onApply, onClose]);

  // ---------------------------------------------------------------- VocAlign
  const runAlign = useCallback(async () => {
    const gt = tracks.find(t => t.id === gTrackId);
    const guide = gt?.clips.find(c => c.id === gClipId);
    if (!gt || !guide) return;
    const targets = candidates.filter(c => checked[`${c.trackId}::${c.clipId}`]);
    if (!targets.length) { setError('Coche au moins un clip à caler sur le guide.'); return; }
    const gsrc = araSource(guide, has);
    const gbuf = gsrc.bufferId ? audioBufferRegistry.get(gsrc.bufferId) : undefined;
    if (!gbuf) { setPhase('error'); setError("Le son du guide n'est pas chargé."); return; }
    const sr = gbuf.sampleRate;
    const dubs = targets.map(t => {
      const tr = tracks.find(x => x.id === t.trackId)!;
      const c = tr.clips.find(x => x.id === t.clipId)!;
      const s = araSource(c, has);
      return { t, clip: c, src: s, buf: s.bufferId ? audioBufferRegistry.get(s.bufferId) : undefined };
    });
    const missing = dubs.find(d => !d.buf || d.buf.sampleRate !== sr);
    if (missing) { setPhase('error'); setError(`« ${missing.clip.name} » : son absent ou à une autre fréquence d’échantillonnage que le guide.`); return; }
    const w = alignWindow([guide, ...dubs.map(d => d.clip)]);
    const gch = clipInWindow(channelsOf(gbuf), sr, guide, gsrc.offset, w);
    const dch = dubs.map(d => clipInWindow(channelsOf(d.buf!), sr, d.clip, d.src.offset, w));
    setPhase('rendering'); setError('');
    const mode = how === 'nova' ? 'nova' : 'capture';
    try {
      let rendered: Float32Array[][];
      if (how === 'nova') {
        setInfo('Alignement NOVA en cours…');
        await new Promise(r => setTimeout(r, 30));
        rendered = dch.map(ch => alignToGuide(gch, ch, sr, { maxShift: 0.2 }).channels);
      } else {
        const sid = `vocalign-${guide.id}-${Date.now()}`;
        sessionRef.current = sid;
        const secs = (w.end - w.start) * (how === 'window' ? 1 : 2) * dubs.length;
        setInfo(how === 'window'
          ? 'VocAlign capture le guide et le double (lecture du passage)… sa fenêtre s’ouvre sur ton PC.'
          : `VocAlign aligne ${dubs.length} clip${dubs.length > 1 ? 's' : ''} (environ ${Math.ceil(secs)} s, fenêtre cachée)…`);
        const r = await novaBridge.araAlign({
          sessionId: sid, sampleRate: sr, interactive: how === 'window',
          guide: { id: guide.id, name: guide.name, channels: gch },
          dubs: dubs.map((d, i) => ({ id: d.clip.id, name: d.clip.name, channels: dch[i] })),
        });
        if (r.waiting) {
          setPhase('open');
          setInfo('La fenêtre de VocAlign est ouverte sur ton PC avec le guide et le double capturés. Règle si besoin, puis « Valider ».');
          alignRef.current = { dubs, guide, gt, w, sr };
          return;
        }
        sessionRef.current = null;
        rendered = dubs.map(d => r.renders.find(x => x.clipId === d.clip.id)?.channels || []);
      }
      applyAligned(dubs, rendered, guide, gt, w, sr, mode);
    } catch (e: any) {
      sessionRef.current = null;
      setPhase('error');
      setError(`${e?.message || 'VocAlign ne répond pas'}. Tu peux choisir « Alignement NOVA » à la place.`);
    }
  }, [tracks, gTrackId, gClipId, candidates, checked, how, onApply, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyAligned = (dubs: any[], rendered: Float32Array[][], guide: Clip, gt: Track, w: { start: number; end: number }, sr: number, mode: 'capture' | 'nova') => {
    const changes: AraApply[] = [];
    dubs.forEach((d, i) => {
      const ch = rendered[i];
      if (!ch?.length || !ch[0].length) return;
      const newBufferId = `cale-${d.clip.id}-${Date.now()}`;
      audioBufferRegistry.register(toBuffer(ch, sr), newBufferId);
      const regionStart = windowRegionStart(d.clip.start, d.src.offset, w);
      changes.push({ trackId: d.t.trackId, clipId: d.clip.id, patch: araClipPatch(d.clip, {
        plugin: 'vocalign', mode, newBufferId, sourceBufferId: d.src.bufferId, sourceOffset: d.src.offset, regionStart,
        persistentId: araPersistentId(d.src.bufferId, d.clip.id, { start: regionStart, end: regionStart + (w.end - w.start) }),
        pluginName: mode === 'nova' ? 'Alignement NOVA' : 'VocAlign 6', guide: { trackId: gt.id, clipId: guide.id, name: guide.name }, at: Date.now(),
      }) });
    });
    if (!changes.length) { setPhase('error'); setError('Aucun clip n’a été calé.'); return; }
    onApply(changes, `🎙️ ${changes.length} clip${changes.length > 1 ? 's' : ''} calé${changes.length > 1 ? 's' : ''} sur « ${guide.name} »`
      + `${mode === 'nova' ? ' (alignement NOVA)' : ' avec VocAlign'} : les prises d’origine sont gardées (Ctrl+Z pour annuler).`);
    onClose();
  };

  const validateAlignWindow = useCallback(async () => {
    const sid = sessionRef.current;
    const p = alignRef.current;
    if (!sid || !p) return;
    setPhase('rendering');
    setInfo('VocAlign rend les doubles calés…');
    try {
      const res = await novaBridge.araCommit(sid);
      sessionRef.current = null;
      applyAligned(p.dubs, p.dubs.map((d: any) => res.renders.find(x => x.clipId === d.clip.id)?.channels || []), p.guide, p.gt, p.w, p.sr, 'capture');
    } catch (e: any) { setPhase('error'); setError(e?.message || 'Rendu impossible'); }
  }, [onApply, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const revert = useCallback(() => {
    if (!clip || !trackId) return;
    const patch = araRevertPatch(clip, has);
    if (!patch) return;
    onApply([{ trackId, clipId: clip.id, patch }], '↩️ Prise d’origine remise (Ctrl+Z pour revenir au son retouché).');
    onClose();
  }, [clip, trackId, onApply, onClose]);

  if (!open || !clip) return null;
  const busy = phase === 'sending' || phase === 'rendering';
  const label = plugin === 'melodyne' ? 'Melodyne' : 'VocAlign';

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="ara-title" data-testid={`ara-dialog-${plugin}`}>
      <div className="w-full max-w-[560px] rounded-2xl border border-white/10 bg-[#15171d] p-5 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <h2 id="ara-title" className="mr-auto text-[15px] font-black text-white">
            {plugin === 'melodyne' ? `🎛️ Melodyne : ${clip.name}` : `🎙️ Aligner avec VocAlign`}<Badge />
          </h2>
          <button type="button" onClick={close} aria-label="Fermer" className="h-9 w-9 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10">✕</button>
        </div>

        {reopen?.message && <p className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200" data-testid="ara-reopen-message">{reopen.message}</p>}

        {!avail.enabled && plugin === 'melodyne' && (
          <div className="mb-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-slate-300" data-testid="ara-unavailable">
            {avail.tooltip}
            <div className="mt-2"><button type="button" className="rounded-lg bg-cyan-500/20 px-3 py-1.5 font-bold text-cyan-200 hover:bg-cyan-500/30"
              onClick={() => { onClose(); openNovaWindow('pitch-editor', { targets: [{ trackId: trackId!, clipId: clip.id }] }); }}>Ouvrir la justesse NOVA</button></div>
          </div>
        )}

        {plugin === 'melodyne' && avail.enabled && (
          <div className="space-y-3 text-[13px] text-slate-300">
            {phase === 'idle' && <p>Le clip part dans Melodyne avec ses notes déjà analysées. Retouche dans la fenêtre de Melodyne, puis reviens ici pour « Valider » : le son corrigé remplace celui du clip, l’original et tes retouches sont gardés.</p>}
            {phase === 'sending' && <p className="animate-pulse">Envoi du clip à Melodyne et analyse…</p>}
            {phase === 'open' && <p data-testid="ara-open-info">La fenêtre de Melodyne est ouverte sur ton PC. {info}.</p>}
            {phase === 'rendering' && <p className="animate-pulse">Melodyne rend le son corrigé…</p>}
          </div>
        )}

        {plugin === 'vocalign' && (
          <div className="space-y-3 text-[13px] text-slate-300">
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">Guide (la voix de référence)</span>
              <select value={guideKey} onChange={e => setGuideKey(e.target.value)} disabled={busy}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-white" data-testid="ara-guide">
                {guideOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
            <div>
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">Clips à caler sur le guide</span>
              {candidates.length === 0 && <p className="text-slate-500">Aucun clip d’une autre piste ne joue en même temps que le guide.</p>}
              <div className="max-h-40 space-y-1 overflow-auto" data-testid="ara-candidates">
                {candidates.map(c => {
                  const k = `${c.trackId}::${c.clipId}`;
                  return (
                    <label key={k} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                      <input type="checkbox" checked={!!checked[k]} disabled={busy} onChange={e => setChecked(s => ({ ...s, [k]: e.target.checked }))} />
                      <span className="text-white">{c.trackName}</span><span className="text-slate-500">— {c.name}</span>
                      {c.suggested && <span className="ml-auto text-[10px] text-cyan-300">proposé</span>}
                    </label>
                  );
                })}
              </div>
            </div>
            <fieldset className="space-y-1" disabled={busy}>
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">Comment</span>
              {([
                ['oneclick', 'En un clic avec VocAlign', 'Réglages par défaut de VocAlign, sans fenêtre (le passage est lu une fois pour la capture).', !avail.enabled],
                ['window', 'Ouvrir VocAlign', 'Sa fenêtre s’ouvre avec guide et double capturés : tu règles, puis « Valider ».', !avail.enabled],
                ['nova', 'Alignement NOVA', 'Sans plugin, instantané : attaques et enveloppe calées sur le guide.', false],
              ] as const).map(([v, t, d, dis]) => (
                <label key={v} className={`flex items-start gap-2 ${dis ? 'opacity-40' : ''}`} title={dis ? avail.tooltip : d}>
                  <input type="radio" name="ara-how" checked={how === v} disabled={dis} onChange={() => setHow(v)} className="mt-1" />
                  <span><span className="font-bold text-white">{t}</span><br /><span className="text-[11px] text-slate-400">{d}</span></span>
                </label>
              ))}
            </fieldset>
            {info && <p className={busy ? 'animate-pulse' : ''} data-testid="ara-info">{info}</p>}
          </div>
        )}

        {error && <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200" role="alert">{error}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {clip.araEdit && reopen?.canRevert && (
            <button type="button" onClick={revert} disabled={busy} className="rounded-lg border border-white/10 px-3 py-2 text-[12px] font-bold text-slate-300 hover:bg-white/5" data-testid="ara-revert">Revenir à l’original</button>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={close} className="rounded-lg px-3 py-2 text-[12px] font-bold text-slate-400 hover:bg-white/5">{phase === 'open' ? 'Annuler' : 'Fermer'}</button>
            {plugin === 'melodyne' && avail.enabled && phase !== 'open' && (
              <button type="button" disabled={busy} onClick={openMelodyne} data-testid="ara-open"
                className="rounded-lg bg-fuchsia-500 px-4 py-2 text-[12px] font-black text-white hover:bg-fuchsia-400 disabled:opacity-50">{phase === 'error' ? 'Réessayer' : `Ouvrir dans ${label}`}</button>
            )}
            {phase === 'open' && (
              <>
                {plugin === 'melodyne' && <button type="button" onClick={() => sessionRef.current && novaBridge.araShow(sessionRef.current)} className="rounded-lg border border-white/10 px-3 py-2 text-[12px] font-bold text-slate-200 hover:bg-white/5">Remettre la fenêtre devant</button>}
                <button type="button" onClick={plugin === 'melodyne' ? validateMelodyne : validateAlignWindow} data-testid="ara-validate"
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-[12px] font-black text-black hover:bg-emerald-400">Valider</button>
              </>
            )}
            {plugin === 'vocalign' && phase !== 'open' && (
              <button type="button" disabled={busy || !candidates.some(c => checked[`${c.trackId}::${c.clipId}`])} onClick={runAlign} data-testid="ara-align"
                className="rounded-lg bg-fuchsia-500 px-4 py-2 text-[12px] font-black text-white hover:bg-fuchsia-400 disabled:opacity-50">Caler sur le guide</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AraDialog;
