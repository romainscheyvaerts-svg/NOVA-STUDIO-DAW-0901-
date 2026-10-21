import React, { useEffect, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import { DEFAULT_TALKBACK, talkbackSettingsStore, useTalkbackSettings } from '../utils/talkback';
import { shortcutHint } from '../utils/keymap';
import { useKeymap } from '../utils/keymapStore';

/**
 * Réglages du talkback LOCAL (au studio, hors collaboration) : micro du talkback (ex. le
 * micro de l'ordinateur), baisse de la musique pendant qu'on parle (dim), niveau de la voix,
 * et où part la voix (mixes casque, ou sortie d'écoute). En collaboration, le talkback passe
 * par le direct (micro du navigateur) : ces réglages ne s'y appliquent pas.
 */
const TalkbackSettings: React.FC = () => {
  const s = useTalkbackSettings();
  useKeymap(); // raccourci affiché à jour après un remappage
  const key = shortcutHint('nova.talkback');
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [route, setRoute] = useState<'cue' | 'main'>(() => audioEngine.getTalkbackRoute());
  useEffect(() => {
    let alive = true;
    const list = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        const ins = all.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
        if (alive) setMics(ins.map((d, i) => ({ id: d.deviceId, label: d.label || `Micro n° ${i + 1}` })));
      } catch { /* liste indisponible : micro par défaut seulement */ }
    };
    void list();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', list);
    const id = window.setInterval(() => setRoute(audioEngine.getTalkbackRoute()), 1500);
    return () => { alive = false; md?.removeEventListener?.('devicechange', list); window.clearInterval(id); };
  }, []);
  const missing = !!s.deviceId && mics.length > 0 && !mics.some(m => m.id === s.deviceId);
  return (
    <div id="nova-talkback-reglages" className="rounded-2xl border border-red-500/25 bg-red-500/[0.04] p-4 space-y-3" data-testid="talkback-settings">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-black text-red-300 uppercase tracking-widest"><i className="fas fa-comment-dots mr-1.5" aria-hidden="true" />Talkback</span>
        <span className="text-[11px] text-slate-300">Bouton « Talk » de la barre{key ? ` · touche ${key}` : ''}</span>
      </div>
      <p className="text-[11px] text-slate-400 leading-snug">
        Au studio : ta voix part dans le casque de l’artiste, jamais dans le mix, l’export ni les prises (coupée pendant une prise).
        Appui court = reste ouvert (2e appui coupe) ; maintenu = tu parles tant que tu tiens.
      </p>
      <label className="block space-y-1">
        <span className="text-[11px] font-bold text-white">Micro du talkback</span>
        <select data-testid="talkback-device" value={missing ? '' : s.deviceId} onChange={e => talkbackSettingsStore.set({ deviceId: e.target.value })}
          className="w-full h-10 rounded-xl border border-white/10 bg-black/40 px-3 text-[12px] text-white">
          <option value="">Micro par défaut de l’ordinateur</option>
          {mics.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {missing && <span className="block text-[11px] text-amber-200" role="status">Le micro choisi n’est plus branché : le micro par défaut sera pris.</span>}
        {!mics.length && <span className="block text-[10px] text-slate-500">Les noms des micros s’affichent après le premier appui sur Talk (autorisation du micro).</span>}
      </label>
      <label className="block">
        <span className="flex justify-between text-[11px] text-slate-300">
          <span>Baisse de la musique pendant que tu parles</span>
          <button type="button" className="font-mono text-white" title="Remettre la valeur conseillée" onClick={() => talkbackSettingsStore.set({ dimDb: DEFAULT_TALKBACK.dimDb })}>
            {s.dimDb === 0 ? 'aucune' : `${s.dimDb} dB`}
          </button>
        </span>
        <input type="range" min={-40} max={0} step={1} value={s.dimDb} data-testid="talkback-dim"
          onChange={e => talkbackSettingsStore.set({ dimDb: parseInt(e.target.value, 10) })}
          className="w-full accent-red-400" aria-label="Baisse de la musique pendant le talkback (dB)" />
      </label>
      <label className="block">
        <span className="flex justify-between text-[11px] text-slate-300">
          <span>Volume de ta voix dans le casque</span>
          <button type="button" className="font-mono text-white" title="Remettre à 0 dB" onClick={() => talkbackSettingsStore.set({ levelDb: 0 })}>
            {s.levelDb > 0 ? '+' : ''}{s.levelDb} dB
          </button>
        </span>
        <input type="range" min={-24} max={12} step={1} value={s.levelDb} data-testid="talkback-level"
          onChange={e => talkbackSettingsStore.set({ levelDb: parseInt(e.target.value, 10) })}
          className="w-full accent-red-400" aria-label="Volume de la voix du talkback (dB)" />
      </label>
      <p className="text-[11px] leading-snug" role="status" data-testid="talkback-route">
        {route === 'cue'
          ? <span className="text-emerald-300">Ta voix part dans les mixes casque (sorties de la carte, ou l’écoute d’un mix). La régie ne t’entend pas : pas de larsen.</span>
          : <span className="text-amber-200">Pas de mix casque : ta voix part sur la sortie d’écoute. Écoute au casque, pas sur les enceintes (sinon larsen). Pour la carte son à plusieurs sorties : Mixes casque.</span>}
      </p>
      {route === 'main' && (
        <button type="button" onClick={() => window.dispatchEvent(new Event('nova:open-cue-mixes'))}
          className="w-full h-10 rounded-xl border border-white/15 text-[12px] font-bold text-white hover:bg-white/5"><i className="fas fa-headphones mr-1.5" aria-hidden="true" />Mixes casque (un mix par musicien)…</button>
      )}
    </div>
  );
};

export default TalkbackSettings;
