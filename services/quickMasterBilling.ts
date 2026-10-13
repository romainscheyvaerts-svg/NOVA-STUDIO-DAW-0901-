/**
 * Export du « Master express » (lot 4a) : la règle d'export de NOVA, décidée
 * par le SERVEUR (nova-billing, grille du 14/10/2026).
 *
 *  - écoute gratuite et illimitée (rien ici ne la bloque) ;
 *  - export payant par morceau, au prix de la grille (`loadPricing`,
 *    `euros`), avec le produit d'export de la grille (`productFor`) ;
 *  - admin, Nova Pro (abonnement ou cadeau), morceau déjà payé : libre, c'est
 *    le serveur qui le dit (`exportAccess`).
 *
 * Le master d'un fichier est vu par le serveur comme un projet SANS élément du
 * catalogue ni kit, en portée « mix », dont la clé est l'empreinte du fichier
 * (`master:<sha256>`). L'API n'a pas (encore) de portée « master de fichier » :
 * cette requête donne exactement la règle voulue (admin → Pro → déjà payé →
 * paiement) sans rien inventer côté navigateur.
 */
import {
  ExportAccess, ExportQuery, Grille, euros, exportAccess, forgetExportAccess, loadPricing, productFor, startExportPayment, waitPaid,
} from './Billing';
import { md5Hex } from '../utils/md5';

/** Clé d'achat d'un morceau : empreinte du fichier (payer une fois = exporter toutes ses variantes de master). */
export async function masterFileKey(bytes: Uint8Array): Promise<string> {
  let hex = '';
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    hex = Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    hex = md5Hex(bytes);
  }
  return `master:${hex.slice(0, 32)}`;
}

/** Requête d'export d'un master de fichier (aucun élément du catalogue, aucun kit). */
export const masterExportQuery = (fileKey: string): ExportQuery => ({ projectKey: fileKey, catalogIds: [], kits: false, scope: 'mix' });

export interface MasterExportAccess {
  kind: 'admin' | 'pro' | 'unlocked' | 'pay' | 'error';
  /** Prix de l'export selon la grille du serveur (« 1,99 € ») ; null si la grille est indisponible. */
  price: string | null;
  loginRequired: boolean;
  grille: Grille;
  message?: string;
}

/** Ce que coûtera l'export de ce morceau pour ce compte (libellé du bouton), d'après le serveur. */
export async function masterExportAccess(fileKey: string): Promise<MasterExportAccess> {
  const [grille, a]: [Grille, ExportAccess] = await Promise.all([loadPricing(), exportAccess(masterExportQuery(fileKey))]);
  const price = grille.unavailable ? null : euros(grille.export.cents);
  const base = { price, loginRequired: !!a.login_required, grille };
  if (a.unlocked) return { ...base, kind: a.via === 'admin' ? 'admin' : a.via === 'pro' ? 'pro' : 'unlocked' };
  if (a.reason === 'erreur') return { ...base, kind: 'error', message: a.message || 'Vérification impossible, réessaie.' };
  return { ...base, kind: 'pay' };
}

export interface UnlockResult { ok: boolean; via?: 'admin' | 'pro' | 'deja_paye' | 'credit' | 'paiement'; message: string }

/**
 * LE point d'entrée du paiement. Débloqué par le serveur → libre ; sinon
 * `startExportPayment` (produit de la grille, Stripe ouvert pendant le clic :
 * l'accès est lu d'avance), puis attente du paiement.
 */
export async function unlockMasterExport(fileKey: string, opts: { access?: MasterExportAccess | null; isCancelled?: () => boolean; onWaiting?: () => void } = {}): Promise<UnlockResult> {
  const access = opts.access || await masterExportAccess(fileKey);
  if (access.kind === 'admin') return { ok: true, via: 'admin', message: 'Compte admin : export gratuit.' };
  if (access.kind === 'pro') return { ok: true, via: 'pro', message: 'Inclus dans Nova Pro.' };
  if (access.kind === 'unlocked') return { ok: true, via: 'deja_paye', message: 'Morceau déjà débloqué : exporte autant de versions que tu veux.' };
  if (access.kind === 'error') return { ok: false, message: access.message || 'Vérification impossible, réessaie.' };
  if (access.loginRequired) return { ok: false, message: 'Connecte-toi à ton compte Make Music pour exporter (l’écoute reste gratuite).' };
  if (!productFor(access.grille, 'export') || access.grille.unavailable) return { ok: false, message: 'Prix indisponible (connexion ?) : réessaie dans un instant.' };
  try {
    const r = await startExportPayment(masterExportQuery(fileKey), access.grille);
    if (r.credit) { forgetExportAccess(fileKey); return { ok: true, via: 'credit', message: '⭐ Export Nova Pro utilisé.' }; }
    opts.onWaiting?.();
    const paid = r.sessionId ? await waitPaid(r.sessionId, opts.isCancelled) : false;
    if (!paid) return { ok: false, message: 'Paiement non reçu : l’écoute reste libre, réessaie quand tu veux.' };
    forgetExportAccess(fileKey);
    return { ok: true, via: 'paiement', message: '✅ Paiement reçu : ton master se télécharge.' };
  } catch (e: any) {
    const m = String(e?.message || 'erreur');
    return { ok: false, message: /auth|connect|jwt|login|401/i.test(m) ? 'Connecte-toi à ton compte Make Music pour exporter (l’écoute reste gratuite).' : `Paiement impossible : ${m}` };
  }
}
