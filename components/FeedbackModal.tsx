import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  FEEDBACK_LIMITS, FeedbackCategory, FeedbackError, FeedbackFrequency, FeedbackStatus, HistoryItem, OPEN_FEEDBACK_EVENT,
  OpenFeedbackOptions, feedbackStore, flushFeedbackQueue, formatRef, getFeedbackUserEmail, getHistory, getQueue,
  refreshFeedbackStatuses, submitFeedback,
} from '../services/feedback';
import { catalogSupabase } from '../services/supabase';
import { collectFeedbackContext, describeContext, type FeedbackContext } from '../utils/feedbackContext';
import { recordAction } from '../utils/feedbackLog';
import { track } from '../utils/analytics';
import { FEEDBACK_SHORTCUT, isFeedbackShortcut } from '../utils/feedbackShortcut';

/**
 * « Signaler un bug / proposer une idée » : fenêtre montée une seule fois à la
 * racine (index.tsx), ouverte par le menu ☰, l'icône de la barre du haut, le
 * menu du téléphone, l'écran d'erreur ou Ctrl+Maj+B (utils/keymap).
 */

const CATEGORIES: { id: FeedbackCategory; label: string; icon: string; hint: string }[] = [
  { id: 'bug', label: 'Bug', icon: 'fa-bug', hint: 'Quelque chose ne marche pas' },
  { id: 'amelioration', label: 'Amélioration', icon: 'fa-wand-magic-sparkles', hint: 'Ça marche, mais ça pourrait être mieux' },
  { id: 'idee', label: 'Idée', icon: 'fa-lightbulb', hint: 'Une nouvelle fonction' },
];

const PLACEHOLDERS: Record<FeedbackCategory, { title: string; description: string }> = {
  bug: { title: 'Ex. : le son coupe quand j’enregistre', description: 'Ce que tu faisais, ce qui s’est passé, et ce que tu attendais.' },
  amelioration: { title: 'Ex. : pouvoir renommer une prise', description: 'Ce qui te gêne aujourd’hui, et comment ce serait mieux.' },
  idee: { title: 'Ex. : un accordeur pour la guitare', description: 'Ton idée, et à quoi elle te servirait.' },
};

const STATUS_VIEW: Record<FeedbackStatus, { label: string; cls: string; icon: string }> = {
  en_attente: { label: 'En attente d’envoi', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', icon: 'fa-clock' },
  recu: { label: 'Reçu', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30', icon: 'fa-inbox' },
  en_cours: { label: 'En cours', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30', icon: 'fa-screwdriver-wrench' },
  corrige: { label: 'Corrigé', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', icon: 'fa-check' },
  ferme: { label: 'Classé', cls: 'bg-white/5 text-slate-400 border-white/10', icon: 'fa-box-archive' },
  refuse: { label: 'Pas pu être envoyé', cls: 'bg-red-500/15 text-red-300 border-red-500/30', icon: 'fa-triangle-exclamation' },
};

export const statusLabel = (h: Pick<HistoryItem, 'status' | 'fixedIn'>): string =>
  h.status === 'corrige' && h.fixedIn ? `Corrigé dans la version ${h.fixedIn}` : STATUS_VIEW[h.status]?.label || h.status;

// --- Capture d'écran : masques et compression ----------------------------------------------

interface Rect { x: number; y: number; w: number; h: number }
const MAX_W = 1280;

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('image illisible'));
  img.src = src;
});

/** Image finale : réduite à 1280 px, zones masquées en noir (ou tout flouté), JPEG. */
export const renderScreenshot = async (src: string, masks: Rect[], blurAll: boolean): Promise<string> => {
  const img = await loadImage(src);
  const scale = Math.min(1, MAX_W / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (blurAll) {
    // Pixelisation forte : on devine la mise en page, pas le texte.
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(w / 28)); small.height = Math.max(1, Math.round(h / 28));
    small.getContext('2d')!.drawImage(img, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, w, h);
  } else {
    ctx.drawImage(img, 0, 0, w, h);
  }
  ctx.fillStyle = '#000';
  for (const m of masks) ctx.fillRect(m.x * w, m.y * h, m.w * w, m.h * h);
  let q = 0.72;
  let out = canvas.toDataURL('image/jpeg', q);
  while (out.length * 0.75 > FEEDBACK_LIMITS.screenshotBytes * 0.9 && q > 0.3) { q -= 0.12; out = canvas.toDataURL('image/jpeg', q); }
  return out;
};

const readFileAsDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

const canCaptureScreen = (): boolean => {
  try {
    const md = navigator.mediaDevices as any;
    return !!md?.getDisplayMedia && !/Android|iPhone|iPad/.test(navigator.userAgent);
  } catch { return false; }
};

const ScreenshotEditor: React.FC<{
  src: string; masks: Rect[]; blurAll: boolean;
  onMasks: (m: Rect[]) => void; onBlurAll: (b: boolean) => void; onRemove: () => void;
}> = ({ src, masks, blurAll, onMasks, onBlurAll, onRemove }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rel = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const toRect = (d: { x0: number; y0: number; x1: number; y1: number }): Rect => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });
  const live = drag ? toRect(drag) : null;
  return (
    <div className="space-y-2">
      <div
        ref={boxRef}
        data-nova-feedback-preview=""
        className="relative w-full overflow-hidden rounded-xl border border-white/15 bg-black select-none cursor-crosshair"
        style={{ touchAction: 'none' }}
        onPointerDown={e => { (e.target as Element).setPointerCapture?.(e.pointerId); const p = rel(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }}
        onPointerMove={e => { if (drag) { const p = rel(e); setDrag({ ...drag, x1: p.x, y1: p.y }); } }}
        onPointerUp={() => { if (live && live.w > 0.01 && live.h > 0.01) onMasks([...masks, live]); setDrag(null); }}
        onPointerCancel={() => setDrag(null)}
        aria-label="Aperçu de la capture : glisse dessus pour cacher une zone"
        role="img"
      >
        <img src={src} alt="" draggable={false} className="block w-full h-auto pointer-events-none" style={blurAll ? { filter: 'blur(10px)' } : undefined} />
        {[...masks, ...(live ? [live] : [])].map((m, i) => (
          <div key={i} className="absolute bg-black border border-white/30" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }} />
        ))}
      </div>
      <p className="text-[12px] text-slate-400">Glisse le doigt ou la souris sur l’aperçu pour cacher une zone (nom, e-mail, message…). Ce qui est caché ne quitte jamais ton appareil.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onBlurAll(!blurAll)} aria-pressed={blurAll}
          className={`min-h-[44px] px-3 rounded-lg border text-[13px] font-bold ${blurAll ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200' : 'bg-white/5 border-white/10 text-slate-200'}`}>
          <i className="fas fa-eye-slash mr-1.5" aria-hidden="true"></i>{blurAll ? 'Tout est masqué' : 'Tout masquer'}
        </button>
        {masks.length > 0 && (
          <button type="button" onClick={() => onMasks(masks.slice(0, -1))} className="min-h-[44px] px-3 rounded-lg border border-white/10 bg-white/5 text-[13px] font-bold text-slate-200">
            <i className="fas fa-rotate-left mr-1.5" aria-hidden="true"></i>Annuler la dernière zone
          </button>
        )}
        <button type="button" onClick={onRemove} className="min-h-[44px] px-3 rounded-lg border border-red-500/30 bg-red-500/10 text-[13px] font-bold text-red-300">
          <i className="fas fa-trash mr-1.5" aria-hidden="true"></i>Retirer la capture
        </button>
      </div>
    </div>
  );
};

// --- Fenêtre ------------------------------------------------------------------------------

interface DraftState { category: FeedbackCategory; title: string; description: string; frequency: FeedbackFrequency | null; email: string }
const DRAFT_KEY = 'nova_feedback_draft';
const emptyDraft = (): DraftState => ({ category: 'bug', title: '', description: '', frequency: null, email: '' });
const loadDraft = (): DraftState => {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d && typeof d === 'object') return { ...emptyDraft(), category: d.category || 'bug', title: String(d.title || ''), description: String(d.description || ''), frequency: d.frequency || null };
  } catch { /* */ }
  return emptyDraft();
};
// L'e-mail n'est pas gardé dans le brouillon (donnée personnelle).
const saveDraft = (d: DraftState) => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ category: d.category, title: d.title, description: d.description, frequency: d.frequency })); } catch { /* */ } };
const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ } };

type Done = { ref: string; status: 'envoye' | 'en_attente'; note?: string };

const fmtDate = (iso: string) => {
  try { return new Date(iso).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso.slice(0, 10); }
};

const FeedbackModal: React.FC<{ open: boolean; initial?: OpenFeedbackOptions; onClose: () => void }> = ({ open, initial, onClose }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'nouveau' | 'historique'>('nouveau');
  const [draft, setDraft] = useState<DraftState>(loadDraft);
  const [shot, setShot] = useState<string | null>(null);
  const [masks, setMasks] = useState<Rect[]>([]);
  const [blurAll, setBlurAll] = useState(false);
  const [hiddenForCapture, setHiddenForCapture] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ field?: string; text: string } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [context, setContext] = useState<FeedbackContext | null>(null);
  const [showTech, setShowTech] = useState(false);
  const [emailFromAccount, setEmailFromAccount] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const storeVersion = useSyncExternalStore(feedbackStore.subscribe, feedbackStore.getVersion, feedbackStore.getVersion);
  const history = useMemo(() => getHistory(), [storeVersion, open]);
  const pendingCount = useMemo(() => getQueue().length, [storeVersion, open]);

  const update = (patch: Partial<DraftState>) => setDraft(d => { const n = { ...d, ...patch }; saveDraft(n); return n; });

  // Ouverture : contexte frais, e-mail du compte, onglet demandé.
  useEffect(() => {
    if (!open) return;
    setContext(collectFeedbackContext());
    setError(null);
    // Chaque ouverture repart sur un formulaire (le brouillon non envoyé est gardé),
    // sauf demande explicite de « Mes signalements ».
    setTab(initial?.tab || 'nouveau');
    if (done) { setDone(null); setShot(null); setMasks([]); setBlurAll(false); }
    if (initial?.category || initial?.title) {
      update({ ...(initial.category ? { category: initial.category } : {}), ...(initial.title && !draft.title ? { title: initial.title } : {}) });
    }
    let alive = true;
    if (!draft.email) {
      const fallback = getFeedbackUserEmail();
      catalogSupabase.auth.getSession().then(({ data }) => {
        const mail = data?.session?.user?.email || fallback;
        if (alive && mail) { setDraft(d => (d.email ? d : { ...d, email: mail })); setEmailFromAccount(true); }
      }).catch(() => { if (alive && fallback) { setDraft(d => (d.email ? d : { ...d, email: fallback })); setEmailFromAccount(true); } });
    }
    void refreshFeedbackStatuses();
    const t = setTimeout(() => titleRef.current?.focus({ preventScroll: true }), 60);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  // Clavier : Échap ferme ; les touches tapées ici ne pilotent pas le studio derrière.
  useEffect(() => {
    const el = rootRef.current;
    if (!open || !el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (isFeedbackShortcut(e)) return;
      e.stopPropagation();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [open, onClose, hiddenForCapture]);

  // Coller une image (Ctrl+V) pendant que la fenêtre est ouverte.
  useEffect(() => {
    if (!open || tab !== 'nouveau') return;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files || []).find(f => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      void readFileAsDataUrl(file).then(src => { setShot(src); setMasks([]); setBlurAll(false); });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, tab]);

  const captureScreen = useCallback(async () => {
    setError(null);
    setHiddenForCapture(true);
    let stream: MediaStream | null = null;
    try {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      await new Promise(r => setTimeout(r, 350));
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d')!.drawImage(video, 0, 0);
      setShot(c.toDataURL('image/png')); setMasks([]); setBlurAll(false);
      recordAction('feedback:capture');
    } catch {
      setError({ text: 'Capture annulée. Tu peux aussi joindre une image enregistrée (bouton « Choisir une image »).' });
    } finally {
      stream?.getTracks().forEach(t => t.stop());
      setHiddenForCapture(false);
    }
  }, []);

  const onPickFile = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError({ text: 'Choisis une image (PNG, JPEG…).' }); return; }
    if (file.size > 25 * 1024 * 1024) { setError({ text: 'Image trop lourde (25 Mo au maximum).' }); return; }
    setShot(await readFileAsDataUrl(file)); setMasks([]); setBlurAll(false);
  };

  const resetForm = () => {
    clearDraft();
    setDraft(d => ({ ...emptyDraft(), email: d.email }));
    setShot(null); setMasks([]); setBlurAll(false); setError(null); setDone(null);
    setContext(collectFeedbackContext());
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (sending) return;
    setError(null);
    setSending(true);
    try {
      const screenshot = shot ? await renderScreenshot(shot, masks, blurAll) : null;
      const ctx = { ...(context || collectFeedbackContext()), capture: screenshot ? (blurAll ? 'jointe (tout masqué)' : masks.length ? `jointe (${masks.length} zone(s) masquée(s))` : 'jointe') : 'aucune' };
      const res = await submitFeedback({ ...draft, screenshot, context: ctx as unknown as Record<string, unknown> });
      recordAction('feedback:envoyer');
      track('feedback_sent', { category: draft.category, queued: res.status !== 'envoye', capture: !!screenshot });
      clearDraft();
      setDone(res);
    } catch (err) {
      if (err instanceof FeedbackError) {
        if (err.code === 'doublon' && err.ref) setDone({ ref: err.ref, status: 'envoye', note: err.message });
        else setError({ field: err.code, text: err.message });
      } else {
        setError({ text: 'Le signalement n’a pas pu être préparé. Réessaie ; s’il bloque encore, retire la capture.' });
      }
    } finally {
      setSending(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await flushFeedbackQueue({ force: true }); await refreshFeedbackStatuses(); } finally { setRefreshing(false); }
  };

  if (!open) return null;
  const ph = PLACEHOLDERS[draft.category];
  const summary = context ? describeContext(context) : [];
  const titleLen = draft.title.trim().length;
  const input = 'w-full rounded-xl border bg-black/30 px-3 py-2.5 text-[16px] sm:text-[14px] text-white placeholder:text-slate-500 outline-none focus:border-cyan-400/70';

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[900] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      style={hiddenForCapture ? { visibility: 'hidden' } : undefined}
      onMouseDown={e => { if (e.target === e.currentTarget && !sending) onClose(); }}
      data-nova-feedback=""
    >
      <div role="dialog" aria-modal="true" aria-labelledby="nova-feedback-title"
        className="relative w-full sm:max-w-xl max-h-[100dvh] sm:max-h-[92dvh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: 'var(--bg-surface, #101216)', color: 'var(--text-primary, #fff)' }}>
        {/* En-tête */}
        <div className="flex items-start gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-white/10">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-cyan-500/15 text-cyan-300 flex items-center justify-center"><i className="fas fa-comment-dots" aria-hidden="true"></i></div>
          <div className="min-w-0 flex-1">
            <h2 id="nova-feedback-title" className="text-[17px] font-black leading-tight">Signaler un bug ou proposer une idée</h2>
            <p className="text-[12px] text-slate-400 mt-0.5">On lit tout, et on corrige au prochain tour d’amélioration.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="w-11 h-11 -mr-1.5 -mt-1 shrink-0 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 flex items-center justify-center">
            <i className="fas fa-times text-lg" aria-hidden="true"></i>
          </button>
        </div>
        {/* Onglets */}
        <div className="flex gap-1 px-4 sm:px-5 pt-3" role="tablist" aria-label="Signalements">
          {([['nouveau', 'Nouveau'], ['historique', `Mes signalements${history.length ? ` (${history.length})` : ''}`]] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`min-h-[44px] px-4 rounded-xl text-[13px] font-bold transition-colors ${tab === id ? 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(34,211,238,0.45)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-5 py-4" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
          {tab === 'nouveau' && done && (
            <div className="py-6 text-center" role="status" data-nova-feedback-done="">
              <div className={`mx-auto mb-4 w-16 h-16 rounded-full flex items-center justify-center text-2xl ${done.status === 'envoye' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                <i className={`fas ${done.status === 'envoye' ? 'fa-check' : 'fa-cloud-arrow-up'}`} aria-hidden="true"></i>
              </div>
              <p className="text-[18px] font-black">Merci ! Ton signalement n° <span className="mono text-cyan-300 whitespace-nowrap">{formatRef(done.ref)}</span>{done.status === 'envoye' ? ' est bien reçu.' : ' est enregistré.'}</p>
              <p className="mt-2 text-[14px] text-slate-300 max-w-sm mx-auto">
                {done.note
                  ? done.note
                  : done.status === 'envoye'
                    ? 'Tu peux suivre ce qu’il devient dans « Mes signalements ».'
                    : 'Pas de connexion pour l’instant : il est gardé sur cet appareil et partira tout seul dès que la connexion revient.'}
              </p>
              <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
                <button type="button" onClick={() => setTab('historique')} className="min-h-[48px] px-5 rounded-xl bg-white/10 text-white font-bold">Voir mes signalements</button>
                <button type="button" onClick={resetForm} className="min-h-[48px] px-5 rounded-xl border border-white/15 text-slate-200 font-bold">En envoyer un autre</button>
                <button type="button" onClick={onClose} className="min-h-[48px] px-5 rounded-xl bg-cyan-400 text-black font-black">Fermer</button>
              </div>
            </div>
          )}

          {tab === 'nouveau' && !done && (
            <form onSubmit={submit} className="space-y-4" noValidate>
              {/* Catégorie */}
              <fieldset>
                <legend className="text-[12px] font-bold text-slate-300 mb-1.5">C’est…</legend>
                <div className="grid grid-cols-3 gap-2">
                  {CATEGORIES.map(c => (
                    <button key={c.id} type="button" aria-pressed={draft.category === c.id} onClick={() => update({ category: c.id })} title={c.hint}
                      className={`min-h-[60px] rounded-xl border px-2 py-2 text-[13px] font-bold flex flex-col items-center justify-center gap-1 transition-colors ${draft.category === c.id ? 'bg-cyan-500/15 border-cyan-400/60 text-white' : 'bg-white/[0.03] border-white/10 text-slate-300 hover:bg-white/5'}`}>
                      <i className={`fas ${c.icon} ${draft.category === c.id ? 'text-cyan-300' : 'text-slate-400'}`} aria-hidden="true"></i>{c.label}
                    </button>
                  ))}
                </div>
              </fieldset>

              {/* Titre */}
              <div>
                <label htmlFor="nova-fb-title" className="flex justify-between text-[12px] font-bold text-slate-300 mb-1.5">
                  <span>Titre court</span><span className={`font-normal ${titleLen > FEEDBACK_LIMITS.title - 10 ? 'text-amber-300' : 'text-slate-500'}`}>{titleLen}/{FEEDBACK_LIMITS.title}</span>
                </label>
                <input id="nova-fb-title" ref={titleRef} value={draft.title} maxLength={FEEDBACK_LIMITS.title} onChange={e => update({ title: e.target.value })}
                  placeholder={ph.title} autoComplete="off" aria-invalid={error?.field === 'titre'}
                  className={`${input} ${error?.field === 'titre' ? 'border-red-400/70' : 'border-white/10'}`} />
              </div>

              {/* Description */}
              <div>
                <label htmlFor="nova-fb-desc" className="block text-[12px] font-bold text-slate-300 mb-1.5">Description <span className="font-normal text-slate-500">(facultatif, mais ça nous aide beaucoup)</span></label>
                <textarea id="nova-fb-desc" value={draft.description} maxLength={FEEDBACK_LIMITS.description} rows={4} onChange={e => update({ description: e.target.value })}
                  placeholder={ph.description} className={`${input} resize-y min-h-[96px] border-white/10`} />
              </div>

              {/* Fréquence (bug) */}
              {draft.category === 'bug' && (
                <fieldset>
                  <legend className="text-[12px] font-bold text-slate-300 mb-1.5">Ça arrive…</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {([['toujours', 'À chaque fois'], ['parfois', 'Parfois']] as const).map(([id, label]) => (
                      <button key={id} type="button" aria-pressed={draft.frequency === id} onClick={() => update({ frequency: draft.frequency === id ? null : id })}
                        className={`min-h-[44px] rounded-xl border text-[13px] font-bold ${draft.frequency === id ? 'bg-cyan-500/15 border-cyan-400/60 text-white' : 'bg-white/[0.03] border-white/10 text-slate-300'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {/* Capture */}
              <div>
                <div className="text-[12px] font-bold text-slate-300 mb-1.5">Capture d’écran <span className="font-normal text-slate-500">(facultatif)</span></div>
                {shot ? (
                  <ScreenshotEditor src={shot} masks={masks} blurAll={blurAll} onMasks={setMasks} onBlurAll={setBlurAll}
                    onRemove={() => { setShot(null); setMasks([]); setBlurAll(false); }} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {canCaptureScreen() && (
                      <button type="button" onClick={() => { void captureScreen(); }} className="min-h-[44px] px-3 rounded-xl border border-white/10 bg-white/5 text-[13px] font-bold text-slate-100">
                        <i className="fas fa-camera mr-1.5" aria-hidden="true"></i>Capturer l’écran
                      </button>
                    )}
                    <button type="button" onClick={() => fileRef.current?.click()} className="min-h-[44px] px-3 rounded-xl border border-white/10 bg-white/5 text-[13px] font-bold text-slate-100">
                      <i className="fas fa-image mr-1.5" aria-hidden="true"></i>Choisir une image
                    </button>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" data-nova-feedback-file=""
                      onChange={e => { void onPickFile(e.target.files?.[0]); e.target.value = ''; }} />
                    <p className="w-full text-[12px] text-slate-500">Tu pourras cacher les zones privées avant l’envoi.{canCaptureScreen() ? ' Tu peux aussi coller une image (Ctrl+V).' : ''}</p>
                  </div>
                )}
              </div>

              {/* E-mail */}
              <div>
                <label htmlFor="nova-fb-email" className="block text-[12px] font-bold text-slate-300 mb-1.5">Ton e-mail <span className="font-normal text-slate-500">(facultatif, pour qu’on te réponde)</span></label>
                <input id="nova-fb-email" type="email" inputMode="email" autoComplete="email" value={draft.email} maxLength={FEEDBACK_LIMITS.email}
                  onChange={e => { setEmailFromAccount(false); setDraft(d => ({ ...d, email: e.target.value })); }}
                  placeholder="toi@exemple.com" aria-invalid={error?.field === 'email'}
                  className={`${input} ${error?.field === 'email' ? 'border-red-400/70' : 'border-white/10'}`} />
                {emailFromAccount && draft.email && <p className="mt-1 text-[11px] text-slate-500">Rempli avec ton compte. Efface-le si tu ne veux pas être recontacté.</p>}
              </div>

              {/* Ce qui sera joint */}
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3" data-nova-feedback-context="">
                <div className="text-[12px] font-black text-slate-200 mb-2"><i className="fas fa-paperclip mr-1.5 text-slate-400" aria-hidden="true"></i>Ce qui sera joint</div>
                <ul className="space-y-1">
                  {summary.map(s => (
                    <li key={s.label} className="text-[12px] text-slate-400 flex gap-2"><span className="text-slate-500 shrink-0 w-[150px] max-w-[45%]">{s.label}</span><span className="text-slate-300 min-w-0 break-words">{s.value}</span></li>
                  ))}
                  <li className="text-[12px] text-slate-400 flex gap-2"><span className="text-slate-500 shrink-0 w-[150px] max-w-[45%]">Capture</span><span className="text-slate-300">{shot ? (blurAll ? 'oui, tout masqué' : masks.length ? `oui, ${masks.length} zone(s) cachée(s)` : 'oui') : 'non'}</span></li>
                </ul>
                <p className="mt-2 text-[11px] text-emerald-300/80"><i className="fas fa-lock mr-1" aria-hidden="true"></i>Jamais de mot de passe, de jeton de connexion ni de son.</p>
                <button type="button" onClick={() => setShowTech(v => !v)} aria-expanded={showTech} className="mt-1 min-h-[36px] text-[12px] font-bold text-cyan-300 underline-offset-2 hover:underline">
                  {showTech ? 'Masquer le détail technique' : 'Voir le détail technique'}
                </button>
                {showTech && context && (
                  <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 text-[10px] leading-snug text-slate-400 whitespace-pre-wrap break-all">{JSON.stringify(context, null, 1)}</pre>
                )}
              </div>

              {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-200">{error.text}</p>}

              <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-1">
                <button type="button" onClick={onClose} className="min-h-[48px] px-5 rounded-xl border border-white/15 text-slate-200 font-bold">Plus tard</button>
                <button type="submit" disabled={sending || titleLen < FEEDBACK_LIMITS.titleMin} data-nova-feedback-send=""
                  className="min-h-[48px] px-6 rounded-xl bg-cyan-400 text-black font-black disabled:opacity-40 disabled:cursor-not-allowed">
                  {sending ? <><i className="fas fa-spinner fa-spin mr-2" aria-hidden="true"></i>Envoi…</> : <><i className="fas fa-paper-plane mr-2" aria-hidden="true"></i>Envoyer</>}
                </button>
              </div>
              {titleLen < FEEDBACK_LIMITS.titleMin && <p className="text-right text-[11px] text-slate-500 -mt-2">Écris un titre pour pouvoir envoyer.</p>}
            </form>
          )}

          {tab === 'historique' && (
            <div className="space-y-3" data-nova-feedback-history="">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] text-slate-400 min-w-0">
                  {pendingCount > 0 ? `${pendingCount} en attente d’envoi sur cet appareil.` : 'Le statut se met à jour quand on s’en occupe.'}
                </p>
                <button type="button" onClick={() => { void refresh(); }} disabled={refreshing} className="min-h-[40px] shrink-0 px-3 rounded-lg border border-white/10 bg-white/5 text-[12px] font-bold text-slate-200 disabled:opacity-50">
                  <i className={`fas fa-rotate mr-1.5 ${refreshing ? 'fa-spin' : ''}`} aria-hidden="true"></i>{pendingCount > 0 ? 'Réessayer maintenant' : 'Actualiser'}
                </button>
              </div>
              {history.length === 0 ? (
                <div className="py-10 text-center">
                  <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-white/5 text-slate-400 flex items-center justify-center"><i className="fas fa-inbox" aria-hidden="true"></i></div>
                  <p className="text-[14px] font-bold text-slate-200">Tu n’as encore rien signalé.</p>
                  <p className="text-[12px] text-slate-500 mt-1">Un bug, une idée ? On lit tout.</p>
                  <button type="button" onClick={() => setTab('nouveau')} className="mt-4 min-h-[44px] px-4 rounded-xl bg-cyan-400 text-black font-black">Signaler quelque chose</button>
                </div>
              ) : (
                <ul className="space-y-2">
                  {history.map(h => {
                    const sv = STATUS_VIEW[h.status] || STATUS_VIEW.recu;
                    const cat = CATEGORIES.find(c => c.id === h.category);
                    return (
                      <li key={h.ref} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                        <div className="flex items-start gap-3">
                          <i className={`fas ${cat?.icon || 'fa-comment'} mt-1 text-slate-400`} aria-label={cat?.label}></i>
                          <div className="min-w-0 flex-1">
                            <p className="text-[14px] font-bold text-white break-words">{h.title}</p>
                            <p className="text-[11px] text-slate-500 mt-0.5">n° <span className="mono">{formatRef(h.ref)}</span> · {fmtDate(h.createdAt)}</p>
                            {h.note && <p className="text-[11px] text-slate-400 mt-1">{h.note}</p>}
                          </div>
                          <span className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold ${sv.cls}`}>
                            <i className={`fas ${sv.icon}`} aria-hidden="true"></i>{statusLabel(h)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-[11px] text-slate-500">Sans compte, le suivi se fait sur cet appareil. Connecte-toi pour retrouver tes signalements partout.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** Monté une fois à la racine : écoute openFeedback() et le raccourci clavier. */
export { FEEDBACK_SHORTCUT };
export default FeedbackModal;
