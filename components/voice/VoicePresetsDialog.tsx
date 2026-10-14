/**
 * Lot 8a + 8b : bibliothèque des presets voix (par rôle et par style) et « Décris ton son ».
 * Ouvert depuis le One Knob d'une piste voix (tranche de la console, téléphone).
 * Poser un preset ou une description = UNE modification de la piste (un Ctrl+Z).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TrackType, type Track } from '../../types';
import {
  VOICE_PRESETS, ROLE_NAMES, STYLE_NAMES, applyVoicePreset, describeVoicePreset, findVoicePreset, roleFromTrackName,
  type VoicePreset, type VoicePresetRole, type VoicePresetStyle,
} from '../../utils/voicePresets';
import { VOICE_PRESET_SOURCES } from '../../utils/voicePresetSources';
import { applyDescribedSound, describeSound, type DescribedSound } from '../../utils/describeSound';
import { trackInputLufs } from '../../utils/voiceTrackLevel';

interface Props {
  track: Track;
  allTracks: Track[];
  projectKey?: number | null;
  projectScale?: string | null;
  /** Ouvrir directement sur « Décris ton son ». */
  describeFirst?: boolean;
  onApply: (t: Track, message: string) => void;
  onClose: () => void;
}

const ROLES: VoicePresetRole[] = ['lead', 'back', 'double', 'adlib', 'harmony', 'bus'];
const EXAMPLES = ['voix plus brillante et plus en avant avec un peu d’écho', 'plus chaude et plus ronde', 'trap, très compressée', 'ad-libs au téléphone', 'R&B doux avec beaucoup de réverbe', 'drill sèche et agressive'];

const sourcesText = (p: VoicePreset) => p.sources.map(s => {
  const src = VOICE_PRESET_SOURCES[s];
  return src ? `${s} — ${src.title} (${src.by}${src.date ? `, ${src.date}` : ''})` : s;
}).join('\n');

/** Site ou ingé d'une source, court (« Sound On Sound », « Antares », « Rys Up Audio »). */
const siteOf = (by: string) => { const last = by.split(',').pop()!.trim(); return last === 'SOS' ? 'Sound On Sound' : last; };
const sourcesShort = (p: VoicePreset) => p.sources.filter(s => /^S/.test(s)).map(s => VOICE_PRESET_SOURCES[s] && siteOf(VOICE_PRESET_SOURCES[s].by)).filter(Boolean)
  .filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(' · ');

const fmtDb = (v: number) => `${v > 0 ? '+' : ''}${String(Math.round(v * 10) / 10).replace('.', ',')} dB`;

const VoicePresetsDialog: React.FC<Props> = ({ track, allTracks, projectKey, projectScale, describeFirst, onApply, onClose }) => {
  const current = findVoicePreset(track.voiceChain?.presetId);
  const [role, setRole] = useState<VoicePresetRole>(current?.role || roleFromTrackName(track.name));
  const [style, setStyle] = useState<VoicePresetStyle | null>(null);
  const [text, setText] = useState('');
  const [proposal, setProposal] = useState<DescribedSound | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;

  useEffect(() => { if (describeFirst) inputRef.current?.focus(); }, [describeFirst]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const styles = useMemo(() => Array.from(new Set(VOICE_PRESETS.filter(p => p.role === role).map(p => p.style))), [role]);
  const list = useMemo(() => VOICE_PRESETS.filter(p => p.role === role && (!style || p.style === style)), [role, style]);
  const ctx = { allTracks, projectKey, projectScale };

  const measure = async () => {
    setStatus({ kind: 'info', text: '🎚️ J’écoute ta prise pour caler le niveau…' });
    return trackInputLufs(track.id);
  };

  const trimNote = (lufs: number | null, trimDb: number) => lufs === null
    ? 'aucune prise sur la piste : trim laissé tel quel, il se calera quand tu reposeras le preset après la prise'
    : `trim ${fmtDb(trimDb)} (ta prise : ${String(lufs).replace('.', ',')} LUFS)`;

  /** Bus où sort la piste (les presets « Bus voix » s'y posent, jamais sur une piste : règle maison). */
  const outBus = allTracks.find(t => t.id === track.outputTrackId && t.type === TrackType.BUS && t.id !== 'master');

  const applyPreset = async (p: VoicePreset) => {
    if (p.role === 'bus') {
      if (!outBus) { setStatus({ kind: 'error', text: 'Les presets « Bus voix » se posent sur un bus : envoie d’abord tes voix dans un bus (Sortie de la tranche).' }); return; }
      const r = applyVoicePreset(outBus, p, { ...ctx, keepFader: true });
      const msg = `✅ « ${p.name} » posé sur le bus ${outBus.name} (FET 76 : 5 dB max${p.bus?.leveler ? ', Leveler 2A : 2 dB max' : ''}) · Ctrl+Z pour revenir`;
      onApply(r.track, msg);
      setStatus({ kind: 'ok', text: msg });
      return;
    }
    setBusy(true);
    try {
      const lufs = await measure();
      const r = applyVoicePreset(track, p, { ...ctx, inputLufs: lufs });
      const msg = `✅ « ${p.name} » posé sur ${track.name} — ${trimNote(lufs, r.trimDb)}${r.notes.length ? ` · ${r.notes.join(' · ')}` : ''} · Ctrl+Z pour revenir`;
      onApply(r.track, msg);
      setStatus({ kind: 'ok', text: msg });
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Impossible de poser le preset : ${e?.message || e}` });
    } finally { setBusy(false); }
  };

  const propose = (value = text) => {
    const v = value.trim();
    if (!v) { setStatus({ kind: 'info', text: 'Écris ce que tu veux entendre, par exemple « plus brillante avec un peu d’écho ».' }); return; }
    const d = describeSound(v, { role: current?.role || roleFromTrackName(track.name), currentPresetId: current?.id || null });
    setProposal(d);
    setStatus(d.matched.length ? null : { kind: 'info', text: 'Je n’ai reconnu aucun mot de son. Essaie : brillante, chaude, en avant, compressée, écho, réverbe, large, saturée, autotune, trap, R&B…' });
  };

  const applyProposal = async () => {
    if (!proposal || !proposal.matched.length) return;
    setBusy(true);
    try {
      const lufs = proposal.presetId ? await measure() : null;
      const r = applyDescribedSound(track, proposal, { ...ctx, inputLufs: proposal.presetId ? lufs : undefined });
      const msg = `✨ ${track.name} : ${proposal.summary}${r.notes.length ? ` · ${r.notes.join(' · ')}` : ''} · Ctrl+Z pour revenir`;
      onApply(r.track, msg);
      setStatus({ kind: 'ok', text: msg });
    } finally { setBusy(false); }
  };

  const chip = (on: boolean) => `min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] rounded-full border px-3 text-[12px] font-bold transition-colors ${on ? 'border-cyan-400 bg-cyan-500 text-black' : 'border-nv-line text-nv-ink hover:bg-nv-accent/10'}`;
  const btn = 'min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] px-3 rounded-lg text-[12px] font-bold transition-colors disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-[720] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Presets voix" data-testid="voice-presets-dialog" onClick={e => e.stopPropagation()}
        className="flex max-h-[92vh] w-full sm:max-w-2xl flex-col rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-nv-line p-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-black">Presets voix <span className="font-semibold text-nv-muted">· {track.name}</span></h2>
            <p className="text-[11px] text-nv-muted">
              {current ? <>Chaîne actuelle : <b className="text-nv-ink">{current.name}</b>. </> : null}
              Chaînes faites avec les effets NOVA, d’après des recettes d’ingés, calées sur ta prise (niveau et 5 dB de compression max, la règle du studio).
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10 hover:text-nv-ink"><i className="fas fa-times" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {/* Décris ton son */}
          <section aria-labelledby="describe-title" className="rounded-xl border border-nv-line bg-nv-surface p-3">
            <h3 id="describe-title" className="mb-1 text-[13px] font-black"><i className="fas fa-pen-nib mr-1.5 text-cyan-500" aria-hidden="true" />Décris ton son</h3>
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); propose(); }}>
              <input ref={inputRef} value={text} onChange={e => { setText(e.target.value); setProposal(null); }} data-testid="voice-describe-input" maxLength={160}
                placeholder="ex. voix plus brillante et plus en avant avec un peu d’écho" aria-label="Décris le son que tu veux"
                className="min-w-0 flex-1 rounded-lg border border-nv-line bg-nv-well px-3 py-2 text-[13px] outline-none focus:border-nv-accent" />
              <button type="submit" data-testid="voice-describe-propose" className={`${btn} bg-cyan-500 text-black hover:bg-cyan-400`}>Proposer</button>
            </form>
            {!proposal && (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Exemples">
                {EXAMPLES.slice(0, narrow ? 3 : 6).map(x => (
                  <button key={x} type="button" onClick={() => { setText(x); propose(x); }} className="rounded-full bg-nv-well px-2.5 py-1 text-[11px] text-nv-muted hover:text-nv-ink">{x}</button>
                ))}
              </div>
            )}
            {proposal && proposal.matched.length > 0 && (
              <div data-testid="voice-describe-result" className="mt-2 space-y-2">
                <p className="text-[12px] font-bold">{proposal.summary}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {proposal.matched.map((m, i) => (
                    <li key={i} className="rounded-full bg-cyan-500/10 px-2.5 py-1 text-[11px]"><b>{m.word}</b> → {m.meaning}{m.amount !== undefined && !m.negated ? ` (${Math.round(m.amount * 100)} %)` : ''}</li>
                  ))}
                </ul>
                {proposal.ignored.length > 0 && <p className="text-[11px] text-nv-muted">Pas compris (ignoré) : {proposal.ignored.join(', ')}</p>}
                <button type="button" disabled={busy} onClick={() => void applyProposal()} data-testid="voice-describe-apply" className={`${btn} bg-cyan-500 text-black hover:bg-cyan-400`}>
                  <i className="fas fa-wand-magic-sparkles mr-1" aria-hidden="true" />Appliquer à {track.name}
                </button>
              </div>
            )}
          </section>

          {status && (
            <p role={status.kind === 'error' ? 'alert' : 'status'} data-testid="voice-presets-status"
              className={`rounded-lg px-3 py-2 text-[12px] ${status.kind === 'error' ? 'bg-red-500/10 text-red-400' : status.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-nv-accent/10'}`}>{status.text}</p>
          )}

          {/* Filtres */}
          <div role="radiogroup" aria-label="Rôle de la voix" className="flex flex-wrap gap-1.5">
            {ROLES.map(r => (
              <button key={r} type="button" role="radio" aria-checked={role === r} data-testid={`voice-role-${r}`} onClick={() => { setRole(r); setStyle(null); }} className={chip(role === r)}>{ROLE_NAMES[r]}</button>
            ))}
          </div>
          {styles.length > 1 && narrow && (
            <label className="flex items-center gap-2 text-[12px] font-bold">
              Style
              <select value={style || ''} onChange={e => setStyle((e.target.value || null) as VoicePresetStyle | null)} data-testid="voice-style-select"
                className="min-h-[44px] flex-1 rounded-lg border border-nv-line bg-nv-well px-3 text-[13px] text-nv-ink">
                <option value="">Tous les styles ({VOICE_PRESETS.filter(p => p.role === role).length})</option>
                {styles.map(s2 => <option key={s2} value={s2}>{STYLE_NAMES[s2]}</option>)}
              </select>
            </label>
          )}
          {styles.length > 1 && !narrow && (
            <div role="radiogroup" aria-label="Style" className="flex flex-wrap gap-1.5">
              <button type="button" role="radio" aria-checked={!style} onClick={() => setStyle(null)} className={chip(!style)}>Tous</button>
              {styles.map(s => (
                <button key={s} type="button" role="radio" aria-checked={style === s} data-testid={`voice-style-${s}`} onClick={() => setStyle(s)} className={chip(style === s)}>{STYLE_NAMES[s]}</button>
              ))}
            </div>
          )}

          <ul className="grid gap-2 sm:grid-cols-2" data-testid="voice-preset-list">
            {list.map(p => {
              const on = current?.id === p.id;
              return (
                <li key={p.id} data-testid="voice-preset-card" data-preset-id={p.id}
                  className={`flex flex-col rounded-xl border p-3 ${on ? 'border-cyan-400 bg-cyan-500/5' : 'border-nv-line bg-nv-surface'}`}>
                  <p className="flex items-center gap-2 text-[13px] font-bold">
                    <span className="truncate">{p.name}</span>
                    {on && <span className="shrink-0 rounded bg-cyan-500/15 px-1.5 text-[9px] font-black uppercase text-cyan-500">Posé</span>}
                  </p>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-nv-muted">{STYLE_NAMES[p.style]} · {ROLE_NAMES[p.role]}</p>
                  <p className="mt-1 text-[12px]">{p.description}</p>
                  <p className="mt-1 text-[11px] text-nv-muted">{describeVoicePreset(p)}</p>
                  <p className="mt-1 text-[10px] text-nv-muted" title={sourcesText(p)}><i className="fas fa-book-open mr-1" aria-hidden="true" />Recettes : {sourcesShort(p) || 'règles du studio'}{p.sources.includes('M') ? ' · règles Make Music' : ''}</p>
                  <div className="mt-2 flex-1" />
                  {p.role === 'bus' ? (
                    <button type="button" disabled={busy || !outBus} onClick={() => void applyPreset(p)} data-testid="voice-preset-apply"
                      title={outBus ? `Remplace la chaîne du bus « ${outBus.name} » (un seul Ctrl+Z pour revenir)` : 'Envoie d’abord tes voix dans un bus (Sortie de la tranche) : ces presets ne se posent jamais sur une piste.'}
                      className={`${btn} ${outBus ? 'bg-cyan-500 text-black hover:bg-cyan-400' : 'border border-nv-line text-nv-muted'}`}>
                      {outBus ? `Poser sur le bus ${outBus.name}` : 'Pour un bus voix : sortie de la piste vers un bus'}
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => void applyPreset(p)} data-testid="voice-preset-apply"
                      title={`Remplace la chaîne de « ${track.name} » (un seul Ctrl+Z pour revenir)`}
                      className={`${btn} ${on ? 'border border-cyan-400 text-cyan-500' : 'bg-cyan-500 text-black hover:bg-cyan-400'}`}>
                      {on ? 'Reposer (recaler sur ma prise)' : `Poser sur ${track.name}`}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default VoicePresetsDialog;
