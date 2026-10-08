import React, { useEffect, useMemo, useState } from 'react';
import { CueMix, Track, TrackType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { copyMainMix, cueLevelOf, cueProblems, defaultCueMixes, newCueMix, outputPairs, pairLabel, setCueLevel } from '../utils/cueMix';

/**
 * R15 · « Mixes casque » (cue mixes, Pro Tools : envois pré-fader vers une paire de
 * sorties). Un mix par musicien : niveau et pan de chaque piste, le clic, et la paire
 * de sorties de la carte où il part. « Écouter » : le mix sur la sortie principale
 * (carte à une seule paire, navigateur, ou pour le préparer).
 */

const dbOf = (g: number) => (g <= 0.001 ? -60 : Math.max(-60, Math.min(6, 20 * Math.log10(g))));
const gainOf = (db: number) => (db <= -59.9 ? 0 : Math.pow(10, db / 20));
const dbText = (g: number) => (g <= 0.001 ? '−∞' : `${dbOf(g) > 0 ? '+' : ''}${dbOf(g).toFixed(1)} dB`);
const panText = (p: number) => (Math.abs(p) < 0.02 ? 'C' : p < 0 ? `G ${Math.round(-p * 100)}` : `D ${Math.round(p * 100)}`);

const isSource = (t: Track) => t.id !== 'master' && (t.type === TrackType.AUDIO || t.type === TrackType.MIDI || t.type === TrackType.SAMPLER || t.type === TrackType.DRUM_RACK) && !t.isVca && !t.isInactive;

interface Props {
  tracks: Track[];
  mixes: CueMix[];
  onChange: (mixes: CueMix[]) => void;
  onClose: () => void;
  isMobile?: boolean;
}

const CueMixPanel: React.FC<Props> = ({ tracks, mixes, onChange, onClose, isMobile }) => {
  const [info, setInfo] = useState(() => audioEngine.getCueOutputInfo());
  const [listen, setListen] = useState<string | null>(() => audioEngine.getCueListen());
  const [openId, setOpenId] = useState<string | null>(mixes[0]?.id || null);
  useEffect(() => {
    const refresh = () => setInfo(audioEngine.getCueOutputInfo());
    const onListen = (e: Event) => setListen((e as CustomEvent).detail ?? null);
    window.addEventListener('nova:asio-stream', refresh);
    window.addEventListener('nova:cue-listen', onListen);
    const id = window.setInterval(refresh, 1500);
    return () => { window.removeEventListener('nova:asio-stream', refresh); window.removeEventListener('nova:cue-listen', onListen); window.clearInterval(id); };
  }, []);
  useEffect(() => { if (!openId && mixes[0]) setOpenId(mixes[0].id); }, [mixes, openId]);

  const sources = useMemo(() => tracks.filter(isSource), [tracks]);
  const problems = cueProblems(mixes, info);
  const pairs = info.bridge ? outputPairs(info.outputChannels) : 0;
  const pairChoices = Array.from({ length: Math.max(pairs, 4) - 1 }, (_, i) => i + 1);
  const upd = (id: string, f: (m: CueMix) => CueMix) => onChange(mixes.map(m => (m.id === id ? f(m) : m)));
  const toggleListen = (id: string) => { const next = listen === id ? null : id; audioEngine.setCueListen(next); setListen(next); };

  const body = (
    <div data-testid="cue-panel" role="dialog" aria-modal="true" aria-labelledby="cue-title"
      className={`${isMobile ? 'w-full h-full rounded-none' : 'w-[min(720px,calc(100vw-24px))] max-h-[88vh] rounded-3xl'} bg-nv-bg border border-white/10 shadow-2xl flex flex-col overflow-hidden`}
      onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5 bg-nv-surface shrink-0">
        <div className="w-9 h-9 rounded-xl bg-cyan-500/10 text-cyan-300 flex items-center justify-center border border-cyan-500/20"><i className="fas fa-headphones" /></div>
        <div className="min-w-0 flex-1">
          <h2 id="cue-title" className="text-sm font-black text-white uppercase tracking-[0.15em]">Mixes casque</h2>
          <p className="text-[11px] text-slate-400 truncate">Un mix par musicien, sur sa paire de sorties (envois pré-fader)</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Fermer les mixes casque" className="nova-hit w-9 h-9 rounded-full hover:bg-white/10 text-slate-400 hover:text-white"><i className="fas fa-times" /></button>
      </div>

      <div className="p-4 sm:p-5 space-y-3 overflow-y-auto">
        <p className="text-[11px] text-slate-400 leading-relaxed">
          Chaque mix a ses niveaux et son pan par piste, plus le clic. La lecture part du DAW ; la voix en direct de la piste armée est mélangée dans le pont (Nova Studio) : l'artiste s'entend sans retard.
          {info.bridge ? <> Carte : <b className="text-white">{info.outputChannels} sorties</b> ({pairs} paires).</> : null}
        </p>
        {problems.map(p => (
          <div key={p.kind} data-testid="cue-problem" role="status" className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-[12px] text-amber-100 leading-snug">
            <i className="fas fa-info-circle mr-1.5 text-amber-300" />{p.message}
          </div>
        ))}

        {!mixes.length && (
          <div className="rounded-2xl border border-dashed border-white/15 p-5 text-center space-y-3">
            <p className="text-[13px] text-white font-bold">Aucun mix casque pour l'instant</p>
            <p className="text-[11px] text-slate-400">Crée le mix de l'artiste (sorties 3-4) et celui de l'ingé (sorties 5-6), puis règle ce que chacun entend.</p>
            <button type="button" data-testid="cue-create-default" onClick={() => { const d = defaultCueMixes(); onChange(d); setOpenId(d[0].id); }}
              className="h-10 px-4 rounded-xl bg-cyan-400 text-black font-black text-[12px]">Créer « Casque artiste » et « Casque ingé »</button>
          </div>
        )}

        {mixes.map(m => {
          const open = openId === m.id;
          const routed = info.bridge && !m.muted && m.pair >= 1 && m.pair < pairs;
          return (
            <div key={m.id} data-testid={`cue-mix-${m.id}`} className={`rounded-2xl border ${open ? 'border-cyan-400/40 bg-cyan-500/[0.04]' : 'border-white/10 bg-white/[0.02]'}`}>
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button type="button" onClick={() => setOpenId(open ? null : m.id)} aria-expanded={open} aria-label={`${open ? 'Replier' : 'Déplier'} ${m.name}`}
                  className="nova-hit-tactile w-7 h-7 rounded-lg bg-white/5 text-slate-300"><i className={`fas fa-chevron-${open ? 'down' : 'right'} text-[10px]`} /></button>
                <input value={m.name} aria-label="Nom du mix casque" data-testid={`cue-name-${m.id}`} maxLength={40}
                  onChange={e => upd(m.id, x => ({ ...x, name: e.target.value }))}
                  className="min-w-0 flex-1 basis-32 h-8 rounded-lg border border-white/10 bg-black/40 px-2 text-[12px] font-bold text-white" />
                <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
                  <span className="sr-only">Sortie</span>
                  <select value={m.pair} data-testid={`cue-pair-${m.id}`} aria-label={`Sortie de ${m.name}`}
                    onChange={e => upd(m.id, x => ({ ...x, pair: parseInt(e.target.value, 10) }))}
                    className="h-8 rounded-lg border border-white/10 bg-black/40 px-2 text-[11px] text-white">
                    {pairChoices.map(p => <option key={p} value={p} disabled={info.bridge && p >= pairs}>{pairLabel(p)}{info.bridge && p >= pairs ? ' (absente)' : ''}</option>)}
                  </select>
                </label>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${routed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-slate-500'}`}>
                  {routed ? 'envoyé' : m.muted ? 'coupé' : 'pas envoyé'}
                </span>
                <button type="button" data-testid={`cue-listen-${m.id}`} aria-pressed={listen === m.id} onClick={() => toggleListen(m.id)}
                  title="Écouter ce mix sur la sortie principale (à la place du master)"
                  className={`nova-hit-tactile h-8 px-3 rounded-lg text-[11px] font-bold ${listen === m.id ? 'bg-cyan-400 text-black' : 'bg-white/5 text-slate-200 hover:bg-white/10'}`}>
                  <i className="fas fa-headphones mr-1" />{listen === m.id ? 'Écoute' : 'Écouter'}
                </button>
              </div>
              {open && (
                <div className="px-3 pb-3 space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" data-testid={`cue-copy-${m.id}`} onClick={() => upd(m.id, x => copyMainMix(x, sources))}
                      className="h-8 px-3 rounded-lg bg-white/5 text-[11px] font-bold text-slate-200 hover:bg-white/10">Copier le mix principal</button>
                    <button type="button" aria-pressed={!!m.muted} onClick={() => upd(m.id, x => ({ ...x, muted: !x.muted }))}
                      className={`h-8 px-3 rounded-lg text-[11px] font-bold ${m.muted ? 'bg-red-500/20 text-red-300' : 'bg-white/5 text-slate-200 hover:bg-white/10'}`}>{m.muted ? 'Mix coupé' : 'Couper le mix'}</button>
                    <button type="button" onClick={() => { onChange(mixes.filter(x => x.id !== m.id)); if (listen === m.id) toggleListen(m.id); }}
                      className="h-8 px-3 rounded-lg bg-white/5 text-[11px] font-bold text-slate-400 hover:text-red-300">Supprimer</button>
                  </div>
                  <Row label="Volume du mix" value={dbText(m.master ?? 1)}>
                    <input type="range" min={-60} max={6} step={0.5} value={dbOf(m.master ?? 1)} aria-label={`Volume général de ${m.name}`}
                      onChange={e => upd(m.id, x => ({ ...x, master: gainOf(parseFloat(e.target.value)) }))} className="w-full accent-cyan-400" />
                  </Row>
                  <Row label="Clic" value={dbText(m.click)}>
                    <input type="range" min={-60} max={6} step={0.5} value={dbOf(m.click)} data-testid={`cue-click-${m.id}`} aria-label={`Clic dans ${m.name}`}
                      onChange={e => upd(m.id, x => ({ ...x, click: gainOf(parseFloat(e.target.value)) }))} className="w-full accent-amber-400" />
                  </Row>
                  <div className="rounded-xl border border-white/5 divide-y divide-white/5">
                    {sources.map(t => {
                      const l = cueLevelOf(m, t);
                      const own = !!m.levels[t.id];
                      return (
                        <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                          <span className={`min-w-0 flex-1 basis-24 truncate text-[12px] font-bold ${own ? 'text-white' : 'text-slate-400'}`} title={own ? t.name : `${t.name} : suit le mix principal`}>
                            {t.name}{t.isTrackArmed ? ' · 🎤' : ''}
                          </span>
                          <input type="range" min={-60} max={6} step={0.5} value={dbOf(l.muted ? 0 : l.level)} data-testid={`cue-level-${m.id}-${t.id}`}
                            aria-label={`Niveau de ${t.name} dans ${m.name}`} aria-valuetext={dbText(l.level)}
                            onChange={e => upd(m.id, x => setCueLevel(x, t.id, { level: gainOf(parseFloat(e.target.value)), muted: false }, t))}
                            className="w-28 sm:w-36 accent-cyan-400" />
                          <span className="w-14 text-right text-[10px] font-mono text-slate-300">{l.muted ? 'coupé' : dbText(l.level)}</span>
                          <input type="range" min={-1} max={1} step={0.02} value={l.pan} data-testid={`cue-pan-${m.id}-${t.id}`}
                            aria-label={`Pan de ${t.name} dans ${m.name}`} aria-valuetext={panText(l.pan)}
                            onChange={e => upd(m.id, x => setCueLevel(x, t.id, { pan: parseFloat(e.target.value) }, t))}
                            onDoubleClick={() => upd(m.id, x => setCueLevel(x, t.id, { pan: 0 }, t))}
                            className="w-16 sm:w-20 accent-slate-300" />
                          <span className="w-9 text-[10px] font-mono text-slate-400">{panText(l.pan)}</span>
                          <button type="button" aria-pressed={!!l.muted} aria-label={`${l.muted ? 'Rétablir' : 'Couper'} ${t.name} dans ${m.name}`}
                            onClick={() => upd(m.id, x => setCueLevel(x, t.id, { muted: !l.muted }, t))}
                            className={`nova-hit-tactile w-7 h-7 rounded-md text-[11px] font-bold ${l.muted ? 'bg-amber-500 text-black' : 'bg-white/5 text-slate-400'}`}>M</button>
                        </div>
                      );
                    })}
                    {!sources.length && <p className="p-3 text-[11px] text-slate-500">Aucune piste à mettre dans le casque.</p>}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {mixes.length > 0 && (
          <button type="button" data-testid="cue-add" onClick={() => { const n = newCueMix(mixes, '', Math.max(pairs, 8)); onChange([...mixes, n]); setOpenId(n.id); }}
            className="w-full h-10 rounded-xl border border-dashed border-white/15 text-[12px] font-bold text-slate-300 hover:bg-white/5">+ Ajouter un mix casque</button>
        )}
      </div>
    </div>
  );

  return (
    <div className={`fixed inset-0 z-[710] bg-black/70 flex ${isMobile ? '' : 'items-center justify-center p-3'}`} onClick={onClose}>
      {body}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string; children: React.ReactNode }> = ({ label, value, children }) => (
  <label className="flex items-center gap-3 text-[11px] text-slate-300">
    <span className="w-28 shrink-0">{label}</span>
    <span className="flex-1 min-w-0">{children}</span>
    <span className="w-16 text-right font-mono text-[10px] text-slate-400">{value}</span>
  </label>
);

export default CueMixPanel;
