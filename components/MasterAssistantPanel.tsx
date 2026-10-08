import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PluginInstance, Track } from '../types';
import { PLATFORM_TARGETS, CHARACTERS, MasterCharacter, eqMoveLabel, fmtDb } from '../utils/masterAssistant';
import { runMasterNova, measureCurrentMix, isMasterNovaPlugin, MASTER_ID, MasterNovaResult } from '../services/masterNova';
import { referencePlayer } from '../services/referenceTrack';
import { truePeakOf } from '../utils/audioMeasure';

/**
 * Fenêtre « Master Nova » (V15) : mastering en un clic avec cible par
 * plateforme, rapport avant / après, A/B à niveau égal et morceau de
 * référence. Comme le Mastering Assistant de Logic Pro.
 */
interface Props {
  tracks: Track[];
  isPlaying: boolean;
  onTogglePlay: () => void;
  /** Insère la chaîne en fin de master (une seule étape d'annulation). */
  onApply: (plugins: PluginInstance[]) => void;
  /** Retire la chaîne Master Nova (annulable). */
  onRemove: () => void;
  /** A/B : contourne la chaîne sans créer d'étape d'annulation. */
  onSetBypass: (bypassed: boolean) => void;
  onClose: () => void;
}

const PREF_KEY = 'nova.masternova.prefs';
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } };

const MasterAssistantPanel: React.FC<Props> = ({ tracks, isPlaying, onTogglePlay, onApply, onRemove, onSetBypass, onClose }) => {
  const saved = useMemo(readPrefs, []);
  const [targetId, setTargetId] = useState<string>(saved.target || 'spotify');
  const [character, setCharacter] = useState<MasterCharacter>(saved.character || 'propre');
  const [eqAmount, setEqAmount] = useState<number>(typeof saved.eq === 'number' ? saved.eq : 60);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<{ label: string; p: number } | null>(null);
  const [result, setResult] = useState<MasterNovaResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ab, setAb] = useState<'avec' | 'sans'>('avec');
  const [equalLevel, setEqualLevel] = useState(true);
  // Le niveau égal ne s'applique qu'une fois la comparaison commencée (premier passage sur B).
  const [abUsed, setAbUsed] = useState(false);
  const [, force] = useState(0);
  const [refBusy, setRefBusy] = useState<string | null>(null);
  const [exportCheck, setExportCheck] = useState<{ lufs: number; truePeak: number; busy: boolean; duration?: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const target = PLATFORM_TARGETS.find(t => t.id === targetId) || PLATFORM_TARGETS[0];

  useEffect(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ target: targetId, character, eq: eqAmount })); } catch { /* stockage indisponible */ } }, [targetId, character, eqAmount]);
  useEffect(() => referencePlayer.subscribe(() => force(x => x + 1)), []);

  const master = tracks.find(t => t.id === MASTER_ID);
  const mnPlugins = (master?.plugins || []).filter(isMasterNovaPlugin);
  const applied = mnPlugins.length > 0;
  const bypassed = applied && mnPlugins.every(p => !p.isEnabled);

  // Vérification : le projet rendu comme à l'export (même moteur), chaîne appliquée.
  const mnSig = mnPlugins.map(p => `${p.id}:${p.isEnabled ? 1 : 0}`).join(',');
  useEffect(() => {
    if (!applied || bypassed) { setExportCheck(null); return; }
    let alive = true;
    setExportCheck(c => ({ lufs: c?.lufs ?? NaN, truePeak: c?.truePeak ?? NaN, busy: true }));
    const id = window.setTimeout(() => {
      measureCurrentMix(tracks).then(m => {
        if (!alive) return;
        const ch = [m.buffer.getChannelData(0), m.buffer.getChannelData(m.buffer.numberOfChannels > 1 ? 1 : 0)];
        setExportCheck({ lufs: m.lufs, truePeak: truePeakOf(ch, 4, 48), busy: false, duration: m.buffer.duration });
      }).catch(() => alive && setExportCheck(null));
    }, 400);
    return () => { alive = false; window.clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mnSig, applied, bypassed]);

  // Niveau d'écoute : en « avec » à niveau égal, le master est ramené au niveau d'avant.
  const levelDb = applied && abUsed && ab === 'avec' && equalLevel && result && Number.isFinite(result.before.lufs) && Number.isFinite(result.after.lufs)
    ? result.before.lufs - result.after.lufs : 0;
  useEffect(() => { referencePlayer.setMixLevel(Math.pow(10, levelDb / 20)); }, [levelDb]);

  // Fermeture : écoute normale, chaîne réactivée.
  const closeRef = useRef(() => {});
  closeRef.current = () => { referencePlayer.resetMonitoring(); if (bypassed) onSetBypass(false); };
  useEffect(() => () => closeRef.current(), []);

  const run = async () => {
    setRunning(true); setError(null); setResult(null);
    try {
      if (bypassed) onSetBypass(false);
      setAb('avec');
      const r = await runMasterNova(tracks, { target, character, eqAmount: eqAmount / 100 }, (label, p) => setStep({ label, p }));
      setResult(r);
    } catch (e: any) {
      setError(e?.message || 'Analyse impossible');
    } finally {
      setRunning(false); setStep(null);
    }
  };

  const switchAb = (v: 'avec' | 'sans') => {
    if (referencePlayer.active) referencePlayer.setActive(false);
    setAb(v);
    if (v === 'sans') setAbUsed(true);
    onSetBypass(v === 'sans');
  };

  const loadRef = async (f: File) => {
    setRefBusy('Lecture du morceau de référence…'); setError(null);
    try {
      await referencePlayer.load(f);
      setRefBusy('Mesure de ton mix pour les mettre au même niveau…');
      const m = await measureCurrentMix(tracks);
      referencePlayer.setMixLufs(m.lufs + levelDb);
    } catch (e: any) {
      setError(`Référence illisible : ${e?.message || 'format non pris en charge'}`);
    } finally { setRefBusy(null); }
  };
  // Le mix change de niveau (master appliqué, A/B) : la référence suit.
  useEffect(() => {
    if (!referencePlayer.info || !result) return;
    const mixNow = applied && ab === 'avec' ? result.after.lufs : result.before.lufs;
    referencePlayer.setMixLufs(mixNow + levelDb);
  }, [result, applied, ab, levelDb]);

  const ref = referencePlayer.info;
  const Row = ({ label, before, after, unit, hint, good }: { label: string; before?: number; after?: number; unit: string; hint: string; good?: boolean }) => (
    <tr className="border-t border-white/5" title={hint}>
      <td className="py-2 pr-3 text-slate-300">{label}</td>
      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-400">{before !== undefined ? `${fmtDb(before)} ${unit}` : '—'}</td>
      <td className={`py-2 pl-3 text-right font-mono tabular-nums font-black ${good === false ? 'text-red-300' : 'text-white'}`}>{after !== undefined ? `${fmtDb(after)} ${unit}` : '—'}</td>
    </tr>
  );

  return (
    <div className="fixed inset-0 z-[260] bg-black/70 backdrop-blur-sm flex items-stretch sm:items-center justify-center" role="dialog" aria-modal="true" aria-label="Master Nova" data-nova-master="">
      <div className="w-full sm:max-w-3xl sm:max-h-[92vh] overflow-y-auto bg-nv-bg sm:rounded-2xl border border-white/10 shadow-2xl text-white">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-3 bg-nv-bg/95 backdrop-blur border-b border-white/10">
          <div className="min-w-0">
            <h2 className="text-base font-black tracking-tight"><i className="fas fa-crown text-amber-400 mr-2"></i>Master Nova</h2>
            <p className="text-[11px] text-slate-400 leading-snug">Ton morceau prêt pour les plateformes en un clic, comme le Mastering Assistant de Logic Pro</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Lecture'} title="Écouter / pause (barre d'espace)"
              className={`w-10 h-10 rounded-full flex items-center justify-center ${isPlaying ? 'bg-cyan-400 text-black' : 'bg-white text-black'}`}><i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'}`}></i></button>
            <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"><i className="fas fa-times"></i></button>
          </div>
        </div>

        <div className="p-5 space-y-6">
          {/* 1. Cible */}
          <section>
            <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">1 · Où va ton morceau ?</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PLATFORM_TARGETS.map(t => (
                <button key={t.id} type="button" data-nova-cible={t.id} onClick={() => setTargetId(t.id)} aria-pressed={t.id === targetId} title={t.hint}
                  className={`rounded-xl border px-3 py-2 text-left ${t.id === targetId ? 'bg-amber-400 text-black border-amber-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                  <div className="text-[12px] font-black">{t.label}</div>
                  <div className={`text-[11px] font-mono ${t.id === targetId ? 'text-black/70' : 'text-slate-400'}`}>{fmtDb(t.lufs, 0)} LUFS · {fmtDb(t.ceiling)} dBTP</div>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">{target.hint}</p>
          </section>

          {/* 2. Caractère et EQ */}
          <section className="grid sm:grid-cols-2 gap-4">
            <div>
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">2 · Couleur</h3>
              <div className="grid grid-cols-3 gap-2">
                {CHARACTERS.map(c => (
                  <button key={c.id} type="button" onClick={() => setCharacter(c.id)} aria-pressed={c.id === character} title={c.hint}
                    className={`h-10 rounded-xl border text-[12px] font-black ${c.id === character ? 'bg-white text-black border-white' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>{c.label}</button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">{CHARACTERS.find(c => c.id === character)?.hint}</p>
            </div>
            <label className="block" title="Dose de la correction d'égalisation vers la courbe d'un master rap / R&B actuel (0 % = aucune EQ)">
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">3 · Correction d'EQ : <span className="text-white">{eqAmount} %</span></h3>
              <input type="range" min={0} max={100} step={5} value={eqAmount} onChange={e => setEqAmount(parseInt(e.target.value))} className="w-full h-8 accent-amber-400" aria-label="Dose de correction d'EQ" />
              <p className="text-[11px] text-slate-500">Légère par défaut : jamais plus de ±3,5 dB par bande.</p>
            </label>
          </section>

          {/* Lancer */}
          <section>
            <button type="button" data-nova-master-run="" onClick={run} disabled={running}
              className="w-full h-12 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-black font-black text-[14px] disabled:opacity-60">
              {running ? <><i className="fas fa-circle-notch fa-spin mr-2"></i>{step?.label || 'Analyse…'}</> : <><i className="fas fa-magic mr-2"></i>{result ? 'Refaire l’analyse' : 'Analyser et masteriser'}</>}
            </button>
            {running && <div className="mt-2 h-1.5 rounded bg-white/10 overflow-hidden" role="progressbar" aria-valuenow={Math.round((step?.p || 0) * 100)}><div className="h-full bg-amber-400 transition-all" style={{ width: `${Math.round((step?.p || 0) * 100)}%` }} /></div>}
            {error && <p className="mt-2 text-[12px] text-red-300" role="alert">{error}</p>}
          </section>

          {/* Rapport */}
          {result && (
            <section data-nova-master-rapport="" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Rapport avant / après</h3>
              <table className="w-full text-[12px]">
                <thead><tr className="text-[10px] uppercase tracking-widest text-slate-500"><th className="text-left font-black">Mesure</th><th className="text-right font-black px-3">Avant</th><th className="text-right font-black pl-3">Après</th></tr></thead>
                <tbody>
                  <Row label={`Loudness (cible ${fmtDb(target.lufs, 0)})`} before={result.before.lufs} after={result.after.lufs} unit="LUFS" good={result.reached} hint="Loudness intégrée BS.1770 : ce que mesurent Spotify, Apple Music et YouTube." />
                  <Row label={`Crête vraie (plafond ${fmtDb(target.ceiling)})`} before={result.before.truePeak} after={result.after.truePeak} unit="dBTP" good={result.after.truePeak <= target.ceiling} hint="Crête entre les échantillons (dBTP) : au-dessus de −1, le MP3 / AAC des plateformes peut saturer." />
                  <Row label="Dynamique (crête − loudness)" before={result.before.plr} after={result.after.plr} unit="dB" hint="PLR : plus c'est bas, plus le son est compressé. En dessous de 6 dB, ça devient écrasé." />
                  <Row label="Variations de niveau (LRA)" before={result.before.lra} after={result.after.lra} unit="LU" hint="Écart entre passages calmes et forts du morceau." />
                </tbody>
              </table>
              <p className={`mt-3 text-[12px] ${result.reached ? 'text-emerald-300' : 'text-amber-300'}`}>
                {result.reached ? `✓ Cible atteinte : ${fmtDb(result.after.lufs)} LUFS pour ${fmtDb(target.lufs, 0)} visés, crête vraie ${fmtDb(result.after.truePeak)} dBTP.` : `Cible pas tout à fait atteinte (${fmtDb(result.after.lufs)} LUFS) : le mix est très dynamique, essaie la couleur Punch ou une cible moins forte.`}
                {result.after.plr < 6 && ' Attention : la dynamique devient faible (son écrasé).'}
              </p>
              <details className="mt-3 text-[12px] text-slate-300">
                <summary className="cursor-pointer text-slate-400">Ce que Nova a réglé</summary>
                <ul className="mt-2 space-y-1 list-disc pl-5">
                  <li>EQ : {result.proposal.eqMoves.filter(m => m.gainDb !== 0).map(eqMoveLabel).join(' · ') || 'aucune correction nécessaire'}</li>
                  <li>Compression de bus : ratio {String(result.proposal.compParams.ratio).replace('.', ',')}:1, seuil {fmtDb(result.proposal.compParams.threshold)} dB, attaque {Math.round(result.proposal.compParams.attack * 1000)} ms</li>
                  <li>Limiteur : +{fmtDb(result.proposal.limiterParams.inputGain)} dB d'entrée, plafond {fmtDb(result.proposal.limiterParams.ceiling)} dBTP, relâchement {result.proposal.limiterParams.release} ms ({result.iterations.length} essai{result.iterations.length > 1 ? 's' : ''})</li>
                </ul>
              </details>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" data-nova-master-apply="" onClick={() => { onApply(result.plugins); setAb('avec'); }}
                  title="Ajoute EQ + compression + limiteur à la fin de la piste master, fader master à 0 dB. Ctrl+Z pour annuler."
                  className="h-10 px-4 rounded-xl bg-emerald-400 text-black font-black text-[12px]"><i className="fas fa-check mr-1.5"></i>{applied ? 'Remplacer le master' : 'Appliquer sur le master'}</button>
                {applied && <button type="button" onClick={() => { onRemove(); setAb('avec'); }} title="Retire la chaîne Master Nova (annulable)" className="h-10 px-4 rounded-xl bg-white/5 border border-white/10 text-[12px] font-bold">Retirer</button>}
              </div>
            </section>
          )}

          {/* A/B */}
          {applied && (
            <section data-nova-master-ab="" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Comparer (A/B)</h3>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-xl overflow-hidden border border-white/15" role="radiogroup" aria-label="A/B Master Nova">
                  <button type="button" role="radio" aria-checked={ab === 'avec' && !referencePlayer.active} onClick={() => switchAb('avec')} className={`h-10 px-4 text-[12px] font-black ${ab === 'avec' && !referencePlayer.active ? 'bg-amber-400 text-black' : 'bg-white/5 text-slate-300'}`}>A · Avec Master Nova</button>
                  <button type="button" role="radio" aria-checked={ab === 'sans' && !referencePlayer.active} onClick={() => switchAb('sans')} className={`h-10 px-4 text-[12px] font-black ${ab === 'sans' && !referencePlayer.active ? 'bg-white text-black' : 'bg-white/5 text-slate-300'}`}>B · Sans</button>
                </div>
                <label className="flex items-center gap-2 text-[12px] text-slate-300" title="Le master est baissé au niveau du mix d'origine pendant la comparaison : on juge le son, pas le volume (le plus fort paraît toujours meilleur).">
                  <input type="checkbox" checked={equalLevel} onChange={e => setEqualLevel(e.target.checked)} className="accent-amber-400" disabled={!result} />
                  À niveau égal{result && equalLevel && result ? ` (A baissé de ${fmtDb(Math.abs(result.before.lufs - result.after.lufs))} dB pendant la comparaison)` : ''}
                </label>
              </div>
              {!result && <p className="mt-2 text-[11px] text-slate-500">Relance l’analyse pour comparer à niveau égal.</p>}
              {exportCheck && (
                <p className="mt-2 text-[12px]" data-nova-master-export="" data-lufs={Number.isFinite(exportCheck.lufs) ? exportCheck.lufs.toFixed(2) : ''} data-tp={Number.isFinite(exportCheck.truePeak) ? exportCheck.truePeak.toFixed(2) : ''} data-duree={exportCheck.duration ? exportCheck.duration.toFixed(2) : ''}
                  title="Le projet est rendu exactement comme à l’export (même moteur), master Nova compris.">
                  {exportCheck.busy ? <span className="text-slate-400"><i className="fas fa-circle-notch fa-spin mr-1.5"></i>Vérification du fichier exporté…</span>
                    : <span className={Math.abs(exportCheck.lufs - target.lufs) <= 0.5 && exportCheck.truePeak <= target.ceiling ? 'text-emerald-300' : 'text-amber-300'}>
                        À l’export : <b>{fmtDb(exportCheck.lufs)} LUFS</b> · crête vraie <b>{fmtDb(exportCheck.truePeak)} dBTP</b>{Math.abs(exportCheck.lufs - target.lufs) <= 0.5 ? ' ✓' : ` (cible ${fmtDb(target.lufs, 0)} : relance l’analyse si tu as changé le mix)`}
                      </span>}
                </p>
              )}
              <p className="mt-2 text-[11px] text-slate-500">L’A/B ne crée pas d’étape d’annulation et n’est jamais exporté : seul le réglage « A » compte.</p>
            </section>
          )}

          {/* Référence */}
          <section data-nova-reference="" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-1">Morceau de référence</h3>
            <p className="text-[11px] text-slate-500 mb-3">Importe un son du commerce que tu aimes et compare-le à ton mix, au même niveau (comme Reference Track / le comparateur du Mastering Assistant). Il n’est jamais exporté.</p>
            <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void loadRef(f); e.target.value = ''; }} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => fileRef.current?.click()} disabled={!!refBusy} className="h-10 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-[12px] font-bold disabled:opacity-50"><i className="fas fa-file-import mr-1.5"></i>{ref ? 'Changer de référence' : 'Importer une référence'}</button>
              {ref && (
                <div className="flex rounded-xl overflow-hidden border border-white/15" role="radiogroup" aria-label="Écoute mix ou référence">
                  <button type="button" role="radio" aria-checked={!referencePlayer.active} onClick={() => referencePlayer.setActive(false)} className={`h-10 px-4 text-[12px] font-black ${!referencePlayer.active ? 'bg-cyan-400 text-black' : 'bg-white/5 text-slate-300'}`}>Mon mix</button>
                  <button type="button" role="radio" aria-checked={referencePlayer.active} data-nova-ref-play="" onClick={() => referencePlayer.setActive(true)} className={`h-10 px-4 text-[12px] font-black ${referencePlayer.active ? 'bg-fuchsia-500 text-black' : 'bg-white/5 text-slate-300'}`}>Référence</button>
                </div>
              )}
            </div>
            {refBusy && <p className="mt-2 text-[12px] text-slate-300"><i className="fas fa-circle-notch fa-spin mr-1.5"></i>{refBusy}</p>}
            {ref && (
              <p className="mt-2 text-[12px] text-slate-300" data-nova-ref-info="" data-mix-lufs={referencePlayer.mixLufs !== null ? referencePlayer.mixLufs.toFixed(2) : ''}>
                <b className="text-white">{ref.name}</b> · {fmtDb(ref.lufs)} LUFS · crête {fmtDb(ref.truePeak)} dBTP
                {referencePlayer.mixLufs !== null && <> · écoutée à <b className="text-white">{fmtDb(referencePlayer.match.gainDb)} dB</b> pour être au niveau de ton mix ({fmtDb(referencePlayer.mixLufs)} LUFS){referencePlayer.match.limited ? ' — un peu moins fort pour ne pas saturer' : ''}</>}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default MasterAssistantPanel;
