import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState } from '../types';
import { applyR21, openSessionPanel } from '../utils/r21Bus';
import type { AafSession } from '../utils/aaf/aafRead';
import type { AafImportReport } from '../utils/aaf/aafToNova';
import type { AafZip } from '../utils/aaf/aafApp';
import { buildProToolsZip, importAafIntoProject, isAafFile, isAudioFile, missingMedia, openAaf, planProjectExport } from '../utils/aaf/aafApp';
import { saveBlob } from '../utils/saveBlob';
import { billingStatus } from '../services/Billing';
import { MEDIA_FOLDER } from '../utils/aaf/aafWrite';

/**
 * Échange de séance avec Pro Tools (chantier 14) :
 *  - « Importer une séance Pro Tools (AAF) » : pistes, clips à l'échantillon près, gain
 *    de clip, fondus, volume et pan ; médias intégrés ou liés (dossier « Audio Files ») ;
 *  - « Séance pour Pro Tools » : .zip avec l'AAF et les BWF horodatés.
 * La logique est dans utils/aaf (modules purs testés).
 */
const btn = 'nova-hit-tactile h-9 rounded-lg border border-nv-line px-3 text-[12px] font-bold text-nv-ink hover:bg-nv-accent/15 disabled:opacity-40';
const btnMain = 'nova-hit-tactile h-10 rounded-lg bg-nv-accent px-4 text-[13px] font-black text-black disabled:opacity-40';
const card = 'w-full rounded-xl border border-nv-line bg-nv-well/40 p-3 text-left hover:bg-nv-accent/10';
const khz = (r: number) => `${(r / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kHz`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
/** « Audio Files » avec espaces insécables (pas de guillemet seul en fin de ligne). */
const MF = `« ${MEDIA_FOLDER} »`;

const Shell: React.FC<{ title: string; icon: string; testId: string; busy: boolean; onClose: () => void; children: React.ReactNode; hint?: string }> = ({ title, icon, testId, busy, onClose, children, hint }) => (
  <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-3" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId}
      className="flex max-h-[92vh] w-full max-w-[640px] flex-col gap-3 rounded-2xl border border-nv-line bg-nv-panel p-4 shadow-2xl">
      <div className="flex items-center gap-2">
        <i className={`fas ${icon} text-nv-accent`} />
        <h2 id={`${testId}-title`} className="min-w-0 flex-1 truncate text-[15px] font-bold text-nv-ink" title={hint}>{title}</h2>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Fermer" className="nova-hit-tactile h-9 w-9 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
      </div>
      {children}
    </div>
  </div>
);

// ── Import ───────────────────────────────────────────────────────────────────────────────
export const AafImportDialog: React.FC<{ getState: () => DAWState; initialFiles?: File[]; onClose: () => void }> = ({ getState, initialFiles, onClose }) => {
  const [step, setStep] = useState<'pick' | 'review' | 'done'>('pick');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aafName, setAafName] = useState('');
  const [session, setSession] = useState<AafSession | null>(null);
  const [media, setMedia] = useState<File[]>([]);
  const [report, setReport] = useState<AafImportReport | null>(null);
  const aafRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  const take = async (files: File[]) => {
    const aaf = files.find(isAafFile);
    const audio = files.filter(isAudioFile);
    if (!aaf) {
      if (audio.length && session) { setMedia(m => [...m, ...audio]); return; }
      setError('Choisis un fichier .aaf (Pro Tools : Fichier › Exporter › Pistes sélectionnées en tant que nouveau AAF/OMF).');
      return;
    }
    setBusy('Lecture de la séance…'); setError(null);
    try {
      const s = await openAaf(aaf);
      if (!s.tracks.length) throw new Error('Aucune piste audio dans cette séance AAF.');
      setSession(s); setAafName(aaf.name); setMedia(audio); setStep('review');
    } catch (e: any) {
      setError(`Séance illisible : ${e?.message || e}`);
    } finally { setBusy(null); }
  };
  useEffect(() => { if (initialFiles?.length) void take(initialFiles); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const missing = useMemo(() => (session ? missingMedia(session, media) : []), [session, media]);
  const offlineClips = useMemo(() => {
    if (!session || !missing.length) return 0;
    const keys = new Set(missing.map(m => m.key));
    return session.tracks.reduce((n, t) => n + t.clips.filter(c => c.sources.some(x => keys.has(x.media.key))).length, 0);
  }, [session, missing]);

  const go = async () => {
    if (!session) return;
    setBusy('Import…');
    try {
      const out = await importAafIntoProject(session, media, getState(), t => setBusy(t));
      applyR21(() => out.state, `📥 Séance Pro Tools : ${out.report.summary}. Ctrl+Z pour revenir.`);
      setReport(out.report); setStep('done');
    } catch (e: any) {
      setError(`Import impossible : ${e?.message || e}`);
    } finally { setBusy(null); }
  };

  const linked = session ? session.media.filter(m => m.storage === 'lie').length : 0;
  const embedded = session ? session.media.filter(m => m.storage === 'integre').length : 0;
  return (
    <Shell title={`Importer une séance Pro Tools (AAF)${aafName ? ` · ${aafName}` : ''}`} icon="fa-file-import" testId="aaf-import-dialog" busy={!!busy} onClose={onClose}
      hint="Pro Tools : Fichier › Exporter › Pistes sélectionnées en tant que nouveau AAF/OMF">
      {error && <p role="alert" className="rounded-lg border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300">⚠️ {error}</p>}
      {busy && <p className="p-2 text-center text-[13px] text-nv-muted" role="status" data-testid="aaf-busy"><i className="fas fa-circle-notch fa-spin mr-2" />{busy}</p>}

      {step === 'pick' && !busy && (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-nv-muted">Dans Pro Tools : sélectionne les pistes, puis <b>Fichier › Exporter › Pistes sélectionnées en tant que nouveau AAF/OMF</b> (AAF, médias intégrés ou copiés). Les clips arrivent à l'échantillon près, avec leur gain et leurs fondus.</p>
          <button type="button" className={card} onClick={() => aafRef.current?.click()} data-testid="aaf-pick">
            <span className="block text-[13px] font-black text-nv-ink">🎚️ Choisir le fichier .aaf</span>
            <span className="block text-[11px] text-nv-muted">Tu peux aussi sélectionner en même temps les sons du dossier {MF}, ou glisser le tout sur la timeline.</span>
          </button>
          <input ref={aafRef} type="file" multiple accept=".aaf,.wav,.bwf,.aif,.aiff" className="hidden" data-testid="aaf-input"
            onChange={e => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) void take(f); }} />
        </div>
      )}

      {step === 'review' && session && !busy && (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto" data-testid="aaf-review">
          <p className="text-[13px] text-nv-ink" data-testid="aaf-preview">
            <b>{session.name}</b> · {plural(session.tracks.length, 'piste')} · {plural(session.stats.clips, 'clip')} · {khz(session.sampleRate)}
            {embedded ? ` · ${plural(embedded, 'son intégré', 'sons intégrés')}` : ''}{linked ? ` · ${plural(linked, 'son lié', 'sons liés')}` : ''}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
            {session.tracks.map((t, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg border border-nv-line bg-nv-well/30 px-2 py-1.5 text-[12px] text-nv-ink" data-testid="aaf-track">
                <i className="fas fa-wave-square text-nv-muted" />
                <span className="min-w-0 flex-1 truncate font-bold">{t.name}</span>
                <span className="text-nv-muted">{t.channels === 2 ? 'stéréo' : 'mono'} · {plural(t.clips.length, 'clip')}</span>
              </li>
            ))}
          </ul>
          {getState().sampleRate && getState().sampleRate !== session.sampleRate && (
            <p className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-2 text-[12px] text-amber-200">
              La séance est à {khz(session.sampleRate)}, ton projet à {khz(getState().sampleRate!)} : les sons seront convertis (positions gardées).
              Pour rester au bit près, <button type="button" className="underline" onClick={() => openSessionPanel('reglages')}>passe le projet à {khz(session.sampleRate)}</button> avant d'importer.
            </p>
          )}
          {missing.length > 0 && (
            <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-2 text-[12px] text-amber-100" data-testid="aaf-missing">
              <p className="font-bold">⚠️ {plural(missing.length, 'fichier son introuvable', 'fichiers son introuvables')} ({plural(offlineClips, 'clip')}) :</p>
              <p className="mt-0.5 break-words text-amber-200">{missing.slice(0, 8).map(m => m.fileName).join(', ')}{missing.length > 8 ? '…' : ''}</p>
              <p className="mt-1 text-amber-200/80">Ils sont dans le dossier {MF} livré avec l'AAF.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={btn} onClick={() => dirRef.current?.click()} data-testid="aaf-pick-folder">📁 Choisir le dossier des sons</button>
                <button type="button" className={btn} onClick={() => filesRef.current?.click()}>Choisir des fichiers</button>
              </div>
              <input ref={dirRef} type="file" multiple className="hidden" data-testid="aaf-folder-input" {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={e => { const f = Array.from(e.target.files || []).filter(isAudioFile); e.target.value = ''; if (f.length) setMedia(m => [...m, ...f]); }} />
              <input ref={filesRef} type="file" multiple accept=".wav,.bwf,.aif,.aiff" className="hidden" data-testid="aaf-media-input"
                onChange={e => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) setMedia(m => [...m, ...f]); }} />
            </div>
          )}
          {!missing.length && linked > 0 && <p className="text-[12px] text-emerald-300" data-testid="aaf-media-ok">✅ Tous les sons liés sont trouvés.</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={onClose} data-testid="aaf-cancel">Annuler</button>
            <button type="button" className={btnMain} onClick={() => void go()} data-testid="aaf-import-go">
              {missing.length ? `Importer quand même (${plural(offlineClips, 'clip muet', 'clips muets')})` : `Importer ${plural(session.tracks.length, 'piste')}`}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && report && (
        <div className="flex flex-col gap-2" data-testid="aaf-import-report">
          <p className="text-[14px] font-bold text-nv-ink" data-testid="aaf-report-summary">✅ {report.summary}</p>
          <ul className="space-y-0.5 text-[12px] text-nv-ink">
            {report.lines.map((l, i) => <li key={i} className={l.startsWith('⚠️') ? 'text-amber-300' : ''}>{l}</li>)}
          </ul>
          <p className="text-[11px] text-nv-muted">Ctrl+Z annule l'import.</p>
          <div className="flex justify-end">
            <button type="button" className={btnMain} onClick={onClose} data-testid="aaf-import-close">Fermer</button>
          </div>
        </div>
      )}
    </Shell>
  );
};

// ── Export ───────────────────────────────────────────────────────────────────────────────
export const AafExportDialog: React.FC<{ getState: () => DAWState; onClose: () => void; getOwned?: () => (string | number)[] }> = ({ getState, onClose, getOwned }) => {
  const [embed, setEmbed] = useState(false);
  // Licences : beats achetés (ids) ; admin = export libre (confirmé par le serveur).
  const [admin, setAdmin] = useState(false);
  useEffect(() => { let alive = true; billingStatus().then(s => { if (alive) setAdmin(!!s.admin); }).catch(() => {}); return () => { alive = false; }; }, []);
  const owned: (string | number)[] | 'all' = admin ? 'all' : (getOwned?.() || []);
  const [volPan, setVolPan] = useState(true);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AafZip | null>(null);
  const state = getState();
  const plan = useMemo(() => planProjectExport(state, { embed, trackVolumePan: volPan, includeMuted: muted, owned }), [state, embed, volPan, muted, admin]);
  const clips = plan.input.tracks.reduce((n, t) => n + t.clips.length, 0);
  const files = plan.input.media.reduce((n, m) => n + Math.min(2, m.channels.length), 0);

  const go = async () => {
    setBusy('Fabrication de la séance…'); setError(null);
    try {
      await new Promise(r => setTimeout(r, 30));
      const z = await buildProToolsZip(getState(), { embed, trackVolumePan: volPan, includeMuted: muted, owned });
      await saveBlob(z.blob, z.fileName);
      setDone(z);
      (window as any).__novaAafLastExport = { fileName: z.fileName, size: z.blob.size, stats: z.result.stats };
    } catch (e: any) {
      setError(`Export impossible : ${e?.message || e}`);
    } finally { setBusy(null); }
  };

  return (
    <Shell title="Séance pour Pro Tools (AAF + BWF)" icon="fa-file-export" testId="aaf-export-dialog" busy={!!busy} onClose={onClose}
      hint="Pro Tools : Fichier › Ouvrir (AAF) ou Fichier › Importer › Données de session">
      {error && <p role="alert" className="rounded-lg border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300">⚠️ {error}</p>}
      {busy && <p className="p-2 text-center text-[13px] text-nv-muted" role="status"><i className="fas fa-circle-notch fa-spin mr-2" />{busy}</p>}
      {!done && !busy && (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <p className="text-[12px] text-nv-muted">Un dossier .zip à ouvrir dans Pro Tools : la séance (.aaf) et un fichier BWF 24 bits horodaté par son, dans {MF}. Une piste par piste audio, avec les clips, leur gain et leurs fondus.</p>
          <p className="text-[13px] text-nv-ink" data-testid="aaf-export-preview">
            {plural(plan.input.tracks.length, 'piste')} · {plural(clips, 'clip')} · {plural(files, 'fichier BWF', 'fichiers BWF')} · {khz(plan.input.sampleRate)}
          </p>
          <fieldset className="flex flex-col gap-1.5 text-[12px] text-nv-ink">
            <legend className="mb-1 text-[11px] font-black uppercase tracking-wider text-nv-muted">Sons</legend>
            <label className="flex items-start gap-2"><input type="radio" name="aaf-media" checked={!embed} onChange={() => setEmbed(false)} data-testid="aaf-linked" />
              <span><b>À côté de l'AAF</b> (dossier {MF}) — léger, comme une séance Pro Tools.</span></label>
            <label className="flex items-start gap-2"><input type="radio" name="aaf-media" checked={embed} onChange={() => setEmbed(true)} data-testid="aaf-embedded" />
              <span><b>Dans l'AAF</b> — un seul fichier à ouvrir, rien à relier (plus lourd).</span></label>
          </fieldset>
          <label className="flex items-center gap-2 text-[12px] text-nv-ink"><input type="checkbox" checked={volPan} onChange={e => setVolPan(e.target.checked)} data-testid="aaf-volpan" />Volume et pan des pistes</label>
          <label className="flex items-center gap-2 text-[12px] text-nv-ink"><input type="checkbox" checked={muted} onChange={e => setMuted(e.target.checked)} />Exporter aussi les clips coupés</label>
          {(plan.skipped.length > 0 || plan.notes.length > 0) && (
            <ul className="max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-nv-line bg-nv-well/30 p-2 text-[12px]" data-testid="aaf-export-notes">
              {plan.skipped.map((s, i) => <li key={`s${i}`} className="text-amber-300">⚠️ {s}</li>)}
              {plan.notes.map((s, i) => <li key={`n${i}`} className="text-nv-muted">{s}</li>)}
            </ul>
          )}
          {!plan.input.tracks.length && <p className="text-[12px] text-amber-300">Aucune piste audio à exporter.</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={onClose} data-testid="aaf-cancel">Annuler</button>
            <button type="button" className={btnMain} disabled={!plan.input.tracks.length} onClick={() => void go()} data-testid="aaf-export-go">Exporter la séance</button>
          </div>
        </div>
      )}
      {done && (
        <div className="flex flex-col gap-2" data-testid="aaf-export-done">
          <p className="text-[14px] font-bold text-nv-ink">✅ Séance exportée : {plural(done.result.stats.tracks, 'piste')}, {plural(done.result.stats.clips, 'clip')}, {plural(done.result.stats.mediaFiles, 'fichier BWF', 'fichiers BWF')}.</p>
          <p className="text-[12px] text-nv-muted">« {done.fileName} » : décompresse-le, puis dans Pro Tools <b>Fichier › Ouvrir</b> le fichier .aaf (ou <b>Importer › Données de session</b>). Le mode d'emploi est dans LISEZ-MOI.txt.</p>
          {done.result.messages.map((m, i) => <p key={i} className="text-[12px] text-amber-300">{m}</p>)}
          <div className="flex justify-end"><button type="button" className={btnMain} onClick={onClose} data-testid="aaf-export-close">Fermer</button></div>
        </div>
      )}
    </Shell>
  );
};
