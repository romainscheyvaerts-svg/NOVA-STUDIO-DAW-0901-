import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DAWState } from '../types';
import { videoTake, type CamState } from '../utils/videoTakeRecorder';
import { fmtBytes, fmtMinutes, type VideoFormat } from '../utils/videoTake';
import { deleteTake, listMeta, videoDbAvailable, type VideoTakeMeta } from '../utils/videoTakeStore';
import { useSimpleMode } from '../utils/simpleMode';

const VideoTakeExportModal = lazy(() => import('./VideoTakeExportModal'));

/**
 * Lot 2b · « 🎥 Filmer la prise » : la caméra pendant la prise (bureau et téléphone).
 *
 *  - pastille « 🎥 Filmer » quand une piste voix est armée (un geste pour ouvrir) ;
 *  - panneau : autorisation expliquée, choix de la caméra (avant / arrière au téléphone),
 *    format 9:16 ou 16:9, aperçu avec voyant REC, « Couper la caméra » en un geste,
 *    place restante, calage par clap, vidéos du projet ;
 *  - la vidéo reste sur l'appareil (pas de collaboration, pas de cloud), dit clairement.
 * La caméra ne prend que l'image : le micro et la carte son de la prise ne changent pas.
 */
interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  state: DAWState;
  /** Séance à plusieurs en cours : la vidéo n'est pas envoyée (message renforcé). */
  inCollab?: boolean;
  ownedInstrumentIds?: (string | number)[];
  onBuyBeat: () => void;
  onOpenExport?: () => void;
  onLyricsChange: (text: string) => void;
}

const HIDE_PILL = 'nova_video_pill_hidden';
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const isTouch = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; } };

function useCam(): CamState { return useSyncExternalStore(videoTake.subscribe, videoTake.getSnapshot, videoTake.getSnapshot); }

const VideoTakeDock: React.FC<Props> = props => {
  const { open, onOpen, onClose, state } = props;
  const cam = useCam();
  const { simple } = useSimpleMode();
  const [pillHidden, setPillHidden] = useState(() => { try { return sessionStorage.getItem(HIDE_PILL) === '1'; } catch { return false; } });
  const [mini, setMini] = useState(false);
  const [takes, setTakes] = useState<VideoTakeMeta[]>([]);
  const [exportFor, setExportFor] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [, tick] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => { videoTake.setProject(state.id || null, state.name || ''); }, [state.id, state.name]);

  const reload = useCallback(async () => {
    if (!videoDbAvailable()) return;
    try { setTakes(await listMeta(state.id || null)); } catch { setTakes([]); }
  }, [state.id]);
  useEffect(() => { if (open) void reload(); }, [open, reload]);
  useEffect(() => {
    const on = () => { void reload(); };
    window.addEventListener('nova:video-take-saved', on);
    return () => window.removeEventListener('nova:video-take-saved', on);
  }, [reload]);
  useEffect(() => { if (open && cam.status === 'off') void videoTake.refreshStorage(); }, [open, cam.status]);

  // Aperçu : le flux de la caméra (muet, jamais de son).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.srcObject !== videoTake.stream) v.srcObject = videoTake.stream;
    if (videoTake.stream) void v.play().catch(() => { /* lecture auto refusée : l'image reste figée */ });
    videoTake.attachPreview(videoTake.stream ? v : null);
  }, [cam.status, cam.deviceId, cam.facing, open, mini]);

  // Voyant REC : le compteur avance.
  useEffect(() => {
    if (!cam.recording) return;
    const id = setInterval(() => tick(x => x + 1), 500);
    return () => clearInterval(id);
  }, [cam.recording]);

  // Échap réduit le panneau (sans couper la caméra) ; jamais pendant une prise.
  useEffect(() => {
    if (!open || exportFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || cam.recording) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (cam.status === 'on') setMini(true); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, exportFor, cam.recording, cam.status, onClose]);

  const linkedIds = useMemo(() => new Set(state.tracks.flatMap(t => t.clips.map(c => c.bufferId || c.id))), [state.tracks]);
  const voiceArmed = state.tracks.some(t => t.isTrackArmed && t.type === 'AUDIO');

  const turnOn = async () => { setMini(false); await videoTake.open(); };
  const cut = () => { videoTake.close(); };
  const closeAll = () => { if (cam.recording) return; videoTake.close(); onClose(); };
  const remove = async (id: string) => { await deleteTake(id); setConfirmDel(null); await reload(); void videoTake.refreshStorage(); };

  // ── Pastille (panneau fermé) ──
  if (!open) {
    // Mode simple : pas de pastille flottante (elle recouvrait « Envoyer » du chat invité et la carte
    // « Et maintenant ? ») ; la caméra est dans le menu ☰ (« Plus d'outils ») et la palette Ctrl+K.
    // Téléphone (< 640 px), même en mode avancé : la pastille recouvrait « Envois » de la piste sélectionnée.
    // La caméra y est dans ☰ (« Filmer la prise ») et la palette.
    const phone = typeof window !== 'undefined' && window.innerWidth < 640;
    if (!voiceArmed || pillHidden || simple || phone) return null;
    return (
      <div className="fixed z-[640] bottom-[140px] right-3 sm:bottom-[120px] sm:right-5 flex items-center gap-1 rounded-full border border-nv-line bg-nv-panel/95 text-nv-ink shadow-xl pl-1 pr-1 backdrop-blur" data-testid="video-take-pill">
        <button type="button" onClick={onOpen} className="h-10 rounded-full px-3 text-[13px] font-bold hover:bg-nv-accent/10" aria-label="Filmer la prise avec la caméra"
          title="Filme-toi pendant la prise : la vidéo se cale sur ton son">🎥 Filmer la prise</button>
        <button type="button" onClick={() => { setPillHidden(true); try { sessionStorage.setItem(HIDE_PILL, '1'); } catch { /* */ } }}
          className="h-8 w-8 rounded-full text-nv-muted hover:bg-nv-accent/10" aria-label="Masquer « Filmer la prise » (palette Ctrl+K : « caméra »)" title="Masquer (Ctrl+K « caméra » pour la retrouver)">×</button>
      </div>
    );
  }

  const vertical = cam.format === '9:16';
  const recSecs = cam.recording && cam.recSince !== null ? (performance.now() - cam.recSince) / 1000 : 0;
  const on = cam.status === 'on';
  const mirrored = cam.facing === 'user';
  const chip = (sel: boolean) => `min-h-[40px] px-3 rounded-xl border text-[12px] font-bold transition-colors disabled:opacity-40 ${sel ? 'border-cyan-400 bg-cyan-500/15 text-nv-ink' : 'border-nv-line text-nv-muted hover:bg-nv-accent/10'}`;
  const st = cam.storage;

  const preview = (
    <div className={`relative mx-auto overflow-hidden rounded-2xl border border-nv-line bg-black ${mini ? 'w-[120px]' : vertical ? 'w-[min(200px,46vw)]' : 'w-full'}`}
      style={{ aspectRatio: vertical ? '9 / 16' : '16 / 9' }} data-testid="video-take-preview">
      <video ref={videoRef} muted playsInline autoPlay aria-label="Aperçu de la caméra"
        className="absolute inset-0 h-full w-full object-cover" style={mirrored ? { transform: 'scaleX(-1)' } : undefined} />
      {cam.recording ? (
        <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-black text-white shadow" data-testid="video-take-rec" role="status">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />REC {fmtClock(recSecs)}
        </span>
      ) : on ? (
        <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white" data-testid="video-take-ready">
          {cam.armed ? '● Prête : filme avec REC' : 'Caméra allumée · prises non filmées'}
        </span>
      ) : null}
    </div>
  );

  // ── Panneau réduit : l'aperçu seul, avec le voyant ──
  if (mini && on) {
    return (
      <div className="fixed z-[640] bottom-[140px] right-3 sm:bottom-[120px] sm:right-5 rounded-2xl border border-nv-line bg-nv-panel p-1.5 shadow-2xl" data-testid="video-take-mini">
        {preview}
        <div className="mt-1 flex gap-1">
          <button type="button" onClick={() => setMini(false)} className="h-9 flex-1 rounded-lg text-[11px] font-bold text-nv-ink hover:bg-nv-accent/10" aria-label="Agrandir le panneau caméra">Agrandir</button>
          <button type="button" onClick={cut} className="h-9 rounded-lg px-2 text-[11px] font-bold text-red-500 hover:bg-red-500/10" aria-label="Couper la caméra" title="Couper la caméra">⏻</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="fixed z-[640] inset-x-0 bottom-0 sm:inset-x-auto sm:bottom-28 sm:right-5 sm:w-[360px] max-h-[78vh] sm:max-h-[calc(100vh-200px)] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line bg-nv-panel text-nv-ink shadow-2xl p-3 sm:p-4"
        role="region" aria-label="Filmer la prise" data-testid="video-take-panel">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-black">🎥 Filmer la prise</h2>
            <p className="text-[11px] text-nv-muted">La caméra prend l'image ; le son reste celui de ta prise NOVA (micro ou carte son).</p>
          </div>
          {on && <button type="button" onClick={() => setMini(true)} className="h-9 w-9 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10" aria-label="Réduire le panneau caméra" title="Réduire (la caméra reste allumée)">—</button>}
          <button type="button" onClick={closeAll} disabled={cam.recording} className="h-9 w-9 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10 disabled:opacity-40" aria-label="Fermer et couper la caméra"
            title={cam.recording ? 'Arrête d\'abord la prise' : 'Fermer (la caméra se coupe)'}><i className="fas fa-times" /></button>
        </div>

        {props.inCollab && (
          <p className="mt-2 rounded-xl border border-amber-400/50 bg-amber-400/10 p-2 text-[12px]" data-testid="video-take-collab">
            🔒 Séance à plusieurs : ta vidéo <b>n'est pas envoyée</b> aux autres membres. Seul ton son part dans la séance. Exporte la vidéo et partage le fichier si tu veux la montrer.
          </p>
        )}

        {cam.notice && (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-400/50 bg-amber-400/10 p-2 text-[12px]" role="alert" data-testid="video-take-notice">
            <span className="flex-1">{cam.notice}</span>
            <button type="button" onClick={() => videoTake.clearNotice()} className="text-nv-muted" aria-label="Fermer le message">×</button>
          </div>
        )}

        <div className="mt-3 space-y-3">
          {/* Format */}
          <div className="flex gap-2" role="group" aria-label="Format de la vidéo">
            {(['9:16', '16:9'] as VideoFormat[]).map(f => (
              <button key={f} type="button" disabled={cam.recording} onClick={() => videoTake.setFormat(f)} aria-pressed={cam.format === f} data-testid={`video-format-${f === '9:16' ? 'vertical' : 'horizontal'}`} className={`${chip(cam.format === f)} flex-1`}>
                {f === '9:16' ? '📱 Vertical 9:16' : '🖥 Horizontal 16:9'}
                <span className="block text-[10px] font-normal text-nv-muted">{f === '9:16' ? 'TikTok, Reels, Shorts' : 'YouTube, écran'}</span>
              </button>
            ))}
          </div>

          {cam.status === 'off' && (
            <div className="space-y-2" data-testid="video-take-intro">
              <p className="text-[12px] text-nv-muted">Ton navigateur va te demander l'accès à la <b className="text-nv-ink">caméra</b>. Elle sert seulement à filmer : NOVA ne touche ni à ton micro ni à ta carte son.</p>
              <button type="button" onClick={() => void turnOn()} data-testid="video-take-on" className="h-11 w-full rounded-xl bg-cyan-500 text-[14px] font-black text-black">Allumer la caméra</button>
            </div>
          )}
          {cam.status === 'asking' && <p className="text-[13px]" role="status" data-testid="video-take-asking">Autorise la caméra dans la fenêtre du navigateur…</p>}
          {cam.status === 'denied' && (
            <div className="space-y-2 text-[12px]" role="alert" data-testid="video-take-denied">
              <p className="font-bold">La caméra est bloquée pour NOVA.</p>
              <p className="text-nv-muted">Dans Chrome ou Edge : clique sur le cadenas à gauche de l'adresse, puis Caméra → Autoriser. Dans l'appli Windows : Paramètres Windows → Confidentialité → Caméra → autoriser les applications de bureau. Au téléphone : Réglages du navigateur → Caméra.</p>
              <button type="button" onClick={() => void turnOn()} className="h-10 rounded-xl border border-nv-line px-4 font-bold">Réessayer</button>
            </div>
          )}
          {cam.status === 'notfound' && (
            <div className="space-y-2 text-[12px]" role="alert" data-testid="video-take-notfound">
              <p className="font-bold">Aucune caméra trouvée.</p>
              <p className="text-nv-muted">Branche une webcam (ou ouvre NOVA sur ton téléphone), puis réessaie.</p>
              <button type="button" onClick={() => void turnOn()} className="h-10 rounded-xl border border-nv-line px-4 font-bold">Réessayer</button>
            </div>
          )}
          {cam.status === 'busy' && (
            <div className="space-y-2 text-[12px]" role="alert" data-testid="video-take-busy">
              <p className="font-bold">La caméra est déjà utilisée par une autre appli (Zoom, Teams, OBS…).</p>
              <p className="text-nv-muted">Ferme-la puis réessaie.</p>
              <button type="button" onClick={() => void turnOn()} className="h-10 rounded-xl border border-nv-line px-4 font-bold">Réessayer</button>
            </div>
          )}
          {cam.status === 'error' && <p className="text-[12px] text-red-400" role="alert">La caméra n'a pas pu s'allumer ({cam.error}). Réessaie, ou recharge la page.</p>}
          {cam.status === 'unsupported' && <p className="text-[12px] text-red-400" role="alert" data-testid="video-take-unsupported">Ce navigateur ne sait pas filmer une prise ({cam.error}). Ouvre NOVA dans Chrome ou Edge (ordinateur ou Android), ou dans l'appli Windows.</p>}

          {(on || cam.status === 'asking') && preview}

          {on && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {cam.devices.length > 1 && (
                  <select value={cam.deviceId || ''} disabled={cam.recording} onChange={e => void videoTake.selectDevice(e.target.value)} aria-label="Choisir la caméra" data-testid="video-take-device"
                    className="h-10 min-w-0 flex-1 rounded-xl border border-nv-line bg-nv-surface px-2 text-[12px] text-nv-ink">
                    {cam.devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                  </select>
                )}
                {(isTouch() || cam.devices.length > 1) && (
                  <button type="button" disabled={cam.recording} onClick={() => void videoTake.switchFacing()} className={chip(false)} data-testid="video-take-flip" aria-label={cam.facing === 'user' ? 'Passer à la caméra arrière' : 'Passer à la caméra avant'}>
                    🔄 {cam.facing === 'user' ? 'Caméra arrière' : 'Caméra avant'}
                  </button>
                )}
                {cam.devices.length <= 1 && <span className="min-w-0 flex-1 truncate text-[11px] text-nv-muted" title={cam.label}>{cam.label}{cam.size ? ` · ${cam.size.width} × ${cam.size.height}` : ''}</span>}
              </div>
              <label className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={cam.armed} onChange={e => videoTake.setArmed(e.target.checked)} className="h-4 w-4 accent-cyan-400" data-testid="video-take-armed" />
                Filmer les prochaines prises (la vidéo démarre et s'arrête avec REC)
              </label>
              <button type="button" onClick={cut} data-testid="video-take-off" className="h-10 w-full rounded-xl border border-red-500/60 text-[13px] font-black text-red-500 hover:bg-red-500/10">
                ⏻ Couper la caméra{cam.recording ? ' (la prise audio continue)' : ''}
              </button>
              {cam.recording && <p className="text-[11px] text-nv-muted" role="status">Vidéo : {cam.frames} images, {fmtBytes(cam.bytes)}</p>}
            </div>
          )}

          {/* Place */}
          <p className={`text-[11px] ${st.level === 'full' ? 'text-red-400 font-bold' : st.level === 'low' ? 'text-amber-500' : 'text-nv-muted'}`} data-testid="video-take-storage" data-level={st.level}>
            {st.level === 'unknown' ? 'Place libre inconnue sur cet appareil.'
              : st.level === 'full' ? `Plus assez de place pour filmer (${fmtBytes(st.freeBytes || 0)} libres) : supprime des vidéos ci-dessous ou libère de la place sur l'appareil.`
              : st.level === 'low' ? `Place bientôt pleine : ${fmtBytes(st.freeBytes || 0)} libres, environ ${fmtMinutes(st.minutes || 0)} de vidéo. Une minute filmée ≈ 19 Mo.`
              : `Place libre : ${fmtBytes(st.freeBytes || 0)}, environ ${fmtMinutes(st.minutes || 0)} de vidéo.`}
          </p>
          <p className="text-[11px] text-nv-muted" data-testid="video-take-privacy">🔒 Les vidéos restent sur cet appareil. Elles ne sont pas envoyées en collaboration ni dans le cloud.</p>

          {/* Vidéos du projet */}
          <section aria-label="Vidéos de ce projet" className="space-y-2">
            <h3 className="text-[13px] font-bold">Prises filmées de ce projet</h3>
            {!takes.length ? (
              <p className="text-[12px] text-nv-muted" data-testid="video-take-empty">Aucune pour l'instant. Allume la caméra, puis enregistre une prise (REC) : la vidéo se range ici, calée sur ton son.</p>
            ) : (
              <ul className="space-y-2">
                {takes.map(m => {
                  const live = m.bufferIds.some(id => linkedIds.has(id));
                  const name = state.tracks.find(t => t.id === m.trackIds[0])?.name || 'Prise';
                  return (
                    <li key={m.id} className="rounded-xl border border-nv-line p-2 text-[12px]" data-testid="video-take-item" data-id={m.id}>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-bold">{name} · {new Date(m.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                        <span className="shrink-0 text-nv-muted">{fmtClock(m.durationSec)} · {m.format} · {fmtBytes(m.bytes)}</span>
                      </div>
                      {m.status === 'partial' && <p className="text-amber-500">Vidéo arrêtée avant la fin ({m.stopReason}).</p>}
                      {m.status === 'recording' && <p className="text-amber-500">Vidéo interrompue (page fermée pendant la prise).</p>}
                      {!live && m.status !== 'recording' && <p className="text-nv-muted">Prise audio retirée du projet : l'export garde le mix actuel.</p>}
                      {confirmDel === m.id ? (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="flex-1">Supprimer cette vidéo ? (la prise audio reste)</span>
                          <button type="button" onClick={() => void remove(m.id)} className="h-9 rounded-lg bg-red-600 px-3 font-bold text-white" data-testid="video-take-delete-yes">Supprimer</button>
                          <button type="button" onClick={() => setConfirmDel(null)} className="h-9 rounded-lg border border-nv-line px-3">Non</button>
                        </div>
                      ) : (
                        <div className="mt-1 flex gap-2">
                          <button type="button" disabled={m.status === 'recording' || !m.times} onClick={() => setExportFor(m.id)} data-testid="video-take-export"
                            className="h-9 flex-1 rounded-lg bg-gradient-to-r from-cyan-400 to-violet-500 px-3 font-black text-black disabled:opacity-40">🎬 Exporter la vidéo</button>
                          <button type="button" onClick={() => setConfirmDel(m.id)} className="h-9 rounded-lg border border-nv-line px-3 text-nv-muted" aria-label="Supprimer cette vidéo" data-testid="video-take-delete">🗑</button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
      {exportFor && (
        <Suspense fallback={null}>
          <VideoTakeExportModal takeId={exportFor} onClose={() => { setExportFor(null); void reload(); }} state={state} ownedInstrumentIds={props.ownedInstrumentIds}
            onBuyBeat={() => { setExportFor(null); props.onBuyBeat(); }} onOpenExport={props.onOpenExport ? () => { setExportFor(null); props.onOpenExport!(); } : undefined}
            onLyricsChange={props.onLyricsChange} />
        </Suspense>
      )}
    </>
  );
};

export default VideoTakeDock;
