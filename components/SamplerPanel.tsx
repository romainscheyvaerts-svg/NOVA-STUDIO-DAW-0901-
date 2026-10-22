import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clip, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { DEFAULT_SAMPLER, MelodicSamplerSettings, noteName, samplerBufferKey } from '../utils/melodicSampler';
import { INSTRUMENT_PRESETS, loadInstrumentManifest, settingsForInstrument } from '../utils/instrumentPresets';
import { preloadInstrument } from '../utils/samplerLoad';
import { detectRoot } from '../utils/samplerRoot';
import { MicTake, startMicSample } from '../utils/micSample';
import { clipRegionChannels } from '../utils/drumSamples';
import { registerSamplerSound } from './SamplerHost';
import { Faceplate, HwHelpProvider, HwSection, InfoBar, Knob, PushButton } from '../plugins/hw';

/**
 * R18 · Écran du sampler mélodique (FL : Sampler / DirectWave · Live :
 * Simpler · Logic : Quick Sampler) et R20 · choix des instruments
 * multi-échantillons. Ordinateur et tablette : tout ; téléphone : l'essentiel
 * (instrument, son au micro ou en fichier, note racine, attaque / relâchement,
 * mono / glide) avec « Plus de réglages ».
 * 1.5.1 : les réglages (enveloppe, jeu, son) sont sur une façade « matériel » (kit
 * plugins/hw : boutons rotatifs, poussoirs, aide dans l'infobulle et la ligne d'info) ;
 * mêmes réglages, mêmes bornes, mêmes envois (preuve : tests/pluginsFinInstruments.test.ts).
 */

interface SessionClipRef { trackId: string; clip: Clip; trackName: string }

interface Props {
  track: Track;
  isMobile: boolean;
  bpm: number;
  onChange: (patch: Partial<MelodicSamplerSettings>) => void;
  onClose: () => void;
  onBackToSynth: () => void;
  onOpenPianoRoll?: () => void;
  ensureEngine: () => Promise<unknown>;
  notify: (msg: string) => void;
  sessionClips: SessionClipRef[];
}

const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
const ms = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * Réglage du sampler : bouton rotatif du kit (glisser vertical, Maj = fin, molette,
 * double-clic = valeur d'origine) ; mêmes bornes et même pas qu'avant (curseurs).
 */
const Range: React.FC<{
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string;
  onChange: (v: number) => void; title: string; log?: boolean; testId?: string; dflt: number; paramId: string;
}> = ({ label, value, min, max, step, fmt, onChange, title, log, testId, dflt, paramId }) => (
  <div className="flex justify-center min-w-0" data-testid={testId}>
    <Knob size="S" label={label} hint={title} value={value} min={min} max={max} step={step || undefined} curve={log ? 'log' : 'lin'}
      format={fmt} onChange={onChange} defaultValue={dflt} paramId={paramId} cap="black" arc="#7c3aed" />
  </div>
);

const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }> = ({ title, hint, children, right }) => (
  <section className="rounded-xl border border-nv-line bg-nv-well p-3 flex flex-col gap-2 min-w-0">
    <header className="flex items-center gap-2" title={hint}>
      <h3 className="text-[11px] font-black uppercase tracking-wider text-nv-ink mr-auto">{title}</h3>
      {right}
    </header>
    {children}
  </section>
);

const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

/** Clavier d'essai au doigt ou à la souris (plusieurs doigts à la fois). */
const Keys: React.FC<{ from: number; count: number; root: number; onOn: (p: number) => void; onOff: (p: number) => void }> = ({ from, count, root, onOn, onOff }) => {
  const held = useRef(new Map<number, number>());
  const [down, setDown] = useState<Set<number>>(new Set());
  const press = (id: number, p: number) => { held.current.set(id, p); onOn(p); setDown(d => new Set(d).add(p)); };
  const lift = (id: number) => {
    const p = held.current.get(id);
    if (p === undefined) return;
    held.current.delete(id); onOff(p);
    setDown(d => { const n = new Set(d); n.delete(p); return n; });
  };
  useEffect(() => () => { held.current.forEach(p => onOff(p)); held.current.clear(); }, [onOff]);
  const keys = Array.from({ length: count }, (_, i) => from + i);
  const whites = keys.filter(k => !isBlack(k));
  const handlers = (p: number) => ({
    onPointerDown: (e: React.PointerEvent) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); press(e.pointerId, p); },
    onPointerUp: (e: React.PointerEvent) => lift(e.pointerId),
    onPointerCancel: (e: React.PointerEvent) => lift(e.pointerId),
  });
  return (
    <div className="relative h-20 select-none touch-none" role="group" aria-label="Clavier d'essai du sampler" data-testid="sampler-keys" data-own-longpress="">
      <div className="absolute inset-0 flex">
        {whites.map(p => (
          <button key={p} type="button" aria-label={`Note ${noteName(p)}`} {...handlers(p)}
            // Couleurs fixes : un clavier reste blanc et noir dans les deux thèmes.
            style={{ background: down.has(p) ? '#67e8f9' : '#f1f5f9', borderColor: 'rgba(0,0,0,0.5)' }}
            className="relative flex-1 border rounded-b-md">
            {(p % 12 === 0 || p === root) && <span className="absolute bottom-1 inset-x-0 text-[9px] font-bold" style={{ color: p === root ? '#0891b2' : '#64748b' }}>{p === root ? '◆' : noteName(p)}</span>}
          </button>
        ))}
      </div>
      {keys.filter(isBlack).map(p => {
        const idx = whites.filter(w => w < p).length;
        return (
          <button key={p} type="button" aria-label={`Note ${noteName(p)}`} {...handlers(p)}
            style={{ left: `calc(${(idx / whites.length) * 100}% - ${(0.6 / whites.length) * 50}%)`, width: `${(0.6 / whites.length) * 100}%`, background: down.has(p) ? '#06b6d4' : '#0f172a', borderColor: '#000' }}
            className="absolute top-0 h-[60%] rounded-b-md z-10 border" />
        );
      })}
    </div>
  );
};

/** Forme d'onde du sample perso, avec le début de lecture et la boucle. */
const Wave: React.FC<{ buffer: AudioBuffer | null; s: MelodicSamplerSettings; onSet: (patch: Partial<MelodicSamplerSettings>) => void }> = ({ buffer, s, onSet }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<null | 'start' | 'loopStart' | 'loopEnd'>(null);
  const peaks = useMemo(() => {
    if (!buffer) return null;
    const d = buffer.getChannelData(0);
    const n = 400;
    const out = new Float32Array(n);
    const step = Math.max(1, Math.floor(d.length / n));
    for (let i = 0; i < n; i++) { let m = 0; for (let k = i * step; k < Math.min(d.length, (i + 1) * step); k++) { const a = Math.abs(d[k]); if (a > m) m = a; } out[i] = m; }
    let pk = 0; out.forEach(v => { if (v > pk) pk = v; });
    return pk > 0 ? out.map(v => v / pk) : out;
  }, [buffer]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = c.clientWidth, h = c.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    const ink = css.getPropertyValue('--nv-ink').trim() ? `rgb(${css.getPropertyValue('--nv-ink').trim()})` : '#cbd5e1';
    if (s.loop) { g.fillStyle = 'rgba(34,211,238,0.15)'; g.fillRect(s.loopStart * w, 0, (s.loopEnd - s.loopStart) * w, h); }
    if (peaks) {
      g.fillStyle = ink;
      g.globalAlpha = 0.75;
      for (let i = 0; i < peaks.length; i++) { const x = (i / peaks.length) * w; const a = peaks[i] * (h / 2 - 2); g.fillRect(x, h / 2 - a, Math.max(1, w / peaks.length), a * 2 || 1); }
      g.globalAlpha = 1;
    }
    const line = (x: number, col: string) => { g.fillStyle = col; g.fillRect(Math.round(x * w) - 1, 0, 2, h); };
    line(s.start || 0, '#f59e0b');
    if (s.loop) { line(s.loopStart, '#22d3ee'); line(s.loopEnd, '#22d3ee'); }
  }, [peaks, s.start, s.loop, s.loopStart, s.loopEnd]);
  const posOf = (e: React.PointerEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  return (
    <canvas ref={ref} className="w-full h-20 rounded-lg bg-nv-bg border border-nv-line touch-none cursor-ew-resize" data-testid="sampler-wave"
      title="Glisse : le trait orange = début de lecture, les traits bleus = la boucle"
      onPointerDown={e => {
        const p = posOf(e);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const cand: [typeof drag.current, number][] = [['start', s.start || 0]];
        if (s.loop) cand.push(['loopStart', s.loopStart], ['loopEnd', s.loopEnd]);
        cand.sort((a, b) => Math.abs(a[1] - p) - Math.abs(b[1] - p));
        drag.current = cand[0][0];
      }}
      onPointerMove={e => {
        if (!drag.current) return;
        const p = posOf(e);
        if (drag.current === 'start') onSet({ start: Math.min(0.95, p) });
        else if (drag.current === 'loopStart') onSet({ loopStart: Math.min(p, s.loopEnd - 0.01) });
        else onSet({ loopEnd: Math.max(p, s.loopStart + 0.01) });
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
  );
};

const SamplerPanel: React.FC<Props> = ({ track, isMobile, onChange, onClose, onBackToSynth, onOpenPianoRoll, ensureEngine, notify, sessionClips }) => {
  const s = track.melodicSampler!;
  const [narrow, setNarrow] = useState(() => isMobile || (typeof window !== 'undefined' && window.innerWidth < 640));
  useEffect(() => {
    const on = () => setNarrow(isMobile || window.innerWidth < 640);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [isMobile]);
  const [more, setMore] = useState(false);
  const [loadingInst, setLoadingInst] = useState<string | null>(null);
  const [ready, setReady] = useState(() => !!audioEngine.getMelodicSamplerNode(track.id)?.hasSound());
  const [rec, setRec] = useState<null | { take: MicTake; t0: number }>(null);
  const [recLevel, setRecLevel] = useState(0);
  const [recSec, setRecSec] = useState(0);
  const [octave, setOctave] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const buffer = s.sampleId ? audioBufferRegistry.get(samplerBufferKey(s.sampleId)) || null : null;

  useEffect(() => audioEngine.onSamplerReady(id => { if (id === track.id) setReady(true); }), [track.id]);
  useEffect(() => { setReady(!!audioEngine.getMelodicSamplerNode(track.id)?.hasSound()); }, [track.id, s.instrument, s.sampleId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !rec) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, rec]);
  // Vu-mètre et durée de l'enregistrement.
  useEffect(() => {
    if (!rec) return;
    let raf = 0;
    const tick = () => { setRecLevel(rec.take.level()); setRecSec(rec.take.seconds()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rec]);
  useEffect(() => () => { rec?.take.cancel(); }, [rec]);

  // Moteur lancé : la note sonne tout de suite (sans attendre resume(), ~29 ms par note avant).
  const noteOn = (p: number) => { const c = audioEngine.ctx; if (c && c.state === 'running') audioEngine.triggerTrackAttack(track.id, p, 0.85); else void ensureEngine().then(() => audioEngine.triggerTrackAttack(track.id, p, 0.85)); };
  const noteOff = (p: number) => { audioEngine.triggerTrackRelease(track.id, p); };
  const noteOffStable = useRef(noteOff); noteOffStable.current = noteOff;
  const stableOff = React.useCallback((p: number) => noteOffStable.current(p), []);

  const chooseInstrument = async (id: string) => {
    setLoadingInst(id);
    try {
      await ensureEngine();
      const m = await loadInstrumentManifest(id);
      if (audioEngine.ctx) await preloadInstrument(id, audioEngine.ctx);
      onChange(settingsForInstrument(id, m.release));
    } catch {
      notify('Cet instrument ne se charge pas (connexion ?) : réessaie dans un instant.');
    } finally { setLoadingInst(null); }
  };

  const useSound = (b: AudioBuffer, name: string) => {
    const patch = registerSamplerSound(b, name);
    onChange({ ...patch, start: 0, loop: false });
    notify(patch.rootAuto
      ? `🎛️ « ${patch.sampleName} » chargé : note racine trouvée ${noteName(patch.rootKey!)}${Math.abs(patch.fineTune || 0) >= 1 ? ` (${(patch.fineTune || 0) > 0 ? '+' : ''}${Math.round(patch.fineTune || 0)} cents corrigés)` : ''}. Joue-le au clavier.`
      : `🎛️ « ${patch.sampleName} » chargé sur C4 (pas de hauteur nette : son percussif). Règle la note racine si besoin.`);
  };

  const importFile = async (f: File) => {
    try {
      await ensureEngine();
      if (!audioEngine.ctx) return;
      const b = await audioEngine.ctx.decodeAudioData(await f.arrayBuffer());
      useSound(b, f.name);
    } catch { notify('Ce fichier ne se lit pas : essaie un WAV, MP3, AIFF ou FLAC.'); }
  };

  const startRec = async () => {
    try {
      await ensureEngine();
      if (!audioEngine.ctx) return;
      const take = await startMicSample(audioEngine.ctx as AudioContext, { deviceId: track.inputDeviceId, maxSec: 20 });
      setRec({ take, t0: Date.now() });
    } catch {
      notify('🎙️ Micro inaccessible : autorise le micro pour NOVA dans le navigateur (icône à gauche de l’adresse), puis réessaie.');
    }
  };
  const stopRec = () => {
    if (!rec) return;
    const b = rec.take.stop();
    setRec(null);
    if (!b) { notify('Rien entendu au micro : rapproche-toi ou monte le gain de ta carte son, puis réessaie.'); return; }
    useSound(b, `Micro ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
  };

  const fromClip = (ref: SessionClipRef) => {
    const src = ref.clip.bufferId ? audioBufferRegistry.get(ref.clip.bufferId) : undefined;
    if (!src || !audioEngine.ctx) return;
    const chans = clipRegionChannels(channelsOf(src), src.sampleRate, ref.clip);
    const b = audioEngine.ctx.createBuffer(chans.length, Math.max(1, chans[0].length), src.sampleRate);
    chans.forEach((c, i) => b.getChannelData(i).set(c));
    useSound(b, ref.clip.name || 'Clip');
  };

  const redetect = () => {
    if (!buffer) return;
    const r = detectRoot(channelsOf(buffer), buffer.sampleRate);
    if (!r || r.voiced < 0.35) { notify('Pas de hauteur nette dans ce son (percussion, bruit) : règle la note racine à l’oreille.'); return; }
    onChange({ rootKey: r.midi, fineTune: r.fineTune, rootAuto: true });
    notify(`Note racine : ${noteName(r.midi)}${Math.abs(r.fineTune) >= 1 ? `, accord fin ${r.fineTune > 0 ? '+' : ''}${Math.round(r.fineTune)} cents` : ''}.`);
  };

  const inst = INSTRUMENT_PRESETS.find(p => p.id === s.instrument);
  const sourceName = inst ? `${inst.emoji} ${inst.name}` : s.sampleName ? s.sampleName : 'Aucun son';
  const kbFrom = 48 + octave * 12;
  const root = inst ? 60 : s.rootKey;
  const showAll = !narrow || more;

  const instruments = (
    <Section title="Instruments NOVA" hint="Instruments multi-échantillons libres de droits (domaine public / CC0) : zones de notes et de vélocité.">
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5" data-testid="sampler-instruments">
        {INSTRUMENT_PRESETS.map(p => (
          <button key={p.id} type="button" onClick={() => void chooseInstrument(p.id)} title={p.hint} aria-pressed={s.instrument === p.id}
            data-testid={`sampler-inst-${p.id}`}
            className={`min-h-[52px] rounded-lg px-2 py-1.5 border text-left ${s.instrument === p.id ? 'bg-cyan-500/20 border-cyan-400 text-nv-ink' : 'bg-nv-raised border-nv-line text-nv-ink hover:border-cyan-400/60'}`}>
            <span className="block text-[16px] leading-none">{loadingInst === p.id ? <i className="fas fa-circle-notch fa-spin text-[13px]" /> : p.emoji}</span>
            <span className="block text-[12px] font-bold truncate mt-1">{p.name}</span>
          </button>
        ))}
      </div>
    </Section>
  );

  const ownSound = (
    <Section title="Ton son" hint="Charge un fichier, enregistre-toi au micro ou prends un clip de la session : il se joue sur tout le clavier.">
      <div className="flex flex-wrap gap-1.5">
        <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        <button type="button" onClick={() => fileRef.current?.click()} className="nova-hit min-h-[40px] px-3 rounded-lg bg-nv-raised border border-nv-line text-[12px] font-bold text-nv-ink"
          title="Choisir un fichier audio (WAV, MP3, AIFF, FLAC…)"><i className="fas fa-file-audio mr-1.5 text-cyan-500" />Fichier</button>
        {!rec ? (
          <button type="button" onClick={() => void startRec()} data-testid="sampler-rec"
            className="nova-hit min-h-[40px] px-3 rounded-lg bg-red-500/15 border border-red-400/50 text-[12px] font-bold text-red-500"
            title="Enregistrer au micro directement dans le sampler : chante une note, tape un objet…"><i className="fas fa-microphone mr-1.5" />Micro</button>
        ) : (
          <button type="button" onClick={stopRec} data-testid="sampler-rec-stop"
            className="nova-hit min-h-[40px] px-3 rounded-lg bg-red-500 text-white text-[12px] font-black animate-pulse" title="Arrêter et charger le son">
            <i className="fas fa-stop mr-1.5" />Stop · {recSec.toFixed(1)} s
          </button>
        )}
        {sessionClips.length > 0 && (
          <select value="" onChange={e => { const r = sessionClips[parseInt(e.target.value, 10)]; if (r) fromClip(r); }}
            className="min-h-[40px] max-w-[220px] rounded-lg bg-nv-raised border border-nv-line px-2 text-[12px] text-nv-ink" aria-label="Prendre le son d'un clip de la session"
            title="Prendre la partie jouée d'un clip de la session">
            <option value="">Depuis un clip…</option>
            {sessionClips.slice(0, 60).map((r, i) => <option key={r.clip.id} value={i}>{r.trackName} · {r.clip.name || 'Clip'}</option>)}
          </select>
        )}
      </div>
      {rec && (
        <div className="h-2 rounded bg-nv-bg overflow-hidden" aria-label="Niveau du micro"><div className="h-full bg-red-500 transition-[width]" style={{ width: `${Math.min(100, recLevel * 100)}%` }} /></div>
      )}
      {buffer && !s.instrument && !s.slices && (
        <>
          <Wave buffer={buffer} s={s} onSet={onChange} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-nv-muted">Note racine</span>
            <button type="button" onClick={() => onChange({ rootKey: s.rootKey - 1, rootAuto: false })} aria-label="Racine un demi-ton plus bas" className="nova-hit w-9 h-9 rounded-lg bg-nv-raised border border-nv-line text-nv-ink">−</button>
            <span className="min-w-[64px] text-center text-[14px] font-black text-nv-ink" data-testid="sampler-root"
              title="Note à laquelle le son joue sans transposition">{noteName(s.rootKey)}{s.rootAuto && <span className="ml-1 text-[10px] font-bold text-cyan-500">auto</span>}</span>
            <button type="button" onClick={() => onChange({ rootKey: s.rootKey + 1, rootAuto: false })} aria-label="Racine un demi-ton plus haut" className="nova-hit w-9 h-9 rounded-lg bg-nv-raised border border-nv-line text-nv-ink">+</button>
            <button type="button" onClick={redetect} className="nova-hit min-h-[36px] px-3 rounded-lg bg-cyan-500/15 border border-cyan-400/50 text-[12px] font-bold text-cyan-600 dark:text-cyan-200"
              title="Retrouver la note du son"><i className="fas fa-wand-magic-sparkles mr-1" />Détecter</button>
            <label className="flex items-center gap-2 text-[12px] text-nv-muted ml-auto" title="Boucle la partie entre les traits bleus pendant que la note est tenue">
              <input type="checkbox" checked={s.loop} onChange={e => onChange({ loop: e.target.checked })} className="w-5 h-5 accent-cyan-500" />Boucle
            </label>
          </div>
          {showAll && (
            <Range label="Accord fin" paramId="fineTune" dflt={0} value={s.fineTune} min={-50} max={50} step={1} fmt={v => `${v > 0 ? '+' : ''}${Math.round(v)} cents`}
              onChange={v => onChange({ fineTune: v })} title="Accord fin en cents. Rempli tout seul par la détection." />
          )}
        </>
      )}
      {s.slices && <p className="text-[12px] text-nv-muted">✂️ {s.slices.length} tranches sur les notes {noteName(s.sliceBase ?? 48)} à {noteName((s.sliceBase ?? 48) + s.slices.length - 1)}.</p>}
    </Section>
  );

  const D = DEFAULT_SAMPLER;
  const envelope = (
    <HwSection title="Enveloppe">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-1 gap-y-2" title="ADSR : comment la note démarre, tient et s'éteint.">
        <Range label="Attaque" paramId="attack" dflt={D.attack} value={Math.max(0.001, s.attack)} min={0.001} max={2} step={0} log fmt={ms} onChange={v => onChange({ attack: v })} title="Attaque : temps pour atteindre le volume (Attack)" testId="sampler-attack" />
        {showAll && <Range label="Déclin" paramId="decay" dflt={D.decay} value={s.decay} min={0.005} max={5} step={0} log fmt={ms} onChange={v => onChange({ decay: v })} title="Déclin : temps pour descendre au maintien (Decay)" />}
        {showAll && <Range label="Maintien" paramId="sustain" dflt={D.sustain} value={s.sustain} min={0} max={1} step={0.01} fmt={pct} onChange={v => onChange({ sustain: v })} title="Maintien : niveau tant que la note est tenue (Sustain)" />}
        <Range label="Relâche" paramId="release" dflt={D.release} value={s.release} min={0.005} max={5} step={0} log fmt={ms} onChange={v => onChange({ release: v })} title="Relâchement : temps d'extinction après la note (Release)" testId="sampler-release" />
      </div>
    </HwSection>
  );

  const play = (
    <HwSection title="Jeu" className="mt-2">
      <div className="flex flex-wrap items-start justify-around gap-2" title="Poly : plusieurs notes à la fois. Mono : une seule note, legato et glissé entre les notes.">
        <div className="flex gap-1.5 pt-5" role="radiogroup" aria-label="Polyphonie">
          {([[false, 'Poly'], [true, 'Mono']] as const).map(([m, label]) => (
            <PushButton key={label} role="radio" active={s.mono === m} onClick={() => onChange({ mono: m })} text={label} led="#a78bfa" dark
              dataAttrs={{ 'data-testid': `sampler-${label.toLowerCase()}` }}
              hint={m ? 'Mono : une seule note à la fois, les notes liées glissent (808 qui glisse).' : 'Poly : plusieurs notes à la fois (accords).'} />
          ))}
        </div>
        <Range label="Glissé" paramId="glide" dflt={0} value={s.glide} min={0} max={1} step={0.005} fmt={v => (v ? ms(v) : 'off')} onChange={v => onChange({ glide: v })}
          title="Glissé (portamento) entre deux notes : en mono, les notes liées glissent sans nouvelle attaque (808 qui glisse)." testId="sampler-glide" />
        {showAll && <Range label="Pitch bend" paramId="bendRange" dflt={D.bendRange} value={s.bendRange} min={0} max={24} step={1} fmt={v => `±${v} dt`} onChange={v => onChange({ bendRange: v })}
          title="Amplitude de la molette de pitch bend (demi-tons). Le pitch bend et la modulation (CC1) du piano roll sont suivis." />}
        {showAll && <Range label="Vélocité" paramId="velSens" dflt={D.velSens} value={s.velSens} min={0} max={1} step={0.01} fmt={pct} onChange={v => onChange({ velSens: v })}
          title="Sensibilité à la force de frappe (0 = toutes les notes au même niveau)." />}
      </div>
    </HwSection>
  );

  const tone = showAll ? (
    <HwSection title="Son" className="mt-2">
      <div className="grid grid-cols-3 gap-x-1" title="Filtre passe-bas et niveau de sortie.">
        <Range label="Filtre" paramId="cutoff" dflt={D.cutoff} value={s.cutoff} min={40} max={20000} step={0} log fmt={v => (v >= 19999 ? 'ouvert' : v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`)} onChange={v => onChange({ cutoff: v >= 19900 ? 20000 : v })}
          title="Coupure du filtre passe-bas (Cutoff)" />
        <Range label="Résonance" paramId="resonance" dflt={D.resonance} value={s.resonance} min={0.1} max={12} step={0.1} fmt={v => v.toFixed(1)} onChange={v => onChange({ resonance: v })} title="Résonance du filtre (Q)" />
        <Range label="Volume" paramId="gainDb" dflt={D.gainDb} value={s.gainDb} min={-24} max={12} step={0.5} fmt={v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`} onChange={v => onChange({ gainDb: v })} title="Niveau de sortie du sampler" />
      </div>
    </HwSection>
  ) : null;

  return (
    <div className="fixed inset-0 z-[300] bg-black/60 flex items-stretch sm:items-center justify-center" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label="Sampler" data-testid="sampler-panel">
      <HwHelpProvider>
      <div className="w-full sm:w-[min(980px,96vw)] h-full sm:h-auto sm:max-h-[92vh] bg-nv-panel text-nv-ink sm:rounded-2xl border border-nv-line shadow-2xl flex flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-nv-line bg-gradient-to-r from-cyan-500/10 to-amber-500/10">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-[11px] font-black uppercase tracking-widest text-cyan-600 dark:text-cyan-300 shrink-0">🎛️ Sampler</span>
            <span className="text-[13px] font-bold truncate" data-testid="sampler-source">{sourceName}</span>
            {(s.instrument || s.sampleId) && !ready && <span className="text-[11px] text-nv-muted shrink-0"><i className="fas fa-circle-notch fa-spin mr-1" />chargement…</span>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {onOpenPianoRoll && <button type="button" onClick={onOpenPianoRoll} className="nova-hit h-10 px-3 rounded-lg bg-nv-raised border border-nv-line text-[12px] font-bold" title="Écrire les notes au piano roll"><i className="fas fa-music mr-1" />{narrow ? '' : 'Piano roll'}</button>}
            <button type="button" onClick={onBackToSynth} className="nova-hit h-10 px-3 rounded-lg bg-nv-raised border border-nv-line text-[12px] font-bold text-nv-muted" title="Rejouer cette piste avec le synthé NOVA (le sampler est gardé dans l'historique : Ctrl+Z)">Synthé</button>
            <button type="button" onClick={onClose} aria-label="Fermer le sampler" title="Fermer (Échap)" className="nova-hit w-10 h-10 rounded-lg bg-nv-raised border border-nv-line"><i className="fas fa-times" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain p-3 grid grid-cols-1 md:grid-cols-2 gap-2 content-start">
          <div className="flex flex-col gap-2 min-w-0">{instruments}{ownSound}</div>
          <div className="flex flex-col gap-2 min-w-0 nova-sombre" data-nova-plugin="MELODIC_SAMPLER">
            <Faceplate finish="lilac" model="Sampler" kicker="Enveloppe · jeu · son" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: '#7c3aed' }}>
              {envelope}{play}{tone}
              {narrow && (
                <div className="flex justify-center mt-2">
                  <button type="button" onClick={() => setMore(v => !v)} className="hw-chip">
                    {more ? 'Moins de réglages' : 'Plus de réglages'}
                  </button>
                </div>
              )}
            </Faceplate>
          </div>
        </div>
        <div className="border-t border-nv-line px-3 py-2 bg-nv-well flex items-center gap-2">
          <div className="flex flex-col gap-1 shrink-0">
            <button type="button" onClick={() => setOctave(o => Math.min(3, o + 1))} aria-label="Clavier une octave plus haut" className="w-11 h-9 rounded bg-nv-raised border border-nv-line text-[11px] font-bold">+8ve</button>
            <button type="button" onClick={() => setOctave(o => Math.max(-3, o - 1))} aria-label="Clavier une octave plus bas" className="w-11 h-9 rounded bg-nv-raised border border-nv-line text-[11px] font-bold">−8ve</button>
          </div>
          <div className="flex-1 min-w-0"><Keys from={kbFrom} count={narrow ? 13 : 25} root={root} onOn={noteOn} onOff={stableOff} /></div>
        </div>
        <div className="nova-sombre shrink-0">
          <InfoBar idle={<>Sampler : choisis un instrument ou charge ton son, puis règle l'enveloppe. Glisse un bouton, double-clic = valeur d'origine.</>} />
        </div>
      </div>
      </HwHelpProvider>
    </div>
  );
};

export default SamplerPanel;
