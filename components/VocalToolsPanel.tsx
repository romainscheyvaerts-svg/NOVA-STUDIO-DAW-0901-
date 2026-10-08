import React from 'react';
import { VOCAL_MIX_STYLES } from '../utils/vocalPresets';
import { fmtTime, CompZone } from '../utils/takes';
import { TakeLane } from '../utils/playlists';
import { takeColor } from './PlaylistLanes';

interface VocalToolsPanelProps {
  open: boolean;
  onClose: () => void;
  currentStyleId?: string;
  onApplyStyle: (styleId: string) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  canClean: boolean;
  onCleanSilences: () => void;
  autoClean: boolean;
  onAutoCleanChange: (on: boolean) => void;
  /** Respirations (components/BreathTools) : bloc des outils voix et case du Mix auto. */
  breathTools?: React.ReactNode;
  breathMixOption?: React.ReactNode;
  /** « Fredonne → 808 / piano » (V20, components/AudioToMidiDialog). */
  humTools?: React.ReactNode;
  countIn: boolean;
  onCountInChange: (on: boolean) => void;
  monitoring: boolean;
  onMonitoringChange: (on: boolean) => void;
  onAskNova: () => void;
  /** Un beat du catalogue est chargé (bouton « Acheter cette instru »). */
  hasCatalogBeat: boolean;
  onBuyBeat: () => void;
  onProMix: () => void;
  onBookSession: () => void;
  onShare: () => void;
  onOpenDrums: () => void;
  hasDrums: boolean;
  /** Couloirs de prises par piste voix (choix de la meilleure prise). */
  takeGroups: { trackId: string; trackName: string; lanes: TakeLane[] }[];
  /** Prise écoutée seule (null : le comp). */
  audition?: { trackId: string; n: number } | null;
  onAuditionTake: (trackId: string, n: number | null) => void;
  onKeepTake: (trackId: string, n: number) => void;
  /** Ouvre les couloirs de la piste dans l'arrangement. */
  onShowLanes?: (trackId: string) => void;
  /** « Meilleure prise » : l'IA locale note les prises et propose un comp. */
  onAutoComp?: (trackId: string) => void;
  /** Comping : zones (parties du morceau, boucle) où garder une prise. */
  compZones?: CompZone[];
  onCompTake?: (trackId: string, n: number, zone: CompZone) => void;
  activeTakeInZone?: (trackId: string, zone: CompZone) => number | null;
}

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }> = ({ checked, onChange, label, hint }) => (
  <div className="flex items-start gap-3 py-2.5 cursor-pointer select-none">
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`mt-0.5 relative shrink-0 w-11 h-6 rounded-full transition-colors ${checked ? 'bg-cyan-500' : 'bg-white/15'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
    <span className="min-w-0" onClick={() => onChange(!checked)}>
      <span className="block text-[13px] font-semibold text-white">{label}</span>
      {hint && <span className="block text-[11px] text-slate-400 mt-0.5">{hint}</span>}
    </span>
  </div>
);

/**
 * « Mix auto » : l'artiste choisit un style, l'entend tout de suite (bouton
 * Écouter dans le panneau) et peut en essayer un autre. Regroupe aussi les
 * outils d'enregistrement : nettoyage des blancs, décompte, retour casque.
 */
const VocalToolsPanel: React.FC<VocalToolsPanelProps> = (p) => {
  const [compZoneIdx, setCompZoneIdx] = React.useState(-1);
  if (!p.open) return null;
  return (
    <div
      className="fixed inset-0 z-[550] flex items-end sm:items-center justify-center bg-black/50"
      onClick={p.onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="vocal-tools-title"
    >
      <div
        className="w-full sm:max-w-2xl max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-[#121418] border border-white/10 shadow-2xl pb-[env(safe-area-inset-bottom)]"
        onClick={e => e.stopPropagation()}
      >
        {/* En-tête */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3 border-b border-white/5">
          <div className="min-w-0 flex-1">
            <h2 id="vocal-tools-title" className="text-[17px] font-black text-white">🎚️ Mix auto de ta voix</h2>
            <p className="text-[12px] text-slate-400 mt-0.5">Choisis un style : effets, réverb et volume du beat se règlent tout seuls.</p>
          </div>
          <button
            type="button"
            onClick={p.onTogglePlay}
            className={`h-11 px-4 rounded-xl font-bold text-[12px] flex items-center gap-2 shrink-0 ${p.isPlaying ? 'bg-white text-black' : 'bg-cyan-500 text-black'}`}
            aria-label={p.isPlaying ? 'Pause' : 'Écouter'}
          >
            <i className={`fas ${p.isPlaying ? 'fa-pause' : 'fa-play'}`} />
            <span className="hidden sm:inline">{p.isPlaying ? 'Pause' : 'Écouter'}</span>
          </button>
          <button type="button" onClick={p.onClose} aria-label="Fermer" className="w-11 h-11 rounded-xl bg-white/5 text-slate-300 hover:text-white shrink-0">
            <i className="fas fa-times" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {/* Mes prises : en haut (B3 de l'audit), avant tout le reste */}
          {p.takeGroups.some(g => g.lanes.length > 1) && (
            <div data-mes-prises className="rounded-2xl border border-cyan-400/25 bg-cyan-500/[0.04] p-3">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-[13px] font-black text-white">🎙️ Mes prises</h3>
                <span className="text-[11px] text-slate-400">écoute-les, garde la meilleure</span>
              </div>
              {p.compZones && p.compZones.length > 0 && (
                <label className="mb-2 flex items-center gap-2 text-[11px] text-slate-300">
                  <span className="shrink-0">Garder sur</span>
                  <select value={compZoneIdx} onChange={e => setCompZoneIdx(Number(e.target.value))}
                    className="h-10 min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-2 text-[12px] font-bold text-white outline-none focus:border-cyan-500">
                    <option value={-1}>Toute la prise</option>
                    {p.compZones.map((z, i) => <option key={i} value={i}>{z.label} ({fmtTime(z.start)} – {fmtTime(z.end)})</option>)}
                  </select>
                </label>
              )}
              <div className="space-y-3">
                {p.takeGroups.filter(g => g.lanes.length > 1).map(g => (
                  <div key={g.trackId}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <p className="text-[11px] text-slate-400 min-w-0 truncate flex-1">{g.trackName}</p>
                      {p.onShowLanes && <button type="button" onClick={() => p.onShowLanes!(g.trackId)}
                        title="Ouvre les couloirs sous la piste : balaie un passage d'une prise pour le garder (comme les Playlists de Pro Tools)."
                        className="h-8 px-2.5 rounded-lg text-[11px] font-bold text-cyan-200 border border-cyan-400/40 hover:bg-cyan-500/10 shrink-0">
                        <i className="fas fa-layer-group mr-1" />Voir les couloirs
                      </button>}
                    </div>
                    {p.onAutoComp && (
                      <button type="button" onClick={() => p.onAutoComp!(g.trackId)}
                        title="Nova note chaque prise phrase par phrase (justesse, calage sur le temps, niveau, bruit), sur ton ordi, et monte le meilleur comp. Tu le gardes ou tu reviens en arrière."
                        className="mb-1.5 w-full h-10 rounded-xl bg-gradient-to-r from-cyan-500/20 to-fuchsia-500/20 border border-cyan-400/40 text-[12px] font-black text-white hover:from-cyan-500/30">
                        ✨ Meilleure prise : laisse l'IA choisir phrase par phrase
                      </button>
                    )}
                    <div className="flex flex-col gap-1.5">
                      {g.lanes.map(l => {
                        const zone = compZoneIdx >= 0 ? p.compZones?.[compZoneIdx] : undefined;
                        const active = zone && p.activeTakeInZone ? p.activeTakeInZone(g.trackId, zone) === l.n : Math.abs(l.used - l.duration) < 0.05 && l.used > 0;
                        const solo = p.audition?.trackId === g.trackId && p.audition.n === l.n;
                        return (
                          <div key={l.n} className={`flex items-center rounded-xl border ${active ? 'border-cyan-400/60 bg-cyan-500/10' : 'border-white/10 bg-white/[0.03]'}`} title={l.title}>
                            <span className="w-1 self-stretch rounded-l-xl" style={{ background: takeColor(l.n) }} />
                            <button type="button" onClick={() => p.onAuditionTake(g.trackId, solo ? null : l.n)} aria-pressed={solo}
                              aria-label={solo ? 'Revenir à ta voix finale' : `Écouter ${l.name} seule`}
                              className="h-11 pl-2.5 pr-2 min-w-0 flex-1 text-left flex items-center gap-2">
                              <i className={`fas ${solo ? 'fa-stop' : 'fa-headphones'} text-[11px] ${solo ? 'text-cyan-300' : 'text-slate-300'}`} />
                              <span className="min-w-0">
                                <span className="block truncate text-[12px] font-bold text-white">{l.label}</span>
                                <span className="block truncate text-[10px] text-slate-400">{l.used > 0.05 ? `entendue ${fmtTime(l.used)} sur ${fmtTime(l.duration)}` : 'pas utilisée'}{l.meta?.score ? ` · note IA ${l.meta.score.total}/100` : ''}</span>
                              </span>
                            </button>
                            {active ? (
                              <span className="h-11 px-3 flex items-center text-[11px] font-black text-cyan-300 shrink-0">✓ gardée</span>
                            ) : (
                              <button type="button"
                                onClick={() => (zone && p.onCompTake ? p.onCompTake(g.trackId, l.n, zone) : p.onKeepTake(g.trackId, l.n))}
                                className="h-11 px-3 text-[12px] font-bold text-slate-200 border-l border-white/10 hover:text-white shrink-0">Garder</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-2">Garder une prise fait taire les autres au même endroit (elles restent dans leurs couloirs). Choisis une partie pour monter ta meilleure prise morceau par morceau (le « comping »).</p>
            </div>
          )}

          {/* Styles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {VOCAL_MIX_STYLES.map(s => {
              const active = p.currentStyleId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => p.onApplyStyle(s.id)}
                  aria-pressed={active}
                  className={`text-left rounded-2xl p-3 border transition-all active:scale-[0.98] flex gap-3 ${active ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'}`}
                >
                  <span className="text-2xl leading-none mt-0.5">{s.emoji}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-[14px] font-bold text-white">{s.name}</span>
                      {active && <span className="text-[10px] font-black text-cyan-300 uppercase">✓ actif</span>}
                    </span>
                    <span className="block text-[11.5px] leading-snug text-slate-400 mt-0.5">{s.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {p.breathMixOption}
          <p className="text-[11px] text-slate-500">
            Lance la lecture et change de style pour comparer. <b className="text-slate-300">Annuler</b> (Ctrl+Z) revient au réglage précédent.
          </p>

          <button
            type="button"
            onClick={p.onAskNova}
            className="w-full h-11 rounded-xl border border-cyan-500/40 text-cyan-300 font-bold text-[13px] hover:bg-cyan-500/10"
          >
            <i className="fas fa-wand-magic-sparkles mr-2" />Je ne sais pas lequel choisir : demander à Nova
          </button>

          {/* Le mix auto est une pré-écoute : le vrai rendu se fait au studio. */}
          <div className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
            <p className="text-[13px] font-bold text-white">Ton son te plaît ? Passe au niveau pro.</p>
            <p className="text-[11.5px] text-slate-300 mt-1">
              Le mix auto te donne une idée. Nos ingés son mixent ta voix sur l'instru pour un rendu prêt à sortir.
            </p>
            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              {p.hasCatalogBeat && (
                <button type="button" onClick={p.onBuyBeat} className="shrink-0 sm:flex-1 h-10 rounded-xl bg-amber-400 text-black text-[12px] font-black hover:bg-amber-300">
                  🛒 Acheter cette instru
                </button>
              )}
              <button type="button" onClick={p.onProMix} className="shrink-0 sm:flex-1 h-10 rounded-xl bg-white/10 text-white text-[12px] font-bold hover:bg-white/20">
                🎚️ Faire mixer par un pro
              </button>
            </div>
            <button type="button" onClick={p.onBookSession} className="mt-2 w-full h-10 rounded-xl border border-white/15 text-white text-[12px] font-bold hover:bg-white/10">
              🎙️ Enregistrer ce morceau au studio, avec un ingé son
            </button>
            <button type="button" onClick={p.onShare} className="mt-2 w-full h-10 rounded-xl border border-cyan-400/40 text-cyan-200 text-[12px] font-bold hover:bg-cyan-500/10">
              📲 Partager un extrait (vidéo / audio) ou télécharger la démo
            </button>
            <button type="button" onClick={p.onOpenDrums} className="mt-2 w-full h-10 rounded-xl border border-orange-400/40 text-orange-200 text-[12px] font-bold hover:bg-orange-500/10">
              🥁 {p.hasDrums ? 'Modifier la batterie' : 'Ajouter une batterie (pour une mélodie)'}
            </button>
          </div>

          {/* Outils */}
          <div className="border-t border-white/5 pt-4">
            <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-400 mb-2">Outils voix</h3>
            <button
              type="button"
              onClick={p.onCleanSilences}
              disabled={!p.canClean}
              className="w-full h-11 rounded-xl bg-white/5 text-white font-bold text-[13px] disabled:opacity-40 hover:bg-white/10"
            >
              🧹 Retirer les blancs de ma voix
            </button>
            {!p.canClean && <p className="text-[11px] text-slate-500 mt-1">Enregistre d'abord une prise.</p>}
            {p.breathTools}
            {p.humTools && <div className="mt-2">{p.humTools}</div>}
            <div className="mt-2 divide-y divide-white/5">
              <Toggle
                checked={p.autoClean}
                onChange={p.onAutoCleanChange}
                label="Retirer les blancs automatiquement"
                hint="Après chaque prise, les passages sans voix sont enlevés (souffle, bruits de la pièce)."
              />
              <Toggle
                checked={p.countIn}
                onChange={p.onCountInChange}
                label="Décompte 4 temps avant d'enregistrer"
                hint="Le temps de te placer devant le micro."
              />
              <Toggle
                checked={p.monitoring}
                onChange={p.onMonitoringChange}
                label="M'entendre dans le casque"
                hint="Seulement avec un casque : sur haut-parleurs, le son siffle (larsen)."
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VocalToolsPanel;
