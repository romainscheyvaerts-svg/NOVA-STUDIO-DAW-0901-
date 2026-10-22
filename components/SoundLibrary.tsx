import React, { useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import { KIT_DRAG_TYPE, KIT_ERROR_TEXT, KitIndex, KitSoundError, loadKitIndex } from '../utils/drumKitLibrary';
import {
  buildSoundIndex, isMinorScale, keyLabel, parseLoopRef, searchSounds, soundFavorites, SOUND_GENRES, SOUND_TYPES, toggleSoundFavorite,
  type SoundEntry, type SoundGenre, type SoundKey, type SoundKind, type SoundType,
} from '../utils/soundSearch';
import { buildPalette } from '../utils/loopPalette';
import { previewBuffer } from '../utils/soundPreview';
import { LOOP_DRAG_TYPE, requestSoundPlace, sonsBeatStore, useProjectInfo, type SonsTab } from '../utils/sonsBeatStore';

/**
 * Lot 5 · Navigateur de sons de NOVA : one-shots (kits NOVA, batterie du studio), instruments et
 * boucles NOVA, filtrables par type, genre, BPM et tonalité, avec favoris, écoute au toucher (ou
 * au survol sur ordinateur) et pose sur une piste ou la boîte à rythmes (bouton ou glisser).
 * Onglet « Palette » : 2 à 5 boucles assorties au projet (lot 5b).
 *
 * Règle de Romain : les sons ne se TÉLÉCHARGENT pas. On compose avec dans le DAW ; aucun bouton
 * de téléchargement, aucune adresse de fichier affichée ; l'export suit les règles payantes.
 */

export interface SoundLibraryProps {
  /** Dans une fenêtre (Ctrl+K) ou dans le panneau de gauche / la page Sons du téléphone. */
  variant: 'dialog' | 'embedded';
  initialTab?: SonsTab;
  narrow?: boolean;
  onClose?: () => void;
  ensureEngine?: () => Promise<unknown>;
  notify?: (msg: string) => void;
}

const PAGE = 50;
const fine = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

const SoundLibrary: React.FC<SoundLibraryProps> = p => {
  const proj = useProjectInfo();
  const [tab, setTab] = useState<SonsTab>(p.initialTab || 'sons');
  const [ix, setIx] = useState<KitIndex | null>(null);
  const [kitsState, setKitsState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [text, setText] = useState('');
  const [type, setType] = useState<SoundType | ''>('');
  const [genre, setGenre] = useState<SoundGenre | ''>('');
  const [myTempo, setMyTempo] = useState(true);
  const [myKey, setMyKey] = useState(true);
  const [favs, setFavs] = useState<Set<string>>(() => soundFavorites());
  const [shown, setShown] = useState(PAGE);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [hover, setHover] = useState(false);
  const [palSeed, setPalSeed] = useState(1);
  const [palCount, setPalCount] = useState(4);
  const [palGenre, setPalGenre] = useState<SoundGenre | ''>('');
  const hoverTimer = useRef<number | null>(null);
  const playTimer = useRef<number | null>(null);
  const narrow = !!p.narrow;
  const h = narrow ? 'h-11' : 'h-9';
  const canHover = fine() && !narrow;

  const loadKits = () => {
    setKitsState('loading');
    loadKitIndex().then(x => { setIx(x); setKitsState('ok'); }).catch(() => setKitsState('error'));
  };
  useEffect(() => { loadKits(); }, []);
  useEffect(() => () => {
    audioEngine.stopAudition();
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (playTimer.current) window.clearTimeout(playTimer.current);
  }, []);
  useEffect(() => { setShown(PAGE); }, [tab, text, type, genre, myTempo, myKey]);

  const index = useMemo(() => buildSoundIndex(ix), [ix]);
  const projKey: SoundKey | null = proj.root === null ? null : { root: proj.root, scale: (isMinorScale(proj.scale || '') ? 'MINOR' : proj.scale === 'MAJOR' ? 'MAJOR' : 'MINOR') as SoundKey['scale'] };
  const kindOf: Record<SonsTab, SoundKind | ''> = { sons: '', boucles: 'loop', palette: 'loop', favoris: '' };

  const results = useMemo(() => {
    if (tab === 'palette') return [];
    const all = searchSounds(index, {
      text, type: type || undefined, genre: genre || undefined, kind: kindOf[tab] || undefined,
      bpm: myTempo ? proj.bpm : null, key: myKey ? projKey : null, favs: tab === 'favoris' ? favs : null,
    });
    // Onglet Sons : one-shots et instruments (les boucles ont leur onglet).
    return tab === 'sons' ? all.filter(e => e.kind !== 'loop') : all;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, tab, text, type, genre, myTempo, myKey, proj.bpm, proj.root, proj.scale, favs]);

  const palette = useMemo(() => (tab === 'palette'
    ? buildPalette(index, { bpm: proj.bpm, key: projKey, genre: palGenre || null, count: palCount, seed: palSeed })
    : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [tab, index, proj.bpm, proj.root, proj.scale, palGenre, palCount, palSeed]);

  const stopAll = () => { audioEngine.stopAudition(); setPlaying(null); if (playTimer.current) window.clearTimeout(playTimer.current); };

  const notify = (m: string) => (p.notify || sonsBeatStore.helpers().notify)?.(m);
  const engineCtx = async () => {
    // Moteur lancé : on n'attend rien (pré-écoute plus réactive).
    if (!(audioEngine.ctx && audioEngine.ctx.state === 'running')) await (p.ensureEngine || sonsBeatStore.helpers().ensureEngine)?.();
    if (!audioEngine.ctx) throw new KitSoundError('decode', KIT_ERROR_TEXT.decode);
    if (audioEngine.ctx.state !== 'running') await audioEngine.ctx.resume().catch(() => {});
    return audioEngine.ctx;
  };

  const fail = (id: string, e: unknown) => {
    const offline = e instanceof KitSoundError && e.code === 'offline';
    setFailed(f => ({ ...f, [id]: offline ? 'Hors ligne' : 'Indisponible' }));
    notify(e instanceof KitSoundError ? e.message : 'Ce son ne se charge pas. Vérifie ta connexion, puis réessaie (ou choisis-en un autre).');
  };

  /** Écoute (re-toucher = stop). Plusieurs entrées = la palette jouée ensemble. */
  const audition = async (list: SoundEntry[], key: string, toggle = true) => {
    if (toggle && playing === key) { stopAll(); return; }
    setLoading(key);
    try {
      const c = await engineCtx();
      const minor = isMinorScale(proj.scale || '') || proj.scale === null;
      const bufs = await Promise.all(list.map(e => previewBuffer(e, c, { bpm: proj.bpm, root: proj.root, minor, ix })));
      audioEngine.auditionBuffers(bufs.map(buffer => ({ buffer, at: 0, gain: list.length > 1 ? 0.8 : 1 })));
      setPlaying(key);
      setFailed(f => { if (!f[key]) return f; const n = { ...f }; delete n[key]; return n; });
      if (playTimer.current) window.clearTimeout(playTimer.current);
      const dur = Math.max(...bufs.map(b => b.duration));
      playTimer.current = window.setTimeout(() => setPlaying(cur => (cur === key ? null : cur)), Math.min(20000, dur * 1000 + 100));
    } catch (e) { fail(key, e); } finally { setLoading(null); }
  };

  const onHover = (e: SoundEntry) => {
    if (!hover || !canHover) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => { void audition([e], e.id, false); }, 160);
  };
  const onLeave = () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); };

  const place = (e: SoundEntry) => { stopAll(); requestSoundPlace({ ref: e.ref, name: e.name }); };
  const placeAll = (list: SoundEntry[]) => { stopAll(); requestSoundPlace({ ref: list[0].ref, refs: list.map(e => e.ref), name: 'Palette' }); };
  /** « Écouter ensemble » : la 2e suite d'accords (refrain) se pose après la 1re, on ne la joue pas par-dessus. */
  const togetherItems = (list: SoundEntry[]) => {
    const first = list.map(e => parseLoopRef(e.ref)).find(x => x && x.t === 'chords');
    return list.filter(e => { const x = parseLoopRef(e.ref); return !(x && x.t === 'chords' && first && first.t === 'chords' && x.prog !== first.prog); });
  };
  const fav = (id: string) => setFavs(new Set(toggleSoundFavorite(id)));

  const chip = (on: boolean) => `nova-hit-tactile shrink-0 ${h} px-3 rounded-xl text-[12px] font-bold whitespace-nowrap ${on ? 'bg-cyan-500/15 text-nv-ink ring-1 ring-cyan-400/70' : 'bg-nv-well text-nv-muted hover:text-nv-ink'}`;
  // Panneau de gauche (320 px) : libellés courts, le détail reste dans l'infobulle.
  const compact = p.variant === 'embedded' && !narrow;
  const placeLabel = (e: SoundEntry) => (compact
    ? (e.kind === 'loop' ? 'Poser' : e.kind === 'instrument' ? '+ Piste' : '+ Pad')
    : e.kind === 'loop' ? (e.type === 'drums' ? 'Poser (batterie)' : 'Poser') : e.kind === 'instrument' ? 'Nouvelle piste' : 'Sur un pad');
  const placeTitle = (e: SoundEntry) => (e.kind === 'loop'
    ? (e.type === 'drums' ? 'Remplace le motif de la boîte à rythmes (tout le morceau)' : 'Pose la boucle à la tête de lecture, calée sur la mesure')
    : e.kind === 'instrument' ? 'Crée une piste jouée par cet instrument' : 'Ajoute le son sur un nouveau pad de la boîte à rythmes');

  const row = (e: SoundEntry) => {
    const isPlaying = playing === e.id, isLoading = loading === e.id, isFav = favs.has(e.id), bad = failed[e.id];
    const drag = e.ref.startsWith('kit:') ? KIT_DRAG_TYPE : e.kind === 'loop' ? LOOP_DRAG_TYPE : null;
    return (
      <li key={e.id} data-testid="sound-row" data-sound-kind={e.kind} data-sound-type={e.type}
        draggable={!narrow && !!drag}
        onDragStart={ev => { if (!drag) return; ev.dataTransfer.setData(drag, drag === KIT_DRAG_TYPE ? e.ref.slice(4) : e.ref); ev.dataTransfer.setData('text/plain', e.name); ev.dataTransfer.effectAllowed = 'copy'; }}
        onMouseEnter={() => onHover(e)} onMouseLeave={onLeave}
        className={`flex items-center gap-2 rounded-xl px-1.5 py-1 ${isPlaying ? 'bg-cyan-500/10 ring-1 ring-cyan-400/40' : 'hover:bg-nv-accent/5'}`}>
        <button type="button" onClick={() => void audition([e], e.id)} aria-label={`${isPlaying ? 'Arrêter' : 'Écouter'} ${e.name}`} data-testid="sound-play"
          className={`shrink-0 w-11 ${narrow ? 'h-11' : 'h-10'} rounded-xl flex items-center justify-center ${isPlaying ? 'bg-cyan-500 text-black' : 'bg-nv-well text-nv-ink hover:bg-nv-accent/10'}`}>
          <i className={`fas ${isLoading ? 'fa-circle-notch fa-spin' : isPlaying ? 'fa-stop' : 'fa-play'} text-[12px]`} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-nv-ink truncate">{e.name}</div>
          <div className="text-[11px] text-nv-muted truncate">
            {e.kind === 'loop' && e.bpm ? `${e.bpm} BPM · ` : ''}{e.detail}{bad ? <span className="ml-1.5 text-amber-500 font-bold">· {bad}</span> : null}
          </div>
        </div>
        <button type="button" onClick={() => fav(e.id)} aria-pressed={isFav} aria-label={isFav ? `Retirer ${e.name} des favoris` : `Ajouter ${e.name} aux favoris`}
          className={`shrink-0 w-11 ${narrow ? 'h-11' : 'h-10'} rounded-xl ${isFav ? 'text-amber-400' : 'text-nv-muted hover:text-amber-400'}`}>
          <i className={`${isFav ? 'fas' : 'far'} fa-star`} aria-hidden />
        </button>
        <button type="button" onClick={() => place(e)} data-testid="sound-place" title={placeTitle(e)} aria-label={`${placeTitle(e)} : ${e.name}`}
          className={`shrink-0 ${narrow ? 'h-11' : 'h-10'} px-3 rounded-xl text-[12px] font-black bg-cyan-500 text-black hover:bg-cyan-400`}>
          {placeLabel(e)}
        </button>
      </li>
    );
  };

  const typeChips = SOUND_TYPES.filter(t => (tab === 'boucles' ? t.kind === 'loop' : tab === 'sons' ? t.kind !== 'loop' : true));
  const keyText = projKey ? keyLabel(projKey) : null;

  const body = (
    <div className="space-y-2.5">
      <div role="tablist" aria-label="Sons, boucles, palette ou favoris" className="flex gap-1.5 overflow-x-auto pb-0.5">
        {([['sons', 'Sons'], ['boucles', 'Boucles'], ['palette', '🎨 Palette'], ['favoris', `Favoris${favs.size ? ` (${favs.size})` : ''}`]] as [SonsTab, string][]).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setType(''); stopAll(); }} data-testid={`sounds-tab-${t}`} className={chip(tab === t)}>{label}</button>
        ))}
      </div>

      {tab !== 'palette' && (
        <>
          <label className="block">
            <span className="sr-only">Rechercher un son ou une boucle</span>
            <input type="search" value={text} onChange={e => setText(e.target.value)} data-testid="sounds-search"
              placeholder={tab === 'boucles' ? 'Rechercher : drill, accords, 808, la mineur…' : 'Rechercher : kick, 808, snare trap, piano…'}
              className={`w-full ${h} px-3 rounded-xl bg-nv-well border border-nv-line text-[13px] text-nv-ink placeholder:text-nv-muted focus:outline-none focus:ring-2 focus:ring-cyan-400/60`} />
          </label>
          <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Type de son">
            <button type="button" onClick={() => setType('')} aria-pressed={!type} className={chip(!type)}>Tout</button>
            {typeChips.map(t => <button key={t.id} type="button" onClick={() => setType(t.id)} aria-pressed={type === t.id} data-testid={`sounds-type-${t.id}`} className={chip(type === t.id)}>{t.label}</button>)}
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Genre">
            <button type="button" onClick={() => setGenre('')} aria-pressed={!genre} className={chip(!genre)}>Tous les genres</button>
            {SOUND_GENRES.map(g => <button key={g.id} type="button" onClick={() => setGenre(g.id)} aria-pressed={genre === g.id} data-testid={`sounds-genre-${g.id}`} className={chip(genre === g.id)}>{g.label}</button>)}
          </div>
          {tab !== 'sons' && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-nv-muted">
              <label className="flex items-center gap-1.5 cursor-pointer" title="Boucles à ±15 % de ton tempo (ou en half-time / double-time)">
                <input type="checkbox" checked={myTempo} onChange={e => setMyTempo(e.target.checked)} data-testid="sounds-my-tempo" className="accent-cyan-500" /> Mon tempo ({Math.round(proj.bpm)} BPM)
              </label>
              <label className={`flex items-center gap-1.5 ${keyText ? 'cursor-pointer' : 'opacity-60'}`} title={keyText ? 'Boucles dans ta tonalité ou sa relative' : 'Ton projet n’a pas encore de tonalité : toutes les tonalités sont montrées'}>
                <input type="checkbox" checked={myKey && !!keyText} disabled={!keyText} onChange={e => setMyKey(e.target.checked)} data-testid="sounds-my-key" className="accent-cyan-500" /> {keyText ? `Ma tonalité (${keyText})` : 'Ma tonalité (pas encore choisie)'}
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-nv-muted">
            {canHover && (
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={hover} onChange={e => setHover(e.target.checked)} className="accent-cyan-500" data-testid="sounds-hover" /> Écoute au survol
              </label>
            )}
            <span>{tab === 'sons' ? 'Écoute, puis pose sur un pad ou une nouvelle piste.' : 'Les boucles jouent à ton tempo, avec les sons NOVA.'}{!narrow ? ' Tu peux aussi glisser sur la timeline.' : ''}</span>
          </div>

          {kitsState === 'loading' && tab === 'sons' && <p className="text-[12px] text-nv-muted" role="status"><i className="fas fa-circle-notch fa-spin mr-2" aria-hidden />Chargement des kits NOVA…</p>}
          {kitsState === 'error' && tab === 'sons' && (
            <p className="text-[12px] text-amber-600 flex flex-wrap items-center gap-2" role="alert">
              Les sons des kits ne se sont pas chargés (connexion ?). La batterie du studio et les instruments restent là.
              <button type="button" onClick={loadKits} className={`${h} px-3 rounded-xl bg-nv-well text-nv-ink font-bold`}>Réessayer</button>
            </p>
          )}

          {results.length === 0 ? (
            <p className="text-[12px] text-nv-muted py-6 text-center" data-testid="sounds-empty">
              {tab === 'favoris' && !favs.size
                ? 'Aucun favori pour l’instant. Touche ★ à côté d’un son pour le retrouver ici.'
                : tab === 'boucles' && (myTempo || myKey)
                  ? 'Aucune boucle dans ce tempo ou cette tonalité. Décoche « Mon tempo » ou « Ma tonalité » pour en voir plus.'
                  : 'Rien ne correspond. Essaie un autre mot (kick, 808, accords…), un autre type ou un autre genre.'}
            </p>
          ) : (
            <>
              <p className="text-[11px] text-nv-muted" aria-live="polite" data-testid="sounds-count">{results.length.toLocaleString('fr-FR')} résultat{results.length > 1 ? 's' : ''}</p>
              <ul className={`space-y-0.5 ${narrow && p.variant === 'embedded' ? '' : p.variant === 'dialog' ? 'max-h-[46vh] overflow-y-auto pr-1' : 'max-h-[60vh] overflow-y-auto pr-1'}`} data-testid="sounds-list">
                {results.slice(0, shown).map(row)}
              </ul>
              {results.length > shown && (
                <button type="button" onClick={() => setShown(n => n + PAGE)} className={`w-full ${h} rounded-xl bg-nv-well text-[12px] font-bold text-nv-ink hover:bg-nv-accent/10`}>
                  Afficher {Math.min(PAGE, results.length - shown)} de plus
                </button>
              )}
            </>
          )}
        </>
      )}

      {tab === 'palette' && palette && (
        <section aria-labelledby="palette-title" data-testid="palette" className="space-y-2.5">
          <div>
            <h3 id="palette-title" className="text-[14px] font-black text-nv-ink">Palette assortie à ton projet</h3>
            <p className="text-[11px] text-nv-muted">
              {Math.round(proj.bpm)} BPM · {keyLabel(palette.key)}{proj.root === null ? ' (proposée : ton projet n’a pas encore de tonalité)' : ''} · {SOUND_GENRES.find(g => g.id === palette.genre)?.label}. Toutes les boucles sont dans ta tonalité (ou sa relative) et à ±15 % de ton tempo.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <label className="flex items-center gap-1.5 text-nv-muted">Genre
              <select value={palGenre} onChange={e => setPalGenre(e.target.value as SoundGenre | '')} data-testid="palette-genre"
                className={`${h} px-2 rounded-xl bg-nv-well border border-nv-line text-nv-ink`}>
                <option value="">selon mon tempo</option>
                {SOUND_GENRES.filter(g => g.id !== 'pop').map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-nv-muted">Boucles
              <select value={palCount} onChange={e => setPalCount(Number(e.target.value))} data-testid="palette-count"
                className={`${h} px-2 rounded-xl bg-nv-well border border-nv-line text-nv-ink`}>
                {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => { stopAll(); setPalSeed(s => s + 1); }} data-testid="palette-dice" title="Tirer une autre palette"
              className={`${h} px-3 rounded-xl bg-nv-well text-nv-ink font-bold hover:bg-nv-accent/10`}>🎲 Autre palette</button>
          </div>
          {palette.items.length === 0 ? (
            <p className="text-[12px] text-nv-muted py-4 text-center" data-testid="palette-empty">{palette.note || 'Aucune boucle compatible.'}</p>
          ) : (
            <>
              <ul className="space-y-0.5" data-testid="palette-list">{palette.items.map(row)}</ul>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void audition(togetherItems(palette.items), 'palette')} data-testid="palette-play"
                  className={`flex-1 min-w-[9rem] ${h} rounded-xl text-[12px] font-bold ${playing === 'palette' ? 'bg-cyan-500 text-black' : 'bg-nv-well text-nv-ink hover:bg-nv-accent/10'}`}>
                  <i className={`fas ${loading === 'palette' ? 'fa-circle-notch fa-spin' : playing === 'palette' ? 'fa-stop' : 'fa-play'} mr-1.5`} aria-hidden />{playing === 'palette' ? 'Stop' : 'Écouter ensemble'}
                </button>
                <button type="button" onClick={() => placeAll(palette.items)} data-testid="palette-place"
                  className={`flex-1 min-w-[9rem] ${h} rounded-xl text-[12px] font-black bg-cyan-500 text-black hover:bg-cyan-400`}>
                  Tout poser (une seule annulation)
                </button>
              </div>
              {togetherItems(palette.items).length < palette.items.length && (
                <p className="text-[11px] text-nv-muted">La 2e suite d’accords se pose juste après la 1re (pour un refrain) ; « Écouter ensemble » joue la 1re.</p>
              )}
              {palette.note && <p className="text-[11px] text-amber-600">{palette.note}</p>}
            </>
          )}
        </section>
      )}

      <p className="text-[10.5px] text-nv-muted border-t border-nv-line pt-2">
        Sons NOVA : à utiliser dans tes morceaux, ils ne se téléchargent pas. Le morceau s’exporte selon ton offre (prix affiché à l’export).
        {' '}<button type="button" onClick={() => sonsBeatStore.open({ kind: 'beat' })} data-testid="sounds-open-beat" className="font-bold text-cyan-600 hover:underline">🎲 Démarrer un beat</button>
      </p>
    </div>
  );

  if (p.variant === 'embedded') return <div className="p-3" data-testid="sound-library">{body}</div>;
  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => { stopAll(); p.onClose?.(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="sounds-title" data-testid="sound-library" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[94vh] overflow-y-auto space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="sounds-title" className="text-[15px] font-black">Sons et boucles NOVA</h2>
            <p className="text-[11px] text-nv-muted">
              {ix ? `${index.length.toLocaleString('fr-FR')} sons, instruments et boucles` : 'One-shots, instruments et boucles'} · {Math.round(proj.bpm)} BPM{projKey ? ` · ${keyLabel(projKey)}` : ''}
            </p>
          </div>
          <button type="button" onClick={() => { stopAll(); p.onClose?.(); }} aria-label="Fermer les sons" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" aria-hidden /></button>
        </div>
        {body}
      </div>
    </div>
  );
};

export default SoundLibrary;

