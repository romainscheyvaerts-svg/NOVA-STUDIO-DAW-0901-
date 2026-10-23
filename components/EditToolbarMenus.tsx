import React from 'react';
import type { CrossfadeCurve, EditorTool } from '../types';
import ToolbarMenu, { MenuSection, menuRowClass, MenuSwitch } from './ToolbarMenu';
import { useClipGainView } from './ClipGainTools';
import { clipGainViewStore, PENCIL_SHAPES, PencilShape } from '../utils/clipGain';
import { editPrefsStore, useEditPrefs } from '../utils/editSelection';
import { FADE_CURVES, FADE_CURVE_INFO, NUDGE_UNITS, NudgeUnit } from '../utils/fades';
import { GRID_OPTIONS, gridLabel } from '../utils/grid';
import {
  chooseEditMode, EDIT_MODE_INFO, editModeMessage, EDIT_MODES, EditMode, editModeStore, GRID_KIND_LABEL, toggleShuffleLock, useEditMode,
} from '../utils/editModes';
import { notify } from './EditModeSelector';
import { shortcutHint } from '../utils/keymap';

/**
 * Barre d'outils de l'arrangement, mode avancé, allégée (22/10/2026, « trop de boutons ») :
 *  - « Outils ▾ » : scrub, zoom, crayon (et ses formes), ligne de gain, valeurs de gain,
 *    mode boucle, Trim TCE. L'outil actif s'affiche sur le bouton ; une pastille signale
 *    un affichage allumé (ligne de gain…). Raccourcis inchangés (F5, F9, 6, Alt+G…).
 *  - « Édition ▾ » : le mode (SHUF / SLIP / SPOT / GRID, affiché sur le bouton), la valeur
 *    de grille, le décalage (nudge), les fondus enchaînés et « l'automation suit l'édition ».
 * Les deux menus ne sont montés qu'à l'ouverture.
 */

const MORE_TOOLS: { tool: EditorTool; icon: string; label: string; aria: string; testId?: string; hint: () => string }[] = [
  { tool: 'SCRUB', icon: 'fa-headphones', label: 'Scrub', aria: 'Outil scrub', testId: 'tool-scrub',
    hint: () => `Scrubber (${shortcutHint('tool.scrub') || 'F9'}) : glisse sur la forme d'onde pour l'entendre, au rythme de ta main (ou de ton doigt). Alt+glisser = shuttle. Avec le Sélecteur, Ctrl+glisser fait la même chose.` },
  { tool: 'ZOOM', icon: 'fa-magnifying-glass', label: 'Zoom', aria: 'Outil zoom', testId: 'tool-zoom',
    hint: () => `Zoom (${shortcutHint('tool.zoom') || 'F5'}) : clic = zoom avant sur ce point, Alt+clic = zoom arrière` },
];

export const ToolsMoreMenu: React.FC<{ activeTool: EditorTool; setActiveTool: (t: EditorTool) => void }> = ({ activeTool, setActiveTool }) => {
  const v = useClipGainView();
  const prefs = useEditPrefs();
  const shape = PENCIL_SHAPES.find(s => s.id === v.shape) || PENCIL_SHAPES[0];
  const inMenu = activeTool === 'SCRUB' || activeTool === 'ZOOM' || activeTool === 'DRAW';
  const icon = activeTool === 'SCRUB' ? 'fa-headphones' : activeTool === 'ZOOM' ? 'fa-magnifying-glass' : activeTool === 'DRAW' ? 'fa-pencil-alt' : 'fa-toolbox';
  // Pastille : un réglage qui n'est pas celui d'origine (les bords des clips ne se comportent plus pareil, etc.).
  const lit = [v.line && 'ligne de gain affichée', !v.info && 'valeurs de gain masquées', v.loopTrim && 'mode boucle', prefs.trimTce && 'Trim TCE'].filter(Boolean) as string[];
  return (
    <ToolbarMenu testId="tools-more" menuLabel="Autres outils" width={290}
      ariaLabel={inMenu ? `Outils : ${activeTool === 'DRAW' ? 'crayon' : activeTool === 'SCRUB' ? 'scrub' : 'zoom'} (actif)` : 'Autres outils'}
      title={`Autres outils : scrub, zoom, crayon, ligne de gain, mode boucle, Trim TCE${lit.length ? ` · allumé : ${lit.join(', ')}` : ''}`}
      triggerProps={{ 'data-nova-target': 'tools-more', 'aria-pressed': inMenu }}
      triggerClassName={`relative h-9 [@media(pointer:coarse)]:h-10 px-2 shrink-0 rounded-lg flex items-center gap-1.5 border text-[11px] font-bold transition-all ${inMenu ? (activeTool === 'DRAW' ? 'bg-amber-400 text-black border-amber-300' : 'bg-[#38bdf8] text-black border-sky-300') : 'bg-black/40 border-white/5 text-slate-400 hover:text-white'}`}
      label={<>
        <i className={`fas ${icon} text-[12px]`} aria-hidden="true" />
        <span className="hidden xl:inline">Outils</span>
        <i className="fas fa-chevron-down text-[8px] opacity-70" aria-hidden="true" />
        {lit.length > 0 && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-black/60" data-testid="tools-more-lit" aria-hidden="true" />}
      </>}>
      {(close) => (<>
        <MenuSection title="Outils" first>
          {MORE_TOOLS.map(t => (
            <button key={t.tool} type="button" role="menuitemradio" aria-checked={activeTool === t.tool} aria-pressed={activeTool === t.tool} data-testid={t.testId} aria-label={t.aria}
              title={t.hint()} onClick={() => { setActiveTool(t.tool); close(); }} className={menuRowClass(activeTool === t.tool)}>
              <i className={`fas ${t.icon} w-5 text-center text-[12px]`} aria-hidden="true" /><span>{t.label}</span>
              <kbd className="ml-auto text-[10px] font-mono text-slate-500">{t.tool === 'SCRUB' ? (shortcutHint('tool.scrub') || 'F9') : (shortcutHint('tool.zoom') || 'F5')}</kbd>
            </button>
          ))}
          <button type="button" role="menuitemradio" aria-checked={activeTool === 'DRAW'} aria-pressed={activeTool === 'DRAW'} data-testid="tool-pencil" aria-label="Crayon"
            title={`Crayon (6, comme le Pencil Tool : F10) : dessine la ligne de gain d'un clip ou une ligne d'automation ouverte. Forme : ${shape.label}.`}
            onClick={() => { setActiveTool(activeTool === 'DRAW' ? 'SMART' : 'DRAW'); close(); }} className={menuRowClass(activeTool === 'DRAW')}>
            <i className="fas fa-pencil-alt w-5 text-center text-[12px]" aria-hidden="true" /><span>Crayon</span><kbd className="ml-auto text-[10px] font-mono text-slate-500">6</kbd>
          </button>
          <div role="group" aria-label={`Forme du crayon : ${shape.label}`} data-testid="pencil-shape" className="mt-1 grid grid-cols-3 gap-1 pl-7">
            {PENCIL_SHAPES.map(s => (
              <button key={s.id} type="button" role="menuitemradio" aria-checked={v.shape === s.id} data-testid={`pencil-shape-${s.id}`} title={s.hint}
                onClick={() => { clipGainViewStore.set({ shape: s.id as PencilShape }); setActiveTool('DRAW'); close(); }}
                className={`min-h-8 [@media(pointer:coarse)]:min-h-10 px-1.5 rounded-md flex items-center gap-1 text-[10px] font-bold ${v.shape === s.id ? 'bg-amber-400/15 text-amber-500' : 'text-slate-400 hover:bg-white/5'}`}>
                <i className={`fas ${s.icon} text-[10px]`} aria-hidden="true" /><span className="truncate">{s.label}</span>
              </button>
            ))}
          </div>
        </MenuSection>
        <MenuSection title="Gain des clips">
          <button type="button" role="menuitemcheckbox" aria-checked={v.line} aria-pressed={v.line} data-testid="toggle-gain-line" aria-label="Ligne de gain"
            title="Ligne de gain des clips (Ctrl+Maj+−, ici aussi Alt+G) : clique sur la ligne pour poser un point, tire-le, Alt+clic pour l'enlever, Ctrl+glisser pour courber un segment, Maj+glisser pour tout le clip. Ctrl+Maj+↑ / ↓ : ±0,5 dB."
            onClick={() => clipGainViewStore.set({ line: !v.line })} className={menuRowClass(v.line)}>
            <i className="fas fa-chart-line w-5 text-center text-[12px]" aria-hidden="true" /><span>Ligne de gain</span><MenuSwitch on={v.line} />
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={v.info} aria-pressed={v.info} data-testid="toggle-gain-info" aria-label="Valeurs de gain sur les clips"
            title="Valeurs de gain sur les clips (Clip Gain Info) : le gain de chaque clip et de chaque point de sa ligne."
            onClick={() => clipGainViewStore.set({ info: !v.info })} className={menuRowClass(v.info)}>
            <i className="fas fa-sliders w-5 text-center text-[12px]" aria-hidden="true" /><span>Valeurs de gain (dB)</span><MenuSwitch on={v.info} />
          </button>
        </MenuSection>
        <MenuSection title="Bords des clips">
          <button type="button" role="menuitemcheckbox" aria-checked={v.loopTrim} aria-pressed={v.loopTrim} data-testid="toggle-loop-trim" aria-label="Mode boucle"
            title="Mode boucle (Loop Trim) : tire le bord droit d'un clip pour le répéter ; la dernière boucle peut être partielle. Ctrl+Alt+L : boucler n fois, Alt+R : répéter."
            onClick={() => clipGainViewStore.set({ loopTrim: !v.loopTrim })} className={menuRowClass(v.loopTrim)}>
            <i className="fas fa-repeat w-5 text-center text-[12px]" aria-hidden="true" /><span>Mode boucle</span><MenuSwitch on={v.loopTrim} />
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={!!prefs.trimTce} aria-pressed={!!prefs.trimTce} data-testid="trim-tce" aria-label="Étirer en tirant le bord (Trim TCE)"
            title="Étirer en tirant le bord (outil Trim en mode TCE) : le clip audio s'allonge ou raccourcit, sa hauteur ne change pas. Sans ce mode : Alt + bord."
            onClick={() => editPrefsStore.set({ trimTce: !prefs.trimTce })} className={menuRowClass(!!prefs.trimTce)}>
            <i className="fas fa-left-right w-5 text-center text-[12px]" aria-hidden="true" /><span>Étirer en tirant le bord</span><MenuSwitch on={!!prefs.trimTce} />
          </button>
        </MenuSection>
      </>)}
    </ToolbarMenu>
  );
};

const selectClass = 'w-full h-9 [@media(pointer:coarse)]:h-11 bg-black/40 border border-white/10 rounded-lg px-2 text-[12px] text-slate-300';

export const EditMenu: React.FC<{ onSetNudge?: (u: NudgeUnit) => void }> = ({ onSetNudge }) => {
  const em = useEditMode();
  const prefs = useEditPrefs();
  const info = EDIT_MODE_INFO[em.mode];
  const gridRel = em.mode === 'GRID' && em.gridKind === 'RELATIVE';
  const pick = (m: EditMode, e: React.MouseEvent) => {
    if (m === 'SHUFFLE' && (e.ctrlKey || e.metaKey)) { notify(toggleShuffleLock().message); return; }
    notify(chooseEditMode(m).message);
  };
  // États à ne jamais cacher : verrou Shuffle, fondu enchaîné auto, automation qui ne suit plus.
  const flags = [em.shuffleLock && '🔒 Shuffle verrouillé', !prefs.autoXfade && 'fondu enchaîné auto coupé', prefs.automationFollowsEdit === false && "l'automation ne suit pas l'édition"].filter(Boolean) as string[];
  return (
    <ToolbarMenu testId="grid-value" menuLabel="Édition : mode, grille, décalage, fondus" width={320}
      ariaLabel={`Édition : mode ${info.label}${gridRel ? ' relatif' : ''}, grille ${gridLabel(em.gridSize)} (valeur de grille)`}
      title={`Édition : mode ${info.label} (${info.keys}), grille ${gridLabel(em.gridSize)}, décalage, fondus enchaînés, automation qui suit l'édition${flags.length ? `\nActif : ${flags.join(', ')}` : ''}`}
      triggerProps={{ 'data-nova-target': 'edit-modes', 'data-edit-mode-current': em.mode }}
      triggerClassName="relative h-9 [@media(pointer:coarse)]:h-10 shrink-0 rounded-lg flex items-center gap-1.5 pl-1 pr-2 border border-white/10 bg-black/40 text-[11px] font-bold tabular-nums text-slate-200 hover:border-white/25 transition-colors"
      label={<>
        <span className="h-7 [@media(pointer:coarse)]:h-8 min-w-[40px] px-1.5 rounded-md flex items-center justify-center text-[10px] font-black tracking-wider text-black" style={{ background: info.color }}>
          {info.short}{gridRel && <span className="ml-0.5 text-[8px] opacity-80">REL</span>}
        </span>
        <span className="text-slate-400 hidden lg:inline">Édition</span>
        <span className="whitespace-nowrap"><i className="fas fa-th mr-1 text-[9px] text-slate-500" aria-hidden="true" />{gridLabel(em.gridSize)}</span>
        <i className="fas fa-chevron-down text-[8px] opacity-70" aria-hidden="true" />
        {em.shuffleLock && <i className="fas fa-lock absolute -top-1 -left-1 text-[8px] text-orange-300" aria-hidden="true" />}
        {(!prefs.autoXfade || prefs.automationFollowsEdit === false) && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-black/60" data-testid="edit-menu-lit" aria-hidden="true" />}
      </>}>
      {() => (<>
        <MenuSection title="Mode d'édition" first>
          <div role="radiogroup" aria-label="Mode d'édition" className="grid grid-cols-4 gap-1">
            {EDIT_MODES.map(m => {
              const mi = EDIT_MODE_INFO[m];
              const on = em.mode === m;
              const locked = m === 'SHUFFLE' && em.shuffleLock;
              return (
                <button key={m} type="button" role="radio" aria-checked={on} data-edit-mode={m}
                  aria-label={`Mode ${mi.label}${m === 'GRID' && on ? ` ${GRID_KIND_LABEL[em.gridKind]}` : ''}${locked ? ' (verrouillé)' : ''}`}
                  title={`${mi.hint}\nRaccourci : ${mi.keys}.${locked ? '\n🔒 Verrouillé (Shuffle Lock) : clic droit ou Ctrl+clic pour déverrouiller.' : ''}`}
                  onClick={(e) => pick(m, e)}
                  onContextMenu={m === 'SHUFFLE' ? (e) => { e.preventDefault(); notify(toggleShuffleLock().message); } : undefined}
                  className={`relative h-9 [@media(pointer:coarse)]:h-11 rounded-md text-[10px] font-black tracking-wider transition-colors ${on ? 'text-black' : locked ? 'text-slate-600' : 'text-slate-400 hover:text-white'}`}
                  style={on ? { background: mi.color, boxShadow: `0 0 12px ${mi.color}55` } : { borderBottom: `2px solid ${mi.color}55` }}>
                  {mi.short}
                  {m === 'GRID' && gridRel && <span className="ml-0.5 text-[8px] font-black opacity-80">REL</span>}
                  {locked && <i className="fas fa-lock absolute -top-1 -right-1 text-[8px] text-orange-300" aria-hidden />}
                </button>
              );
            })}
          </div>
          <p className="px-1 pt-1 text-[10px] leading-snug text-slate-500">{editModeMessage()}</p>
        </MenuSection>
        <MenuSection title="Valeur de grille">
          {([['musique', null], ['temps', 'En temps (min:s, images)']] as const).map(([kind, title]) => (
            <React.Fragment key={kind}>
              {title && <div className="px-1 pb-1 pt-1 text-[10px] font-bold text-slate-500" title="Grille en min:sec ou en timecode, indépendante du tempo (vidéo, podcast, son sans tempo)">{title}</div>}
              <div className="grid grid-cols-4 gap-0.5">
                {GRID_OPTIONS.filter(o => (o.kind || 'musique') === kind).map(o => (
                  <button key={o.value} type="button" role="menuitemradio" aria-checked={em.gridSize === o.value} title={o.title} data-grid-option={o.value}
                    onClick={() => editModeStore.set({ gridSize: o.value })}
                    className={`px-1 py-1.5 [@media(pointer:coarse)]:py-2.5 rounded-lg text-[10px] font-bold ${em.gridSize === o.value ? 'bg-blue-500/15 text-blue-300' : 'text-slate-300 hover:bg-white/5'}`}>{o.label}</button>
                ))}
              </div>
            </React.Fragment>
          ))}
          <div className="mt-1 grid grid-cols-2 gap-1">
            {(['ABSOLUTE', 'RELATIVE'] as const).map(k => (
              <button key={k} type="button" role="menuitemradio" aria-checked={em.gridKind === k}
                title={k === 'ABSOLUTE' ? 'Grid absolu : le début du clip (ou son point de synchro) tombe pile sur la grille.' : 'Grid relatif : le clip avance par pas de grille en gardant son décalage (une prise un peu en avance reste en avance). Relative Grid.'}
                onClick={() => { editModeStore.set({ mode: 'GRID', gridKind: k }); notify(editModeMessage()); }}
                className={`px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 rounded-lg text-[10px] font-bold capitalize ${em.gridKind === k ? 'bg-blue-500/15 text-blue-300' : 'text-slate-300 hover:bg-white/5'}`}>Grid {GRID_KIND_LABEL[k]}</button>
            ))}
          </div>
          <button type="button" role="menuitemcheckbox" aria-checked={em.tabToTransient} onClick={() => editModeStore.set({ tabToTransient: !em.tabToTransient })}
            title="Tab to Transient : Tab amène la tête de lecture à l'attaque suivante du clip sélectionné ; éteint, Tab va au bord de clip suivant. Maj+Tab : en arrière."
            className={menuRowClass(false)}>
            <span>Tab va aux attaques</span><MenuSwitch on={em.tabToTransient} />
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={em.shuffleLock} onClick={() => notify(toggleShuffleLock().message)}
            title="Shuffle Lock : empêche d'entrer en Shuffle par erreur (F1, clic)." className={menuRowClass(false)}>
            <i className={`fas ${em.shuffleLock ? 'fa-lock text-orange-300' : 'fa-lock-open text-slate-500'} w-4 text-center`} aria-hidden="true" /><span>Verrouiller Shuffle</span><MenuSwitch on={em.shuffleLock} />
          </button>
        </MenuSection>
        <MenuSection title="Décalage et fondus">
          <div className="flex items-center gap-2 px-1 pb-1" data-nova-target="nudge">
            <label className="w-24 shrink-0 text-[11px] font-bold text-slate-400" htmlFor="nova-nudge" title="Décalage (« nudge ») : ← / → déplacent la sélection d'un pas ; Maj = 10 pas.">Décalage</label>
            <select id="nova-nudge" value={prefs.nudge} onChange={e => onSetNudge ? onSetNudge(e.target.value as NudgeUnit) : editPrefsStore.set({ nudge: e.target.value as NudgeUnit })}
              title="Pas du décalage (« Nudge value ») : ← / → sur la sélection, Maj = 10 pas" aria-label="Pas du décalage" className={selectClass}>
              {NUDGE_UNITS.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2 px-1 pb-1">
            <label className="w-24 shrink-0 text-[11px] font-bold text-slate-400" htmlFor="nova-xfade-curve">Courbe</label>
            <select id="nova-xfade-curve" value={prefs.xfadeCurve} onChange={e => editPrefsStore.set({ xfadeCurve: e.target.value as CrossfadeCurve })}
              aria-label="Courbe des fondus enchaînés"
              title="Courbe des crossfades posés à la souris (bas d'une jonction), avec Ctrl+F ou automatiquement. Puissance égale = « Equal Power », sans creux de niveau."
              className={selectClass}>
              {FADE_CURVES.map(cv => <option key={cv} value={cv}>{FADE_CURVE_INFO[cv].label}</option>)}
            </select>
          </div>
          <button type="button" role="menuitemcheckbox" aria-checked={!!prefs.autoXfade} aria-pressed={!!prefs.autoXfade} onClick={() => editPrefsStore.set({ autoXfade: !prefs.autoXfade })}
            title="Fondu enchaîné auto : quand tu poses un clip contre un autre ou par-dessus (≤ 2 s), un fondu enchaîné (crossfade) est créé tout seul."
            className={menuRowClass(!!prefs.autoXfade)}>
            <i className="fas fa-xmark w-5 text-center" aria-hidden="true" /><span>Fondu enchaîné auto</span><MenuSwitch on={!!prefs.autoXfade} />
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={prefs.automationFollowsEdit !== false} aria-pressed={prefs.automationFollowsEdit !== false}
            onClick={() => editPrefsStore.set({ automationFollowsEdit: !prefs.automationFollowsEdit })}
            data-nova-target="automation-follows"
            title="L'automation suit l'édition (« Automation Follows Edit ») : un clip déplacé emporte sa courbe de volume, de pan, de mute et d'effets ; copier, couper, coller, effacer ou dupliquer une plage portent aussi l'automation. Désactivé : la courbe reste où elle est."
            className={menuRowClass(prefs.automationFollowsEdit !== false)}>
            <i className="fas fa-wave-square w-5 text-center" aria-hidden="true" /><span>Automation suit l'édition</span><MenuSwitch on={prefs.automationFollowsEdit !== false} />
          </button>
        </MenuSection>
      </>)}
    </ToolbarMenu>
  );
};
