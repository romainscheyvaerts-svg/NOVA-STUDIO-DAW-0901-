import React, { useState } from 'react';
import type { RemoteInge } from '../hooks/useRemoteInge';
import { SLOT_LABEL } from '../utils/remoteInge';

/**
 * Mode « Ingé à distance (ses propres VST) » : chacun sa session.
 *  - Artiste : lien d'invitation, zone d'envoi (glisser une piste sur
 *    Lead / Backs…), état de chaque piste (« Chez l'ingé… », « Mise à jour
 *    reçue »), « Recevoir les réglages de l'ingé », « Revenir à ma prise brute ».
 *  - Ingé : enregistrement / mix, pont VST, pistes reçues, règle des envois
 *    (« Déplacer en envoi »), « Geler et envoyer à l'artiste », compensation.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  remote: RemoteInge;
}

const TONE: Record<string, string> = {
  info: 'text-slate-300', busy: 'text-sky-300', ok: 'text-emerald-300', warn: 'text-amber-300', error: 'text-red-300',
};
const BOX: Record<string, string> = {
  ok: 'border-emerald-500/20 bg-emerald-500/[0.06]', busy: 'border-sky-500/20 bg-sky-500/[0.06]',
  warn: 'border-amber-500/30 bg-amber-500/10', error: 'border-red-500/30 bg-red-500/10',
};
const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? "à l'instant" : s < 3600 ? `il y a ${Math.round(s / 60)} min` : `il y a ${Math.round(s / 3600)} h`;
};
/** « Max (ingé) », mais « Ingé son » tout court quand le nom est déjà le rôle. */
const who = (name: string, peerIsEngineer: boolean): string => {
  const role = peerIsEngineer ? 'ingé' : 'artiste';
  return name.toLowerCase().includes(role) ? name : `${name} (${role})`;
};
const btn = 'h-10 rounded-xl px-3 text-[12px] font-black transition-colors disabled:opacity-40';

const RemoteIngePanel: React.FC<Props> = ({ open, onClose, remote: r }) => {
  const [copied, setCopied] = useState(false);
  const [copiedArtist, setCopiedArtist] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  if (!open) return null;
  const isArtist = r.role === 'artist';

  const copy = async () => {
    if (!r.inviteUrl) return;
    try { await navigator.clipboard.writeText(r.inviteUrl); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* */ }
  };
  const copyArtist = async () => {
    if (!r.artistInviteUrl) return;
    try { await navigator.clipboard.writeText(r.artistInviteUrl); setCopiedArtist(true); setTimeout(() => setCopiedArtist(false), 1600); } catch { /* */ }
  };
  const dropProps = (slot: string) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('trackid') || e.dataTransfer.types.includes('trackId')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(slot); } },
    onDragLeave: () => setOver(o => (o === slot ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('trackId'); if (id) r.sendTrack(id, slot); },
  });

  return (
    <div data-testid="remote-panel" className="fixed right-3 bottom-20 md:bottom-4 z-[640] w-[min(400px,calc(100vw-24px))] max-h-[min(680px,calc(100vh-110px))] flex flex-col rounded-3xl border border-white/10 bg-nv-surface/[0.97] shadow-2xl backdrop-blur" role="dialog" aria-labelledby="remote-title">
      <div className="flex items-center gap-2 p-4 border-b border-white/5">
        <h2 id="remote-title" className="flex-1 text-[14px] font-black text-white">🎧 Ingé à distance</h2>
        <span data-testid="remote-phase" className={`rounded-full px-2.5 py-1 text-[10px] font-black ${r.phase === 'mixing' ? 'bg-violet-500/20 text-violet-200' : 'bg-rose-500/20 text-rose-200'}`}>
          {r.phase === 'mixing' ? 'Mix' : 'Enregistrement'}
        </span>
        <button type="button" onClick={onClose} aria-label="Fermer" className="w-9 h-9 rounded-xl bg-white/5 text-slate-300">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {r.connecting && <p role="status" className="text-[12px] text-sky-300"><i className="fas fa-circle-notch fa-spin mr-1.5" />{r.connecting}</p>}
        {r.status && r.status.code !== 'live' && r.status.code !== 'waiting_peer' && (
          <div data-testid="remote-conn" role="status" className={`rounded-2xl border p-2.5 ${BOX[r.status.tone]}`}>
            <p className={`text-[11px] leading-snug ${TONE[r.status.tone]}`}>{r.status.label}</p>
            {r.status.action && (
              <button type="button" data-testid="remote-conn-action" onClick={() => (r.status!.action === 'reload' ? void r.reconnect() : r.retry())}
                className={`${btn} mt-2 h-9 ${r.status.action === 'reload' ? 'bg-red-400 text-black' : 'bg-white/10 text-white'}`}>{r.status.action === 'reload' ? 'Se reconnecter au lien' : r.status.actionLabel}</button>
            )}
          </div>
        )}
        <p data-testid="remote-peer" className="text-[12px] text-slate-300">
          {r.peerName
            ? <><span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1.5" />{who(r.peerName, isArtist)} est connecté.</>
            : r.peerSeen
              ? <><span className="inline-block w-2 h-2 rounded-full bg-sky-400 mr-1.5" />{who(r.peerSeen.name, isArtist)} actif {ago(r.peerSeen.at)}.</>
              : isArtist ? "Ton ingé n'est pas encore connecté : envoie-lui le lien ci-dessous." : "L'artiste n'est pas connecté pour l'instant : ses envois t'attendent en ligne."}
        </p>
        {r.queuedCount > 0 && <p className="text-[11px] text-amber-300">📡 {r.queuedCount} envoi{r.queuedCount > 1 ? 's' : ''} en attente de connexion : ça partira tout seul.</p>}

        {isArtist ? (
          <>
            {r.inviteUrl && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-slate-400">Lien pour ton ingé : il l'ouvre dans SA session NOVA (l'appli Windows, pour ses VST).</p>
                <div className="flex gap-1.5">
                  <input readOnly value={r.inviteUrl} aria-label="Lien d'invitation de l'ingé" data-testid="remote-invite"
                    className="h-10 flex-1 min-w-0 rounded-xl border border-white/10 bg-black/40 px-2 text-[11px] text-slate-300" onFocus={e => e.currentTarget.select()} />
                  <button type="button" onClick={copy} className={`${btn} bg-white/10 text-white`}>{copied ? 'Copié ✓' : 'Copier'}</button>
                </div>
                {r.artistInviteUrl && (
                  <button type="button" onClick={copyArtist} data-testid="remote-invite-artist" className="text-[11px] text-cyan-300 underline">
                    {copiedArtist ? 'Lien copié ✓ (pour un autre artiste)' : '+ Inviter un autre artiste sur ce lien (même ingé, chacun ses pistes)'}
                  </button>
                )}
              </div>
            )}

            <div data-testid="remote-dropzone" className="rounded-2xl border-2 border-dashed border-cyan-500/40 bg-cyan-500/5 p-3">
              <p className="text-[12px] font-bold text-white">📤 Envoyer à l'ingé</p>
              <p className="text-[11px] text-slate-400 mb-2">Glisse une piste (sa poignée ⋮⋮) sur son emplacement :</p>
              <div className="grid grid-cols-2 gap-1.5">
                {Object.entries(SLOT_LABEL).map(([slot, label]) => (
                  <div key={slot} {...dropProps(slot)} data-testid={`remote-slot-${slot}`}
                    className={`h-11 rounded-xl border flex items-center justify-center text-[12px] font-black transition-colors ${over === slot ? 'border-cyan-300 bg-cyan-500/25 text-white' : 'border-white/10 bg-black/30 text-slate-300'}`}>
                    {label}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2" aria-live="polite">
              {r.artistRows.length === 0 && <p className="text-[12px] text-slate-500">Pas encore de prise : enregistre une voix, ta piste apparaîtra ici.</p>}
              {r.artistRows.map(({ track: t, status, busy }) => {
                const rm = t.remote;
                const hasPending = !!rm?.pending;
                const applied = !!rm?.appliedSig && !rm?.reverted;
                return (
                  <div key={t.id} data-testid={`remote-row-${t.id}`} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-6 rounded-full" style={{ background: t.color }} />
                      <span className="flex-1 truncate text-[13px] font-bold text-white">{t.name}{rm?.slot && SLOT_LABEL[rm.slot] ? <span className="ml-1 text-[11px] text-slate-400">· {SLOT_LABEL[rm.slot]}</span> : null}</span>
                    </div>
                    {(busy || status.label) && <p data-testid={`remote-status-${t.id}`} className={`text-[11px] ${TONE[busy ? 'busy' : status.tone]}`}>{busy || status.label}</p>}
                    <div className="flex flex-wrap gap-1.5">
                      {!rm?.sentV && <button type="button" data-testid={`remote-send-${t.id}`} onClick={() => r.sendTrack(t.id)} className={`${btn} bg-cyan-500 text-black`}>Envoyer à l'ingé</button>}
                      {hasPending && <button type="button" data-testid={`remote-receive-${t.id}`} onClick={() => { void r.receive(t.id); }} disabled={!!busy}
                        className={`${btn} bg-emerald-400 text-black`}>{rm?.reverted ? "Réappliquer les réglages de l'ingé" : "Recevoir les réglages de l'ingé"}</button>}
                      {applied && rm?.before && <button type="button" data-testid={`remote-revert-${t.id}`} onClick={() => r.revert(t.id)} className={`${btn} bg-white/10 text-white`}>Revenir à ma prise brute</button>}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500">Tes coupes, fondus, volumes et nouvelles prises repartent tout seuls chez l'ingé, qui te renvoie la piste avec ses effets. Ta prise brute est toujours gardée.</p>
          </>
        ) : (
          <>
            {r.phase === 'recording' ? (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3 space-y-2">
                <p className="text-[12px] text-rose-100">🎙️ Enregistrement en direct : reverbs et délais de NOVA seulement. L'artiste les a aussi et les entend en direct, exactement comme toi (leurs réglages sont synchronisés).</p>
                <button type="button" data-testid="remote-phase-mix" onClick={() => r.setPhase('mixing')} className={`${btn} w-full bg-violet-600 text-white`}>Enregistrement terminé : passer au mix</button>
              </div>
            ) : (
              <div className="rounded-2xl border border-violet-500/30 bg-violet-500/10 p-3 space-y-2">
                <p className="text-[12px] text-violet-100">🎚️ Mix : remplace la reverb de NOVA par ta reverb VST sur le bus d'envoi, puis « Geler et envoyer à l'artiste » (la session est sauvegardée). L'artiste reçoit le rendu et peut toujours retoucher.</p>
                <button type="button" onClick={() => r.setPhase('recording')} className={`${btn} w-full bg-white/10 text-white`}>Revenir à l'enregistrement</button>
              </div>
            )}
            {!r.bridgeConnected && (
              <p data-testid="remote-bridge" className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-100">
                🔌 Pont VST non connecté : ouvre NOVA Studio pour Windows (ou « Connecter » dans l'onglet VST) pour travailler avec tes VST. Les effets de NOVA marchent sans.
              </p>
            )}
            <div className="space-y-2" aria-live="polite">
              {r.engineerRows.length === 0 && <p className="text-[12px] text-slate-500">Aucune piste reçue pour l'instant. Quand l'artiste t'en envoie une, elle arrive ici et dans ta session.</p>}
              {r.engineerRows.map(({ track: t, label, tone, issues, busy, latencyMs, failed }) => (
                <div key={t.id} data-testid={`remote-row-${t.id}`} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-6 rounded-full" style={{ background: t.color }} />
                    <span className="flex-1 truncate text-[13px] font-bold text-white">{t.name}{t.collabOwnerName && !t.name.includes(t.collabOwnerName) ? <span className="ml-1 text-[11px] font-normal text-slate-400">· de {t.collabOwnerName}</span> : null}</span>
                    <span className="text-[10px] text-slate-500">v{t.remote?.recvV ?? 0}</span>
                  </div>
                  <p data-testid={`remote-status-${t.id}`} className={`text-[11px] ${TONE[tone]}`}>{label}</p>
                  {latencyMs > 0 && <p className="text-[10px] text-slate-500">Compensation : {latencyMs} ms</p>}
                  {issues.map(i => (
                    <div key={`${i.trackId}-${i.pluginId}`} data-testid="remote-issue" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2 space-y-1.5">
                      <p className="text-[11px] text-amber-100">{i.message}</p>
                      <button type="button" onClick={() => r.fixIssue(i)} className={`${btn} h-9 bg-amber-400 text-black`}>
                        {i.fix === 'move-to-send' ? `Déplacer « ${i.pluginName} » en envoi` : `Mettre « ${i.pluginName} » en pause`}
                      </button>
                    </div>
                  ))}
                  <button type="button" data-testid={`remote-return-${t.id}`} disabled={!!busy || issues.length > 0 || !!r.otherEngineer} onClick={() => { void r.returnTrack(t.id); }}
                    className={`${btn} w-full ${failed ? 'bg-amber-400' : 'bg-cyan-500'} text-black`}>{busy ? 'En cours…' : failed ? 'Réessayer : geler et envoyer' : "Geler et envoyer à l'artiste"}</button>
                  {t.remote?.auto && <p className="text-[10px] text-slate-500">Renvoi automatique activé : ses prochaines coupes reviennent ici, sont regelées et repartent toutes seules.</p>}
                </div>
              ))}
            </div>
          </>
        )}
        {r.error && <p role="alert" className="text-[12px] text-red-300">{r.error}</p>}
      </div>
      <button type="button" onClick={() => { void r.leave(true); }} className="pb-3 text-[11px] text-slate-500 underline">Quitter le lien</button>
    </div>
  );
};

export default RemoteIngePanel;
