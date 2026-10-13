import React, { useEffect, useRef, useState } from 'react';
import { catalogSupabase } from '../services/supabase';
import { billingStatus } from '../services/Billing';
import { isNovaDesktop } from '../utils/desktopApp';
import { onRecordersChange, recordersRunning, setCaptureProtection, setSecureScreen, unboughtCatalog } from '../utils/captureGuard';
import type { Track } from '../types';

/**
 * Anti-enregistrement d'écran dans le studio (voir utils/captureGuard.ts) :
 *  - studio ouvert : écran protégé (Android) et fenêtre exclue des captures (Windows), sauf admins ;
 *  - logiciel d'enregistrement détecté (Windows) ou écran enregistré (iPhone) ET instru /
 *    mélodie du catalogue non achetée dans le projet : la lecture est coupée (même chemin que
 *    « nova:transport-pause ») et un message dit quoi faire.
 */
interface Props {
  tracks: Track[];
  owned: (string | number)[];
  isPlaying: boolean;
  onBuyBeat: () => void;
}

const CaptureGuard: React.FC<Props> = ({ tracks, owned, isPlaying, onBuyBeat }) => {
  const [recorders, setRecorders] = useState<string[]>(() => recordersRunning());
  const [admin, setAdmin] = useState(false);
  const adminRef = useRef(false);

  // Studio ouvert : protections actives, puis coupées si le compte est admin.
  useEffect(() => {
    setSecureScreen(true);
    if (isNovaDesktop()) setCaptureProtection(true);
    let live = true;
    const check = () => billingStatus().then(st => {
      if (!live) return;
      adminRef.current = !!st.admin;
      setAdmin(!!st.admin);
      setSecureScreen(!st.admin);
      if (isNovaDesktop()) setCaptureProtection(!st.admin);
    }).catch(() => { /* hors ligne : protections gardées */ });
    void check();
    const { data: sub } = catalogSupabase.auth.onAuthStateChange(() => { void check(); });
    return () => { live = false; sub?.subscription?.unsubscribe(); setSecureScreen(false); };
  }, []);

  useEffect(() => onRecordersChange(setRecorders), []);

  const nonAchetees = unboughtCatalog(tracks, owned);
  const bloque = !admin && recorders.length > 0 && nonAchetees.length > 0;

  // Lecture coupée dès qu'elle démarre (ou dès que l'enregistrement commence pendant la lecture).
  // (Répété tant que la lecture continue : la 1re demande peut arriver avant que l'état
  // « en lecture » soit validé par le transport.)
  useEffect(() => {
    if (!bloque || !isPlaying) return;
    const stop = () => window.dispatchEvent(new Event('nova:transport-pause'));
    const t0 = window.setTimeout(stop, 0);
    const id = window.setInterval(stop, 250);
    return () => { window.clearTimeout(t0); window.clearInterval(id); };
  }, [bloque, isPlaying]);

  if (!bloque) return null;
  const quoi = nonAchetees.length > 1 ? 'les instrus non achetées' : `« ${nonAchetees[0]?.clips?.[0]?.name || nonAchetees[0]?.name || "l'instru"} » (pas encore achetée)`;
  return (
    <div className="fixed inset-x-0 bottom-20 z-[640] flex justify-center px-4 pointer-events-none" role="alert" data-testid="capture-guard">
      <div className="pointer-events-auto max-w-md rounded-2xl border border-red-500/40 bg-[#1a0d0f]/95 p-3 text-[12px] text-red-100 shadow-2xl">
        🎥 <b>{recorders.join(', ')}</b> : enregistrement d'écran détecté. La lecture de {quoi} est coupée pour protéger les beatmakers.
        {' '}Ferme le logiciel d'enregistrement, ou{' '}
        <button type="button" className="underline font-bold" onClick={onBuyBeat}>achète la licence</button> pour l'écouter librement.
      </div>
    </div>
  );
};

export default CaptureGuard;
