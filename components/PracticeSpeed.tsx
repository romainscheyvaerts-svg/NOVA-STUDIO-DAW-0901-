/**
 * R13 · Bouton « Vitesse » de la barre de transport : lecture ralentie de 50 à
 * 100 % sans changer la hauteur (Pro Tools : Half-Speed, Maj+Espace · Logic :
 * Varispeed « vitesse seulement » · Live : tempo baissé avec Warp · FL : tempo
 * baissé). Réglage d'écoute : l'export n'est jamais ralenti.
 *
 * Compact (téléphone) : un appui passe au préréglage suivant (100 → 85 → 75 →
 * 60 → 50 → 100).
 */
import React, { useEffect, useRef, useState } from 'react';
import { nextPreset, PRACTICE_PRESETS, practiceLabel, practiceSpeedStore, usePracticeSpeed } from '../utils/practiceSpeed';

const TITLE = 'Lecture ralentie : écoute de 50 à 100 % sans changer la hauteur, pour travailler un passage rapide ou apprendre un texte (Pro Tools : Half-Speed, Maj+Espace · Logic : Varispeed « vitesse seulement » · Live : tempo baissé avec Warp · FL : tempo baissé). L’export n’est jamais ralenti. Maj+Espace : lecture à 50 %.';

const PracticeSpeed: React.FC<{ compact?: boolean; className?: string }> = ({ compact = false, className = '' }) => {
  const speed = usePracticeSpeed();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const slow = speed < 0.999;

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [open]);

  const chip = `h-8 min-w-[52px] px-2 rounded-lg border text-[11px] font-black tabular-nums transition-colors ${slow ? 'border-amber-400/60 bg-amber-400/15 text-amber-500' : 'border-white/10 text-slate-500 hover:text-white'}`;

  if (compact) {
    return (
      <button type="button" data-testid="practice-speed" aria-label={`Vitesse de lecture : ${practiceLabel(speed)}`} title={TITLE}
        onClick={() => practiceSpeedStore.set(nextPreset(speed))} className={`${chip} min-h-[44px] ${className}`}>
        <i className="fas fa-gauge-simple-high mr-1" aria-hidden="true" />{practiceLabel(speed)}
      </button>
    );
  }

  return (
    <div ref={box} className={`relative ${className}`}>
      <button type="button" data-testid="practice-speed" aria-haspopup="dialog" aria-expanded={open} aria-label={`Vitesse de lecture : ${practiceLabel(speed)}`}
        title={TITLE} onClick={() => setOpen(v => !v)} className={chip}>
        {slow ? practiceLabel(speed) : <><i className="fas fa-gauge-simple-high mr-1" aria-hidden="true" />100 %</>}
      </button>
      {open && (
        <div role="dialog" aria-label="Vitesse de lecture" data-testid="practice-speed-panel"
          className="absolute left-1/2 top-full z-[400] mt-2 w-64 -translate-x-1/2 space-y-2 rounded-xl border border-nv-line bg-nv-panel p-3 text-nv-ink shadow-2xl">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] font-black">Lecture ralentie</span>
            <span className="text-[16px] font-black tabular-nums" data-testid="practice-speed-value">{practiceLabel(speed)}</span>
          </div>
          <input type="range" min={50} max={100} step={1} value={Math.round(speed * 100)} aria-label="Vitesse (%)" data-testid="practice-speed-slider"
            onChange={e => practiceSpeedStore.set(Number(e.target.value) / 100)} className="w-full accent-amber-500" />
          <div className="flex gap-1">
            {PRACTICE_PRESETS.map(p => (
              <button key={p} type="button" onClick={() => practiceSpeedStore.set(p)} aria-pressed={Math.abs(p - speed) < 1e-6} data-testid={`practice-preset-${Math.round(p * 100)}`}
                className={`flex-1 min-h-[32px] [@media(pointer:coarse)]:min-h-[44px] rounded-lg text-[11px] font-bold ${Math.abs(p - speed) < 1e-6 ? 'bg-amber-500 text-black' : 'border border-nv-line hover:bg-nv-accent/10'}`}>{Math.round(p * 100)}</button>
            ))}
          </div>
          <p className="text-[10px] leading-snug text-nv-muted">La hauteur ne change pas. NOVA prépare le passage quelques instants avant de le jouer ; la prise et l’export restent à 100 %.</p>
        </div>
      )}
    </div>
  );
};

export default PracticeSpeed;
