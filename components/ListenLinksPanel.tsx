import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createListenLink, listListenLinks, revokeListenLink, type SessionKey } from '../services/ListenLinks';
import { listenHost, type ListenHostState } from '../services/ListenBroadcast';
import {
  appBase, contentSummary, expiresIn, listenUrl, LISTEN_TTL_OPTIONS,
  type ListenLinkInfo, type ListenTtlHours,
} from '../utils/listenLink';

/**
 * « Lien d'écoute client » (côté ingé, dans Collaboration) : remplace
 * Audiomovers. L'ingé crée un lien (24 h, 7 j ou 30 j ; mix en direct,
 * versions, commentaires ; mot de passe facultatif), le copie, le partage ou
 * le fait scanner (QR). Son client l'ouvre sur son téléphone, sans compte.
 * Liste des liens actifs, révocation en un clic, diffusion du mix en direct
 * aux clients (services/ListenBroadcast).
 */

interface Props {
  /** Séance en ligne (lien <id>.<secret>) ; null : pas encore de séance. */
  session: SessionKey | null;
  /** Nom de l'ingé, montré au client (« Max diffuse son mix »). */
  name: string;
  /** Flux du mix (master NOVA ou source choisie), moteur prêt. */
  getMixStream: () => Promise<MediaStream | null>;
}

const btn = 'nova-hit-tactile inline-flex items-center justify-center gap-1.5 rounded-xl px-3 text-[12px] font-black transition-colors disabled:opacity-50';

const linkOf = (l: Pick<ListenLinkInfo, 'token'>) => {
  let base = '';
  try { base = appBase(window.location, !!(window as any).__novaDesktop, import.meta.env.BASE_URL); } catch { base = appBase(null, true); }
  return listenUrl(l.token, base);
};

async function copyText(text: string, input?: HTMLInputElement | null): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* repli */ }
  try { if (input) { input.select(); return document.execCommand('copy'); } } catch { /* */ }
  return false;
}

const ListenLinksPanel: React.FC<Props> = ({ session, name, getMixStream }) => {
  const [links, setLinks] = useState<ListenLinkInfo[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState<ListenTtlHours>(168);
  const [live, setLive] = useState(true);
  const [versions, setVersions] = useState(true);
  const [comments, setComments] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ link: ListenLinkInfo; password: boolean } | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [host, setHost] = useState<ListenHostState>(listenHost.state());

  useEffect(() => listenHost.subscribe(setHost), []);
  useEffect(() => { listenHost.configure(session, name); }, [session, name]);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const l = await listListenLinks(session);
      setLinks(l); setLoadErr(null);
      listenHost.setLinks(l);
    } catch (e: any) {
      setLoadErr(e?.status === 401 ? 'Connecte-toi à ton compte Make Music pour voir tes liens.' : e?.message || 'Liste indisponible');
    }
  }, [session]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Compteurs (ouvertures) et expirations à jour pendant que le panneau est ouvert.
  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(id);
  }, [session, refresh]);
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 3500); return () => window.clearTimeout(id); }, [toast]);

  const nothing = !live && !versions && !comments;
  const pwBad = password.length > 0 && (password.length < 4 || password.length > 64);

  const create = async () => {
    if (!session || nothing || pwBad) return;
    setBusy('create'); setErr(null);
    try {
      const link = await createListenLink(session, { ttlHours: ttl, live, versions, comments, password: password || undefined, label: label.trim() || undefined });
      setCreated({ link, password: !!password });
      setShown(link.id);
      setPassword(''); setLabel(''); setFormOpen(false);
      const next = [link, ...(links || []).filter(l => l.id !== link.id)];
      setLinks(next);
      listenHost.setLinks(next);
    } catch (e: any) {
      setErr(e?.status === 401 ? 'Connecte-toi à ton compte Make Music pour créer un lien.' : e?.message || 'Création impossible : réessaie.');
    } finally { setBusy(null); }
  };

  const revoke = async (l: ListenLinkInfo) => {
    if (!session) return;
    setBusy(`revoke:${l.id}`); setErr(null);
    try {
      await revokeListenLink(session, l.id);
      listenHost.forget(l.id);
      const next = (links || []).filter(x => x.id !== l.id);
      setLinks(next);
      listenHost.setLinks(next);
      if (created?.link.id === l.id) setCreated(null);
      setToast(`Lien ${l.label ? `« ${l.label} » ` : ''}révoqué : il ne s'ouvre plus.`);
    } catch (e: any) {
      setErr(e?.message || 'Révocation impossible : réessaie.');
    } finally { setBusy(null); }
  };

  const copy = async (l: ListenLinkInfo) => {
    const ok = await copyText(linkOf(l), document.querySelector<HTMLInputElement>(`[data-listen-url="${l.id}"]`));
    setCopied(ok ? l.id : null);
    if (ok) window.setTimeout(() => setCopied(c => (c === l.id ? null : c)), 2500);
    else setErr('Copie impossible ici : sélectionne le lien et copie-le à la main.');
  };
  const canShare = typeof navigator !== 'undefined' && typeof (navigator as any).share === 'function';

  const toggleLive = async () => {
    if (host.on) { listenHost.stop(); return; }
    const ok = await listenHost.start(getMixStream);
    if (ok && !(links || []).some(l => l.live)) setToast("Diffusion prête : crée un lien avec « Mix en direct » pour que ton client l'entende.");
  };

  const active = useMemo(() => (links || []).filter(l => Date.parse(l.expires_at) > Date.now()), [links]);
  const liveListeners = Object.values(host.links).reduce((s, x) => s + x.connected, 0);

  return (
    <div className="p-4 space-y-2 border-b border-white/5" data-testid="listen-links">
      <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Lien d'écoute client</p>
      <p className="text-[11px] leading-snug text-slate-400">Ton client (artiste, label, manager) écoute sur son téléphone, <b className="text-slate-200">sans compte</b> : ton mix en direct, tes versions, tes commentaires. Il ne peut rien modifier.</p>

      {!session ? (
        <p className="rounded-xl bg-white/[0.04] px-3 py-2 text-[12px] text-slate-300" data-testid="listen-no-session">La séance n'est pas encore en ligne : attends la fin de la synchronisation, puis rouvre ce panneau.</p>
      ) : (
        <>
          <button type="button" onClick={() => { void toggleLive(); }} disabled={host.starting} aria-pressed={host.on} data-testid="listen-live-toggle"
            className={`${btn} h-11 w-full ${host.on ? 'bg-red-500 text-white' : 'bg-white/10 text-white hover:bg-white/15'}`}>
            {host.starting ? 'Démarrage…' : host.on ? `● Diffusion aux clients : en direct${liveListeners ? ` · ${liveListeners} à l'écoute` : ''}` : '📡 Diffuser mon mix à mes clients'}
          </button>
          {host.error && <p className="text-[12px] text-amber-200" role="alert">{host.error}</p>}
          {host.on && <p className="text-[11px] text-slate-400">Tes clients entendent ton master tel que tu l'entends (Opus stéréo ≈ 510 kb/s), dès qu'ils touchent « Écouter ».</p>}

          {!formOpen ? (
            <button type="button" onClick={() => { setFormOpen(true); setErr(null); }} data-testid="listen-new" className={`${btn} h-11 w-full bg-cyan-500/20 text-cyan-100 hover:bg-cyan-500/30`}>＋ Nouveau lien d'écoute</button>
          ) : (
            <form className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-testid="listen-form"
              onSubmit={(e) => { e.preventDefault(); void create(); }}>
              <label className="block text-[11px] font-bold text-slate-300">Pour qui ? <span className="font-normal text-slate-500">(facultatif)</span>
                <input value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => e.stopPropagation()} maxLength={60} placeholder="Label, manager, artiste…" data-testid="listen-label"
                  className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
              </label>
              <fieldset>
                <legend className="text-[11px] font-bold text-slate-300">Valable</legend>
                <div className="mt-1 grid grid-cols-3 gap-1.5" role="radiogroup">
                  {LISTEN_TTL_OPTIONS.map(o => (
                    <button key={o.hours} type="button" role="radio" aria-checked={ttl === o.hours} onClick={() => setTtl(o.hours)} data-testid={`listen-ttl-${o.hours}`}
                      className={`${btn} h-10 ${ttl === o.hours ? 'bg-cyan-400 text-black' : 'bg-white/10 text-white'}`}>{o.label}</button>
                  ))}
                </div>
              </fieldset>
              <fieldset className="space-y-1">
                <legend className="text-[11px] font-bold text-slate-300">Ce que le client voit</legend>
                {([['live', live, setLive, 'Mix en direct', "quand tu diffuses"], ['versions', versions, setVersions, 'Versions envoyées', 'avec leur écoute'], ['comments', comments, setComments, 'Commentaires', 'en lecture seule']] as const).map(([k, v, set, t, help]) => (
                  <label key={k} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-white/[0.03] px-2.5 py-1.5">
                    <input type="checkbox" checked={v} onChange={e => set(e.target.checked)} data-testid={`listen-opt-${k}`} className="h-5 w-5 accent-cyan-400" />
                    <span className="text-[12px] text-slate-200">{t} <span className="text-slate-500">· {help}</span></span>
                  </label>
                ))}
                {nothing && <p className="text-[11px] text-amber-200">Coche au moins une chose à partager.</p>}
              </fieldset>
              <label className="block text-[11px] font-bold text-slate-300">Mot de passe <span className="font-normal text-slate-500">(facultatif, à donner à part)</span>
                <input type="text" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.stopPropagation()} autoComplete="off" maxLength={64} data-testid="listen-password-new"
                  className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" placeholder="Aucun" />
              </label>
              {pwBad && <p className="text-[11px] text-amber-200">Le mot de passe fait de 4 à 64 caractères.</p>}
              <div className="flex gap-1.5">
                <button type="submit" disabled={!!busy || nothing || pwBad} data-testid="listen-create" className={`${btn} h-11 flex-1 bg-cyan-400 text-black`}>{busy === 'create' ? 'Création…' : 'Créer le lien'}</button>
                <button type="button" onClick={() => setFormOpen(false)} className={`${btn} h-11 bg-white/10 text-white`}>Annuler</button>
              </div>
            </form>
          )}

          {err && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-[12px] text-red-200" role="alert" data-testid="listen-error-inge">{err}</p>}
          {toast && <p className="rounded-xl bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200" role="status" data-testid="listen-toast">{toast}</p>}

          <p className="pt-1 text-[11px] font-black uppercase tracking-wider text-slate-400">Liens actifs · {active.length}</p>
          {loadErr && <p className="text-[12px] text-amber-200">{loadErr} <button type="button" onClick={() => { void refresh(); }} className="underline">Réessayer</button></p>}
          {links === null && !loadErr && <p className="text-[11px] text-slate-500">Chargement…</p>}
          {links !== null && active.length === 0 && <p className="text-[11px] text-slate-500" data-testid="listen-empty">Aucun lien actif. Crée-en un pour faire écouter ton mix.</p>}
          <ul className="space-y-1.5" aria-label="Liens d'écoute actifs">
            {active.map(l => {
              const stat = host.links[l.id];
              const open = shown === l.id;
              return (
                <li key={l.id} data-testid="listen-link" data-link-id={l.id} className="rounded-xl bg-white/[0.04] px-2.5 py-2">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 text-[12px] leading-snug">
                      <p className="truncate font-black text-white">{l.label || 'Lien sans nom'}{l.has_password && <span className="ml-1" title="Protégé par un mot de passe">🔒</span>}</p>
                      <p className="text-[11px] text-slate-400">{contentSummary(l)} · {expiresIn(l.expires_at)}</p>
                      <p className="text-[11px] text-slate-500">
                        {l.opens ? `ouvert ${l.opens} fois` : 'pas encore ouvert'}
                        {stat && stat.visitors > 0 && <span className="text-emerald-300"> · {stat.visitors} sur la page{stat.connected ? `, ${stat.connected} à l'écoute` : ''}</span>}
                      </p>
                    </div>
                    <button type="button" onClick={() => setShown(open ? null : l.id)} aria-expanded={open} data-testid="listen-show" className={`${btn} h-9 bg-white/10 text-white`}>{open ? 'Masquer' : 'Lien / QR'}</button>
                    <button type="button" onClick={() => { void revoke(l); }} disabled={busy === `revoke:${l.id}`} data-testid="listen-revoke" className={`${btn} h-9 bg-red-500/20 text-red-100 hover:bg-red-500/30`}>
                      {busy === `revoke:${l.id}` ? '…' : 'Révoquer'}
                    </button>
                  </div>
                  {open && <LinkShare link={l} copied={copied === l.id} onCopy={() => { void copy(l); }} canShare={canShare}
                    passwordNote={created?.link.id === l.id && created.password} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
};

const LinkShare: React.FC<{ link: ListenLinkInfo; copied: boolean; onCopy: () => void; canShare: boolean; passwordNote: boolean }> = ({ link, copied, onCopy, canShare, passwordNote }) => {
  const url = linkOf(link);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Librairie du QR chargée à la demande (déjà utilisée par « Session à emporter »).
    void import('qrcode').then(m => (m.default || m).toDataURL(url, { margin: 1, width: 220, color: { dark: '#0b0d10', light: '#ffffff' } }))
      .then(d => { if (alive) setQr(d); }).catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [url]);
  return (
    <div className="mt-2 space-y-2" data-testid="listen-share">
      <input readOnly value={url} data-listen-url={link.id} data-testid="listen-link-url" onFocus={e => e.currentTarget.select()} aria-label="Lien d'écoute"
        className="h-10 w-full rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-[11px] text-slate-200" />
      <div className="flex gap-1.5">
        <button type="button" onClick={onCopy} data-testid="listen-copy" className={`${btn} h-10 flex-1 ${copied ? 'bg-emerald-400 text-black' : 'bg-white text-black'}`}>{copied ? 'Lien copié ✓' : '🔗 Copier'}</button>
        {canShare && <button type="button" onClick={() => { void (navigator as any).share({ title: "Écoute de ma séance", text: 'Écoute le mix (sans compte) :', url }).catch(() => { /* annulé */ }); }}
          className={`${btn} h-10 bg-white/10 text-white`}>Partager</button>}
      </div>
      {qr ? <img src={qr} alt="QR code du lien d'écoute : à scanner avec l'appareil photo du téléphone" data-testid="listen-qr" className="mx-auto h-44 w-44 rounded-xl bg-white p-1" />
        : <p className="text-center text-[11px] text-slate-500">QR code en préparation…</p>}
      {passwordNote && <p className="text-[11px] text-amber-200">🔒 Donne le mot de passe à part (SMS, appel) : il n'est pas dans le lien.</p>}
      {link.live && <p className="text-[11px] text-slate-500">Le client entend ton mix quand « Diffuser mon mix à mes clients » est actif.</p>}
    </div>
  );
};

export default ListenLinksPanel;
