import React, { useMemo, useRef, useState } from 'react';
import { chordFromEvent, chordLabel } from '../utils/keymap';
import { useKeymapSettings } from '../utils/keymapStore';
import { recentActions, searchActions, type PaletteAction } from '../utils/commandPalette';
import {
  deleteMacro, exportNovamacros, importNovamacros, Macro, MAX_STEPS, macroCandidates, macroKeyConflict, newMacroId, runMacro, saveMacro, useMacros,
} from '../utils/macros';
import { saveBlob } from '../utils/saveBlob';

/**
 * Macros (écart 21), dans l'éditeur de raccourcis : enchaîner plusieurs commandes de la
 * palette Ctrl+K en une, avec une touche. Création à la main (recherche) ou depuis les
 * dernières commandes lancées dans la palette. Une macro jouée = un seul Ctrl+Z.
 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn']);
const btn = 'h-9 rounded-lg border border-nv-line bg-nv-well px-3 text-[12px] font-bold text-nv-ink hover:bg-nv-accent/15 disabled:opacity-40';
const btnMain = 'h-9 rounded-lg bg-cyan-500 px-4 text-[13px] font-black text-black disabled:opacity-40';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

const MacrosPanel: React.FC = () => {
  const list = useMacros();
  const settings = useKeymapSettings();
  const [edit, setEdit] = useState<Macro | null>(null);
  const [search, setSearch] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const actions = useMemo(() => macroCandidates(), [edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(actions.map(a => [a.id, a])), [actions]);
  const labelOf = (id: string) => byId.get(id)?.label || `${id} (absente de cette version)`;
  const found: PaletteAction[] = useMemo(() => (search.trim() ? searchActions(search, actions).slice(0, 8) : []), [search, actions]);
  const recent = useMemo(() => recentActions().filter(id => byId.has(id) && !id.startsWith('macro:')), [byId, edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (m?: Macro) => { setEdit(m ? { ...m, steps: [...m.steps] } : { id: newMacroId(), name: `Macro ${list.length + 1}`, steps: [] }); setSearch(''); setMsg(null); setCapturing(false); };
  const setSteps = (fn: (s: string[]) => string[]) => setEdit(e => (e ? { ...e, steps: fn(e.steps).slice(0, MAX_STEPS) } : e));
  const move = (i: number, d: number) => setSteps(s => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return n; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const onCapture = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault(); e.stopPropagation();
    if (MODIFIER_KEYS.has(e.key)) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { setCapturing(false); return; }
    const chord = chordFromEvent(e.nativeEvent, settings.usLayout);
    setCapturing(false);
    const taken = macroKeyConflict(chord, edit?.id);
    if (taken) { setMsg({ tone: 'warn', text: `« ${chordLabel(chord)} » sert déjà (${taken}). Choisis une combinaison libre, par exemple Ctrl+Alt+1.` }); return; }
    setEdit(x => (x ? { ...x, keys: chord } : x));
    setMsg({ tone: 'ok', text: `Touche « ${chordLabel(chord)} » : enregistre la macro pour la garder.` });
  };

  const doSave = () => {
    if (!edit) return;
    if (!edit.steps.length) { setMsg({ tone: 'warn', text: 'Ajoute au moins une commande.' }); return; }
    const m = saveMacro(edit);
    setEdit(null);
    setMsg({ tone: 'ok', text: `✓ Macro « ${m.name} » enregistrée (${plural(m.steps.length, 'commande')}${m.keys ? `, touche ${chordLabel(m.keys)}` : ''}). Elle est aussi dans la palette Ctrl+K.` });
  };
  const doExport = async () => {
    await saveBlob(new Blob([exportNovamacros()], { type: 'application/json' }), 'macros-nova.novamacros');
    setMsg({ tone: 'ok', text: '✓ Fichier .novamacros enregistré : importe-le sur un autre poste.' });
  };
  const doImport = async (f?: File) => {
    if (!f) return;
    const r = importNovamacros(await f.text());
    setMsg(r.ok ? { tone: 'ok', text: `✓ ${plural(r.added, 'macro importée', 'macros importées')}${r.keysDropped ? ` (${r.keysDropped} sans touche : la sienne était déjà prise ici)` : ''}.` } : { tone: 'warn', text: r.error || 'Import impossible.' });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="macros-panel">
      <div className="border-b border-nv-line px-4 py-3">
        <p className="text-[12px] leading-snug text-nv-muted">Une macro enchaîne plusieurs commandes de la palette (Ctrl+K) en une seule, sur la touche de ton choix. Exemple : « Séparer le clip » puis « Fondu » puis « Normaliser ». Jouée d'un coup, elle s'annule d'un seul Ctrl+Z.</p>
      </div>
      {msg && <p className={`border-b border-nv-line px-4 py-2 text-[13px] ${msg.tone === 'ok' ? 'text-emerald-400' : 'text-amber-300'}`} data-testid="macros-message" aria-live="polite">{msg.text}</p>}
      <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[minmax(240px,320px)_1fr]">
        {/* Liste */}
        <div className="flex min-h-0 flex-col border-b border-nv-line md:border-b-0 md:border-r">
          <div className="flex items-center gap-2 p-3">
            <button type="button" className={btnMain} onClick={() => start()} data-testid="macros-new">+ Nouvelle macro</button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 custom-scroll" data-testid="macros-list">
            {!list.length && <li className="py-6 text-center text-[12px] text-nv-muted">Aucune macro. Crée la première : ses commandes, puis une touche.</li>}
            {list.map(m => (
              <li key={m.id} data-macro={m.id} className={`mb-1.5 rounded-xl border p-2.5 ${edit?.id === m.id ? 'border-nv-accent bg-nv-accent/10' : 'border-nv-line bg-nv-well/40'}`}>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => start(m)} className="min-w-0 flex-1 truncate text-left text-[13px] font-bold text-nv-ink" title="Modifier">{m.name}</button>
                  {m.keys && <span className="shrink-0 rounded-md border border-nv-line bg-nv-panel px-1.5 py-0.5 font-mono text-[11px]">{chordLabel(m.keys)}</span>}
                </div>
                <p className="mt-0.5 truncate text-[11px] text-nv-muted">{plural(m.steps.length, 'commande')} : {m.steps.map(s => byId.get(s)?.label || s).join(' → ')}</p>
                <div className="mt-1.5 flex gap-1.5">
                  <button type="button" className="h-7 rounded-md bg-cyan-500/15 px-2 text-[11px] font-bold text-cyan-300" onClick={() => { void runMacro(m.id); }} data-testid={`macro-play-${m.id}`}>▶ Jouer</button>
                  <button type="button" className="h-7 rounded-md bg-nv-well px-2 text-[11px] font-bold text-nv-ink" onClick={() => start(m)}>Modifier</button>
                  <button type="button" className="h-7 rounded-md px-2 text-[11px] text-nv-muted hover:text-red-400" onClick={() => { if (window.confirm(`Supprimer la macro « ${m.name} » ?`)) { deleteMacro(m.id); if (edit?.id === m.id) setEdit(null); } }}
                    aria-label={`Supprimer ${m.name}`}>Supprimer</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        {/* Édition */}
        <div className="flex min-h-0 flex-col overflow-y-auto p-3 custom-scroll">
          {!edit ? (
            <p className="m-auto max-w-sm py-8 text-center text-[13px] text-nv-muted">Choisis une macro à modifier, ou « + Nouvelle macro ».</p>
          ) : (
            <div className="flex flex-col gap-3" data-testid="macro-editor">
              <label className="flex flex-col gap-1 text-[12px] font-bold text-nv-muted">Nom
                <input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} maxLength={60} data-testid="macro-name"
                  className="rounded-lg border border-nv-line bg-nv-well px-3 py-2 text-[13px] font-normal text-nv-ink outline-none focus:border-nv-accent" />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-bold text-nv-muted">Touche</span>
                {capturing ? (
                  <input autoFocus readOnly value="" onKeyDown={onCapture} onBlur={() => setCapturing(false)} data-testid="macro-capture" data-macro-capture=""
                    placeholder="Appuie sur la combinaison… (Échap pour annuler)" aria-label="Appuie sur la combinaison"
                    className="min-w-[240px] flex-1 animate-pulse rounded-lg border-2 border-nv-accent bg-nv-well px-3 py-2 text-[13px] text-nv-ink outline-none" />
                ) : (
                  <>
                    <button type="button" className={btn} onClick={() => setCapturing(true)} data-testid="macro-key">{edit.keys ? chordLabel(edit.keys) : '⌨ Choisir une touche'}</button>
                    {edit.keys && <button type="button" className="h-9 rounded-lg px-2 text-[12px] text-nv-muted hover:text-nv-ink" onClick={() => setEdit({ ...edit, keys: undefined })}>Sans touche</button>}
                  </>
                )}
              </div>
              <div>
                <p className="mb-1 text-[12px] font-bold text-nv-muted">Commandes, dans l'ordre ({edit.steps.length}/{MAX_STEPS})</p>
                {!edit.steps.length && <p className="rounded-lg border border-dashed border-nv-line p-3 text-[12px] text-nv-muted">Aucune commande : cherche-les ci-dessous ou reprends tes dernières commandes de la palette.</p>}
                <ol className="flex flex-col gap-1" data-testid="macro-steps">
                  {edit.steps.map((s, i) => (
                    <li key={`${s}-${i}`} className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[12px] ${byId.has(s) ? 'border-nv-line bg-nv-well/40 text-nv-ink' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}>
                      <span className="w-5 shrink-0 text-center font-mono text-nv-muted">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate">{labelOf(s)}</span>
                      <button type="button" className="h-7 w-7 rounded-md text-nv-muted hover:text-nv-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter">↑</button>
                      <button type="button" className="h-7 w-7 rounded-md text-nv-muted hover:text-nv-ink disabled:opacity-30" disabled={i === edit.steps.length - 1} onClick={() => move(i, 1)} aria-label="Descendre">↓</button>
                      <button type="button" className="h-7 w-7 rounded-md text-nv-muted hover:text-red-400" onClick={() => setSteps(st => st.filter((_, k) => k !== i))} aria-label="Retirer">✕</button>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="flex flex-col gap-1.5">
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Ajouter une commande : « séparer », « fondu », « normaliser »…" aria-label="Ajouter une commande" data-testid="macro-search"
                  className="rounded-lg border border-nv-line bg-nv-well px-3 py-2 text-[13px] text-nv-ink outline-none focus:border-nv-accent" />
                {found.length > 0 && (
                  <ul className="flex flex-col gap-0.5" data-testid="macro-search-results">
                    {found.map(a => (
                      <li key={a.id}>
                        <button type="button" data-step-id={a.id} disabled={edit.steps.length >= MAX_STEPS}
                          onClick={() => { setSteps(st => [...st, a.id]); setSearch(''); }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-nv-ink hover:bg-nv-accent/15">
                          <span className="text-cyan-400">+</span><span className="min-w-0 flex-1 truncate">{a.label}</span><span className="shrink-0 text-[10px] text-nv-muted">{a.group}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {recent.length > 0 && (
                  <button type="button" className={`${btn} self-start`} data-testid="macro-from-recent" disabled={edit.steps.length >= MAX_STEPS}
                    title={[...recent].reverse().map(labelOf).join(' → ')}
                    onClick={() => setSteps(st => [...st, ...[...recent].reverse()])}>↺ {recent.length > 1 ? `Reprendre mes ${recent.length} dernières commandes` : 'Reprendre ma dernière commande'} de la palette</button>
                )}
              </div>
              <label className="flex items-start gap-2 text-[12px] text-nv-ink">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-cyan-500" checked={!!edit.express} onChange={e => setEdit({ ...edit, express: e.target.checked })} data-testid="macro-express" />
                <span><b>Express</b> : tout d'un coup, en un éclair. Laisse décoché si une commande dépend de la précédente (créer une piste, puis la régler).</span>
              </label>
              <div className="sticky bottom-0 -mx-3 -mb-3 flex flex-wrap justify-end gap-2 border-t border-nv-line bg-nv-panel px-3 py-3">
                <button type="button" className={btn} onClick={() => { setEdit(null); setMsg(null); }}>Annuler</button>
                <button type="button" className={btnMain} onClick={doSave} disabled={!edit.steps.length} data-testid="macro-save">Enregistrer la macro</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-nv-line p-3">
        <button type="button" onClick={() => void doExport()} disabled={!list.length} data-testid="macros-export" className={btn}>⬇ Exporter (.novamacros)</button>
        <button type="button" onClick={() => fileRef.current?.click()} data-testid="macros-import" className={btn}>⬆ Importer</button>
        <input ref={fileRef} type="file" accept=".novamacros,application/json" className="hidden" data-testid="macros-import-file"
          onChange={e => { void doImport(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    </div>
  );
};

export default MacrosPanel;
