import React, { useEffect, useMemo, useState } from 'react';
import { BWF_FORMATS, TIMECODE_FPS, samplesToTimecode, timecodeToSamples, TimecodeFps } from '../utils/bwf';
import { inputVerdictMessage, levelLabel, positionLabel } from '../utils/proToolsBridge';
import {
  canPickFolder, desktopFolderPicker, mixSource, MixSourceKind, pickDesktopFolder, proToolsSink, PtEntry, PtTarget, saveDir, TakesBatch,
} from '../services/ProToolsBridge';

/**
 * Pont Pro Tools, côté ingé (panneau Collaboration) :
 *  - « Dossier Pro Tools » : chaque prise de l'artiste reçue est aussi écrite en BWF
 *    horodaté (import Spot dans Pro Tools à l'échantillon près) ;
 *  - source du mix diffusé : le master de NOVA, ou une entrée système (la sortie de
 *    Pro Tools renvoyée en loopback), avec niveau G / D et message si mono ou muette.
 */
interface Props {
  /** Prises déjà dans la séance (pour « Envoyer aussi les prises déjà là »). */
  existing: () => TakesBatch[];
}

const btn = 'h-10 rounded-xl px-3 text-[12px] font-black transition-colors disabled:opacity-40';
const useSink = () => {
  const sink = proToolsSink();
  const [, force] = useState(0);
  useEffect(() => sink.subscribe(() => force(n => n + 1)), [sink]);
  return sink;
};

const TARGET_LABEL: Record<PtTarget, string> = {
  bridge: 'Nova Studio écrit directement dans ce dossier',
  folder: 'Le navigateur écrit dans le dossier choisi',
  download: 'Chaque prise est téléchargée (dossier Téléchargements)',
};

function EntryRow({ e, fps }: { e: PtEntry; fps: TimecodeFps }) {
  const icon = e.status === 'ok' ? '✅' : e.status === 'erreur' ? '⚠️' : e.status === 'attente' ? '⏸️' : '⏳';
  const tc = e.sampleRate ? samplesToTimecode(e.timeReference, fps, e.sampleRate) : '';
  return (
    <li data-testid="pt-entry" data-status={e.status} data-file={e.file} className="rounded-xl bg-white/[0.03] px-2.5 py-2 text-[12px] leading-snug">
      <span className="font-bold text-slate-100">{icon} {e.file}</span>
      <span className="block text-[11px] text-slate-400">
        {e.status === 'ok' && <>Envoyée vers ton logiciel de studio{e.updated ? ' (mise à jour)' : ''} · Spot à {positionLabel(e.position, e.sampleRate)} · TC {tc}</>}
        {e.status === 'envoi' && <>Écriture…</>}
        {e.status === 'attente' && <>{e.error} : clique « Autoriser le dossier ».</>}
        {e.status === 'erreur' && <span className="text-red-300">{e.error}</span>}
      </span>
      {e.renamed && <span className="block text-[11px] text-amber-200">L’original est ouvert dans ton logiciel de studio : nouvelle version écrite à côté.</span>}
      {e.status === 'ok' && (
        <span className="block truncate text-[10px] text-slate-500" title={e.path}>
          {typeof e.ms === 'number' ? `Écrite en ${(e.ms / 1000).toFixed(1).replace('.', ',')} s` : 'Écrite'}{e.target === 'bridge' && e.path ? ` · ${e.path}` : e.target === 'download' ? ' · Téléchargements' : ''}
        </span>
      )}
    </li>
  );
}

export const ProToolsPanel: React.FC<Props> = ({ existing }) => {
  const sink = useSink();
  const s = sink.getSettings();
  const [target, setTarget] = useState<PtTarget>('download');
  const [defaultFolder, setDefaultFolder] = useState('');
  const [folderState, setFolderState] = useState<{ ok: boolean; text: string } | null>(null);
  const [folderDraft, setFolderDraft] = useState(s.folder);
  const [tcDraft, setTcDraft] = useState(s.sessionStart);
  const [note, setNote] = useState<string | null>(null);

  // Où iront les prises (pont de Nova Studio, dossier du navigateur, téléchargement).
  useEffect(() => {
    let alive = true;
    void sink.target().then(t => { if (alive) setTarget(t); });
    return () => { alive = false; };
  }, [sink, s.enabled, sink.dir]);
  // Pont : dossier par défaut et dossier choisi accessible ?
  useEffect(() => {
    if (target !== 'bridge') { setFolderState(null); return; }
    let alive = true;
    void import('../services/NovaBridge').then(({ novaBridge }) => novaBridge.proToolsStatus(s.folder || undefined)).then(st => {
      if (!alive) return;
      setDefaultFolder(st.defaultFolder);
      setFolderState(st.writable ? { ok: true, text: `Accessible : ${st.folder || st.defaultFolder}` } : { ok: false, text: st.error || 'Dossier inaccessible' });
    }).catch(() => { /* pont occupé : réessayé au prochain changement */ });
    return () => { alive = false; };
  }, [target, s.folder]);

  const tcOk = timecodeToSamples(tcDraft, s.fps, 48000) !== null;
  const commitFolder = (v: string) => { if (v.trim() !== s.folder) { sink.setSettings({ folder: v.trim() }); sink.forget(); } };
  const pickBrowserFolder = async () => {
    try {
      const dir = await (window as any).showDirectoryPicker({ id: 'nova-protools', mode: 'readwrite' });
      sink.setDir(dir); sink.forget();
      void saveDir(dir);
      setNote(`Dossier choisi : « ${dir.name} ». Les prochaines prises y seront écrites.`);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setNote(`Ce dossier ne peut pas être utilisé (${e?.message || e}).`);
    }
  };
  const pickWindowsFolder = async () => {
    const p = await pickDesktopFolder(s.folder || defaultFolder);
    if (p) { setFolderDraft(p); commitFolder(p); }
  };
  const sendExisting = () => {
    const n = sink.sendExisting(existing());
    setNote(n ? `${n} prise${n > 1 ? 's' : ''} déjà dans la séance envoyée${n > 1 ? 's' : ''} vers ton logiciel de studio.` : 'Toutes les prises de l’artiste sont déjà dans le dossier.');
  };

  return (
    <div className="p-4 space-y-2 border-b border-white/5" data-testid="pt-panel">
      <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Pont studio</p>
      <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-xl bg-white/[0.03] px-2.5 py-2">
        <input type="checkbox" data-testid="pt-enabled" checked={s.enabled} onChange={e => sink.setSettings({ enabled: e.target.checked })} className="mt-0.5 h-5 w-5 accent-cyan-400" />
        <span className="text-[12px] leading-snug text-slate-200"><b>Dossier des prises</b> — chaque prise de l’artiste est aussi écrite en WAV horodaté (BWF), prête à importer en Spot dans ton logiciel de studio.</span>
      </label>
      {s.enabled && (
        <div className="space-y-2 rounded-xl bg-white/[0.02] p-2.5">
          <p className="text-[11px] text-slate-400" data-testid="pt-target" data-target={target}>{TARGET_LABEL[target]}</p>
          {target === 'bridge' && (
            <div className="space-y-1">
              <div className="flex gap-2">
                <input value={folderDraft} onChange={e => setFolderDraft(e.target.value)} onBlur={() => commitFolder(folderDraft)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitFolder(folderDraft); }}
                  placeholder={defaultFolder || 'Documents\\Nova Studio\\Prises studio'} aria-label="Dossier des prises" data-testid="pt-folder"
                  className="h-10 min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 text-[12px] text-white" />
                {desktopFolderPicker() && <button type="button" onClick={() => { void pickWindowsFolder(); }} className={`${btn} bg-white/10 text-white`}>Choisir…</button>}
              </div>
              {folderState && <p data-testid="pt-folder-state" className={`text-[11px] ${folderState.ok ? 'text-emerald-300' : 'text-red-300'}`}>{folderState.ok ? '✓ ' : '⚠️ '}{folderState.text}</p>}
            </div>
          )}
          {target !== 'bridge' && canPickFolder() && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" data-testid="pt-pick" onClick={() => { void pickBrowserFolder(); }} className={`${btn} bg-white/10 text-white`}>
                📁 {sink.dir ? `Dossier : ${sink.dir.name}` : 'Choisir le dossier'}
              </button>
              {sink.pendingPermission() > 0 && (
                <button type="button" data-testid="pt-grant" onClick={() => { void sink.grantFolder(); }} className={`${btn} bg-amber-400 text-black`}>
                  Autoriser le dossier ({sink.pendingPermission()} prise{sink.pendingPermission() > 1 ? 's' : ''} en attente)
                </button>
              )}
            </div>
          )}
          {target === 'download' && !canPickFolder() && (
            <p className="text-[11px] text-slate-400">Ce navigateur ne sait pas écrire dans un dossier : les prises arrivent dans Téléchargements. Avec Nova Studio (ou Chrome / Edge), elles vont directement dans ton dossier.</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] text-slate-400">Départ de la séance
              <input value={tcDraft} onChange={e => setTcDraft(e.target.value)} data-testid="pt-start"
                onBlur={() => { if (tcOk && tcDraft.trim() !== s.sessionStart) { sink.setSettings({ sessionStart: tcDraft.trim() }); } }}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && tcOk) sink.setSettings({ sessionStart: tcDraft.trim() }); }}
                aria-invalid={!tcOk} className={`mt-0.5 block h-10 w-32 rounded-xl border bg-black/40 px-3 font-mono text-[12px] text-white ${tcOk ? 'border-white/10' : 'border-red-400'}`} />
            </label>
            <label className="text-[11px] text-slate-400">Images / s
              <select value={s.fps} onChange={e => sink.setSettings({ fps: Number(e.target.value) as TimecodeFps })} data-testid="pt-fps"
                className="mt-0.5 block h-10 rounded-xl border border-white/10 bg-black/40 px-2 text-[12px] text-white">
                {TIMECODE_FPS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <fieldset className="flex gap-1" aria-label="Format des fichiers">
              {BWF_FORMATS.map(f => (
                <button key={f.id} type="button" title={f.hint} aria-pressed={s.format === f.id} data-testid={`pt-format-${f.id}`}
                  onClick={() => sink.setSettings({ format: f.id })}
                  className={`${btn} ${s.format === f.id ? 'bg-cyan-400 text-black' : 'bg-white/10 text-white'}`}>{f.label}</button>
              ))}
            </fieldset>
          </div>
          {!tcOk && <p className="text-[11px] text-red-300">Format attendu : HH:MM:SS:FF (ex. 01:00:00:00).</p>}
          <p className="text-[11px] text-slate-500">Même départ que ta séance (Setup › Session › Start). Dans ton logiciel de studio : mode Spot, glisse le fichier sur une piste, puis « Original Time Stamp ».</p>
          <button type="button" data-testid="pt-existing" onClick={sendExisting} className={`${btn} w-full bg-white/10 text-white`}>Envoyer aussi les prises déjà dans la séance</button>
          {note && <p role="status" className="text-[11px] text-sky-200">{note}</p>}
          {sink.entries.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto" aria-label="Prises envoyées vers ton logiciel de studio" data-testid="pt-entries">
              {sink.entries.slice(0, 12).map(e => <EntryRow key={e.clipId} e={e} fps={s.fps} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

/** Source du mix diffusé à l'artiste : NOVA, ou une entrée système (sortie de Pro Tools). */
export const MixSourcePicker: React.FC<{ mixOutOn: boolean }> = ({ mixOutOn }) => {
  const ctl = mixSource();
  const [, force] = useState(0);
  useEffect(() => ctl.subscribe(() => force(n => n + 1)), [ctl]);
  const [inputs, setInputs] = useState<{ deviceId: string; label: string }[]>([]);
  const refresh = () => { void ctl.listInputs().then(setInputs); };
  useEffect(() => {
    refresh();
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.addEventListener?.('devicechange', refresh);
    return () => md?.removeEventListener?.('devicechange', refresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Entrée choisie : ouverte tout de suite pour voir le niveau avant de diffuser.
  useEffect(() => {
    if (ctl.kind === 'input' && !ctl.view) void ctl.openInput().then(() => refresh());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl.kind, ctl.deviceId]);
  const value = ctl.kind === 'nova' ? 'nova' : `in:${ctl.deviceId}`;
  const v = ctl.view;
  const msg = v ? (v.error ? { text: v.error, warn: true } : inputVerdictMessage(v.verdict, v.label)) : null;
  const bar = (ms: number) => {
    const d = 10 * Math.log10(ms + 1e-20);
    return `${Math.max(0, Math.min(100, ((d + 60) / 60) * 100))}%`;
  };
  const options = useMemo(() => inputs.some(i => i.deviceId === ctl.deviceId) || !ctl.deviceId ? inputs : [...inputs, { deviceId: ctl.deviceId, label: 'Entrée choisie (débranchée ?)' }], [inputs, ctl.deviceId]);
  return (
    <div className="space-y-1.5 pt-1" data-testid="pt-mix">
      <label className="block text-[11px] text-slate-400">Mix diffusé à l’artiste
        <select value={value} data-testid="pt-mix-source"
          onChange={e => { const x = e.target.value; if (x === 'nova') ctl.setSource('nova'); else ctl.setSource('input' as MixSourceKind, x.slice(3)); }}
          className="mt-0.5 block h-10 w-full rounded-xl border border-white/10 bg-black/40 px-2 text-[12px] text-white">
          <option value="nova">Mix de NOVA (master)</option>
          {options.map(i => <option key={i.deviceId} value={`in:${i.deviceId}`}>Entrée système : {i.label}</option>)}
        </select>
      </label>
      {ctl.kind === 'input' && (
        <div className="space-y-1 rounded-xl bg-white/[0.03] p-2" data-testid="pt-mix-input">
          {v && !v.error && (
            <div className="space-y-0.5" aria-label="Niveau de l'entrée">
              {(['G', 'D'] as const).map(side => (
                <div key={side} className="flex items-center gap-2 text-[10px] text-slate-400">
                  <span className="w-3 font-black">{side}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded bg-white/10"><span className="block h-full bg-emerald-400" style={{ width: bar(side === 'G' ? v.msL : v.msR) }} /></span>
                  <span className="w-12 text-right font-mono" data-testid={`pt-mix-level-${side}`}>{levelLabel(side === 'G' ? v.msL : v.msR)}</span>
                </div>
              ))}
            </div>
          )}
          {msg && <p role="status" data-testid="pt-mix-verdict" data-verdict={v?.error ? 'erreur' : v?.verdict} className={`text-[11px] font-bold ${msg.warn ? 'text-amber-200' : 'text-emerald-300'}`}>{msg.warn ? '⚠️ ' : '🟢 '}{msg.text}</p>}
          <p className="text-[11px] text-slate-500">{mixOutOn ? 'Cette entrée part en direct chez l’artiste (Opus stéréo 510 kb/s).' : 'Active « Diffuser mon mix en direct » pour l’envoyer à l’artiste.'} Dans ton logiciel de studio, envoie la sortie de ta séance vers cette entrée (câble virtuel ou loopback de la carte).</p>
        </div>
      )}
    </div>
  );
};

export default ProToolsPanel;
