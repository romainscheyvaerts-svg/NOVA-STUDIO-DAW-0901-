import React, { useState } from 'react';
import { DAWState } from '../types';
import { saveBlob } from '../utils/saveBlob';
import { canMakeVideo, clipAudioMp3, clipVideo, demoMp3, fileBaseName, shareOrSave, projectEnd } from '../utils/demoExport';
import { openBattle } from '../utils/studioLinks';

interface ShareClipModalProps {
  open: boolean;
  onClose: () => void;
  state: DAWState;
  onBuyBeat: () => void;
}

/**
 * Faire écouter son son : extrait 30 s (vidéo verticale ou audio) et démo
 * complète en MP3, avec le tag « Make Music ». La version propre (WAV sans
 * tag) reste liée à l'achat de la licence.
 */
const ShareClipModal: React.FC<ShareClipModalProps> = ({ open, onClose, state, onBuyBeat }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  const hasVoice = state.tracks.some(t => t.type === 'AUDIO' && t.id !== 'instrumental' && !t.instrumentId && t.clips.some(c => !c.isMuted));
  const base = fileBaseName(state);

  const run = async (kind: 'video' | 'audio' | 'demo') => {
    setBusy(kind); setProgress(0); setDone(null); setError(null);
    try {
      let blob: Blob, name: string;
      if (kind === 'video') {
        const v = await clipVideo(state, setProgress);
        blob = v.blob; name = `${base} - extrait.${v.ext}`;
      } else if (kind === 'audio') {
        blob = await clipAudioMp3(state, setProgress); name = `${base} - extrait.mp3`;
      } else {
        blob = await demoMp3(state, setProgress); name = `${base} - démo.mp3`;
      }
      const r = await shareOrSave(blob, name, saveBlob);
      setDone(r === 'shared' ? 'Partagé ✓' : r === 'saved' ? 'Fichier enregistré ✓' : null);
    } catch (e: any) {
      setError(e?.message || 'Création impossible');
    } finally {
      setBusy(null);
    }
  };

  const btn = 'w-full rounded-2xl border p-4 text-left transition-all active:scale-[0.99] disabled:opacity-40';
  return (
    <div className="fixed inset-0 z-[640] flex items-end sm:items-center justify-center bg-black/70 p-4" onClick={() => !busy && onClose()} role="dialog" aria-modal="true" aria-labelledby="share-title">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#121418] p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="share-title" className="text-lg font-black text-white">📲 Fais écouter ton son</h2>
            <p className="text-[12px] text-slate-400 mt-1">Avec le tag « Make Music ». La version propre (WAV, sans tag) est incluse avec la licence du beat.</p>
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label="Fermer" className="w-10 h-10 rounded-xl bg-white/5 text-slate-300">✕</button>
        </div>

        {!hasVoice || projectEnd(state) < 1 ? (
          <p className="mt-5 text-sm text-slate-300">Enregistre d'abord une prise : ici tu pourras la partager.</p>
        ) : (
          <div className="mt-5 space-y-2.5">
            {canMakeVideo() && (
              <button type="button" disabled={!!busy} onClick={() => run('video')} className={`${btn} border-cyan-400/40 bg-cyan-500/10`}>
                <span className="block text-[14px] font-bold text-white">🎬 Vidéo 30 s pour Insta / TikTok</span>
                <span className="block text-[12px] text-slate-300 mt-0.5">Format vertical, pochette du beat, spectre animé. Création en ~30 s.</span>
              </button>
            )}
            <button type="button" disabled={!!busy} onClick={() => run('audio')} className={`${btn} border-white/10 bg-white/[0.03]`}>
              <span className="block text-[14px] font-bold text-white">🎧 Extrait audio 30 s</span>
              <span className="block text-[12px] text-slate-300 mt-0.5">Le meilleur passage de ta voix, en MP3, pour WhatsApp ou Snap.</span>
            </button>
            <button type="button" disabled={!!busy} onClick={() => run('demo')} className={`${btn} border-white/10 bg-white/[0.03]`}>
              <span className="block text-[14px] font-bold text-white">⬇️ Démo complète (MP3)</span>
              <span className="block text-[12px] text-slate-300 mt-0.5">Tout ton morceau, tagué, pour le réécouter partout.</span>
            </button>
          </div>
        )}

        {busy && (
          <div className="mt-4">
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mt-2 text-[12px] text-slate-300" role="status">{busy === 'video' ? 'Création de la vidéo… (laisse cette page ouverte)' : 'Création du fichier…'}</p>
          </div>
        )}
        {done && <p className="mt-4 text-[13px] font-bold text-emerald-300" role="status">{done}</p>}
        {error && <p className="mt-4 text-[13px] text-red-300" role="alert">{error}</p>}

        {hasVoice && projectEnd(state) >= 1 && (
          <button type="button" onClick={openBattle} className="mt-5 w-full rounded-xl border border-pink-400/40 bg-gradient-to-r from-amber-400/15 to-pink-500/15 px-4 py-3 text-left">
            <span className="block text-[14px] font-bold text-white">🏆 Battle de la semaine</span>
            <span className="block text-[12px] text-slate-300 mt-0.5">Crée ton extrait audio ci-dessus, envoie-le et fais voter tes potes : une session studio à gagner.</span>
          </button>
        )}
        <button type="button" onClick={onBuyBeat} className="mt-3 w-full h-11 rounded-xl bg-amber-400 text-black text-[13px] font-black">
          🛒 Version propre : acheter la licence du beat
        </button>
      </div>
    </div>
  );
};

export default ShareClipModal;
