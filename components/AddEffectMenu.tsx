import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { normText } from '../utils/commandPalette';
import { fxPrefs, useFxPrefs } from '../utils/fxFavorites';

/**
 * Menu « Ajouter un effet » d'une piste : rangé comme une chaîne de mix (nettoyage, égaliseur,
 * dynamique, saturation, espace…), chaque effet avec ce qu'il EST (« FET 76 · compresseur FET »),
 * et une case de recherche qui a le focus : on tape « comp », « eq », « reverb », « 1176 »,
 * Entrée. Avant : 28 noms de produits en vrac (« Leveler » pour le compresseur, « S-Killer »…),
 * le compresseur était introuvable pour qui cherchait « compresseur ».
 */
export interface EffectEntry { id: string; name: string; icon?: string; /** Rubrique, nature et mots-clés d'un effet hors catalogue (ex. Melodyne / VocAlign en insert ARA). */ cat?: string; kind?: string; also?: string }

/** Rubrique et nature de chaque effet (ordre des rubriques = ordre d'une chaîne de mix). */
const KIND: Record<string, { cat: string; kind: string; also?: string }> = {
  // Lot 1 : c'est un gate (il coupe le bruit ENTRE les phrases) ; le vrai débruitage est « ✨ Nettoyer la voix » (clip).
  DENOISER: { cat: 'Nettoyage', kind: 'gate vocal : coupe le bruit entre les phrases', also: 'gate porte souffle bruit denoise anti-bruit' },
  DEESSER: { cat: 'Nettoyage', kind: 'de-esser', also: 'sifflantes s ess' },
  GATE: { cat: 'Nettoyage', kind: 'gate / expandeur', also: 'porte noise gate side-chain' },
  PROEQ12: { cat: 'Égaliseur', kind: 'égaliseur 12 bandes', also: 'eq egaliseur filtre coupe-bas low cut' },
  DYNEQ: { cat: 'Égaliseur', kind: 'EQ dynamique, anti-résonances', also: 'eq dynamique dynamic resonance resonances dure harsh egaliseur' },
  COMPRESSOR: { cat: 'Dynamique', kind: 'propre, VCA, opto, FET', also: 'comp compression side-chain dyn3 leveler' },
  OPTO_VINTAGE: { cat: 'Dynamique', kind: 'compresseur optique', also: 'comp opto cl1b' },
  FET76: { cat: 'Dynamique', kind: 'compresseur FET (type 1176)', also: 'comp 1176 fet' },
  LEVELER2A: { cat: 'Dynamique', kind: 'niveleur optique (type LA-2A)', also: 'comp la2a la-2a opto' },
  VOXSTRIP: { cat: 'Dynamique', kind: 'tranche voix (préampli, comp, EQ)', also: 'channel strip voxbox comp' },
  MBCOMP: { cat: 'Dynamique', kind: 'compresseur 3 ou 4 bandes', also: 'comp multibande multiband multipressor bandes' },
  AUTOTUNE: { cat: 'Voix', kind: 'correction de justesse', also: 'autotune pitch justesse' },
  DOUBLER: { cat: 'Voix', kind: 'doubleur', also: 'double largeur' },
  HARMONIZER: { cat: 'Voix', kind: 'harmoniseur', also: 'harmonie tierce' },
  VOICESHIFT: { cat: 'Voix', kind: 'hauteur et formant', also: 'pitch formant grave aigu' },
  VOCALSATURATOR: { cat: 'Saturation et couleur', kind: 'saturation', also: 'disto chaleur' },
  LOFI: { cat: 'Saturation et couleur', kind: 'lo-fi / téléphone', also: 'bitcrush radio telephone' },
  CHORUS: { cat: 'Modulation', kind: 'chorus' },
  FLANGER: { cat: 'Modulation', kind: 'flanger' },
  REVERB: { cat: 'Espace', kind: 'réverbe', also: 'reverb verb salle' },
  DELAY: { cat: 'Espace', kind: 'écho / délai calé au tempo', also: 'delay echo' },
  DJFILTER: { cat: 'Effets trap', kind: 'filtre DJ', also: 'filtre passe-bas passe-haut' },
  GATEFX: { cat: 'Effets trap', kind: 'gate rythmique', also: 'stutter hachure' },
  TIMEFX: { cat: 'Effets trap', kind: 'tape stop, half-time', also: 'gross beat' },
  MASTERSYNC: { cat: 'Master', kind: 'analyse tempo et tonalité', also: 'mastering tempo bpm tonalité calage' },
  LIMITER: { cat: 'Master', kind: 'limiteur', also: 'maximiseur limiter' },
  MASTERTRANSIENT: { cat: 'Master', kind: 'limiteur multibande', also: 'mastering transient' },
};
const CAT_ORDER = ['Nettoyage', 'Égaliseur', 'Dynamique', 'Voix', 'Saturation et couleur', 'Modulation', 'Espace', 'Effets trap', 'Master', 'Autres'];
/** Rubrique des VST du PC : une par éditeur (« VST · Waves »), après les effets NOVA. */
const isVstCat = (c?: string) => !!c && c.startsWith('VST');
const info = (e: EffectEntry) => KIND[e.id] || { cat: e.cat && (CAT_ORDER.includes(e.cat) || isVstCat(e.cat)) ? e.cat : 'Autres', kind: e.kind || '', also: e.also };

export function groupEffects(list: EffectEntry[], query: string): { cat: string; items: EffectEntry[] }[] {
  const words = normText(query).split(/\s+/).filter(Boolean);
  const hit = (e: EffectEntry) => { const i = info(e); const hay = normText(`${e.name} ${i.kind} ${i.cat} ${i.also || ''} ${e.id}`); return words.every(w => hay.includes(w)); };
  const vstCats = [...new Set(list.map(e => info(e).cat).filter(isVstCat))].sort((a, b) => a.localeCompare(b, 'fr'));
  const order = [...CAT_ORDER.slice(0, -1), ...vstCats, 'Autres'];
  return order.map(cat => ({ cat, items: list.filter(e => info(e).cat === cat && hit(e)) })).filter(g => g.items.length);
}

/** Rubriques « Favoris » et « Récents » en tête (sans recherche) : un effet courant en 2 clics. Pur. */
export function quickEffects(list: EffectEntry[], favorites: string[], recents: string[]): { cat: string; items: EffectEntry[] }[] {
  const byId = new Map(list.map(e => [e.id, e]));
  const pick = (ids: string[]) => ids.map(id => byId.get(id)).filter((e): e is EffectEntry => !!e);
  const fav = pick(favorites);
  const rec = pick(recents).filter(e => !favorites.includes(e.id));
  return [{ cat: 'Favoris', items: fav }, { cat: 'Récents', items: rec }].filter(g => g.items.length);
}

const AddEffectMenu: React.FC<{ x: number; y: number; effects: EffectEntry[]; onPick: (id: string) => void; onClose: () => void }> = ({ x, y, effects, onPick, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [pos, setPos] = useState({ x, y });
  const prefs = useFxPrefs();
  const quick = useMemo(() => (q.trim() ? [] : quickEffects(effects, prefs.favorites, prefs.recents)), [effects, q, prefs]);
  const groups = useMemo(() => groupEffects(effects, q), [effects, q]);
  const all = useMemo(() => [...quick.map(g => ({ ...g, quick: true })), ...groups.map(g => ({ ...g, quick: false }))], [quick, groups]);
  const flat = useMemo(() => all.flatMap(g => g.items), [all]);
  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - w - 8)), y: Math.max(8, Math.min(y, window.innerHeight - h - 8)) });
  }, [x, y]);
  useEffect(() => {
    const down = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const t = window.setTimeout(() => { window.addEventListener('mousedown', down); window.addEventListener('touchstart', down); }, 30);
    return () => { window.clearTimeout(t); window.removeEventListener('mousedown', down); window.removeEventListener('touchstart', down); };
  }, [onClose]);
  useEffect(() => { ref.current?.querySelector(`[data-fx-index="${idx}"]`)?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  const pick = (e?: EffectEntry) => { if (!e) return; fxPrefs.noteUsed(e.id); onClose(); onPick(e.id); };
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(flat[idx]); }
  };
  let n = -1;
  return (
    <div ref={ref} role="menu" aria-label="Ajouter un effet" data-testid="add-effect-menu" onKeyDown={onKey}
      className="fixed z-[9999] flex max-h-[min(560px,calc(100vh-16px))] w-[300px] flex-col rounded-xl border border-nv-line/15 bg-nv-raised shadow-2xl text-nv-ink"
      style={{ left: pos.x, top: pos.y }}>
      <div className="flex items-center gap-2 border-b border-nv-line/10 px-2.5">
        <i className="fas fa-search text-[11px] text-nv-muted" aria-hidden="true" />
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Chercher : comp, eq, reverb, 1176…" aria-label="Chercher un effet"
          className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-nv-muted" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1 custom-scroll">
        {groups.length === 0 && <p className="px-3 py-4 text-center text-[12px] text-nv-muted">Aucun effet pour « {q} ».</p>}
        {all.map(g => (
          <div key={`${g.quick ? 'q' : 'c'}-${g.cat}`} role="group" aria-label={g.cat}>
            <p className="px-2 pb-0.5 pt-2 text-[10px] font-black uppercase tracking-widest text-nv-muted">{g.cat === 'Favoris' && g.quick ? '★ Favoris' : g.cat}</p>
            {g.items.map(e => {
              n++;
              const i = n;
              const fav = prefs.favorites.includes(e.id);
              return (
                <div key={e.id} className={`group/fx flex w-full items-center rounded-lg ${i === idx ? 'bg-nv-accent/15' : ''}`} onMouseMove={() => { if (idx !== i) setIdx(i); }}>
                  <button type="button" role="menuitem" data-fx-index={i} {...(g.quick ? { 'data-fx-quick': e.id } : { 'data-fx-id': e.id })}
                    onClick={() => pick(e)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 text-left">
                    {e.icon && <i className={`fas ${e.icon} w-4 text-center text-[10px] text-nv-muted`} aria-hidden="true" />}
                    <span className="truncate text-[12px] font-semibold">{e.name}</span>
                    <span className="ml-auto truncate text-[11px] text-nv-muted">{info(e).kind}</span>
                  </button>
                  {/* Étoile : favori (en tête du menu, ici et dans la liste des VST). */}
                  <button type="button" tabIndex={-1} onClick={ev => { ev.stopPropagation(); fxPrefs.toggleFavorite(e.id); }}
                    aria-pressed={fav} aria-label={fav ? `Retirer ${e.name} des favoris` : `Mettre ${e.name} en favori`} data-fx-star={e.id}
                    title={fav ? 'Retirer des favoris' : 'Mettre en favori : il apparaîtra en tête de ce menu'}
                    className={`mr-1 h-7 w-7 shrink-0 rounded text-[11px] ${fav ? 'text-amber-300' : 'text-nv-muted opacity-0 group-hover/fx:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-60'}`}>
                    <i className={`${fav ? 'fas' : 'far'} fa-star`} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default AddEffectMenu;
