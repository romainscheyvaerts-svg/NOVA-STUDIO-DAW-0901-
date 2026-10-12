import React, { useEffect, useRef, useState } from 'react';
import type { ReceptionView, TakeProgress } from '../utils/liveTake';
import type { NetTestResult } from '../services/NetTest';

/**
 * B3 · Prise envoyée pendant l'enregistrement : ce que voient l'artiste et l'ingé.
 *  - SendStatus (celui qui enregistre) : « Prise en cours d'envoi… 80 % », « Prise reçue par Max ✓ » ;
 *  - ReceptionCard (les autres) : la prise « en cours de réception », forme d'onde qui avance ;
 *  - NetTestCard : test de connexion en un bouton, verdict en clair et prédiction.
 */

const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

/** Phrase d'état de l'envoi de la dernière prise (null : rien à dire). */
export const sendStatusText = (p: TakeProgress | null, recording: boolean, to: string): { text: string; tone: 'busy' | 'ok' | 'warn' } | null => {
  if (!p || p.cancelled) return null;
  if (!p.ended) {
    if (!recording) return null;
    return p.waiting
      ? { text: `📡 Réseau coupé : ta prise est gardée sur ton appareil, elle partira toute seule au retour du réseau.`, tone: 'warn' }
      : { text: `● Ta prise part en direct chez ${to} (${fmt(p.framesSent / (p.sr || 48000))} déjà envoyées)`, tone: 'busy' };
  }
  if (p.receivedBy.length) return { text: `Prise reçue par ${p.receivedBy.join(' et ')} ✓`, tone: 'ok' };
  if (p.done) return { text: `Prise envoyée ✓ — ${to} la reçoit…`, tone: 'busy' };
  const pct = p.total > 0 ? Math.min(99, Math.floor((100 * p.sent) / p.total)) : 0;
  return p.waiting
    ? { text: `Prise en cours d'envoi… ${pct} % — en attente du réseau : elle est gardée sur ton appareil et partira toute seule.`, tone: 'warn' }
    : { text: `Prise en cours d'envoi… ${pct} %`, tone: 'busy' };
};

export const SendStatus: React.FC<{ progress: TakeProgress | null; recording: boolean; to: string; className?: string }> = ({ progress, recording, to, className }) => {
  // « Reçue ✓ » reste 10 s à l'écran, « envoyée » 30 s (personne pour la recevoir), puis s'efface.
  const [, setTick] = useState(0);
  const until = progress?.receivedAt ? progress.receivedAt + 10000 : progress?.doneAt ? progress.doneAt + 30000 : 0;
  useEffect(() => {
    if (!until) return;
    const id = window.setTimeout(() => setTick(x => x + 1), Math.max(0, until - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [until]);
  const s = sendStatusText(progress, recording, to);
  if (!s || (until && Date.now() > until)) return null;
  const tone = s.tone === 'ok' ? 'bg-emerald-500/15 text-emerald-100 border-emerald-400/30' : s.tone === 'warn' ? 'bg-amber-500/15 text-amber-50 border-amber-400/30' : 'bg-cyan-500/10 text-cyan-50 border-cyan-400/30';
  const pct = progress && progress.ended && !progress.done && progress.total > 0 ? Math.min(100, Math.round((100 * progress.sent) / progress.total)) : null;
  return (
    <div role="status" data-testid="take-send-status" data-tone={s.tone} data-received={progress?.receivedBy.length ? '1' : '0'} className={`rounded-2xl border px-4 py-2.5 text-[13px] font-bold ${tone} ${className || ''}`}>
      <p>{s.text}</p>
      {pct !== null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10" aria-hidden>
          <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
};

const Wave: React.FC<{ peaks: number[]; sr: number; color: string }> = ({ peaks, sr, color }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const w = cv.clientWidth || 260, h = cv.clientHeight || 40;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    // Fenêtre qui avance : au moins 30 s affichées, la fin de la prise toujours visible.
    const perSec = sr / 2048;
    const span = Math.max(peaks.length, Math.ceil(30 * perSec));
    const step = span / w;
    g.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(x * step), b = Math.max(a + 1, Math.floor((x + 1) * step));
      if (a >= peaks.length) break;
      let m = 0;
      for (let i = a; i < Math.min(b, peaks.length); i++) if (peaks[i] > m) m = peaks[i];
      const bh = Math.max(1, m * (h - 2));
      g.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [peaks, peaks.length, sr, color]);
  return <canvas ref={ref} className="h-10 w-full" aria-hidden />;
};

const STATE_TEXT: Record<ReceptionView['state'], string> = {
  reception: 'en cours de réception',
  verification: 'vérification…',
  prete: 'reçue en entier, vérifiée',
  posee: 'posée dans la piste ✓',
  erreur: 'abîmée en route : renvoi demandé',
  annulee: 'annulée',
};

export const ReceptionCard: React.FC<{ views: ReceptionView[]; recordingNames: string[]; trackName: (id: string) => string }> = ({ views, recordingNames, trackName }) => {
  const shown = views.filter(v => v.state !== 'annulee').slice(-2);
  if (!shown.length) return null;
  return (
    <div data-testid="lt-reception" className="space-y-2" aria-live="polite">
      {shown.map(v => {
        const live = recordingNames.includes(v.from) && v.state === 'reception';
        return (
          <div key={v.take} data-testid="lt-reception-take" data-state={v.state} data-take={v.take} className="rounded-2xl border border-white/10 bg-nv-surface/95 p-3 shadow-2xl backdrop-blur">
            <p className="text-[12px] font-black text-white">
              {live ? <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" /> : null}
              Prise de {v.from} · « {trackName(v.trackId)} »
            </p>
            <p className={`text-[11px] font-bold ${v.state === 'posee' || v.state === 'prete' ? 'text-emerald-300' : v.state === 'erreur' ? 'text-red-300' : 'text-cyan-200'}`}>
              {live ? `${v.from} chante… ${fmt(v.seconds)} déjà reçues` : `${STATE_TEXT[v.state]}${v.state === 'reception' ? ` · ${fmt(v.seconds)}` : ''}`}
            </p>
            <Wave peaks={v.peaks} sr={v.sr} color={v.state === 'posee' ? '#34d399' : '#22d3ee'} />
          </div>
        );
      })}
    </div>
  );
};

export const NetTestCard: React.FC<{ run: () => Promise<NetTestResult>; big?: boolean; who?: string }> = ({ run, big, who }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<NetTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy('Test en cours…'); setErr(null);
    try { setRes(await run()); } catch (e: any) { setErr(e?.message || 'Test impossible'); } finally { setBusy(null); }
  };
  const tone = res?.verdict.level === 'parfait' ? 'text-emerald-200' : res?.verdict.level === 'ok' ? 'text-amber-100' : 'text-red-200';
  return (
    <div data-testid="net-test" data-level={res?.verdict.level || ''} className="space-y-2">
      <button type="button" data-testid="net-test-run" onClick={go} disabled={!!busy}
        className={`${big ? 'min-h-[52px] rounded-2xl text-[15px]' : 'h-10 rounded-xl text-[12px]'} w-full bg-white/10 px-3 font-black disabled:opacity-50`}>
        {busy || (res ? '🔁 Refaire le test de connexion' : '📶 Tester ma connexion')}
      </button>
      {res && (
        <div data-testid="net-test-result" className="space-y-1 rounded-2xl bg-white/[0.04] p-3">
          <p data-testid="net-test-verdict" className={`text-[14px] font-black ${tone}`}>{res.verdict.level === 'parfait' ? '✅' : res.verdict.level === 'ok' ? '👍' : '⚠️'} {res.verdict.title}</p>
          <p className="text-[12px] text-slate-300">{res.verdict.advice}</p>
          <p data-testid="net-test-prediction" className="text-[12px] text-slate-200">{who ? res.verdict.arrivalText.replace('l’ingé', who) : res.verdict.arrivalText}</p>
          {!big && <p className="text-[11px] text-slate-500">Envoi {res.measure.upKbps >= 1000 ? `${(res.measure.upKbps / 1000).toFixed(1)} Mb/s` : `${res.measure.upKbps} kb/s`} · réponse {res.measure.rttMs < 9999 ? `${res.measure.rttMs} ms` : '—'} · pertes {res.measure.lossPct} %</p>}
        </div>
      )}
      {err && <p role="alert" className="text-[12px] text-red-200">{err}</p>}
    </div>
  );
};
