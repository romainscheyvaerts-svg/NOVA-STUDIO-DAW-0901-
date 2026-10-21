import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState } from '../types';
import { applyR21 } from '../utils/r21Bus';
import type { OpenedDawProject } from '../utils/dawproject/dawProjectApp';
import { buildDawProjectZip, importDawProjectIntoProject, isDawProjectFile, openDawProject, planDawProject } from '../utils/dawproject/dawProjectApp';
import type { DawImportReport } from '../utils/dawproject/dawProjectToNova';
import type { BwfFormat } from '../utils/bwf';
import { saveBlob } from '../utils/saveBlob';
import { exportKeyOf } from '../utils/exportRights';
import { useExportGate } from '../hooks/useExportGate';
import ExportPaywall from './ExportPaywall';
import { openBuyBeat } from '../utils/studioLinks';

/**
 * Échange de projet au format ouvert DAWproject (écart 14), à côté de l'AAF :
 *  - « Ouvrir un projet DAWproject » : pistes, clips audio et MIDI, tempo, volumes, pan,
 *    effets génériques ; plugins absents et sons manquants signalés ;
 *  - « Exporter en DAWproject » : un seul fichier .dawproject (sons inclus).
 * La logique est dans utils/dawproject (modules purs testés).
 */
const btn = 'nova-hit-tactile h-9 rounded-lg border border-nv-line px-3 text-[12px] font-bold text-nv-ink hover:bg-nv-accent/15 disabled:opacity-40';
const btnMain = 'nova-hit-tactile h-10 rounded-lg bg-nv-accent px-4 text-[13px] font-black text-black disabled:opacity-40';
const card = 'w-full rounded-xl border border-nv-line bg-nv-well/40 p-3 text-left hover:bg-nv-accent/10';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const bpmText = (b: number) => (Math.round(b * 100) / 100).toLocaleString('fr-FR');

const Shell: React.FC<{ title: string; icon: string; testId: string; busy: boolean; onClose: () => void; children: React.ReactNode }> = ({ title, icon, testId, busy, onClose, children }) => (
  <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-3" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}>
    <div role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId}
      className="flex max-h-[92vh] w-full max-w-[640px] flex-col gap-3 rounded-2xl border border-nv-line bg-nv-panel p-4 shadow-2xl">
      <div className="flex items-center gap-2">
        <i className={`fas ${icon} text-nv-accent`} />
        <h2 id={`${testId}-title`} className="min-w-0 flex-1 truncate text-[15px] font-bold text-nv-ink">{title}</h2>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Fermer" className="nova-hit-tactile h-9 w-9 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
      </div>
      {children}
    </div>
  </div>
);

// ── Import ───────────────────────────────────────────────────────────────────────────────
export const DawProjectImportDialog: React.FC<{ getState: () => DAWState; initialFiles?: File[]; onClose: () => void }> = ({ getState, initialFiles, onClose }) => {
  const [step, setStep] = useState<'pick' | 'review' | 'done'>('pick');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedDawProject | null>(null);
  const [report, setReport] = useState<DawImportReport | null>(null);
  const projectEmpty = useMemo(() => !getState().tracks.some(t => t.id !== 'master' && t.clips.length), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [takeSettings, setTakeSettings] = useState(projectEmpty);
  const inputRef = useRef<HTMLInputElement>(null);

  const take = async (files: File[]) => {
    const f = files.find(isDawProjectFile) || files[0];
    if (!f || !isDawProjectFile(f)) { setError('Choisis un fichier .dawproject (dans ton logiciel de musique : Fichier › Exporter › DAWproject).'); return; }
    setBusy('Lecture du projet…'); setError(null);
    try {
      const o = await openDawProject(f);
      if (!o.session.tracks.length) throw new Error('Aucune piste dans ce projet.');
      setOpened(o); setStep('review');
    } catch (e: any) {
      setError(`Projet illisible : ${e?.message || e}`);
    } finally { setBusy(null); }
  };
  useEffect(() => { if (initialFiles?.length) void take(initialFiles); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    if (!opened) return;
    setBusy('Import…');
    try {
      const out = await importDawProjectIntoProject(opened, getState(), { takeProjectSettings: takeSettings }, t => setBusy(t));
      applyR21(() => out.state, `📥 Projet DAWproject : ${out.report.summary}. Ctrl+Z pour revenir.`);
      setReport(out.report); setStep('done');
      (window as any).__novaDawLastImport = { summary: out.report.summary, absent: out.report.absentPlugins, missing: out.report.missing, trackIds: out.trackIds };
    } catch (e: any) {
      setError(`Import impossible : ${e?.message || e}`);
    } finally { setBusy(null); }
  };

  const s = opened?.session;
  const { missingFiles, missingClips } = useMemo(() => {
    if (!opened || !s) return { missingFiles: 0, missingClips: 0 };
    const names = new Set([...opened.files.keys()].map(k => k.toLowerCase().split('/').pop()));
    const lost = (p?: string) => !!p && !names.has(p.toLowerCase().split('/').pop());
    const clips = [...s.tracks, ...(s.master ? [s.master] : [])].flatMap(t => t.clips).filter(c => lost(c.audio?.path));
    return { missingFiles: new Set(clips.map(c => c.audio!.path)).size, missingClips: clips.length };
  }, [opened, s]);
  const plugins = useMemo(() => (s ? [...s.tracks, ...(s.master ? [s.master] : [])].flatMap(t => t.devices.filter(d => /Plugin$/.test(d.kind)).map(d => d.name)) : []), [s]);
  const curBpm = getState().bpm;
  return (
    <Shell title={`Ouvrir un projet DAWproject${opened ? ` · ${opened.fileName}` : ''}`} icon="fa-file-import" testId="dawp-import-dialog" busy={!!busy} onClose={onClose}>
      {error && <p role="alert" className="rounded-lg border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300">⚠️ {error}</p>}
      {busy && <p className="p-2 text-center text-[13px] text-nv-muted" role="status" data-testid="dawp-busy"><i className="fas fa-circle-notch fa-spin mr-2" />{busy}</p>}

      {step === 'pick' && !busy && (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-nv-muted">DAWproject est un format ouvert, lu et écrit par plusieurs logiciels de musique. Dans le tien : <b>Fichier › Exporter › DAWproject</b>. Pistes, clips audio et MIDI, tempo, volumes, pan et effets arrivent dans ce projet ; tu peux annuler d'un Ctrl+Z.</p>
          <button type="button" className={card} onClick={() => inputRef.current?.click()} data-testid="dawp-pick">
            <span className="block text-[13px] font-black text-nv-ink">🗂️ Choisir le fichier .dawproject</span>
            <span className="block text-[11px] text-nv-muted">Tu peux aussi le glisser n'importe où sur NOVA.</span>
          </button>
          <input ref={inputRef} type="file" accept=".dawproject" className="hidden" data-testid="dawp-input"
            onChange={e => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) void take(f); }} />
        </div>
      )}

      {step === 'review' && s && !busy && (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto" data-testid="dawp-review">
          <p className="text-[13px] text-nv-ink" data-testid="dawp-preview">
            <b>{s.title || opened!.fileName.replace(/\.dawproject$/i, '')}</b> · {plural(s.tracks.length, 'piste')} · {plural(s.stats.clips, 'clip')} · {bpmText(s.bpm)} BPM · {s.numerator}/{s.denominator}
            {s.app ? <span className="text-nv-muted"> · {s.sidecar ? 'fait avec NOVA' : 'fichier d’un autre logiciel'}</span> : null}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
            {s.tracks.map((t, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg border border-nv-line bg-nv-well/30 px-2 py-1.5 text-[12px] text-nv-ink" data-testid="dawp-track">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: t.color || '#94a3b8' }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-bold">{t.parentXmlId ? '↳ ' : ''}{t.name}</span>
                <span className="shrink-0 text-nv-muted">{t.isFolder ? 'dossier' : t.clips.some(c => c.notes) ? 'MIDI' : t.clips.some(c => c.audio) ? 'audio' : 'bus'} · {plural(t.clips.length, 'clip')}</span>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-[12px] text-nv-ink">
            <input type="checkbox" checked={takeSettings} onChange={e => setTakeSettings(e.target.checked)} data-testid="dawp-take-settings" className="mt-0.5" />
            <span>Reprendre le tempo ({bpmText(s.bpm)} BPM{s.tempoPoints.length > 1 ? ' et ses changements' : ''}), la mesure, les repères et le master du fichier
              {!takeSettings && Math.abs(s.bpm - curBpm) > 1e-6 && <span className="block text-nv-muted">Sinon le projet garde {bpmText(curBpm)} BPM : les clips restent à leur place en secondes.</span>}</span>
          </label>
          {(plugins.length > 0 || missingFiles > 0) && (
            <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-2 text-[12px] text-amber-100" data-testid="dawp-warnings">
              {plugins.length > 0 && <p>⚠️ {plural(plugins.length, 'plugin', 'plugins')} de l'autre logiciel ({[...new Set(plugins)].slice(0, 6).join(', ')}{plugins.length > 6 ? '…' : ''}) : NOVA reprend les effets génériques, les autres seront listés pour les remplacer à la main.</p>}
              {missingFiles > 0 && <p className="mt-1">⚠️ {plural(missingFiles, 'son absent', 'sons absents')} du fichier : {missingClips > 1 ? `les ${missingClips} clips concernés gardent leur place, muets` : 'le clip concerné garde sa place, muet'}.</p>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={onClose} data-testid="dawp-cancel">Annuler</button>
            <button type="button" className={btnMain} onClick={() => void go()} data-testid="dawp-import-go">Importer {plural(s.tracks.length, 'piste')}</button>
          </div>
        </div>
      )}

      {step === 'done' && report && (
        <div className="flex flex-col gap-2" data-testid="dawp-import-report">
          <p className="text-[14px] font-bold text-nv-ink" data-testid="dawp-report-summary">✅ {report.summary}</p>
          <ul className="max-h-60 space-y-0.5 overflow-y-auto text-[12px] text-nv-ink">
            {report.lines.map((l, i) => <li key={i} className={l.startsWith('⚠️') ? 'text-amber-300' : ''}>{l}</li>)}
          </ul>
          <p className="text-[11px] text-nv-muted">Ctrl+Z annule l'import.</p>
          <div className="flex justify-end">
            <button type="button" className={btnMain} onClick={onClose} data-testid="dawp-import-close">Fermer</button>
          </div>
        </div>
      )}
    </Shell>
  );
};

// ── Export ───────────────────────────────────────────────────────────────────────────────
export const DawProjectExportDialog: React.FC<{ getState: () => DAWState; onClose: () => void; getOwned?: () => (string | number)[] }> = ({ getState, onClose, getOwned }) => {
  const [format, setFormat] = useState<BwfFormat>('32f');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ fileName: string; size: number; result: ReturnType<typeof planDawProject> } | null>(null);
  const state = getState();
  // Même verrou que l'AAF : contenu (beat sans licence jamais écrit) et sortie (export débloqué).
  const ownedIds = (getOwned?.() || []).map(String);
  const gate = useExportGate(true, exportKeyOf(state), state.tracks, ownedIds, 'voix');
  const owned: (string | number)[] | 'all' = gate.admin ? 'all' : ownedIds;
  // Aperçu sans fabriquer les WAV (même plan, sons ignorés : rapide).
  const plan = useMemo(() => planDawProject(state, { owned, format, dryRun: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, format, gate.admin, ownedIds.join(',')]);

  const go = async () => {
    if (!gate.unlocked) { setError(gate.access?.reason === 'erreur' ? (gate.access.message || 'Vérification impossible.') : "Débloque d'abord l'export de ce projet (ci-dessus)."); return; }
    setBusy('Fabrication du fichier…'); setError(null);
    try {
      await new Promise(r => setTimeout(r, 30));
      const z = await buildDawProjectZip(getState(), { owned, format });
      await saveBlob(z.blob, z.fileName);
      setDone({ fileName: z.fileName, size: z.blob.size, result: z.result });
      (window as any).__novaDawLastExport = { fileName: z.fileName, size: z.blob.size, stats: z.result.stats };
    } catch (e: any) {
      setError(`Export impossible : ${e?.message || e}`);
    } finally { setBusy(null); }
  };

  const st = plan.stats;
  return (
    <Shell title="Exporter en DAWproject (format ouvert)" icon="fa-file-export" testId="dawp-export-dialog" busy={!!busy} onClose={onClose}>
      {error && <p role="alert" className="rounded-lg border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300">⚠️ {error}</p>}
      {busy && <p className="p-2 text-center text-[13px] text-nv-muted" role="status"><i className="fas fa-circle-notch fa-spin mr-2" />{busy}</p>}
      {!done && !busy && !gate.admin && !gate.unlocked && (
        <ExportPaywall access={gate.access} grille={gate.grille} status={gate.status} paying={gate.paying}
          onPayExport={() => { void gate.pay(); }} onCancelPay={gate.cancelPay} onBuyLicence={() => openBuyBeat(state.tracks)}
          onRetry={gate.recheck} onProActive={gate.recheck} showBuy />
      )}
      {gate.message && <p role="status" className="text-[12px] text-amber-300">{gate.message}</p>}
      {!done && !busy && (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <p className="text-[12px] text-nv-muted">Un seul fichier .dawproject, à ouvrir dans un autre logiciel de musique qui lit ce format ouvert (Fichier › Importer › DAWproject) ou à rouvrir dans NOVA à l'identique. Pistes, clips audio et MIDI, tempo, volumes, pan, envois, automation et effets.</p>
          <p className="text-[13px] text-nv-ink" data-testid="dawp-export-preview">
            {plural(st.tracks, 'piste')} · {plural(st.audioClips, 'clip audio', 'clips audio')} · {plural(st.notes, 'note')} · {plural(st.audioFiles, 'son')} · {plural(st.devices, 'effet ou instrument', 'effets ou instruments')}
          </p>
          <fieldset className="flex flex-col gap-1.5 text-[12px] text-nv-ink">
            <legend className="mb-1 text-[11px] font-black uppercase tracking-wider text-nv-muted">Sons</legend>
            <label className="flex items-start gap-2"><input type="radio" name="dawp-format" checked={format === '32f'} onChange={() => setFormat('32f')} data-testid="dawp-32f" />
              <span><b>32 bits flottants</b> — le son de NOVA au bit près.</span></label>
            <label className="flex items-start gap-2"><input type="radio" name="dawp-format" checked={format === '24'} onChange={() => setFormat('24')} data-testid="dawp-24" />
              <span><b>24 bits</b> — plus léger, standard des studios.</span></label>
          </fieldset>
          {(plan.skipped.length > 0 || plan.notes.length > 0) && (
            <ul className="max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-nv-line bg-nv-well/30 p-2 text-[12px]" data-testid="dawp-export-notes">
              {plan.skipped.map((s, i) => <li key={`s${i}`} className="text-amber-300">⚠️ {s}</li>)}
              {plan.notes.map((s, i) => <li key={`n${i}`} className="text-nv-muted">{s}</li>)}
            </ul>
          )}
          {!st.tracks && <p className="text-[12px] text-amber-300">Aucune piste à exporter.</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={onClose} data-testid="dawp-cancel">Annuler</button>
            <button type="button" className={btnMain} disabled={!st.tracks || !gate.unlocked} onClick={() => void go()} data-testid="dawp-export-go">{gate.unlocked ? 'Exporter le projet' : (gate.access ? 'Export à débloquer' : 'Vérification…')}</button>
          </div>
        </div>
      )}
      {done && (
        <div className="flex flex-col gap-2" data-testid="dawp-export-done">
          <p className="text-[14px] font-bold text-nv-ink">✅ Projet exporté : {plural(done.result.stats.tracks, 'piste')}, {plural(done.result.stats.clips, 'clip')}, {plural(done.result.stats.audioFiles, 'son')}.</p>
          <p className="text-[12px] text-nv-muted">« {done.fileName} » ({(done.size / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo) : dans l'autre logiciel, <b>Fichier › Importer</b> (ou Ouvrir) puis ce fichier.</p>
          <div className="flex justify-end"><button type="button" className={btnMain} onClick={onClose} data-testid="dawp-export-close">Fermer</button></div>
        </div>
      )}
    </Shell>
  );
};
