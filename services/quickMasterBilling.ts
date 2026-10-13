/**
 * Export du « Master express » (lot 4a) : la règle d'export existante de NOVA.
 *
 *  - écoute gratuite et illimitée (rien ici ne la bloque) ;
 *  - export payant par morceau : même produit Stripe que l'export d'un projet
 *    (`export_voices`, services/Billing.ts), ou un des exports gratuits du
 *    mois de Nova Pro ;
 *  - admins : gratuit.
 *
 * BRANCHEMENT SUR LA NOUVELLE GRILLE DE PRIX : tout passe par UNE fonction,
 * `unlockMasterExport`, et UNE clé produit, `QUICK_MASTER_PRODUCT` (avec son
 * libellé de prix `QUICK_MASTER_PRICE_LABEL`). Quand le produit « export à
 * 1,99 € » existera dans nova-billing, il suffit de changer ces deux
 * constantes. Billing.ts n'est pas modifié.
 */
import {
  BillingProduct, billingStatus, isExportVoicesUnlocked, markExportVoicesUnlocked, openCheckout, spendExportCredit, waitPaid,
} from './Billing';
import { md5Hex } from '../utils/md5';

/** Clé produit Stripe du master express (aujourd'hui : l'export d'un projet). */
export const QUICK_MASTER_PRODUCT: BillingProduct = 'export_voices';
/** Prix affiché sur le bouton (suit le produit ci-dessus). */
export const QUICK_MASTER_PRICE_LABEL = '2 €';

/** Clé d'achat d'un morceau : empreinte du fichier (payer une fois = exporter toutes ses variantes de master). */
export async function masterFileKey(bytes: Uint8Array): Promise<string> {
  let hex = '';
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    hex = Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    hex = md5Hex(bytes);
  }
  return `master:${hex.slice(0, 32)}`;
}

export type MasterExportAccess =
  | { kind: 'admin' }
  | { kind: 'unlocked' }
  | { kind: 'pro_credit'; left: number }
  | { kind: 'pay' };

/** Ce que coûtera l'export de ce morceau pour ce compte (pour le libellé du bouton). */
export async function masterExportAccess(fileKey: string): Promise<MasterExportAccess> {
  const st = await billingStatus();
  if (st.admin) return { kind: 'admin' };
  if (await isExportVoicesUnlocked(fileKey)) return { kind: 'unlocked' };
  const pro = st.plans.some(p => p.plan === 'collab');
  if (pro && (st.free_exports_left ?? 0) > 0) return { kind: 'pro_credit', left: st.free_exports_left ?? 0 };
  return { kind: 'pay' };
}

export interface UnlockResult { ok: boolean; via?: 'admin' | 'deja_paye' | 'nova_pro' | 'paiement'; message: string; left?: number }

/**
 * LE point d'entrée du paiement : admin → gratuit ; déjà payé → libre ;
 * Nova Pro avec des exports gratuits → un crédit ; sinon Stripe Checkout
 * (nouvel onglet, à appeler pendant le clic), puis attente du paiement.
 */
export async function unlockMasterExport(fileKey: string, opts: { access?: MasterExportAccess | null; isCancelled?: () => boolean; onWaiting?: () => void } = {}): Promise<UnlockResult> {
  // Accès déjà lu (à l'affichage du bouton) : Stripe s'ouvre pendant le clic, pas bloqué comme fenêtre surgissante.
  const access = opts.access || await masterExportAccess(fileKey);
  if (access.kind === 'admin') return { ok: true, via: 'admin', message: 'Compte admin : export gratuit.' };
  if (access.kind === 'unlocked') return { ok: true, via: 'deja_paye', message: 'Morceau déjà débloqué : exporte autant de versions que tu veux.' };
  if (access.kind === 'pro_credit') {
    const r = await spendExportCredit(fileKey);
    if (r.unlocked) {
      markExportVoicesUnlocked(fileKey);
      return { ok: true, via: 'nova_pro', left: r.remaining, message: `⭐ Export gratuit Nova Pro utilisé (il t'en reste ${r.remaining} ce mois-ci).` };
    }
  }
  try {
    const sid = await openCheckout(QUICK_MASTER_PRODUCT, { project_key: fileKey });
    opts.onWaiting?.();
    const paid = await waitPaid(sid, opts.isCancelled);
    if (!paid) return { ok: false, message: 'Paiement non reçu : l’écoute reste libre, réessaie quand tu veux.' };
    markExportVoicesUnlocked(fileKey);
    return { ok: true, via: 'paiement', message: '✅ Paiement reçu : ton master se télécharge.' };
  } catch (e: any) {
    const m = String(e?.message || 'erreur');
    return { ok: false, message: /auth|connect|jwt|login|401/i.test(m) ? 'Connecte-toi à ton compte Make Music pour exporter (l’écoute reste gratuite).' : `Paiement impossible : ${m}` };
  }
}
