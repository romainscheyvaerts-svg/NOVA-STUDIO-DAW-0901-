import React, { useMemo, useRef, useState } from 'react';
import { KEYMAP, SHORTCUT_CATEGORIES, chordFromEvent, chordLabel, searchShortcuts, type ShortcutCategory, type ShortcutDef } from '../utils/keymap';
import {
  KEYMAP_PRESETS, conflictsFor, exportNovakeys, importNovakeys, keymapConflicts, keymapStore, presetById, useKeymap, useKeymapSettings,
  type KeymapPresetId,
} from '../utils/keymapStore';
import { saveBlob } from '../utils/saveBlob';

/**
 * Éditeur de raccourcis (R17) — Pro Tools 2026 « Keyboard Shortcuts », en mieux :
 * toutes les commandes de NOVA, recherche par nom OU par touche, remappage par
 * capture, conflit signalé AVANT d'être créé avec une résolution proposée
 * (prendre la touche ou échanger), préréglages complets (NOVA, Pro Tools
 * Windows, FL Studio, Ableton Live), « Remettre par défaut », export / import
 * d'un fichier .novakeys. Ordinateur et tablette (pas au téléphone).
 */

type Filter = 'all' | 'custom' | 'conflicts' | 'unbound';
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn']);
const CONTEXT_LABEL: Record<string, string> = { global: 'arrangement', focus: 'Keyboard Focus', pianoroll: 'piano roll', midi: 'clavier MIDI' };

interface Capture { id: string; replaceIndex?: number }
interface Pending { id: string; chord: string; replaceIndex?: number; others: ShortcutDef[] }

const KeymapEditor: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const keymap = useKeymap();
  const settings = useKeymapSettings();
  const [query, setQuery] = useState('');
  const [keyQuery, setKeyQuery] = useState<string | null>(null);
  const [listenKey, setListenKey] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [cat, setCat] = useState<ShortcutCategory | 'all'>('all');
  const [capture, setCapture] = useState<Capture | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [presetChoice, setPresetChoice] = useState<KeymapPresetId>(settings.preset);
  const fileRef = useRef<HTMLInputElement>(null);

  const conflicts = useMemo(() => keymapConflicts(keymap), [keymap]);
  const conflictIds = useMemo(() => new Set(conflicts.flatMap(c => c.ids)), [conflicts]);
  const customCount = Object.keys(settings.overrides).length;
  const labelOf = (id: string) => KEYMAP.find(d => d.id === id)?.label || id;

  const rows = useMemo(() => {
    let list = searchShortcuts(query, keymap);
    if (keyQuery) list = list.filter(d => d.keys.includes(keyQuery));
    if (cat !== 'all') list = list.filter(d => d.category === cat);
    if (filter === 'custom') list = list.filter(d => keymapStore.isCustomized(d.id));
    if (filter === 'conflicts') list = list.filter(d => conflictIds.has(d.id));
    if (filter === 'unbound') list = list.filter(d => !d.keys.length);
    return list;
  }, [query, keyQuery, keymap, cat, filter, conflictIds, settings]);

  const flash = (tone: 'ok' | 'warn', text: string) => setMessage({ tone, text });

  /** Une combinaison capturée : appliquée tout de suite, ou conflit à résoudre. */
  const onCaptured = (chord: string) => {
    if (!capture) return;
    const def = keymap.find(d => d.id === capture.id)!;
    const others = conflictsFor(capture.id, chord, keymap);
    setCapture(null);
    if (def.keys.includes(chord) && (capture.replaceIndex === undefined || def.keys[capture.replaceIndex] === chord)) { flash('ok', `« ${chordLabel(chord)} » est déjà le raccourci de « ${def.label} ».`); return; }
    if (others.some(o => o.fixed)) { flash('warn', `« ${chordLabel(chord)} » est réservé (${others.find(o => o.fixed)!.label}). Choisis une autre combinaison.`); return; }
    if (others.length) { setPending({ id: capture.id, chord, replaceIndex: capture.replaceIndex, others }); return; }
    keymapStore.assign(capture.id, chord, { replaceIndex: capture.replaceIndex });
    flash('ok', `✓ « ${def.label} » : ${chordLabel(chord)}`);
  };

  const onCaptureKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (MODIFIER_KEYS.has(e.key)) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { setCapture(null); setListenKey(false); return; }
    const chord = chordFromEvent(e.nativeEvent, settings.usLayout);
    if (listenKey) { setKeyQuery(chord); setListenKey(false); return; }
    onCaptured(chord);
  };

  const resolve = (how: 'steal' | 'swap') => {
    if (!pending) return;
    const touched = keymapStore.assign(pending.id, pending.chord, { replaceIndex: pending.replaceIndex, resolve: how });
    const names = touched.map(labelOf).map(l => `« ${l} »`).join(', ');
    flash('ok', how === 'swap'
      ? `✓ Échangé : « ${labelOf(pending.id)} » prend ${chordLabel(pending.chord)}, ${names} reprend l’ancienne touche.`
      : `✓ « ${labelOf(pending.id)} » prend ${chordLabel(pending.chord)} ; retiré de ${names}.`);
    setPending(null);
  };

  const applyPreset = () => {
    if (presetChoice === settings.preset && !customCount) return;
    if (customCount && !window.confirm(`Appliquer « ${presetById(presetChoice).name} » efface tes ${customCount} raccourci${customCount > 1 ? 's' : ''} personnalisé${customCount > 1 ? 's' : ''}. Pense à les exporter avant si tu veux les garder. Continuer ?`)) return;
    keymapStore.setPreset(presetChoice);
    flash('ok', `✓ Jeu « ${presetById(presetChoice).name} » appliqué.`);
  };

  const doExport = async () => {
    const text = exportNovakeys(`${presetById(settings.preset).name}${customCount ? ' perso' : ''}`);
    await saveBlob(new Blob([text], { type: 'application/json' }), `raccourcis-nova-${settings.preset}.novakeys`);
    flash('ok', '✓ Fichier .novakeys enregistré : ouvre-le sur un autre poste avec « Importer ».');
  };
  const doImport = async (f: File | undefined) => {
    if (!f) return;
    const r = importNovakeys(await f.text());
    if (!r.ok) { flash('warn', r.error || 'Import impossible.'); return; }
    setPresetChoice(keymapStore.get().preset);
    flash('ok', `✓ ${r.applied} raccourcis importés${r.unknown.length ? ` (${r.unknown.length} commande${r.unknown.length > 1 ? 's' : ''} inconnue${r.unknown.length > 1 ? 's' : ''} de cette version, ignorée${r.unknown.length > 1 ? 's' : ''})` : ''}.`);
  };

  const chip = (on: boolean) => `h-8 shrink-0 rounded-full border px-3 text-[12px] font-bold whitespace-nowrap ${on ? 'border-nv-accent bg-nv-accent/20 text-nv-ink' : 'border-nv-line bg-nv-well text-nv-muted hover:text-nv-ink'}`;
  const capturing = !!capture || listenKey;

  return (
    <div className="fixed inset-0 z-[720] flex items-center justify-center bg-black/60 p-2 sm:p-4" onClick={() => { if (!capturing && !pending) onClose(); }}
      role="dialog" aria-modal="true" aria-labelledby="keymap-title" data-testid="keymap-editor">
      <div className="flex h-[92vh] w-full max-w-5xl flex-col rounded-2xl border border-nv-line bg-nv-panel text-nv-ink shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* En-tête : jeu de raccourcis */}
        <div className="flex flex-wrap items-center gap-2 border-b border-nv-line p-4">
          <h2 id="keymap-title" className="mr-auto text-lg font-black">⌨️ Personnaliser les raccourcis</h2>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${conflicts.length ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`} data-testid="keymap-conflict-count">
            {conflicts.length ? `⚠ ${conflicts.length} conflit${conflicts.length > 1 ? 's' : ''}` : '✓ aucun conflit'}
          </span>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-9 w-9 rounded-lg bg-nv-well text-nv-muted hover:text-nv-ink">✕</button>
        </div>

        <div className="grid gap-3 border-b border-nv-line p-4 lg:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Jeu de raccourcis">
              {KEYMAP_PRESETS.map(p => (
                <button key={p.id} type="button" role="radio" aria-checked={presetChoice === p.id} onClick={() => setPresetChoice(p.id)} data-testid={`keymap-preset-${p.id}`}
                  className={chip(presetChoice === p.id)}>
                  {p.name}{settings.preset === p.id ? ' · actif' : ''}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12px] leading-snug text-nv-muted">{presetById(presetChoice).description}
              <span className="block text-[11px] opacity-80">Source : {presetById(presetChoice).source}</span></p>
          </div>
          <div className="flex flex-col gap-2 lg:items-end">
            <button type="button" onClick={applyPreset} disabled={presetChoice === settings.preset && !customCount} data-testid="keymap-apply-preset"
              className="h-9 rounded-lg bg-cyan-500 px-4 text-[13px] font-black text-black disabled:opacity-40">
              {presetChoice === settings.preset ? (customCount ? 'Revenir à ce jeu' : 'Jeu actif') : `Appliquer « ${presetById(presetChoice).name} »`}
            </button>
            <label className="flex items-center gap-2 text-[12px] text-nv-muted" title="Pro Tools sous Windows lit les touches par leur place sur un clavier US : en AZERTY, Annuler (Ctrl+Z) est sur la touche W.">
              <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={settings.usLayout} onChange={e => keymapStore.setUsLayout(e.target.checked)} data-testid="keymap-uslayout" />
              Touches par position (clavier US, comme Pro Tools)
            </label>
            <label className="flex items-center gap-2 text-[12px] text-nv-muted" title="Sans plage sélectionnée, Ctrl+F fait des fondus rapides sur les clips au lieu d’ouvrir la recherche du navigateur.">
              <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={settings.ctrlFFades} onChange={e => keymapStore.setCtrlFFades(e.target.checked)} data-testid="keymap-ctrlf" />
              Ctrl+F = fondus (même sans plage)
            </label>
          </div>
        </div>

        {/* Recherche et filtres */}
        <div className="flex flex-col gap-2 border-b border-nv-line p-3 sm:flex-row sm:items-center">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Chercher une commande : « séparer », « zoom », « pavé »…" aria-label="Chercher une commande" data-testid="keymap-search"
            className="min-w-0 flex-1 rounded-lg border border-nv-line bg-nv-well px-3 py-2 text-[13px] text-nv-ink outline-none focus:border-nv-accent" />
          <button type="button" onClick={() => { if (keyQuery) setKeyQuery(null); else { setCapture(null); setListenKey(true); } }} data-testid="keymap-search-key"
            className={chip(!!keyQuery || listenKey)} title="Appuie sur une combinaison pour voir à quoi elle sert">
            {listenKey ? 'Appuie sur une touche…' : keyQuery ? `Touche : ${chordLabel(keyQuery)} ✕` : '⌨ Chercher par touche'}
          </button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto border-b border-nv-line px-3 py-2 custom-scroll">
          {([['all', 'Toutes'], ['custom', `Personnalisées${customCount ? ` (${customCount})` : ''}`], ['conflicts', `Conflits${conflicts.length ? ` (${conflicts.length})` : ''}`], ['unbound', 'Sans touche']] as [Filter, string][]).map(([f, l]) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={chip(filter === f)} data-testid={`keymap-filter-${f}`}>{l}</button>
          ))}
          <span className="mx-1 w-px shrink-0 bg-nv-line" />
          <button type="button" onClick={() => setCat('all')} className={chip(cat === 'all')}>Tout</button>
          {SHORTCUT_CATEGORIES.map(c => <button key={c} type="button" onClick={() => setCat(c)} className={chip(cat === c)}>{c}</button>)}
        </div>

        {(capturing || pending || message) && (
          <div className="border-b border-nv-line px-4 py-2" aria-live="polite">
            {capturing && (
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-bold text-nv-accent">{listenKey ? 'Appuie sur la combinaison à chercher' : `Nouvelle touche pour « ${labelOf(capture!.id)} »`}</span>
                <input autoFocus readOnly value="" onKeyDown={onCaptureKey} onBlur={e => e.currentTarget.focus()} data-testid="keymap-capture" data-keymap-capture="" aria-label="Appuie sur la combinaison"
                  placeholder="Appuie sur la combinaison… (Échap pour annuler)"
                  className="min-w-[240px] flex-1 rounded-lg border-2 border-nv-accent bg-nv-well px-3 py-2 text-[13px] text-nv-ink outline-none animate-pulse" />
                <button type="button" onClick={() => { setCapture(null); setListenKey(false); }} className="h-9 rounded-lg bg-nv-well px-3 text-[12px] font-bold text-nv-muted">Annuler</button>
              </div>
            )}
            {pending && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[13px]" data-testid="keymap-conflict">
                <p><b>{chordLabel(pending.chord)}</b> sert déjà à {pending.others.map(o => `« ${o.label} »`).join(', ')} ({CONTEXT_LABEL[pending.others[0].context]}).</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => resolve('steal')} data-testid="keymap-resolve-steal" className="h-9 rounded-lg bg-cyan-500 px-3 text-[12px] font-black text-black">
                    Prendre la touche (la retirer à {pending.others.length > 1 ? 'ces commandes' : 'cette commande'})
                  </button>
                  {(() => {
                    const old = pending.replaceIndex !== undefined ? keymap.find(d => d.id === pending.id)?.keys[pending.replaceIndex] : undefined;
                    return old ? (
                      <button type="button" onClick={() => resolve('swap')} data-testid="keymap-resolve-swap" className="h-9 rounded-lg border border-nv-line bg-nv-well px-3 text-[12px] font-bold">
                        Échanger (elle reçoit {chordLabel(old)})
                      </button>
                    ) : null;
                  })()}
                  <button type="button" onClick={() => setPending(null)} className="h-9 rounded-lg bg-nv-well px-3 text-[12px] font-bold text-nv-muted">Annuler</button>
                </div>
              </div>
            )}
            {!capturing && !pending && message && (
              <p className={`text-[13px] ${message.tone === 'ok' ? 'text-emerald-400' : 'text-amber-300'}`} data-testid="keymap-message">{message.text}</p>
            )}
          </div>
        )}

        {/* Liste des commandes */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 custom-scroll" data-testid="keymap-list">
          {rows.length === 0 && (
            <p className="py-10 text-center text-[13px] text-nv-muted">
              {keyQuery ? `Aucune commande sur « ${chordLabel(keyQuery)} » : elle est libre.` : `Aucune commande pour « ${query} ».`}
            </p>
          )}
          <ul className="divide-y divide-nv-line">
            {rows.map(d => {
              const custom = keymapStore.isCustomized(d.id);
              const inConflict = conflictIds.has(d.id);
              return (
                <li key={d.id} data-command={d.id} className={`flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center ${capture?.id === d.id ? 'bg-nv-accent/10' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] leading-snug">
                      {d.label}
                      {custom && <span className="ml-2 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-bold text-cyan-300">perso</span>}
                      {inConflict && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">conflit</span>}
                    </p>
                    <p className="text-[11px] text-nv-muted">{d.category}{d.context !== 'global' ? ` · ${CONTEXT_LABEL[d.context]}` : ''}{d.pt ? ` · Pro Tools : ${d.pt}` : ''}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                    {d.fixed ? (
                      <span className="text-[11px] text-nv-muted" title="Famille de touches (notes, vitesses) : pas remappable une à une">🔒 {d.keys.length > 3 ? `${chordLabel(d.keys[0])} … ${chordLabel(d.keys[d.keys.length - 1])}` : d.keys.map(chordLabel).join(' · ') || 'au pavé'}</span>
                    ) : (
                      <>
                        {d.keys.map((k, i) => (
                          <span key={k} className="inline-flex items-center overflow-hidden rounded-md border border-nv-line bg-nv-well">
                            <button type="button" onClick={() => { setListenKey(false); setCapture({ id: d.id, replaceIndex: i }); }} title="Changer cette touche"
                              className="px-2 py-1 [@media(pointer:coarse)]:px-3 [@media(pointer:coarse)]:py-2 font-mono text-[12px] hover:bg-nv-accent/15" data-testid={`keymap-key-${d.id}-${i}`}>{chordLabel(k)}</button>
                            <button type="button" onClick={() => keymapStore.removeKey(d.id, k)} aria-label={`Retirer ${chordLabel(k)}`} title="Retirer cette touche"
                              className="border-l border-nv-line px-1.5 py-1 [@media(pointer:coarse)]:px-3 [@media(pointer:coarse)]:py-2 text-[11px] text-nv-muted hover:text-red-400">✕</button>
                          </span>
                        ))}
                        <button type="button" onClick={() => { setListenKey(false); setCapture({ id: d.id }); }} data-testid={`keymap-add-${d.id}`}
                          className="h-7 [@media(pointer:coarse)]:h-9 rounded-md border border-dashed border-nv-line px-2 [@media(pointer:coarse)]:px-3 text-[12px] text-nv-muted hover:text-nv-ink" title="Ajouter une touche">{d.keys.length ? '+' : '+ Choisir une touche'}</button>
                        {custom && (
                          <button type="button" onClick={() => keymapStore.resetCommand(d.id)} title="Remettre comme dans le jeu choisi" aria-label={`Remettre « ${d.label} » par défaut`}
                            className="h-7 rounded-md px-2 text-[12px] text-nv-muted hover:text-nv-ink">↺</button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Pied : export / import / remise à zéro */}
        <div className="flex flex-wrap items-center gap-2 border-t border-nv-line p-3">
          <button type="button" onClick={() => void doExport()} data-testid="keymap-export" className="h-9 rounded-lg border border-nv-line bg-nv-well px-3 text-[12px] font-bold">⬇ Exporter (.novakeys)</button>
          <button type="button" onClick={() => fileRef.current?.click()} data-testid="keymap-import" className="h-9 rounded-lg border border-nv-line bg-nv-well px-3 text-[12px] font-bold">⬆ Importer</button>
          <input ref={fileRef} type="file" accept=".novakeys,application/json" className="hidden" data-testid="keymap-import-file"
            onChange={e => { void doImport(e.target.files?.[0]); e.target.value = ''; }} />
          <span className="mr-auto" />
          <button type="button" data-testid="keymap-reset"
            onClick={() => { if (!customCount || window.confirm(`Remettre les ${customCount} raccourci${customCount > 1 ? 's' : ''} personnalisé${customCount > 1 ? 's' : ''} comme dans « ${presetById(settings.preset).name} » ?`)) { keymapStore.resetAll(); flash('ok', `✓ Raccourcis remis comme dans « ${presetById(settings.preset).name} ».`); } }}
            className="h-9 rounded-lg border border-nv-line bg-nv-well px-3 text-[12px] font-bold">↺ Remettre par défaut</button>
        </div>
      </div>
    </div>
  );
};

export default KeymapEditor;
