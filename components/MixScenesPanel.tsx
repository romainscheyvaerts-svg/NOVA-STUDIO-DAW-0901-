import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '../types';
import {
  liveScenes, readSceneParts, sceneMatches, sceneSummary, writeSceneParts, SCENE_PARTS, SCENE_SLOTS,
  type MixScene, type ScenePart, type SceneSlot,
} from '../utils/mixSnapshots';

/**
 * Scènes de mix A / B / C / D dans la console (écart 20, utils/mixSnapshots) :
 *  - emplacement vide : un clic ENREGISTRE la console ;
 *  - emplacement plein : un clic RAPPELLE la scène (une seule étape d'annulation) ;
 *  - « A ⇄ B » : compare les deux scènes ;
 *  - « ⋯ » : réécrire / effacer une scène, choisir ce qu'on rappelle (volumes, pans, muets, envois, effets).
 * La scène qui correspond déjà à la console est allumée.
 */
export type SceneAction =
  | { kind: 'save'; slot: SceneSlot }
  | { kind: 'recall'; slot: SceneSlot; parts: ScenePart[] }
  | { kind: 'delete'; slot: SceneSlot };

export const MixScenesPanel: React.FC<{ tracks: Track[]; scenes?: MixScene[]; onAction: (a: SceneAction) => void }> = ({ tracks, scenes, onAction }) => {
  const live = useMemo(() => liveScenes(scenes), [scenes]);
  const bySlot = useMemo(() => new Map(live.map(s => [s.slot, s] as const)), [live]);
  const [parts, setParts] = useState<ScenePart[]>(() => readSceneParts());
  const [menu, setMenu] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const say = (t: string) => { setMsg(t); if (msgTimer.current) clearTimeout(msgTimer.current); msgTimer.current = setTimeout(() => setMsg(null), 3200); };
  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);
  useEffect(() => { if (!menu) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [menu]);
  // Scène qui correspond à la console (pour les parties choisies).
  const active = useMemo(() => SCENE_SLOTS.find(sl => { const s = bySlot.get(sl); return !!s && sceneMatches(tracks, s, parts); }) || null, [tracks, bySlot, parts]);
  const partsText = parts.length === SCENE_PARTS.length ? 'tout' : SCENE_PARTS.filter(p => parts.includes(p.id)).map(p => p.label.toLowerCase()).join(', ');

  const click = (slot: SceneSlot, e: React.MouseEvent) => {
    const s = bySlot.get(slot);
    if (!s || e.shiftKey) { onAction({ kind: 'save', slot }); say(`Scène ${slot} enregistrée`); return; }
    onAction({ kind: 'recall', slot, parts });
    say(`Scène ${slot} rappelée (${partsText}) · Ctrl+Z pour annuler`);
  };
  const compare = () => {
    const a = bySlot.get('A'), b = bySlot.get('B');
    if (!a || !b) return;
    const to: SceneSlot = active === 'A' ? 'B' : 'A';
    onAction({ kind: 'recall', slot: to, parts });
    say(`Comparaison : scène ${to}`);
  };
  const togglePart = (id: ScenePart) => {
    const next = parts.includes(id) ? parts.filter(x => x !== id) : [...parts, id];
    if (!next.length) return;
    const ordered = SCENE_PARTS.map(p => p.id).filter(x => next.includes(x));
    setParts(ordered); writeSceneParts(ordered);
  };

  return (
    <div className="flex flex-col items-center gap-1 w-full" data-nova-scenes role="group" aria-label="Scènes de mix">
      <span className="text-[10px] font-bold text-sky-400 whitespace-nowrap">Scènes</span>
      <div className="grid grid-cols-2 gap-1">
        {SCENE_SLOTS.map(slot => {
          const s = bySlot.get(slot);
          const on = active === slot;
          return (
            <button key={slot} type="button" onClick={e => click(slot, e)} data-nova-scene={slot} data-state={s ? (on ? 'active' : 'pleine') : 'vide'}
              aria-pressed={on}
              aria-label={s ? `Scène ${slot} : rappeler (${partsText})` : `Scène ${slot} : enregistrer la console`}
              title={s ? `${sceneSummary(s)}\nClic : rappeler (${partsText}) · Maj+clic : réécrire` : `Scène ${slot} vide : clic pour y enregistrer la console`}
              className={`nova-hit-tactile w-8 h-8 rounded-lg text-[11px] font-black border transition-colors ${on ? 'bg-sky-400 text-black border-sky-300' : s ? 'bg-sky-500/15 text-sky-200 border-sky-400/40 hover:bg-sky-500/25' : 'bg-white/[0.04] text-slate-500 border-dashed border-white/15 hover:text-sky-200 hover:border-sky-400/50'}`}>
              {slot}
            </button>
          );
        })}
      </div>
      <div className="flex gap-1">
        <button type="button" onClick={compare} disabled={!bySlot.get('A') || !bySlot.get('B')} data-nova-scene-compare
          aria-label="Comparer les scènes A et B" title={!bySlot.get('A') || !bySlot.get('B') ? 'Enregistre A et B pour les comparer' : 'Passe de A à B (et retour)'}
          className="nova-hit-tactile h-7 px-1.5 rounded-lg text-[10px] font-black border border-white/10 bg-white/[0.05] text-slate-300 hover:text-white disabled:opacity-35 disabled:cursor-not-allowed">A⇄B</button>
        <button ref={btnRef} type="button" onClick={() => setMenu(m => !m)} aria-expanded={menu} aria-label="Réglages des scènes" title="Réécrire, effacer, choisir ce qu’on rappelle"
          data-nova-scenes-menu className="nova-hit-tactile h-7 w-7 rounded-lg text-[11px] border border-white/10 bg-white/[0.05] text-slate-300 hover:text-white">
          <i className="fas fa-ellipsis-h" aria-hidden="true" />
        </button>
      </div>
      {msg && <span role="status" className="text-[9px] leading-tight text-sky-300 text-center max-w-[84px]">{msg}</span>}
      {menu && (
        <div data-testid="scenes-menu" role="dialog" aria-label="Réglages des scènes"
          className="fixed z-[700] w-72 p-3 rounded-xl bg-nv-raised border border-white/20 shadow-2xl text-left"
          style={menuPos(btnRef.current)}>
          <div className="text-[11px] font-bold text-slate-200 mb-1">Scènes de mix</div>
          <p className="text-[10px] text-slate-400 mb-2">Une scène garde les réglages de la console. Clic sur une lettre vide : enregistrer ; pleine : rappeler (une étape d’annulation).</p>
          <div className="text-[10px] font-bold text-slate-300 mb-1">Ce qu’on rappelle</div>
          <div className="grid grid-cols-2 gap-1 mb-3">
            {SCENE_PARTS.map(p => (
              <label key={p.id} className="flex items-center gap-1.5 text-[11px] text-slate-200 cursor-pointer" title={p.hint}>
                <input type="checkbox" className="accent-sky-400" checked={parts.includes(p.id)} onChange={() => togglePart(p.id)} data-nova-scene-part={p.id} />
                {p.label}
              </label>
            ))}
          </div>
          <div className="space-y-1">
            {SCENE_SLOTS.map(slot => {
              const s = bySlot.get(slot);
              return (
                <div key={slot} className="flex items-center gap-2">
                  <span className="w-5 text-[11px] font-black text-sky-300">{slot}</span>
                  <span className="flex-1 min-w-0 truncate text-[10px] text-slate-400">{s ? sceneSummary(s) : 'vide'}</span>
                  <button type="button" className="text-[10px] font-bold px-2 py-1 rounded bg-white/[0.06] text-slate-200 hover:bg-white/[0.12]" data-nova-scene-save={slot}
                    onClick={() => { onAction({ kind: 'save', slot }); say(`Scène ${slot} enregistrée`); }}>{s ? 'Réécrire' : 'Enregistrer'}</button>
                  {s && <button type="button" className="text-[10px] font-bold px-2 py-1 rounded bg-white/[0.06] text-rose-300 hover:bg-rose-500/20" aria-label={`Effacer la scène ${slot}`} data-nova-scene-delete={slot}
                    onClick={() => { onAction({ kind: 'delete', slot }); say(`Scène ${slot} effacée`); }}>Effacer</button>}
                </div>
              );
            })}
          </div>
          <button type="button" onClick={() => setMenu(false)} className="mt-3 w-full py-1.5 rounded bg-white/5 text-slate-300 text-[10px] font-bold">Fermer</button>
        </div>
      )}
    </div>
  );
};

/** Position du menu : à droite du bouton, dans l'écran. */
function menuPos(el: HTMLElement | null): React.CSSProperties {
  if (!el || typeof window === 'undefined') return { left: 16, top: 80 };
  const r = el.getBoundingClientRect();
  const w = 288, h = 360;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right + 8));
  const top = Math.max(8, Math.min(window.innerHeight - h - 8, r.top - 120));
  return { left, top };
}
