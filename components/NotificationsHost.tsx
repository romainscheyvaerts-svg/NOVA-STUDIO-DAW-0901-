import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import NotificationsPanel from './NotificationsPanel';
import {
  dismissAsk, dismissInApp, enable, openTarget, requestAsk, setOpenHandler, startPushNotify, usePushState,
} from '../services/PushNotify';
import { askText, parseNotifTarget, stripNotifParams, type NotifTarget } from '../utils/pushPrefs';
import type { TimelineComment } from '../utils/timelineComments';
import type { MixVersion } from '../utils/mixVersions';
import { howTo } from '../utils/howTo';

/**
 * Lot 7 · Notifications : branchement dans le studio (App.tsx : 1 état, 1 entrée de palette, 1 rendu).
 *  - démarre la vérification discrète (rien tant qu'aucun compte n'est connecté, aucune permission demandée) ;
 *  - propose « Être prévenu… » au BON moment : 1re collaboration, ou 1er commentaire posé ;
 *  - ouvre la séance / le commentaire / la version d'une notification touchée (adresse ou service worker) ;
 *  - affiche dans la page ce qui arrive pendant que NOVA est devant toi (pas de notification système).
 * Bureau : petites cartes en bas à droite. Téléphone : `NotificationsInline`, posée dans la page des pistes.
 */
export interface NotificationsHostProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  isMobile: boolean;
  /** Mode simple : la demande reste une simple ligne, discrète. */
  simple: boolean;
  inCollab: boolean;
  /** Clé de l'auteur local (« local » ou clé de collaboration) : repère MES commentaires. */
  meKey: string;
  comments: TimelineComment[] | undefined;
  versions: MixVersion[] | undefined;
  /** Pendant une prise / un décompte : on n'interrompt pas. */
  busy: boolean;
  /** Séance en ligne ouverte (id), pour savoir si une notification parle de CETTE séance. */
  sessionId: string | null;
  openComment: (id: string) => void;
  openVersion: (id: string) => void;
  seek: (t: number) => void;
}

// Réglages ouverts depuis une carte (bureau ou téléphone).
let openSettingsFn: (() => void) | null = null;

const NotificationsHost: React.FC<NotificationsHostProps> = (p) => {
  const { open, onOpen, onClose, isMobile, simple, inCollab, meKey, comments, busy } = p;
  const live = useRef(p);
  live.current = p;
  openSettingsFn = onOpen;

  useEffect(() => { startPushNotify(); }, []);

  // ── Le bon moment pour proposer ───────────────────────────────────────────
  // Minuterie gardée hors des effets : un nouvel état (accusé de la collaboration…) ne l'annule pas.
  const askTimer = useRef<number | null>(null);
  // Occupé à ce moment-là (prise, décompte, carte d'étape) : on repropose dès que c'est fini (toutes les 4 s,
  // 3 min au plus) au lieu d'abandonner pour de bon.
  const askLater = (trigger: 'collab' | 'comment', ms: number, tries = 45) => {
    if (askTimer.current !== null) window.clearTimeout(askTimer.current);
    askTimer.current = window.setTimeout(() => {
      askTimer.current = null;
      if (live.current.busy && tries > 0) { askLater(trigger, 4000, tries - 1); return; }
      void requestAsk(trigger, null, live.current.busy);
    }, ms);
  };
  useEffect(() => () => { if (askTimer.current !== null) window.clearTimeout(askTimer.current); }, []);

  const wasCollab = useRef(inCollab);
  useEffect(() => {
    const was = wasCollab.current;
    wasCollab.current = inCollab;
    if (inCollab && !was) askLater('collab', 4000);
  }, [inCollab]);

  const seenComments = useRef<Set<string> | null>(null);
  useEffect(() => {
    const list = comments || [];
    if (!seenComments.current) { seenComments.current = new Set(list.map(c => c.id)); return; }
    const fresh = list.filter(c => !seenComments.current!.has(c.id));
    fresh.forEach(c => seenComments.current!.add(c.id));
    if (fresh.some(c => c.authorKey === meKey && Date.now() - c.createdAt < 60_000)) askLater('comment', 2500);
  }, [comments, meKey]);

  // ── Ouvrir ce qu'une notification montre ──────────────────────────────────
  const [pendingTarget, setPendingTarget] = useState<NotifTarget | null>(() => {
    try { return parseNotifTarget(window.location.search); } catch { return null; }
  });

  useEffect(() => {
    setOpenHandler((t, url) => {
      const cur = live.current.sessionId;
      if (t.sessionId && cur !== t.sessionId) {
        // Une autre séance : on ne quitte pas le projet en cours sans le dire.
        if (url) setOtherShared({ url });
        return;
      }
      setPendingTarget(t);
    });
    return () => setOpenHandler(null);
  }, []);

  useEffect(() => {
    if (!pendingTarget) return;
    const t = pendingTarget;
    const tryGo = () => {
      const cur = live.current;
      if (t.sessionId && cur.sessionId && cur.sessionId !== t.sessionId) return false;
      if (t.commentId) {
        if (!(cur.comments || []).some(c => c.id === t.commentId)) return false;
        cur.openComment(t.commentId);
      } else if (t.versionId) {
        if (!(cur.versions || []).some(v => v.id === t.versionId)) return false;
        cur.openVersion(t.versionId);
      } else if (t.at !== null) {
        cur.seek(t.at);
      }
      return true;
    };
    const done = () => {
      setPendingTarget(null);
      try { window.history.replaceState(window.history.state, '', stripNotifParams(window.location.href)); } catch { /* */ }
    };
    if (tryGo()) { done(); return; }
    // La séance se charge (lien ouvert par la notification) : on attend que le commentaire arrive, 90 s au plus.
    const iv = window.setInterval(() => { if (tryGo()) { window.clearInterval(iv); done(); } }, 500);
    // Commentaire introuvable (effacé, séance pas ouverte) : au moins le bon instant.
    const stop = window.setTimeout(() => { window.clearInterval(iv); if (t.at !== null) live.current.seek(t.at); done(); }, 90_000);
    return () => { window.clearInterval(iv); window.clearTimeout(stop); };
  }, [pendingTarget]);

  return (
    <>
      <NotificationsPanel open={open} onClose={onClose} isMobile={isMobile} />
      {!isMobile && <NotificationsInline floating simple={simple} blocked={busy || open} />}
    </>
  );
};

// Notification d'une AUTRE séance (fenêtre déjà ouverte) : partagé par les cartes du bureau et du téléphone.
let otherSessionState: { url: string } | null = null;
const otherListeners = new Set<() => void>();
const setOtherShared = (v: { url: string } | null) => { otherSessionState = v; otherListeners.forEach(l => l()); };
const useOtherShared = () => {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force(n => n + 1); otherListeners.add(l); return () => { otherListeners.delete(l); }; }, []);
  return otherSessionState;
};

/** Cartes (demande, nouveauté reçue, autre séance). `inline` : posées dans la page (téléphone). */
const NotificationCards: React.FC<{
  simple: boolean; blocked: boolean; inline?: boolean;
  otherSession: { url: string } | null; onOtherSession: (v: { url: string } | null) => void;
}> = ({ simple, blocked, inline, otherSession, onOtherSession }) => {
  const st = usePushState();
  // Une seule carte à la fois : « Et après ? », un parcours ou « Montre-moi » passent d'abord.
  const ht = useSyncExternalStore(howTo.subscribe, howTo.get, howTo.get);
  const wrap = inline ? 'shrink-0 mx-2 my-1.5' : 'fixed z-[160] right-6 bottom-[14.5rem] w-[360px]';
  const box = 'rounded-2xl border border-nv-accent/30 bg-nv-surface/95 p-3 text-nv-ink shadow-2xl backdrop-blur-xl';
  const closeBtn = (onClick: () => void, label = 'Fermer') => (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-nv-muted hover:bg-nv-line/10 hover:text-nv-ink">
      <i className="fas fa-times" aria-hidden="true"></i>
    </button>
  );

  if (blocked || ht.nudge || ht.coach || ht.panel) return null;

  if (otherSession) {
    return (
      <div role="region" aria-label="Notification d'une autre séance" data-testid="notif-other-session" className={wrap}>
        <div className={box}>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[13px] font-bold leading-snug">Cette notification parle d’une autre séance. L’ouvrir maintenant ?</p>
            {closeBtn(() => onOtherSession(null))}
          </div>
          <p className="mt-0.5 text-[11px] text-nv-muted">Ton projet actuel reste enregistré sur cet appareil.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" data-testid="notif-other-open" onClick={() => { const u = otherSession.url; onOtherSession(null); window.location.assign(u); }}
              className="min-h-11 flex-1 rounded-xl bg-cyan-500 px-3 text-[13px] font-black text-black">Ouvrir la séance</button>
            <button type="button" onClick={() => onOtherSession(null)}
              className="min-h-11 rounded-xl border border-nv-line/20 px-3 text-[13px] font-bold">Plus tard</button>
          </div>
        </div>
      </div>
    );
  }

  if (st.inApp) {
    const n = st.inApp;
    return (
      <div role="status" aria-label="Nouveauté" data-testid="notif-inapp" className={wrap}>
        <div className={box}>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[13px] font-black leading-snug">{n.title}</p>
            {closeBtn(dismissInApp)}
          </div>
          {n.body && <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-nv-muted">{n.body}</p>}
          {n.target && (
            <button type="button" data-testid="notif-inapp-open" onClick={() => openTarget(n.target!, n.url)}
              className="mt-2 min-h-11 w-full rounded-xl bg-cyan-500 px-3 text-[13px] font-black text-black">Voir</button>
          )}
        </div>
      </div>
    );
  }

  if (st.ask) {
    const t = askText(st.ask.trigger, st.ask.other);
    const yes = (
      <button type="button" data-testid="notif-ask-yes" disabled={!!st.busy} onClick={() => { void enable('ask'); }}
        className="min-h-11 shrink-0 rounded-xl bg-cyan-500 px-4 text-[13px] font-black text-black disabled:opacity-50">{st.busy ? 'Activation…' : 'Activer'}</button>
    );
    const err = st.error && <p className="mt-1 text-[11px] leading-snug text-amber-500" role="alert">{st.error}</p>;
    // Mode simple : UNE ligne discrète (la question courte, « Activer », ✕ = plus tard).
    if (simple) {
      return (
        <div role="region" aria-label="Notifications" data-testid="notif-ask" data-simple="1" className={wrap}>
          <div className={`${box} py-1.5 pl-3 pr-1.5`}>
            <div className="flex items-center gap-2">
              <span className="text-base leading-none" aria-hidden="true">🔔</span>
              <p className="min-w-0 flex-1 text-[13px] font-bold leading-snug">{t.short}</p>
              {yes}
              <button type="button" data-testid="notif-ask-later" onClick={() => dismissAsk(false)} aria-label="Plus tard" title="Plus tard"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-nv-muted hover:bg-nv-line/10 hover:text-nv-ink">
                <i className="fas fa-times" aria-hidden="true"></i>
              </button>
            </div>
            {err}
          </div>
        </div>
      );
    }
    // Mode avancé : la même carte, avec le détail et « Choisir quoi recevoir ».
    return (
      <div role="region" aria-label="Notifications" data-testid="notif-ask" data-simple="0" className={wrap}>
        <div className={box}>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 text-base leading-none" aria-hidden="true">🔔</span>
            <p className="min-w-0 flex-1 text-[13px] font-bold leading-snug">{t.title}</p>
            {closeBtn(() => dismissAsk(false), 'Plus tard')}
          </div>
          <p className="mt-0.5 pl-6 text-[11px] leading-snug text-nv-muted">{t.detail}</p>
          {err && <div className="pl-6">{err}</div>}
          <div className="mt-2 flex flex-wrap gap-2 pl-6">
            {yes}
            <button type="button" data-testid="notif-ask-later" onClick={() => dismissAsk(false)}
              className="min-h-11 rounded-xl border border-nv-line/20 px-3 text-[13px] font-bold">Plus tard</button>
            <button type="button" data-testid="notif-ask-settings" onClick={() => { dismissAsk(false); openSettingsFn?.(); }}
              className="min-h-11 rounded-xl px-2 text-[12px] font-bold text-nv-muted underline-offset-2 hover:underline">Choisir quoi recevoir</button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

/**
 * Cartes des notifications. Téléphone : posées en tête de la page des pistes (jamais par-dessus) ;
 * bureau (`floating`, rendu par NotificationsHost) : en bas à droite.
 */
export const NotificationsInline: React.FC<{ simple: boolean; blocked?: boolean; floating?: boolean }> = ({ simple, blocked, floating }) => {
  const other = useOtherShared();
  return <NotificationCards inline={!floating} simple={simple} blocked={!!blocked} otherSession={other} onOtherSession={setOtherShared} />;
};

export default NotificationsHost;
