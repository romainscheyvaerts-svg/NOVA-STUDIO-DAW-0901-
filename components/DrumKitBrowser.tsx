import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DrumMachine } from '../utils/drumKits';
import {
  KIT_DRAG_TYPE, KIT_ERROR_TEXT, KIT_PAD_LAYOUT, KitDef, KitIndex, KitSound, KitSoundError, PITCH_CLASS_FR, kitFavorites, kitRef,
  loadKitIndex, loadKitSound, midiNoteName, searchKitSounds, toggleKitFavorite, tuneToRoot,
} from '../utils/drumKitLibrary';
import { audioEngine } from '../engine/AudioEngine';

/**
 * Navigateur des kits NOVA (dans la boîte à rythmes) : kits prêts à jouer par style, ~2 000 sons
 * rangés par catégorie, recherche, favoris, écoute au clic (ou au survol), motif d'écoute calé au
 * tempo du morceau, 808 réaccordées sur la tonique. Les sons se posent sur un pad (bouton, ou
 * glisser sur un pad / une piste) : ils restent DANS le DAW, aucun téléchargement de son brut.
 */

export interface DrumKitBrowserProps {
  dm: DrumMachine | null;
  /** Pad visé par « Poser » (pad choisi dans la grille), null = nouveau pad. */
  targetPad: number | null;
  onTargetPad: (ri: number | null) => void;
  bpm: number;
  projectKey?: number | null;
  onApplyKit: (kit: KitDef, ix: KitIndex) => void;
  onPickSound: (id: string, rowIndex: number | null, ix: KitIndex) => void;
  onClose: () => void;
  ensureEngine?: () => Promise<unknown>;
  notify?: (msg: string) => void;
  narrow: boolean;
}

type Tab = 'kits' | 'sons' | 'favoris';
const PAGE = 60;
const fmtDur = (d: number) => `${d < 1 ? d.toFixed(2).replace('.', ',') : d.toFixed(1).replace('.', ',')} s`;

const DrumKitBrowser: React.FC<DrumKitBrowserProps> = p => {
  const [ix, setIx] = useState<KitIndex | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [tab, setTab] = useState<Tab>('kits');
  const [style, setStyle] = useState('');
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [favs, setFavs] = useState<Set<string>>(() => kitFavorites());
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const playTimer = useRef<number | null>(null);
  const fine = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;
  const root = typeof p.projectKey === 'number' ? p.projectKey : null;
  const h = p.narrow ? 'h-11' : 'h-9';

  const retry = () => { setLoadErr(false); loadKitIndex().then(setIx).catch(() => setLoadErr(true)); };
  useEffect(() => { let alive = true; loadKitIndex().then(x => { if (alive) setIx(x); }).catch(() => { if (alive) setLoadErr(true); }); return () => { alive = false; }; }, []);
  useEffect(() => () => {
    audioEngine.stopAudition();
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (playTimer.current) window.clearTimeout(playTimer.current);
  }, []);
  useEffect(() => { setShown(PAGE); }, [tab, cat, text, style]);

  const results = useMemo(() => (ix ? searchKitSounds(ix, { text, cat: cat || undefined, favs: tab === 'favoris' ? favs : null }) : []), [ix, text, cat, tab, favs]);
  const kits = useMemo(() => (ix ? ix.kits.filter(k => !style || k.style === style) : []), [ix, style]);
  const kitStyles = useMemo(() => (ix ? [...new Set(ix.kits.map(k => k.style).filter(Boolean))] : []), [ix]);

  const fail = (id: string, e: unknown) => {
    const msg = e instanceof KitSoundError ? e.message : KIT_ERROR_TEXT.format;
    setFailed(f => ({ ...f, [id]: e instanceof KitSoundError && e.code === 'offline' ? 'Hors ligne' : 'Indisponible' }));
    p.notify?.(msg);
  };

  const ctx = async () => {
    // Moteur lancé : pas d'attente (l'écoute d'un son au survol ou au clic partait ~29 ms plus tard).
    if (audioEngine.ctx && audioEngine.ctx.state === 'running') return audioEngine.ctx;
    await p.ensureEngine?.();
    if (!audioEngine.ctx) throw new KitSoundError('decode', KIT_ERROR_TEXT.decode);
    if (audioEngine.ctx.state !== 'running') await audioEngine.ctx.resume().catch(() => {});
    return audioEngine.ctx;
  };

  const stopAll = () => { audioEngine.stopAudition(); setPlaying(null); if (playTimer.current) window.clearTimeout(playTimer.current); };

  /** Écoute d'un son (re-clic = stop). */
  const audition = async (s: KitSound, toggle = true) => {
    if (toggle && playing === s.id) { stopAll(); return; }
    setLoading(s.id);
    try {
      const c = await ctx();
      const buf = await loadKitSound(kitRef(s.id), c, root ?? 0);
      audioEngine.auditionBuffers([{ buffer: buf, at: 0 }]);
      setPlaying(s.id);
      setFailed(f => { if (!f[s.id]) return f; const n = { ...f }; delete n[s.id]; return n; });
      if (playTimer.current) window.clearTimeout(playTimer.current);
      playTimer.current = window.setTimeout(() => setPlaying(cur => (cur === s.id ? null : cur)), Math.min(6000, buf.duration * 1000 + 80));
    } catch (e) { fail(s.id, e); } finally { setLoading(null); }
  };

  /** Écoute d'un kit : une mesure calée au tempo du morceau (kick, snare / clap, hi-hats, 808). */
  const auditionKit = async (k: KitDef) => {
    const id = `kit:${k.id}`;
    if (playing === id) { stopAll(); return; }
    setLoading(id);
    try {
      const c = await ctx();
      const step = 60 / Math.max(40, Math.min(220, p.bpm || 120)) / 4;
      const want: [keyof KitDef['pads'], number[], number][] = [
        ['kick', [0, 7, 10], 1], ['snare', [4, 12], 0.9], ['clap', [12], 0.6], ['hihat', [0, 2, 4, 6, 8, 10, 12], 0.55],
        ['openhat', [14], 0.5], ['808', [0, 10], 0.85],
      ];
      const hits: { buffer: AudioBuffer; at: number; gain: number }[] = [];
      // Les sons du kit se chargent EN MÊME TEMPS (avant : l'un après l'autre, 6 allers-retours réseau).
      const roles = want.filter(([role]) => !!k.pads[role]);
      const bufs = await Promise.all(roles.map(([role]) => loadKitSound(kitRef(k.pads[role]!), c, root ?? 0)));
      roles.forEach(([, steps, gain], i) => steps.forEach(si => hits.push({ buffer: bufs[i], at: si * step, gain })));
      audioEngine.auditionBuffers(hits);
      setPlaying(id);
      if (playTimer.current) window.clearTimeout(playTimer.current);
      playTimer.current = window.setTimeout(() => setPlaying(cur => (cur === id ? null : cur)), 16 * step * 1000 + 300);
    } catch (e) { fail(id, e); } finally { setLoading(null); }
  };

  const onHover = (s: KitSound) => {
    if (!hover || !fine) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => { void audition(s, false); }, 140);
  };
  const onLeave = () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); };

  const pick = (s: KitSound) => { if (ix) p.onPickSound(s.id, p.targetPad, ix); };
  const fav = (id: string) => setFavs(new Set(toggleKitFavorite(id)));

  const noteInfo = (s: KitSound) => {
    if (!s.midi) return null;
    const t = root === null ? 0 : tuneToRoot(s.midi, root);
    return root === null ? midiNoteName(s.midi) : `${midiNoteName(s.midi)}${t ? ` → ${PITCH_CLASS_FR[root % 12]}` : ' (déjà dans le ton)'}`;
  };

  const targetName = p.targetPad !== null && p.dm?.rows[p.targetPad] ? p.dm.rows[p.targetPad].name : null;
  const chip = (on: boolean) => `nova-hit-tactile shrink-0 ${h} px-3 rounded-xl text-[12px] font-bold whitespace-nowrap ${on ? 'bg-cyan-500/15 text-white ring-1 ring-cyan-400/70' : 'bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-white'}`;

  const soundRow = (s: KitSound) => {
    const isPlaying = playing === s.id, isLoading = loading === s.id, isFav = favs.has(s.id), bad = failed[s.id];
    const note = noteInfo(s);
    return (
      <li key={s.id} data-testid="kit-sound" data-kit-id={s.id}
        draggable={!p.narrow}
        onDragStart={e => { e.dataTransfer.setData(KIT_DRAG_TYPE, s.id); e.dataTransfer.setData('text/plain', s.name); e.dataTransfer.effectAllowed = 'copy'; }}
        onMouseEnter={() => onHover(s)} onMouseLeave={onLeave}
        className={`flex items-center gap-2 rounded-xl px-1.5 py-1 ${isPlaying ? 'bg-cyan-500/10 ring-1 ring-cyan-400/40' : 'hover:bg-white/[0.04]'}`}>
        <button type="button" onClick={() => void audition(s)} aria-label={`${isPlaying ? 'Arrêter' : 'Écouter'} ${s.name}`} data-testid="kit-sound-play"
          className={`shrink-0 w-11 ${p.narrow ? 'h-11' : 'h-10'} rounded-xl flex items-center justify-center ${isPlaying ? 'bg-cyan-500 text-black' : 'bg-white/[0.06] text-slate-200 hover:bg-white/10'}`}>
          <i className={`fas ${isLoading ? 'fa-circle-notch fa-spin' : isPlaying ? 'fa-stop' : 'fa-play'} text-[12px]`} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-white truncate">{s.name}</div>
          <div className="text-[11px] text-slate-400 truncate">
            {fmtDur(s.dur)}{note ? ` · ${note}` : ''}{bad ? <span className="ml-1.5 text-amber-300 font-bold">· {bad}</span> : null}
          </div>
        </div>
        <button type="button" onClick={() => fav(s.id)} aria-pressed={isFav} aria-label={isFav ? `Retirer ${s.name} des favoris` : `Ajouter ${s.name} aux favoris`}
          className={`shrink-0 w-11 ${p.narrow ? 'h-11' : 'h-10'} rounded-xl ${isFav ? 'text-amber-300' : 'text-slate-500 hover:text-amber-200'}`}>
          <i className={`${isFav ? 'fas' : 'far'} fa-star`} aria-hidden />
        </button>
        <button type="button" onClick={() => pick(s)} data-testid="kit-sound-pick"
          title={targetName ? `Remplacer le son du pad « ${targetName} »` : 'Ajouter sur un nouveau pad'}
          className={`shrink-0 ${p.narrow ? 'h-11' : 'h-10'} px-3 rounded-xl text-[12px] font-black bg-cyan-500 text-black hover:bg-cyan-400`}>
          Poser
        </button>
      </li>
    );
  };

  return (
    <section aria-labelledby="kits-title" data-testid="kit-browser" className="rounded-2xl border border-cyan-400/25 bg-white/[0.03] p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <div className="mr-auto min-w-0">
          <h3 id="kits-title" className="text-[14px] font-black text-white">Kits NOVA</h3>
          <p className="text-[11px] text-slate-400 truncate">
            {ix ? `${ix.sounds.length.toLocaleString('fr-FR')} sons · ${ix.kits.length} kits · écoute, puis pose sur un pad` : 'Sons de batterie prêts à jouer'}
          </p>
        </div>
        <button type="button" onClick={p.onClose} aria-label="Fermer les kits" className={`shrink-0 w-11 ${h} rounded-xl bg-white/[0.06] text-slate-300 hover:text-white`}>
          <i className="fas fa-times" aria-hidden />
        </button>
      </div>

      <div role="tablist" aria-label="Kits, sons ou favoris" className="flex gap-1.5">
        {([['kits', 'Kits'], ['sons', 'Sons'], ['favoris', `Favoris${favs.size ? ` (${favs.size})` : ''}`]] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`kit-tab-${t}`} className={chip(tab === t)}>{label}</button>
        ))}
      </div>

      {!ix && !loadErr && <p className="text-[12px] text-slate-400 py-6 text-center" role="status"><i className="fas fa-circle-notch fa-spin mr-2" aria-hidden />Chargement de la bibliothèque…</p>}
      {loadErr && (
        <div className="text-[12px] text-amber-200 py-4 text-center space-y-2" role="alert">
          <p>La bibliothèque de kits ne s'est pas chargée. Vérifie ta connexion, puis réessaie.</p>
          <button type="button" onClick={retry} className={`${h} px-4 rounded-xl bg-white/[0.08] text-white font-bold`}>Réessayer</button>
        </div>
      )}

      {ix && tab === 'kits' && (
        <>
          <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Style">
            <button type="button" onClick={() => setStyle('')} aria-pressed={!style} className={chip(!style)}>Tous</button>
            {kitStyles.map(st => <button key={st} type="button" onClick={() => setStyle(st)} aria-pressed={style === st} className={chip(style === st)}>{ix.styles[st] || st}</button>)}
            <button type="button" onClick={() => setStyle('-')} aria-pressed={style === '-'} className={chip(style === '-')}>Polyvalents</button>
          </div>
          <ul className={`grid gap-2 ${p.narrow ? 'grid-cols-1' : 'grid-cols-2 lg:grid-cols-3'} max-h-[340px] overflow-y-auto pr-1`} data-testid="kit-list">
            {(style === '-' ? ix.kits.filter(k => !k.style) : kits).map(k => {
              const loaded = p.dm?.kitId === `nova:${k.id}`;
              const pid = `kit:${k.id}`;
              const summary = (['kick', 'snare', '808', 'hihat'] as const).map(r => k.pads[r] && ix.byId.get(k.pads[r]!)?.name).filter(Boolean).join(' · ');
              return (
                <li key={k.id} data-testid="kit-card" data-kit={k.id} className={`rounded-xl p-2.5 space-y-2 ${loaded ? 'bg-cyan-500/10 ring-1 ring-cyan-400/60' : 'bg-white/[0.04]'}`}>
                  <div className="min-w-0">
                    <div className="text-[13px] font-black text-white truncate">{k.name}{loaded && <span className="ml-1.5 text-[11px] text-cyan-300 font-bold">· chargé</span>}</div>
                    <div className="text-[11px] text-slate-400 truncate">{KIT_PAD_LAYOUT.filter(sl => k.pads[sl.role]).length} pads · {summary}</div>
                  </div>
                  <div className="flex gap-1.5">
                    <button type="button" onClick={() => void auditionKit(k)} aria-label={`${playing === pid ? 'Arrêter' : 'Écouter'} le kit ${k.name}`} data-testid="kit-play"
                      className={`flex-1 ${h} rounded-xl text-[12px] font-bold ${playing === pid ? 'bg-cyan-500 text-black' : 'bg-white/[0.06] text-slate-200 hover:bg-white/10'}`}>
                      <i className={`fas ${loading === pid ? 'fa-circle-notch fa-spin' : playing === pid ? 'fa-stop' : 'fa-play'} mr-1.5`} aria-hidden />{playing === pid ? 'Stop' : `Écouter (${Math.round(p.bpm || 120)} BPM)`}
                    </button>
                    <button type="button" onClick={() => { stopAll(); p.onApplyKit(k, ix); }} data-testid="kit-load"
                      className={`flex-1 ${h} rounded-xl text-[12px] font-black bg-cyan-500 text-black hover:bg-cyan-400`}>
                      Charger ce kit
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {ix && tab !== 'kits' && (
        <>
          {tab === 'sons' && (
            <>
              <label className="block">
                <span className="sr-only">Rechercher un son</span>
                <input type="search" value={text} onChange={e => setText(e.target.value)} placeholder="Rechercher : kick, 808 fa, conga, trap…" data-testid="kit-search"
                  className={`w-full ${h} px-3 rounded-xl bg-white/[0.06] border border-white/10 text-[13px] text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/60`} />
              </label>
              <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Catégorie">
                <button type="button" onClick={() => setCat('')} aria-pressed={!cat} className={chip(!cat)}>Tout</button>
                {ix.categories.map(c => (
                  <button key={c.id} type="button" onClick={() => setCat(c.id)} aria-pressed={cat === c.id} data-testid={`kit-cat-${c.id}`} className={chip(cat === c.id)}>
                    {c.label} <span className="text-slate-500 font-normal">{c.count}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <label className="flex items-center gap-1.5 text-slate-300">
              <span>Poser sur</span>
              <select value={p.targetPad === null ? '' : String(p.targetPad)} onChange={e => p.onTargetPad(e.target.value === '' ? null : Number(e.target.value))} data-testid="kit-target"
                className={`${h} max-w-[12rem] px-2 rounded-xl bg-white/[0.06] border border-white/10 text-white`}>
                <option value="">un nouveau pad</option>
                {(p.dm?.rows || []).map((r, i) => <option key={r.id} value={i}>le pad « {r.name} »</option>)}
              </select>
            </label>
            {fine && !p.narrow && (
              <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
                <input type="checkbox" checked={hover} onChange={e => setHover(e.target.checked)} className="accent-cyan-400" /> Écoute au survol
              </label>
            )}
            {root !== null && <span className="text-slate-400">808 et basses accordées en {PITCH_CLASS_FR[root % 12]}</span>}
            {!p.narrow && <span className="text-slate-500">Astuce : glisse un son sur un pad ou une piste.</span>}
          </div>
          {results.length === 0 ? (
            <p className="text-[12px] text-slate-400 py-6 text-center" data-testid="kit-empty">
              {tab === 'favoris' && !favs.size
                ? 'Aucun favori pour l’instant. Touche ★ à côté d’un son pour le retrouver ici.'
                : 'Aucun son ne correspond. Essaie un autre mot (kick, snare, 808, perc…) ou une autre catégorie.'}
            </p>
          ) : (
            <>
              <p className="text-[11px] text-slate-500" aria-live="polite">{results.length.toLocaleString('fr-FR')} son{results.length > 1 ? 's' : ''}</p>
              <ul className="space-y-0.5 max-h-[340px] overflow-y-auto pr-1" data-testid="kit-sound-list">
                {results.slice(0, shown).map(soundRow)}
              </ul>
              {results.length > shown && (
                <button type="button" onClick={() => setShown(n => n + PAGE)} className={`w-full ${h} rounded-xl bg-white/[0.05] text-[12px] font-bold text-slate-200 hover:bg-white/10`}>
                  Afficher {Math.min(PAGE, results.length - shown)} sons de plus
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
};

export default DrumKitBrowser;
