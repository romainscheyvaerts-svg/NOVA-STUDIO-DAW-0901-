import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PREF_KEYS, PREF_LABELS, prefsSummary, DEFAULT_PREFS } from '../utils/pushPrefs';
import { clearMessages, disableDevice, enable, refresh, sendTest, setPref, usePushState } from '../services/PushNotify';

/**
 * Lot 7 · Réglages des notifications : un interrupteur pour tout couper, un réglage par type
 * (commentaires, versions, invitations, prises reçues), l'état de CET appareil, un essai.
 * Ordinateur : fenêtre centrée ; téléphone : plein écran. Échap ferme.
 */
export interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
}

const Switch: React.FC<{ on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void; testId: string }> = ({ on, label, disabled, onChange, testId }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} data-testid={testId}
    onClick={() => onChange(!on)}
    className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? 'border-cyan-500 bg-cyan-500' : 'border-nv-line/25 bg-nv-well/60'}`}>
    <span className={`inline-block h-5 w-5 rounded-full shadow transition-transform ${on ? 'translate-x-6 bg-black' : 'translate-x-1 bg-nv-ink/70'}`} aria-hidden="true" />
  </button>
);

const NotificationsPanel: React.FC<NotificationsPanelProps> = ({ open, onClose, isMobile }) => {
  const st = usePushState();

  useEffect(() => {
    if (!open) return;
    clearMessages();
    void refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const prefs = st.prefs || { ...DEFAULT_PREFS, enabled: false };
  const masterOn = !!st.prefs?.enabled && st.deviceOn;
  const busy = !!st.busy;
  const desktop = st.support === 'desktop';

  let blocker: React.ReactNode = null;
  if (!st.loggedIn) {
    blocker = <p>Connecte-toi à ton compte Make Music (le même que pour collaborer) pour recevoir les notifications.</p>;
  } else if (st.support === 'ios-install') {
    blocker = <p>Sur iPhone et iPad, ajoute d’abord NOVA à l’écran d’accueil (bouton Partager › « Sur l’écran d’accueil »), puis ouvre-la depuis l’icône : les notifications y sont possibles.</p>;
  } else if (st.availability !== 'yes') {
    blocker = <p>Les notifications ne sont pas disponibles sur cet appareil.</p>;
  }

  return createPortal(
    <div className={`fixed inset-0 z-[770] flex bg-black/50 ${isMobile ? '' : 'items-start justify-center px-3 pt-[8vh]'}`}
      onMouseDown={onClose} data-testid="notif-panel">
      <div role="dialog" aria-modal="true" aria-labelledby="notif-title"
        className={`flex flex-col overflow-hidden bg-nv-surface text-nv-ink shadow-2xl ${isMobile
          ? 'h-full w-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
          : 'max-h-[84vh] w-full max-w-[520px] rounded-2xl border border-nv-line/15'}`}
        onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 pt-3">
          <h2 id="notif-title" className="min-w-0 flex-1 truncate text-[16px] font-black">🔔 Notifications</h2>
          <button type="button" onClick={onClose} aria-label="Fermer (Échap)" title="Fermer (Échap)" data-testid="notif-close"
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-nv-muted hover:bg-nv-line/10 hover:text-nv-ink">
            <i className="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 custom-scroll">
          <p className="text-[13px] leading-snug text-nv-muted">
            Sois prévenu quand ton équipe commente, t’envoie une version ou une prise, ou t’invite dans une séance{desktop ? ', tant que Nova Studio est ouvert' : ', même NOVA fermée'}. Jamais pour tes propres actions.
          </p>

          {blocker ? (
            <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2.5 text-[13px] leading-snug text-nv-ink" data-testid="notif-blocker">{blocker}</div>
          ) : (
            <>
              <div className="mt-3 flex items-center gap-3 rounded-xl border border-nv-line/12 bg-nv-raised px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold">Recevoir les notifications</span>
                  <span className="block text-[11px] text-nv-muted" data-testid="notif-summary">{masterOn ? prefsSummary(prefs) : 'Tout est coupé'}</span>
                </span>
                <Switch on={masterOn} label="Recevoir les notifications" disabled={busy} testId="notif-master"
                  onChange={v => { if (v && !st.deviceOn) void enable('panel'); else void setPref('enabled', v); }} />
              </div>

              <p className="mt-4 text-[10px] font-black uppercase tracking-widest text-nv-muted">Ce que tu reçois</p>
              <ul className="mt-1.5 space-y-1.5" data-testid="notif-types">
                {PREF_KEYS.map(k => {
                  const l = PREF_LABELS[k];
                  return (
                    <li key={k} className={`flex items-center gap-3 rounded-xl border border-nv-line/12 bg-nv-raised px-3 py-2 ${masterOn ? '' : 'opacity-60'}`}>
                      <span className="text-lg leading-none" aria-hidden="true">{l.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-bold">{l.label}</span>
                        <span className="block text-[11px] leading-snug text-nv-muted">{l.help}</span>
                      </span>
                      <Switch on={masterOn && prefs[k]} label={l.label} disabled={busy || !masterOn} testId={`notif-pref-${k}`} onChange={v => void setPref(k, v)} />
                    </li>
                  );
                })}
              </ul>

              <div className="mt-4 rounded-xl border border-nv-line/12 px-3 py-2.5" data-testid="notif-device">
                <p className="text-[12px] text-nv-ink">
                  <b>Cet appareil :</b>{' '}
                  {st.permission === 'denied'
                    ? <span className="text-amber-500">notifications bloquées par le navigateur</span>
                    : st.deviceOn ? <span className="text-emerald-500">✓ reçoit les notifications{desktop ? ' (appli Windows ouverte)' : ''}</span>
                      : <span className="text-nv-muted">ne reçoit rien</span>}
                </p>
                {st.permission === 'denied' && (
                  <p className="mt-1 text-[11px] leading-snug text-nv-muted">Clique sur le cadenas à gauche de l’adresse › Notifications › Autoriser, puis rouvre cette fenêtre.</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {st.deviceOn ? (
                    <>
                      <button type="button" onClick={() => void sendTest()} disabled={busy} data-testid="notif-test"
                        className="min-h-11 rounded-xl bg-cyan-500 px-4 text-[13px] font-black text-black disabled:opacity-50">Envoyer un essai</button>
                      <button type="button" onClick={() => void disableDevice()} disabled={busy} data-testid="notif-device-off"
                        className="min-h-11 rounded-xl border border-nv-line/20 px-4 text-[13px] font-bold text-nv-ink hover:bg-nv-line/10 disabled:opacity-50">Désactiver sur cet appareil</button>
                    </>
                  ) : st.permission !== 'denied' && (
                    <button type="button" onClick={() => void enable('panel')} disabled={busy} data-testid="notif-device-on"
                      className="min-h-11 rounded-xl bg-cyan-500 px-4 text-[13px] font-black text-black disabled:opacity-50">Activer sur cet appareil</button>
                  )}
                </div>
              </div>
            </>
          )}

          {st.busy && <p className="mt-3 text-[12px] text-nv-muted" role="status">{st.busy}</p>}
          {st.error && <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-[12px] leading-snug text-red-500" role="alert" data-testid="notif-error">{st.error}</p>}
          {!st.busy && st.info && <p className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] px-3 py-2 text-[12px] leading-snug text-emerald-500" role="status" data-testid="notif-info">{st.info}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default NotificationsPanel;
