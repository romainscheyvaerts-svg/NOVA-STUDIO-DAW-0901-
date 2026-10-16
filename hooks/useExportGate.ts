import { useCallback, useEffect, useRef, useState } from 'react';
import { messageClair } from '../utils/friendlyError';
import type { Track } from '../types';
import {
  billingStatus, exportAccess, forgetExportAccess, loadPricing, startExportPayment, waitPaid,
  type BillingStatus, type ExportAccess, type Grille,
} from '../services/Billing';
import { catalogIdsOf, projectUsesKits } from '../utils/exportProject';

/**
 * Verrou d'export décidé par le SERVEUR (nova-billing « export_access »), pour les sorties de
 * fichiers autres que la fenêtre « Exporter » (ex. séance Pro Tools AAF + BWF, qui contient
 * les sons du projet). Même règle que l'export : licence achetée, projet payé, Nova Pro, admin.
 */
export function useExportGate(open: boolean, projectKey: string | undefined, tracks: Track[], owned: string[] = [], scope: 'mix' | 'voix' = 'mix') {
  const [grille, setGrille] = useState<Grille | null>(null);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [access, setAccess] = useState<ExportAccess | null>(null);
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const cancelled = useRef(false);
  const ids = catalogIdsOf(tracks).join(',');
  const kits = projectUsesKits(tracks);

  const ownedKey = owned.join(',');
  useEffect(() => {
    if (!open) return;
    let live = true;
    setAccess(null);
    void loadPricing().then(g => { if (live) setGrille(g); });
    void billingStatus().then(st => { if (live) setStatus(st); });
    // Projet sans clé d'export (pas encore enregistré, utils/exportRights) : rien n'est débloqué.
    if (projectKey) {
      void exportAccess({ projectKey, catalogIds: ids ? ids.split(',') : [], kits, scope, owned })
        .then(a => { if (live) setAccess(a); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectKey, ids, kits, scope, ownedKey, tick]);
  useEffect(() => () => { cancelled.current = true; }, []);

  const recheck = useCallback(() => { if (projectKey) forgetExportAccess(projectKey); setTick(t => t + 1); }, [projectKey]);
  const pay = useCallback(async () => {
    if (!projectKey || !grille) return;
    cancelled.current = false;
    setMessage(null);
    try {
      const r = await startExportPayment({ projectKey, catalogIds: ids ? ids.split(',') : [], kits, scope, owned }, grille);
      if (r.credit) { recheck(); return; }
      setPaying(true);
      const ok = await waitPaid(r.sessionId!, () => cancelled.current);
      setPaying(false);
      if (ok) recheck();
      else if (!cancelled.current) setMessage("Paiement pas encore reçu. S'il est fait, rouvre cette fenêtre : il sera reconnu.");
    } catch (e: any) {
      setPaying(false);
      setMessage(`Paiement impossible : ${messageClair(e, 'vérifie ta connexion, puis réessaie.')} Rien n’a été débité.`);
    }
  }, [projectKey, grille, ids, kits, scope, owned, recheck]);
  const cancelPay = useCallback(() => { cancelled.current = true; setPaying(false); }, []);
  const admin = !!status?.admin;
  return { grille, status, access, admin, unlocked: admin || !!access?.unlocked, paying, pay, cancelPay, recheck, message, setStatus };
}
