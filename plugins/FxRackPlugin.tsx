/**
 * Fenêtre du « Rack parallèle » (écart 13, engine/fxRack.ts) : une façade cuivre avec la division
 * (parallèle, bandes, centre / côtés), une colonne par branche (ses effets, coupure, solo, niveau)
 * et le mélange sec / humide. Un effet d'une branche s'ouvre dans la même fenêtre, sous la façade.
 * Aide : infobulles + ligne d'info (jamais de phrase sur la façade).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Faceplate, HwSection, HwWindow, Knob, Led, PushButton } from './hw';
import { fmtHzFr } from './hw/screens';
import { PLUGIN_REGISTRY } from '../engine/pluginRegistry';
import { defaultBuiltinParams } from '../utils/sessionTemplate';
import {
  branchLabel, newRackId, rackBranch, sanitizeRack, withChildParams, withMode, HALF_DB, LEVEL_OFF_DB, RACK_BUILTIN_FX, RACK_EXCLUDED,
  RACK_MAX_BRANCHES, RACK_MIN_BRANCHES, type RackMode, type RackParams,
} from '../engine/fxRack';
import { RackChildUI } from './rackChildUi';
import type { PluginInstance, PluginType } from '../types';

interface Props { node: any; initialParams: Record<string, any>; onParamsChange: (p: Record<string, any>) => void; trackId?: string }

const ACCENT = '#fb923c';
const BRANCH_COLORS = ['#fb923c', '#22d3ee', '#a3e635', '#f472b6'];
const fr = (v: number, d = 1) => (Number.isFinite(v) ? v : 0).toFixed(d).replace('.', ',');
const levelText = (db: number) => (db <= LEVEL_OFF_DB + 0.05 ? 'Coupé' : `${db > 0.05 ? '+' : db < -0.05 ? '−' : ''}${fr(Math.abs(db))} dB`);
const MODES: { id: RackMode; label: string; hint: string }[] = [
  { id: 'parallele', label: 'Parallèle', hint: 'Chaque branche reçoit tout le son ; les branches jouent ensemble (compression parallèle, réverbe à part).' },
  { id: 'bandes', label: 'Bandes', hint: 'Le son est coupé en 2 ou 3 bandes de fréquence (grave, médium, aigu) : un traitement par bande. Sans effet, la somme rend le son d’origine.' },
  { id: 'ms', label: 'Centre / côtés', hint: 'Branche 1 = le centre (voix, kick, basse), branche 2 = les côtés (largeur, ambiance), recombinés ensuite.' },
];

/** Effets qu'une branche peut accueillir : effets NOVA intégrés + effets du registre (sauf exclus). */
function rackFxChoices() {
  const reg = PLUGIN_REGISTRY.filter(p => !RACK_EXCLUDED.has(p.type)).map(p => ({ type: p.type, name: p.name }));
  return [...RACK_BUILTIN_FX, ...reg];
}

function newChild(type: string, name: string): PluginInstance {
  const reg = PLUGIN_REGISTRY.find(p => p.type === type);
  const params = reg ? reg.defaultParams() : defaultBuiltinParams(type as PluginType);
  return { id: newRackId('fx'), name, type: type as PluginType, isEnabled: true, params: { ...params, isEnabled: true }, latency: 0 };
}

export const NovaFxRackUI: React.FC<Props> = ({ node, initialParams, onParamsChange, trackId }) => {
  const [params, setParams] = useState<RackParams>(() => sanitizeRack(initialParams));
  const ref = useRef(params);
  const [open, setOpen] = useState<{ branchId: string; pluginId: string } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [lat, setLat] = useState(0);

  const commit = useCallback((next: RackParams) => {
    const clean = sanitizeRack(next);
    ref.current = clean;
    setParams(clean);
    try { node?.updateParams?.(clean); } catch { /* nœud libéré */ }
    onParamsChange(clean as any);
  }, [node, onParamsChange]);

  // Latence du rack (réalignement des branches), relue après chaque changement.
  useEffect(() => { const t = setTimeout(() => setLat(Math.round(((node?.latency as number) || 0) * 10000) / 10), 60); return () => clearTimeout(t); }, [params, node]);
  useEffect(() => { if (!menuFor) return; const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuFor(null); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [menuFor]);

  const setBranch = (id: string, patch: Partial<RackParams['branches'][number]>) =>
    commit({ ...ref.current, branches: ref.current.branches.map(b => (b.id === id ? { ...b, ...patch } : b)) });
  const p = params;
  const n = p.branches.length;
  const openChild = open ? p.branches.find(b => b.id === open.branchId)?.plugins.find(x => x.id === open.pluginId) : undefined;
  const openBranchIdx = open ? p.branches.findIndex(b => b.id === open.branchId) : -1;

  return (
    <HwWindow type="FXRACK" width={940} accent={ACCENT} accentInk="#1c0f06" latencyMs={lat}
      idleHelp={<>Rack parallèle : le son se divise en branches qui jouent en même temps, chacune avec ses effets, puis elles sont mélangées au son d’origine. <span style={{ color: '#7d8696' }}>Survole un réglage : son rôle s’affiche ici.</span></>}>
      <Faceplate finish="copper" model="Rack parallèle" kicker="Branches · mélange" modelStyle="wide">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <HwSection title="Division" className="flex-[2_1_360px] min-w-0">
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Division du son" data-nova-param="mode">
              {MODES.map(m => (
                <PushButton key={m.id} role="radio" active={p.mode === m.id} dark led={ACCENT} className="hw-push-sm" text={m.label} ariaLabel={m.label}
                  hint={m.hint} valueText={p.mode === m.id ? 'choisie' : undefined} dataAttrs={{ 'data-nova-rack-mode': m.id }}
                  onClick={() => { setOpen(null); commit(withMode(ref.current, m.id)); }} />
              ))}
            </div>
            {p.mode === 'bandes' && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Nombre de bandes" data-nova-param="bandCount">
                  {[2, 3].map(k => (
                    <PushButton key={k} role="radio" active={p.bandCount === k} dark led={ACCENT} className="hw-push-sm" text={`${k} bandes`} ariaLabel={`${k} bandes`}
                      hint={k === 2 ? 'Grave et aigu, coupés à la fréquence 1.' : 'Grave, médium et aigu, coupés aux fréquences 1 et 2.'}
                      onClick={() => { setOpen(null); commit(withMode(ref.current, 'bandes', k)); }} />
                  ))}
                </div>
                <Knob paramId="x1" label="Coupure 1" size="S" cap="black" arc={ACCENT} min={40} max={16000} curve="log" value={p.x1} defaultValue={200}
                  onChange={v => commit({ ...ref.current, x1: v })} format={fmtHzFr} hint="Fréquence qui sépare le grave du reste (filtres 24 dB/octave, somme plate)." />
                {p.bandCount >= 3 && (
                  <Knob paramId="x2" label="Coupure 2" size="S" cap="black" arc={ACCENT} min={60} max={18000} curve="log" value={p.x2} defaultValue={3000}
                    onChange={v => commit({ ...ref.current, x2: v })} format={fmtHzFr} hint="Fréquence qui sépare le médium de l’aigu." />
                )}
              </div>
            )}
          </HwSection>
          <HwSection title="Mélange" className="flex-[1_1_220px] min-w-0">
            <div className="flex justify-center gap-4">
              <Knob paramId="mix" label="Sec / humide" ariaLabel="Mélange sec / humide" size="M" cap="black" arc={ACCENT} min={0} max={100} step={1} value={p.mix} defaultValue={100}
                onChange={v => commit({ ...ref.current, mix: v })} format={v => `${Math.round(v)} %`} scale={[{ v: 0, label: 'Sec' }, { v: 100, label: '100' }]}
                hint="0 % : le son d’origine seul ; 100 % : les branches seules (le son d’origine est dans une branche vide)." />
              <Knob paramId="outGain" label="Sortie" ariaLabel="Volume de sortie" size="M" cap="black" arc={ACCENT} bipolar min={-24} max={12} step={0.1} value={p.outGain} defaultValue={0}
                onChange={v => commit({ ...ref.current, outGain: v })} format={v => levelText(v)} scale={[{ v: -24, label: '−24' }, { v: 0, label: '0' }, { v: 12, label: '+12' }]}
                hint="Volume après le rack, pour comparer à volume égal." />
            </div>
          </HwSection>
        </div>

        <div className="hw-rule" style={{ margin: '12px 0 10px' }} />
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="hw-silk" style={{ textAlign: 'left' }}>Branches</span>
          {p.mode === 'parallele' && (
            <button type="button" className="hw-rack-add px-3" data-nova-rack-add-branch disabled={n >= RACK_MAX_BRANCHES}
              title={n >= RACK_MAX_BRANCHES ? '4 branches au plus' : 'Ajouter une branche (vide, au niveau −6 dB)'}
              onClick={() => commit({ ...ref.current, branches: [...ref.current.branches, rackBranch(HALF_DB)] })}>
              <i className="fas fa-plus mr-1.5" aria-hidden="true" />Branche
            </button>
          )}
        </div>
        <div className="hw-rack-branches" style={{ ['--rack-n' as any]: n }} data-nova-rack-branches>
          {p.branches.map((b, i) => {
            const col = BRANCH_COLORS[i % BRANCH_COLORS.length];
            const label = branchLabel(p, i, b);
            const anySolo = p.branches.some(x => x.solo);
            const off = !!b.mute || (anySolo && !b.solo) || b.level <= LEVEL_OFF_DB + 0.05;
            return (
              <div key={b.id} className="hw-rack-branch" style={{ ['--rack-c' as any]: col }} data-off={off ? 'true' : undefined} data-nova-rack-branch={i + 1}>
                <div className="flex items-center gap-1.5">
                  <Led on={!off} color={col} />
                  <span className="hw-silk flex-1 min-w-0 truncate" data-nova-rack-label style={{ textAlign: 'left', textTransform: 'none', letterSpacing: '0.02em', fontSize: 12 }}>{label}</span>
                  <PushButton active={!!b.mute} onClick={() => setBranch(b.id, { mute: !b.mute })} text="Muet" led={false} dark className="hw-push-sm"
                    ariaLabel={`Couper ${label}`} hint="Coupe cette branche." dataAttrs={{ 'data-nova-rack-mute': String(i + 1) }} />
                  <PushButton active={!!b.solo} onClick={() => setBranch(b.id, { solo: !b.solo })} text="Solo" led={false} dark className="hw-push-sm"
                    ariaLabel={`Solo ${label}`} hint="N’écouter que cette branche (avec les autres branches en solo)." dataAttrs={{ 'data-nova-rack-solo': String(i + 1) }} />
                </div>
                {b.plugins.length === 0 && <p className="hw-rack-empty">Branche vide : le son passe tel quel.</p>}
                {b.plugins.map(x => {
                  const sel = open?.pluginId === x.id;
                  return (
                    <div key={x.id} className="hw-rack-fx" data-sel={sel ? 'true' : undefined} data-bypass={x.isEnabled === false ? 'true' : undefined} data-nova-rack-fx={x.type}>
                      <button type="button" className="hw-rack-fx-name" onClick={() => setOpen(sel ? null : { branchId: b.id, pluginId: x.id })}
                        aria-label={`Ouvrir ${x.name} (${label})`} aria-expanded={sel}>{x.name}</button>
                      <button type="button" aria-label={x.isEnabled === false ? `Réactiver ${x.name}` : `Contourner ${x.name}`} title={x.isEnabled === false ? 'Réactiver' : 'Contourner (bypass)'}
                        aria-pressed={x.isEnabled !== false}
                        onClick={() => setBranch(b.id, { plugins: b.plugins.map(y => (y.id === x.id ? { ...y, isEnabled: y.isEnabled === false } : y)) })}>
                        <i className="fas fa-power-off" style={{ color: x.isEnabled === false ? undefined : col }} aria-hidden="true" />
                      </button>
                      <button type="button" aria-label={`Retirer ${x.name}`} title="Retirer l’effet"
                        onClick={() => { if (sel) setOpen(null); setBranch(b.id, { plugins: b.plugins.filter(y => y.id !== x.id) }); }}>
                        <i className="fas fa-times" aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
                <button type="button" className="hw-rack-add" data-nova-rack-add-fx={i + 1} aria-expanded={menuFor === b.id}
                  onClick={() => setMenuFor(menuFor === b.id ? null : b.id)}>
                  <i className="fas fa-plus mr-1.5" aria-hidden="true" />Effet
                </button>
                {menuFor === b.id && (
                  <div className="hw-rack-menu" role="menu" aria-label={`Effets à ajouter dans ${label}`}>
                    {rackFxChoices().map(c => (
                      <button key={c.type} type="button" role="menuitem" data-fx-id={c.type}
                        onClick={() => {
                          const child = newChild(c.type, c.name);
                          setMenuFor(null);
                          setBranch(b.id, { plugins: [...b.plugins, child] });
                          setOpen({ branchId: b.id, pluginId: child.id });
                        }}>{c.name}</button>
                    ))}
                  </div>
                )}
                <div className="flex items-end justify-center gap-2 mt-auto pt-1">
                  <Knob paramId={`br${i + 1}Level`} label="Niveau" ariaLabel={`Niveau de ${label}`} size="S" cap="black" arc={col} min={LEVEL_OFF_DB} max={12} step={0.1}
                    value={b.level} defaultValue={p.mode === 'parallele' ? HALF_DB : 0} onChange={v => setBranch(b.id, { level: v })} format={levelText}
                    hint={p.mode === 'parallele' ? 'Niveau de la branche. Deux branches vides à −6 dB rendent le son d’origine.' : 'Niveau de la bande / du canal. À 0 dB, la somme rend le son d’origine.'} />
                  {p.mode === 'parallele' && n > RACK_MIN_BRANCHES && (
                    <button type="button" className="hw-rack-add px-2" aria-label={`Supprimer ${label}`} title="Supprimer la branche"
                      onClick={() => { if (open?.branchId === b.id) setOpen(null); commit({ ...ref.current, branches: ref.current.branches.filter(y => y.id !== b.id) }); }}>
                      <i className="fas fa-trash-alt" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Faceplate>
      {open && openChild && (
        <div className="hw-rack-child" data-nova-rack-child={openChild.type}>
          <div className="flex items-center justify-between gap-2 mb-2 px-1">
            <span style={{ color: '#fbeee3', font: '700 12px Inter, system-ui, sans-serif' }}>
              {openChild.name} <span style={{ color: '#d9bfa9', fontWeight: 600 }}>· {branchLabel(p, openBranchIdx, p.branches[openBranchIdx])}</span>
            </span>
            <button type="button" className="hw-rack-add px-3" onClick={() => setOpen(null)} aria-label="Fermer l’effet de la branche">Fermer</button>
          </div>
          <RackChildUI key={openChild.id} type={openChild.type} node={node?.childNode?.(openChild.id)} initialParams={openChild.params} trackId={trackId}
            onParamsChange={(cp: Record<string, any>) => commit(withChildParams(ref.current, open.branchId, open.pluginId, cp))} />
        </div>
      )}
    </HwWindow>
  );
};
