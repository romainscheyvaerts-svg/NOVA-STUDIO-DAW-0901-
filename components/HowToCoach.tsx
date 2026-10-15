import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  applicableSteps, findTargetElement, isStepDone, type Guide, type GuideFacts, type GuideStep,
} from '../utils/guides';

/**
 * Mode « Montre-moi » d'un parcours (utils/guides) : une petite carte en bas de l'écran
 * (« Étape 2 / 4 »), un anneau autour du bouton à toucher, et on avance tout seul quand
 * l'étape est faite (clic sur le bouton montré, fenêtre ouverte, prise lancée…).
 *
 * Pas une fenêtre bloquante : le studio reste utilisable, rien n'est grisé. Échap ferme.
 * Bouton absent de l'écran (menu replié, mode simple, autre onglet) : on le dit, et
 * « Fais-le pour moi » lance la même action par la palette Ctrl+K.
 */
export interface HowToCoachProps {
  guide: Guide;
  getFacts: () => GuideFacts;
  /** Lance une action de la palette (même chemin que Ctrl+K). */
  runAction: (id: string) => { ok: boolean; why?: string };
  onClose: (finished: boolean) => void;
  isMobile: boolean;
}

const TICK_MS = 300;

const HowToCoach: React.FC<HowToCoachProps> = ({ guide, getFacts, runAction, onClose, isMobile }) => {
  // Étapes figées au départ (appareil, mode) : la numérotation ne saute pas en route.
  const steps = useMemo<GuideStep[]>(() => applicableSteps(guide, getFacts()), [guide]); // eslint-disable-line react-hooks/exhaustive-deps
  const [index, setIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const [targetShown, setTargetShown] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [placeTop, setPlaceTop] = useState(false);
  const ringRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const scrolledRef = useRef<GuideStep | null>(null);
  const indexRef = useRef(0);
  indexRef.current = index;
  const step = steps[index];

  const advance = useCallback((from: number) => {
    setNotice(null);
    setIndex(i => {
      if (i !== from) return i;
      // Étapes suivantes déjà faites (piste voix déjà là…) : sautées.
      let n = i + 1;
      const f = getFacts();
      while (n < steps.length && isStepDone(steps[n], f, null)) n++;
      if (n >= steps.length) { setFinished(true); return i; }
      return n;
    });
  }, [steps, getFacts]);

  // Départ : on saute ce qui est déjà fait (instru déjà chargée…).
  useEffect(() => {
    const f = getFacts();
    let n = 0;
    while (n < steps.length && isStepDone(steps[n], f, null)) n++;
    if (n >= steps.length) setFinished(true); else setIndex(n);
  }, [steps]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surveillance : cible à l'écran, étape faite (état du projet, fenêtre ouverte).
  useEffect(() => {
    if (finished || !step) { targetRef.current = null; return; }
    const tick = () => {
      const el = findTargetElement(step, getFacts());
      if (el && scrolledRef.current !== step) { scrolledRef.current = step; try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* */ } }
      targetRef.current = el;
      setTargetShown(!!el);
      if (el) {
        const r = el.getBoundingClientRect();
        setPlaceTop(isMobile ? r.top + r.height / 2 > window.innerHeight * 0.45 : (r.left < 420 && r.bottom > window.innerHeight - 300));
      }
      if (isStepDone(step, getFacts(), document)) advance(indexRef.current);
    };
    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [step, finished, getFacts, advance, isMobile]);

  // Anneau autour de la cible (suit le défilement, sans re-rendu React à chaque image).
  useEffect(() => {
    if (finished) return;
    let raf = 0;
    const draw = () => {
      const ring = ringRef.current;
      const el = targetRef.current;
      if (ring) {
        if (el && el.isConnected) {
          const r = el.getBoundingClientRect();
          ring.style.display = 'block';
          ring.style.left = `${r.left - 5}px`;
          ring.style.top = `${r.top - 5}px`;
          ring.style.width = `${r.width + 10}px`;
          ring.style.height = `${r.height + 10}px`;
        } else ring.style.display = 'none';
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [finished]);

  // Le bouton montré a été touché : étape faite (sauf si elle attend autre chose, ex. la prise lancée).
  useEffect(() => {
    if (finished || !step || step.done || step.manual) return;
    const at = index;
    const onClick = (e: Event) => {
      const el = targetRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) window.setTimeout(() => advance(at), 350);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [step, index, finished, advance]);

  // Échap ferme le guide (et seulement lui).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      onClose(finished);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, finished]);

  const doIt = () => {
    if (!step?.action) return;
    // Le bouton du guide garde le focus : une touche rejouée (Espace = lecture) ne doit pas le viser.
    try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch { /* */ }
    const r = runAction(step.action);
    if (!r.ok) { setNotice(r.why || 'Pas possible pour l’instant.'); return; }
    setNotice(null);
    if (!step.done) window.setTimeout(() => advance(index), 350);
  };

  const card = (
    <div role="region" aria-label={`Montre-moi : ${guide.title}`} data-testid="howto-coach"
      data-step={finished ? 'fin' : String(index + 1)} data-guide={guide.id}
      className={`fixed z-[10050] ${isMobile
        ? `inset-x-3 ${placeTop ? 'top-[7.25rem]' : 'bottom-[calc(9rem+env(safe-area-inset-bottom))]'}`
        : `left-4 w-[360px] ${placeTop ? 'top-20' : 'bottom-20'}`}`}>
      <div className="rounded-2xl border border-nv-accent/40 bg-nv-surface/95 p-3 text-nv-ink shadow-2xl backdrop-blur-xl">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-nv-accent">
              {guide.emoji} Montre-moi{finished ? '' : ` · étape ${index + 1} / ${steps.length}`}
            </p>
            <p className="truncate text-[12px] font-bold text-nv-muted">{guide.title}</p>
          </div>
          <button type="button" onClick={() => onClose(finished)} aria-label="Fermer le guide (Échap)" title="Fermer (Échap)" data-testid="howto-coach-close"
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-nv-muted hover:bg-nv-line/10 hover:text-nv-ink">
            <i className="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>
        {finished ? (
          <div aria-live="polite">
            <p className="mt-1 text-[14px] font-black leading-snug">✅ C’est fait !</p>
            <p className="mt-0.5 text-[12px] leading-snug text-nv-muted">{guide.result}</p>
            <button type="button" onClick={() => onClose(true)} data-testid="howto-coach-done"
              className="mt-2 min-h-11 w-full rounded-xl bg-cyan-500 px-3 text-[13px] font-black text-black">Super</button>
          </div>
        ) : step ? (
          <div aria-live="polite">
            <p className="mt-1 text-[14px] font-bold leading-snug" data-testid="howto-coach-text">{isMobile && step.phone ? step.phone : step.text}</p>
            {!step.target ? (
              step.hint ? <p className="mt-1 text-[12px] leading-snug text-nv-muted">{step.hint}</p> : null
            ) : !targetShown && (
              <p className="mt-1 text-[12px] leading-snug text-amber-500" data-testid="howto-coach-missing">
                {step.hint || 'Ce bouton n’est pas visible ici.'}{step.action ? ' « Fais-le pour moi » le lance directement.' : ''}
              </p>
            )}
            {notice && <p role="status" className="mt-1 text-[12px] font-semibold text-amber-500">⚠️ {notice}</p>}
            <div className="mt-2 flex gap-2">
              {step.action && (
                <button type="button" onClick={doIt} data-testid="howto-coach-doit"
                  className={`min-h-11 flex-1 rounded-xl px-3 text-[12px] font-black ${targetShown ? 'border border-nv-line/20 bg-nv-raised text-nv-ink hover:bg-nv-line/10' : 'bg-cyan-500 text-black'}`}>
                  ⚡ Fais-le pour moi
                </button>
              )}
              <button type="button" onClick={() => advance(index)} data-testid="howto-coach-next"
                className="min-h-11 shrink-0 rounded-xl border border-nv-line/20 px-3 text-[12px] font-bold text-nv-muted hover:text-nv-ink">
                {index + 1 >= steps.length ? 'Terminer' : 'Passer ›'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(
    <>
      {!finished && (
        <div ref={ringRef} aria-hidden="true" data-testid="howto-ring"
          className="nova-howto-ring pointer-events-none fixed z-[10040] hidden rounded-xl border-[3px] border-cyan-400 shadow-[0_0_0_4px_rgba(34,211,238,0.25),0_0_24px_rgba(34,211,238,0.55)] motion-safe:animate-pulse" />
      )}
      {card}
    </>,
    document.body,
  );
};

export default HowToCoach;
