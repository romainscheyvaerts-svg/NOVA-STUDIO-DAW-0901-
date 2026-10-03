import React from 'react';
import { Bass808Settings } from '../utils/bass808';

/** Réglages de la piste 808 dans la barre du piano roll : son et glissé. */
const Bass808Controls: React.FC<{ value: Bass808Settings; onChange: (v: Bass808Settings) => void }> = ({ value, onChange }) => (
  <div className="flex items-center gap-1.5 shrink-0" role="group" aria-label="Réglages de la 808">
    <span className="text-[11px] font-black text-fuchsia-200 mr-0.5">🔊 808</span>
    <div className="flex rounded-lg overflow-hidden border border-white/10">
      {([['808', 'Propre'], ['808-dist', 'Saturée']] as const).map(([id, label]) => (
        <button key={id} type="button" onClick={() => onChange({ ...value, style: id })} aria-pressed={value.style === id}
          className={`nova-hit h-8 px-2.5 text-[11px] font-bold ${value.style === id ? 'bg-fuchsia-500 text-white' : 'bg-white/5 text-slate-300 hover:text-white'}`}>{label}</button>
      ))}
    </div>
    <button type="button" onClick={() => onChange({ ...value, glide: !value.glide })} aria-pressed={value.glide}
      title="Glissé : deux notes qui se chevauchent glissent de l'une à l'autre (slide 808)"
      className={`nova-hit h-8 px-2.5 rounded-lg text-[11px] font-bold border ${value.glide ? 'bg-fuchsia-500/25 border-fuchsia-400/60 text-white' : 'bg-white/5 border-white/10 text-slate-300'}`}>
      <i className="fas fa-wave-square mr-1" />Glissé {value.glide ? 'oui' : 'non'}
    </button>
  </div>
);

export default Bass808Controls;
