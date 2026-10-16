import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SeparationResult } from '../services/NovaBridge';
import { bufferChannels, formatBytes, formatSeconds, StemSet, stemMidiConversion, StemsRights, stemTrackName } from '../services/StemSeparation';
import { cancelWebSeparation, deleteWebModel, detectWebStemsCaps, freeStorageBytes, runWebSeparation, webModelCached, webStemsJob, WebStemsJob } from '../services/StemsWeb';
import {
  describeWebStemsError, formatEstimate, STEMS_WEB_MODEL, stemsWebDownloadBytes, WebStemSet, WebStemsCaps, webStemsVerdict,
} from '../utils/stemsWeb';
import { DESKTOP_APP_DOWNLOAD_URL } from '../utils/desktopApp';

/**
 * Lot 6c : « Séparer en stems » sur le SITE (sans l'appli Windows), dans le navigateur.
 * Voix + instru (2 stems) ou voix, batterie, basse, autres (4 stems), avec Demucs v4 (Meta, MIT)
 * sur la carte graphique (WebGPU) ou, à défaut, sur le processeur (plus lent).
 * Modèle téléchargé une fois (taille annoncée, avertissement réseau mobile), gardé sur l'appareil.
 * Progression, temps restant, Annuler ; fermer la fenêtre ne l'arrête pas (pastille).
 * L'appli Windows garde Demucs en local (6 stems, voix lead / chœurs, bien plus rapide).
 */

export interface WebTarget { trackId: string; clipId: string; clipName: string }
export interface WebApplied { key: string; name: string; trackId: string; clipId: string }

const btn = 'min-h-11 px-3 py-2 rounded-xl text-[12px] leading-tight font-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const primary = `${btn} bg-cyan-500 text-black hover:bg-cyan-400`;
const secondary = `${btn} bg-white/5 text-slate-300 hover:bg-white/10 font-bold`;

const useWebJob = () => useSyncExternalStore(webStemsJob.subscribe, webStemsJob.get);

const Bar: React.FC<{ pct: number; label: string; testid?: string }> = ({ pct, label, testid }) => (
  <div className="space-y-1.5" data-testid={testid}>
    <div className="h-2.5 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
      <div className="h-full bg-gradient-to-r from-cyan-500 to-fuchsia-500 transition-all duration-300" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
    <p className="text-[11px] text-slate-300">{label}</p>
  </div>
);

const backendLabel = (b: 'webgpu' | 'wasm') => (b === 'webgpu' ? 'carte graphique' : 'processeur');

/** Pourcentage et libellé d'une séparation en cours (fenêtre et pastille). */
export function webJobProgress(j: WebStemsJob): { pct: number; label: string } {
  if (j.phase === 'download' && j.download) {
    const { loaded, total } = j.download;
    return { pct: (100 * loaded) / Math.max(1, total), label: `Téléchargement du modèle : ${formatBytes(loaded)} sur ${formatBytes(total)} (une seule fois)` };
  }
  if (j.phase === 'separate' && j.progress) {
    const { done, total, etaSec } = j.progress;
    const eta = etaSec == null ? 'temps restant calculé après le 1er passage' : etaSec < 2 ? 'presque fini' : `reste environ ${formatSeconds(etaSec)}`;
    return { pct: (100 * done) / Math.max(1, total), label: `Séparation sur le ${backendLabel(j.backend)} : passage ${done} sur ${total} · ${eta}` };
  }
  if (j.phase === 'verify') return { pct: 100, label: 'Vérification du modèle téléchargé…' };
  if (j.phase === 'load') return { pct: 100, label: 'Préparation du modèle…' };
  if (j.phase === 'separate') return { pct: 0, label: `Séparation sur le ${backendLabel(j.backend)}…` };
  return { pct: 0, label: j.message || 'Chargement du moteur de calcul…' };
}

/** Pastille en bas à droite quand la fenêtre est fermée et qu'une séparation tourne (ou vient de finir). */
export const StemsWebPill: React.FC = () => {
  const j = useWebJob();
  if (!j) return null;
  const running = j.phase !== 'done' && j.phase !== 'error';
  const p = webJobProgress(j);
  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[650] sm:w-80 rounded-2xl border border-cyan-500/30 bg-nv-surface/95 p-3 shadow-2xl space-y-2" data-testid="stems-web-pill">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-black text-white truncate">Stems ({j.set} stems) · {j.target.clipName}</span>
        {!running && <button type="button" aria-label="Fermer" onClick={() => webStemsJob.set(null)} className="min-h-9 min-w-9 text-slate-400 hover:text-white text-[16px]">×</button>}
      </div>
      {running && <>
        <Bar pct={p.pct} label={p.label} />
        <button type="button" onClick={cancelWebSeparation} className="min-h-9 text-[11px] font-bold text-rose-300 hover:text-rose-200">Annuler</button>
      </>}
      {j.phase === 'done' && <p className="text-[11px] text-emerald-300">✅ {j.summary}</p>}
      {j.phase === 'error' && <p className="text-[11px] text-rose-300">❌ {j.error}</p>}
    </div>
  );
};

interface Props {
  target: WebTarget;
  getClipBuffer: (trackId: string, clipId: string) => AudioBuffer | null;
  onApply: (target: WebTarget, result: SeparationResult, set: StemSet) => WebApplied[] | null;
  onClose: () => void;
  rights: StemsRights;
  /** « Basse → MIDI »… après la séparation (même fenêtre Audio → MIDI que sur Windows). */
  onMidi?: (a: WebApplied) => void;
}

const SET_CHOICES: { set: WebStemSet; title: string; detail: string; uses: string }[] = [
  { set: 2, title: 'Voix + instru (2 stems)', detail: 'Voix (stem) et Instru (stem).', uses: 'Enlever la voix d’une instru (karaoké, beat), isoler la voix d’un morceau de référence.' },
  { set: 4, title: 'Voix, batterie, basse, autres (4 stems)', detail: 'Une piste par famille d’instruments.', uses: 'Refaire un sample, récupérer une batterie ou une ligne de basse.' },
];

const StemsWebPanel: React.FC<Props> = ({ target, getClipBuffer, onApply, onClose, rights, onMidi }) => {
  const current = useWebJob();
  const [caps, setCaps] = useState<WebStemsCaps | null>(null);
  const [cached, setCached] = useState<number | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [set, setSet] = useState<WebStemSet>(2);
  const [confirmMobile, setConfirmMobile] = useState(false);
  const [forceWeak, setForceWeak] = useState(false);
  const [cancelledNote, setCancelledNote] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cacheTick, setCacheTick] = useState(0);

  useEffect(() => {
    let alive = true;
    detectWebStemsCaps().then(c => { if (alive) setCaps(c); }).catch(() => { if (alive) setCaps({ webgpu: false, mobile: false, cellular: false, networkUnknown: true }); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    let alive = true;
    webModelCached().then(b => { if (alive) setCached(b); });
    freeStorageBytes().then(b => { if (alive) setFreeBytes(b); });
    return () => { alive = false; };
  }, [cacheTick]);

  const buffer = getClipBuffer(target.trackId, target.clipId);
  const clipSeconds = buffer?.duration || 0;
  const verdict = useMemo(() => (caps ? webStemsVerdict(caps, clipSeconds) : null), [caps, clipSeconds]);
  const dlBytes = stemsWebDownloadBytes();
  const needDownload = cached === 0;

  const start = async () => {
    if (!verdict) return;
    const buf = getClipBuffer(target.trackId, target.clipId);
    if (!buf) { setStartError('Le son de ce clip n’est pas encore chargé.'); return; }
    if (needDownload && caps?.cellular && !confirmMobile) { setConfirmMobile(true); return; }
    setConfirmMobile(false); setCancelledNote(false); setStartError(null);
    const id = `webstems-${Date.now().toString(36)}`;
    const t = target;
    const s = set;
    try {
      const res = await runWebSeparation({ id, target: t, set: s, backend: verdict.backend }, bufferChannels(buf), buf.sampleRate);
      const sep: SeparationResult = {
        stems: res.stems.map(x => ({ key: x.key, label: stemTrackName(x.key), channels: x.channels, sampleRate: buf.sampleRate, path: '' })),
        seconds: res.seconds, device: res.backend, outdir: '', kept: false,
      };
      const applied = onApply(t, sep, s);
      if (!applied) {
        webStemsJob.patch(id, { phase: 'error', error: 'Le clip a été supprimé pendant la séparation : rien n’a été ajouté.' });
        return;
      }
      webStemsJob.patch(id, {
        phase: 'done', applied,
        summary: `${applied.length} pistes ajoutées : ${applied.map(a => a.name).join(', ')} (en ${formatSeconds(res.seconds)}, ${backendLabel(res.backend)})`,
      });
      setCacheTick(x => x + 1);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'cancelled') { if (webStemsJob.get()?.id === id) webStemsJob.set(null); setCancelledNote(true); return; }
      webStemsJob.patch(id, { phase: 'error', error: describeWebStemsError(e), errorCode: code });
      setCacheTick(x => x + 1);
    }
  };

  const running = current && current.phase !== 'done' && current.phase !== 'error' ? current : null;
  const finished = current && !running && current.target.clipId === target.clipId ? current : null;

  // ─── Calcul en cours ───
  if (running) {
    const same = running.target.clipId === target.clipId;
    const p = webJobProgress(running);
    const elapsed = (Date.now() - running.startedAt) / 1000;
    return (
      <div className="space-y-3" data-testid="stems-web-running">
        {!same && <p className="text-[11px] text-amber-300">Une séparation est déjà en cours sur « {running.target.clipName} ».</p>}
        <Bar pct={p.pct} label={p.label} testid="stems-web-progress" />
        {running.fallback && <p className="text-[11px] text-amber-200" role="status" data-testid="stems-web-fallback">{running.fallback}</p>}
        <p className="text-[11px] text-slate-400">
          {running.phase === 'download'
            ? 'Le modèle se télécharge une seule fois, puis il reste sur cet appareil. '
            : `Calcul sur cet appareil, rien n’est envoyé sur Internet · ${formatSeconds(elapsed)} écoulées. `}
          Tu peux fermer cette fenêtre : la séparation continue (pastille en bas à droite). Garde cet onglet ouvert.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => { cancelWebSeparation(); }} className={`${secondary} flex-1`} data-testid="stems-web-cancel">Annuler</button>
          <button type="button" onClick={onClose} className={`${primary} flex-[2]`}>Continuer en arrière-plan</button>
        </div>
      </div>
    );
  }

  if (!caps || !verdict || cached === null) {
    return <p className="text-[12px] text-slate-400" data-testid="stems-web-checking">Vérification de ton appareil (carte graphique, place disponible)…</p>;
  }

  // ─── Réseau mobile : confirmation avant le gros téléchargement ───
  if (confirmMobile) {
    return (
      <div className="space-y-3" data-testid="stems-web-cellular">
        <p className="text-[13px] font-bold text-amber-200" role="alert">📶 Tu sembles être sur un réseau mobile (4G / 5G).</p>
        <p className="text-[12px] text-slate-300">
          La première séparation télécharge le modèle : <b>{formatBytes(dlBytes)}</b>, une seule fois. Sur ton forfait mobile, ça compte.
          Le mieux : attendre d’être en Wi-Fi.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <button type="button" onClick={() => setConfirmMobile(false)} className={`${primary} sm:flex-[2]`} data-testid="stems-web-wait-wifi">Attendre le Wi-Fi</button>
          <button type="button" onClick={() => { void start(); }} className={`${secondary} sm:flex-1`} data-testid="stems-web-download-anyway">Télécharger quand même ({formatBytes(dlBytes)})</button>
        </div>
      </div>
    );
  }

  const weak = verdict.level === 'too-weak' && !forceWeak;
  const tooLong = clipSeconds > 0 && verdict.reason?.startsWith('Clip trop long');
  const lowSpace = needDownload && freeBytes != null && freeBytes < STEMS_WEB_MODEL.sources[0].bytes * 1.2;
  const midi = (finished?.applied || []).filter(a => stemMidiConversion(a.key));

  return (
    <div className="space-y-3" data-testid="stems-web">
      {finished?.phase === 'done' && <p className="text-[12px] text-emerald-300" role="status" data-testid="stems-web-done">✅ {finished.summary}</p>}
      {finished?.phase === 'done' && midi.length > 0 && onMidi && (
        <div className="space-y-1.5" data-testid="stems-midi">
          <p className="text-[11px] text-slate-400">Transformer un stem en piste MIDI (aperçu avant de valider, Ctrl+Z pour revenir) :</p>
          <div className="flex flex-wrap gap-1.5">
            {midi.map(a => {
              const conv = stemMidiConversion(a.key)!;
              return (
                <button key={a.trackId} type="button" onClick={() => onMidi(a)} title={conv.tip}
                  className="min-h-9 px-2.5 py-1.5 rounded-lg border border-fuchsia-400/40 bg-fuchsia-500/10 text-[11px] font-bold text-fuchsia-100 hover:bg-fuchsia-500/20">
                  🎹 {conv.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {cancelledNote && !finished && <p className="text-[12px] text-slate-300" role="status" data-testid="stems-cancelled">Séparation annulée : aucune piste ajoutée.</p>}
      {(finished?.phase === 'error' || startError) && <p className="text-[12px] text-rose-300" role="alert" data-testid="stems-error">❌ {finished?.error || startError}</p>}

      {!finished && (
        <p className="text-[12px] text-slate-300">
          Séparation <b>dans ton navigateur</b>, gratuite : le calcul se fait sur cet appareil, ton son n’est envoyé nulle part.
        </p>
      )}

      {/* Appareil trop juste : le conseil du PC passe en premier (au téléphone, il serait sous la ligne de flottaison). */}
      {weak && (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-500/10 p-3 space-y-2" data-testid="stems-web-weak" role="alert">
          <p className="text-[12px] text-amber-100">{verdict.reason}</p>
          <p className="text-[11px] text-slate-300">Sur ton PC, l’appli <b>Nova Studio</b> sépare un morceau en quelques secondes à une minute : ouvre ton projet (il est dans ton compte), clic droit sur le clip → « Séparer en stems ».</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <a href={DESKTOP_APP_DOWNLOAD_URL} className={`${primary} sm:flex-[2] flex items-center justify-center`} data-testid="stems-web-pc">Séparer sur ton PC (Nova Studio)</a>
            {!tooLong && <button type="button" onClick={() => setForceWeak(true)} className={`${secondary} sm:flex-1`} data-testid="stems-web-force">Essayer quand même</button>}
          </div>
        </div>
      )}

      <div role="radiogroup" aria-label="Choix des stems" className="space-y-2">
        {SET_CHOICES.map(c => (
          <label key={c.set} className={`flex items-start gap-3 rounded-2xl border p-3 cursor-pointer ${set === c.set ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 hover:bg-white/[0.04]'}`} data-testid={`stems-choice-${c.set}`}>
            <input type="radio" name="stems-web-count" className="mt-1" checked={set === c.set} onChange={() => setSet(c.set)} aria-describedby={`stems-web-${c.set}-uses`} />
            <span className="min-w-0">
              <span className="block text-[13px] font-bold text-white">{c.title}</span>
              <span className="block text-[11px] text-slate-300">{c.detail}</span>
              <span id={`stems-web-${c.set}-uses`} className="block text-[11px] text-slate-500">{c.uses}</span>
            </span>
          </label>
        ))}
        <p className="text-[11px] text-slate-500" data-testid="stems-web-more">
          <b>6 stems</b> (guitare, piano) et <b>voix lead / chœurs</b> : dans l’appli Windows <b>Nova Studio</b>, gratuite, 5 à 20 fois plus rapide.
        </p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-1.5 text-[11px]" data-testid="stems-web-device">
        <p className={verdict.backend === 'webgpu' ? 'text-emerald-300' : 'text-amber-200'} data-testid="stems-web-backend" data-backend={verdict.backend}>
          {verdict.backend === 'webgpu'
            ? <>⚡ Calcul sur la <b>carte graphique</b> de cet appareil.</>
            : <>🐢 Pas d’accès à la carte graphique dans ce navigateur (WebGPU) : calcul sur le <b>processeur</b>, nettement plus lent. Chrome ou Edge à jour vont plus vite.</>}
          {clipSeconds > 0 && <> Pour ce clip ({formatSeconds(clipSeconds)}) : compte <b>{formatEstimate(verdict.estimate)}</b>.</>}
        </p>
        {needDownload ? (
          <p className="text-slate-300" data-testid="stems-web-size">
            ⬇ Première fois : <b>{formatBytes(dlBytes)}</b> à télécharger (modèle Demucs + moteur de calcul), gardés ensuite sur cet appareil.
            {caps.mobile && !caps.cellular && <> Sur réseau mobile, ça compte dans ton forfait : mieux vaut le Wi-Fi.</>}
          </p>
        ) : (
          <p className="text-slate-400" data-testid="stems-web-cached">
            ✓ Modèle déjà sur cet appareil ({formatBytes(cached)}) : rien à télécharger.{' '}
            <button type="button" className="underline decoration-dotted hover:text-white" data-testid="stems-web-forget"
              onClick={async () => { await deleteWebModel(); setCacheTick(x => x + 1); }} title="Libère la place du modèle sur cet appareil ; il sera retéléchargé à la prochaine séparation.">
              Libérer la place
            </button>
          </p>
        )}
        {verdict.warning && <p className="text-amber-200" data-testid="stems-web-warning">{verdict.warning}</p>}
        {lowSpace && <p className="text-amber-200" data-testid="stems-web-lowspace">Peu de place libre pour garder le modèle : il sera peut-être retéléchargé la prochaine fois.</p>}
      </div>

      {rights.kind !== 'own' && (
        <p className="text-[11px] text-amber-200/90" data-testid="stems-beat-note">
          🔒 Stems du beat : ils gardent la licence du beat (jamais gelés en fichier, samplés ni envoyés à l’ingé ; export selon ta licence).
        </p>
      )}
      <p className="text-[11px] text-slate-500">Les stems arrivent en nouvelles pistes calées au même endroit ; le clip d’origine est coupé (M pour le réentendre).</p>
      <p className="text-[10px] text-slate-500" data-testid="stems-web-credit">Modèle Demucs v4 de Meta (licence MIT), moteur ONNX Runtime Web de Microsoft (licence MIT).</p>

      <div className="flex gap-2">
        <button type="button" onClick={onClose} className={`${secondary} flex-1`}>{finished?.phase === 'done' ? 'Fermer' : 'Annuler'}</button>
        <button type="button" onClick={() => { void start(); }} disabled={weak || clipSeconds <= 0} className={`${primary} flex-[2]`} data-testid="stems-start">
          {finished?.phase === 'error' ? 'Réessayer' : `Séparer en ${set} stems`}
          {needDownload && <span className="block text-[10px] font-bold text-black/70">téléchargement : {formatBytes(dlBytes)}, une fois</span>}
        </button>
      </div>
    </div>
  );
};

export default StemsWebPanel;
