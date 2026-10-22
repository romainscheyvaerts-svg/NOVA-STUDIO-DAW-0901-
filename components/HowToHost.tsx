import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DAWState } from '../types';
import { guideById, nextGuidesFor, projectFacts, type FactsEnv, type GuideFacts, type HowToMoment } from '../utils/guides';
import { howTo, nextStepPrefs } from '../utils/howTo';
import { track } from '../utils/analytics';
import HowToPanel from './HowToPanel';
import HowToCoach from './HowToCoach';

/**
 * Branchement de « ❓ Comment faire ? » : la liste des parcours, le mode « Montre-moi » et la
 * petite carte « Et après ? » après un style de mix posé. Piloté par utils/howTo (barre du haut,
 * palette Ctrl+K, chat) : App.tsx ne fait que le monter.
 */
export interface HowToHostProps {
  getState: () => DAWState;
  getEnv: () => FactsEnv;
  isMobile: boolean;
  /** Lance une action de la palette Ctrl+K par son id. */
  runPaletteAction: (id: string) => { ok: boolean; why?: string };
  /** Avant « Montre-moi » (téléphone : quitter l'onglet Nova, qui couvre l'écran). */
  onBeforeShowMe?: () => void;
  /** État léger pour la carte « Et après ? » (style de mix posé, prise en cours, autre carte ouverte). */
  vocalMixStyle?: string | null;
  isRecording?: boolean;
  /** Une autre carte (« Et maintenant ? ») ou un éditeur occupe l'écran : on attend. */
  busy?: boolean;
  simple: boolean;
}

export const useHowTo = () => useSyncExternalStore(howTo.subscribe, howTo.get, howTo.get);

const HowToHost: React.FC<HowToHostProps> = ({ getState, getEnv, isMobile, runPaletteAction, onBeforeShowMe, vocalMixStyle, isRecording, busy, simple }) => {
  const st = useHowTo();
  const getFacts = useCallback((): GuideFacts => projectFacts(getState(), { ...getEnv(), mobile: isMobile }), [getState, getEnv, isMobile]);
  const [facts, setFacts] = useState<GuideFacts>(() => getFacts());
  useEffect(() => { if (st.panel) setFacts(getFacts()); }, [st.panel, getFacts]);

  const coachGuide = guideById(st.coach);
  const startedRef = useRef<string | null>(null);
  useEffect(() => {
    if (st.coach && startedRef.current !== st.coach) {
      startedRef.current = st.coach;
      onBeforeShowMe?.();
      track('howto_showme', { guide: st.coach });
    }
    if (!st.coach) startedRef.current = null;
  }, [st.coach, onBeforeShowMe]);
  useEffect(() => { if (st.panel) track('howto_opened'); }, [st.panel]);

  // « Et après ? » quand un style de mix vient d'être posé (mode simple, une fois, jamais pendant une prise).
  // Au téléphone, la carte est posée dans la page des pistes (App : topCard de MobileArrangementPage),
  // jamais en flottant : elle recouvrait les boutons de la zone « Prises gardées ».
  const prevStyle = useRef(vocalMixStyle);
  useEffect(() => {
    const was = prevStyle.current;
    prevStyle.current = vocalMixStyle;
    if (!simple || was || !vocalMixStyle || nextStepPrefs.off() || nextStepPrefs.seen('mix')) return;
    const t = window.setTimeout(() => howTo.setNudge('mix'), 2500);
    return () => window.clearTimeout(t);
  }, [vocalMixStyle, simple]);

  return (
    <>
      <HowToPanel open={!!st.panel} onClose={howTo.closePanel} facts={facts} isMobile={isMobile}
        initialId={st.panel?.initialId ?? null} onShowMe={howTo.showMe} />
      {coachGuide && (
        <HowToCoach key={coachGuide.id} guide={coachGuide} getFacts={getFacts} runAction={runPaletteAction} isMobile={isMobile}
          onClose={(finished) => { if (finished) track('howto_finished', { guide: coachGuide.id }); howTo.stopCoach(); }} />
      )}
      {!isMobile && <HowToNudgeCard blocked={!!busy || !!isRecording} />}
    </>
  );
};

/**
 * Carte « Ton mix est posé. Et après ? ». Bureau : en bas à droite (HowToHost) ; téléphone : `inline`,
 * en tête de la page des pistes. Attend qu'aucune autre carte, prise, liste ou « Montre-moi » ne soit en cours.
 */
export const HowToNudgeCard: React.FC<{ inline?: boolean; blocked?: boolean }> = ({ inline, blocked }) => {
  const st = useHowTo();
  const nudge = st.nudge;
  const show = !!nudge && !blocked && !st.coach && !st.panel;
  useEffect(() => { if (show && nudge) nextStepPrefs.markSeen(nudge); }, [show, nudge]);
  if (!show || !nudge) return null;
  return (
    <div role="region" aria-label="Et après ?" data-testid="howto-nudge"
      className={inline ? 'shrink-0 mx-2 my-1.5' : 'fixed z-[160] right-6 bottom-[13.5rem] w-[340px]'}>
      <div className="rounded-2xl border border-nv-accent/30 bg-nv-surface/95 p-3 text-nv-ink shadow-2xl backdrop-blur-xl">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[14px] font-black leading-tight">Ton mix est posé. Et après ?</p>
          <button type="button" onClick={() => howTo.setNudge(null)} aria-label="Fermer" title="Fermer"
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-nv-muted hover:bg-nv-line/10 hover:text-nv-ink">
            <i className="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>
        <HowToNextRow moment={nudge} onPicked={() => howTo.setNudge(null)} bare />
      </div>
    </div>
  );
};

/**
 * Ligne « Comment faire la suite » : deux parcours proposés après un moment clé (prise, mix,
 * export), « Montre-moi » en un tap, et « Ne plus montrer ». Une seule fois par moment.
 * Posée dans la carte « Et maintenant ? » (components/NextStepCard) et dans la carte « Et après ? ».
 */
export const HowToNextRow: React.FC<{ moment: HowToMoment; onPicked?: () => void; bare?: boolean; /** Une seule rangée (bande réservée du bureau). */ row?: boolean }> = ({ moment, onPicked, bare, row }) => {
  useHowTo();
  const [hidden] = useState(() => nextStepPrefs.off() || (!bare && nextStepPrefs.seen(moment)));
  useEffect(() => { if (!hidden && !bare) nextStepPrefs.markSeen(moment); }, [hidden, bare, moment]);
  const guides = nextGuidesFor(moment);
  if (hidden || nextStepPrefs.off() || !guides.length) return null;
  return (
    <div className={row ? 'flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-nv-line/10 pt-1' : bare ? 'mt-2' : 'mt-2 border-t border-nv-line/10 pt-2'} data-testid="howto-next" data-moment={moment}>
      <p className="text-[11px] font-bold text-nv-muted">Comment faire la suite, pas à pas :</p>
      <div className={row ? 'flex flex-wrap gap-2' : 'mt-1.5 flex flex-wrap gap-2'}>
        {guides.map(g => (
          <button key={g.id} type="button" data-testid={`howto-next-${g.id}`}
            onClick={() => { track('howto_next_clicked', { moment, guide: g.id }); onPicked?.(); howTo.showMe(g.id); }}
            className="min-h-11 rounded-xl border border-nv-accent/40 bg-nv-accent/10 px-3 text-left text-[12px] font-bold text-nv-ink hover:bg-nv-accent/20">
            {g.emoji} {g.title}
          </button>
        ))}
      </div>
      <button type="button" data-testid="howto-next-off" onClick={() => { nextStepPrefs.setOff(); onPicked?.(); }}
        className={`${row ? '' : 'mt-1 '}min-h-11 px-1 text-[11px] font-semibold text-nv-muted underline-offset-2 hover:text-nv-ink hover:underline`}>
        Ne plus montrer ces suggestions
      </button>
    </div>
  );
};

export default HowToHost;
