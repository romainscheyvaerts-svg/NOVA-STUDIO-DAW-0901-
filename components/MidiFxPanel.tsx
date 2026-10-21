import React, { useEffect } from 'react';
import type { Track } from '../types';
import { ARP_RATES, FX_LABEL, defaultSlot, type MidiFxSlot, type MidiFxType, type ChordShape } from '../engine/midiFx';
import { ARP_PATTERNS } from '../utils/midiTools';
import { SCALE_CHOICES, NOTE_NAMES_FR } from '../utils/scales';

interface Props {
  track: Track;
  /** Tonalité du projet (affichée quand la gamme suit le projet). */
  projectKey?: number;
  projectScale?: string;
  onChange: (slots: MidiFxSlot[]) => void;
  onFreeze: () => void;
  onClose: () => void;
}

/** Ordre de la chaîne : la gamme corrige, l'accord empile, l'arpège égrène. */
const ORDER: MidiFxType[] = ['scale', 'chord', 'arp'];
const ICON: Record<MidiFxType, string> = { scale: 'fa-music', chord: 'fa-layer-group', arp: 'fa-signal' };
const HINT: Record<MidiFxType, string> = {
  scale: 'Chaque note tombe sur la note de la gamme la plus proche : plus de fausse note.',
  chord: 'Chaque note devient un accord (une touche = un accord).',
  arp: 'Les notes tenues ensemble sont jouées l’une après l’autre, calées sur le tempo.',
};
const CHORDS: { id: ChordShape; label: string }[] = [
  { id: 'DIATONIC', label: 'Dans la gamme du projet' }, { id: 'MAJOR', label: 'Majeur' }, { id: 'MINOR', label: 'Mineur' },
  { id: 'SUS2', label: 'Sus2' }, { id: 'SUS4', label: 'Sus4' }, { id: 'MAJ7', label: 'Majeur 7' }, { id: 'MIN7', label: 'Mineur 7' },
  { id: 'DOM7', label: 'Septième' }, { id: 'ADD9', label: 'Add9' }, { id: 'MIN9', label: 'Mineur 9' }, { id: 'POWER', label: 'Quinte' },
];
const RATE_LABEL: Record<string, string> = { '1/4': 'Noire', '1/8': 'Croche', '1/8T': 'Croche triolet', '1/16': 'Double', '1/16T': 'Double triolet', '1/32': 'Triple' };

/**
 * L3 · Effets MIDI de la piste (engine/midiFx) : arpège, accord, gamme forcée.
 * Réglables pendant la lecture (le moteur relit la chaîne à chaque pas) ;
 * « Figer en notes » écrit les notes entendues dans les clips.
 */
const MidiFxPanel: React.FC<Props> = ({ track, projectKey, projectScale, onChange, onFreeze, onClose }) => {
  const slots = track.midiFx || [];
  const active = slots.some(s => s.on);
  const keyLabel = typeof projectKey === 'number'
    ? `${NOTE_NAMES_FR[((projectKey % 12) + 12) % 12]} ${SCALE_CHOICES.find(c => c.id === (projectScale || '').toUpperCase())?.label || (projectScale || '').toLowerCase()}`
    : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const set = (id: string, patch: Partial<MidiFxSlot>) => onChange(slots.map(s => (s.id === id ? { ...s, ...patch } : s)));
  const add = (type: MidiFxType) => onChange([...slots, defaultSlot(type)].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)));
  const remove = (id: string) => onChange(slots.filter(s => s.id !== id));
  const chip = (on: boolean) => `nova-hit min-h-9 px-2.5 rounded-lg border text-[12px] font-bold ${on ? 'bg-cyan-500 text-black border-cyan-400' : 'border-nv-line/15 text-nv-ink hover:bg-nv-raised'}`;
  const field = 'min-h-9 bg-nv-well/40 border border-nv-line/15 rounded-lg px-2 text-[12px] text-nv-ink font-bold outline-none focus:border-nv-accent';
  const lbl = 'text-[11px] font-bold text-nv-muted block mb-1';

  return (
    <div className="fixed inset-0 z-[1250] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="mfx-title" data-testid="midi-fx-panel" onMouseDown={e => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line/15 bg-nv-surface text-nv-ink shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-nv-line/15">
          <div className="min-w-0">
            <h2 id="mfx-title" className="text-[14px] font-black uppercase tracking-widest truncate">Effets MIDI · {track.name}</h2>
            <p className="text-[12px] text-nv-muted">Joués avant l’instrument : en lecture, à l’export et au clavier. Les notes du clip ne changent pas.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="nova-hit w-9 h-9 rounded-full text-nv-muted hover:text-nv-ink flex items-center justify-center shrink-0"><i className="fas fa-times" aria-hidden="true"></i></button>
        </div>

        <div className="p-5 space-y-4">
          {!slots.length && (
            <p className="text-[12px] text-nv-muted rounded-xl border border-dashed border-nv-line/20 p-3" data-testid="mfx-empty">
              Aucun effet sur cette piste. Ajoute un <b>arpège</b> pour égrener un accord tenu, un <b>accord</b> pour jouer un accord d’une seule touche, ou la <b>gamme forcée</b> pour ne plus jouer de fausse note.
            </p>
          )}

          {slots.map(s => (
            <section key={s.id} data-testid={`mfx-slot-${s.type}`} className={`rounded-2xl border p-3 space-y-3 ${s.on ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-nv-line/15 opacity-80'}`}>
              <div className="flex items-center gap-2">
                <i className={`fas ${ICON[s.type]} text-nv-accent w-4`} aria-hidden="true"></i>
                <span className="font-black text-[13px] flex-1">{FX_LABEL[s.type]}</span>
                <label className="flex items-center gap-1.5 text-[12px] font-bold cursor-pointer">
                  <input type="checkbox" className="w-5 h-5" checked={s.on} onChange={e => set(s.id, { on: e.target.checked })} data-testid={`mfx-on-${s.type}`} />
                  {s.on ? 'Actif' : 'Coupé'}
                </label>
                <button type="button" onClick={() => remove(s.id)} aria-label={`Retirer ${FX_LABEL[s.type]}`} title="Retirer" className="nova-hit w-9 h-9 rounded-lg text-red-400 hover:bg-nv-raised"><i className="fas fa-trash" aria-hidden="true"></i></button>
              </div>
              <p className="text-[11px] text-nv-muted -mt-1">{HINT[s.type]}</p>

              {s.type === 'arp' && s.arp && (() => { const a = s.arp; const upd = (p: Partial<typeof a>) => set(s.id, { arp: { ...a, ...p } }); return (
                <div className="space-y-3">
                  <div><span className={lbl}>Vitesse</span>
                    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Vitesse de l'arpège">
                      {ARP_RATES.map(r => <button key={r} type="button" role="radio" aria-checked={a.rate === r} data-testid={`mfx-rate-${r.replace('/', '-')}`} onClick={() => upd({ rate: r })} className={chip(a.rate === r)}>{RATE_LABEL[r] || r}</button>)}
                    </div></div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block"><span className={lbl}>Motif</span>
                      <select value={a.pattern} onChange={e => upd({ pattern: e.target.value as typeof a.pattern })} className={`${field} w-full`} data-testid="mfx-pattern">
                        {ARP_PATTERNS.filter(p => p.id !== 'RANDOM').concat(ARP_PATTERNS.filter(p => p.id === 'RANDOM')).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select></label>
                    <div><span className={lbl}>Octaves</span>
                      <div className="flex gap-1.5">{[1, 2, 3, 4].map(o => <button key={o} type="button" aria-pressed={a.octaves === o} onClick={() => upd({ octaves: o })} className={chip(a.octaves === o)}>{o}</button>)}</div></div>
                  </div>
                  <label className="block"><span className={lbl}>Longueur des notes : {Math.round(a.gate)} % du pas</span>
                    <input type="range" min={5} max={100} step={5} value={a.gate} onChange={e => upd({ gate: Number(e.target.value) })} className="w-full" data-testid="mfx-gate" /></label>
                </div>
              ); })()}

              {s.type === 'chord' && (
                <label className="block"><span className={lbl}>Accord</span>
                  <select value={s.chord?.shape || 'DIATONIC'} onChange={e => set(s.id, { chord: { shape: e.target.value as ChordShape } })} className={`${field} w-full`} data-testid="mfx-chord">
                    {CHORDS.map(c => <option key={c.id} value={c.id}>{c.id === 'DIATONIC' && keyLabel ? `${c.label} (${keyLabel})` : c.label}</option>)}
                  </select></label>
              )}

              {s.type === 'scale' && (() => { const g = s.scale || {}; const upd = (p: Partial<typeof g>) => set(s.id, { scale: { ...g, ...p } }); return (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="block"><span className={lbl}>Tonique</span>
                    <select value={g.root ?? ''} onChange={e => { const v = e.target.value; const { root: _r, ...rest } = g; set(s.id, { scale: v === '' ? rest : { ...g, root: Number(v) } }); }} className={`${field} w-full`} data-testid="mfx-root">
                      <option value="">Projet{keyLabel ? ` (${keyLabel.split(' ')[0]})` : ''}</option>
                      {NOTE_NAMES_FR.map((nm, i) => <option key={nm} value={i}>{nm}</option>)}
                    </select></label>
                  <label className="block"><span className={lbl}>Gamme</span>
                    <select value={g.scale ?? ''} onChange={e => { const v = e.target.value; const { scale: _s, ...rest } = g; set(s.id, { scale: v === '' ? rest : { ...g, scale: v } }); }} className={`${field} w-full`} data-testid="mfx-scale">
                      <option value="">Projet</option>
                      {SCALE_CHOICES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select></label>
                  <label className="block"><span className={lbl}>Vers</span>
                    <select value={g.dir || 'nearest'} onChange={e => upd({ dir: e.target.value as 'nearest' | 'up' | 'down' })} className={`${field} w-full`}>
                      <option value="nearest">La plus proche</option><option value="up">Au-dessus</option><option value="down">En dessous</option>
                    </select></label>
                  {!keyLabel && g.root === undefined && <p className="sm:col-span-3 text-[11px] text-amber-300">Le projet n’a pas encore de tonalité : choisis une tonique et une gamme (ou règle la tonalité du projet).</p>}
                </div>
              ); })()}
            </section>
          ))}

          <div className="flex flex-wrap gap-2" aria-label="Ajouter un effet MIDI">
            {ORDER.map(t => {
              const has = slots.some(s => s.type === t);
              return (
                <button key={t} type="button" disabled={has} onClick={() => add(t)} data-testid={`mfx-add-${t}`}
                  title={has ? `${FX_LABEL[t]} déjà sur la piste` : HINT[t]}
                  className="nova-hit min-h-10 px-3 rounded-xl border border-nv-line/15 text-[12px] font-black disabled:opacity-40 hover:bg-nv-raised">
                  <i className="fas fa-plus mr-1.5" aria-hidden="true"></i>{FX_LABEL[t]}
                </button>
              );
            })}
          </div>

          <div className="border-t border-nv-line/15 pt-4 space-y-1.5">
            <button type="button" disabled={!active} onClick={onFreeze} data-testid="mfx-freeze"
              className="w-full min-h-11 rounded-xl bg-cyan-500 text-black text-[13px] font-black disabled:opacity-40">
              Figer en notes
            </button>
            <p className="text-[11px] text-nv-muted">{active ? 'Écrit dans les clips les notes que tu entends, puis coupe les effets (Ctrl+Z pour revenir).' : 'Active un effet pour pouvoir le figer en notes.'}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MidiFxPanel;
