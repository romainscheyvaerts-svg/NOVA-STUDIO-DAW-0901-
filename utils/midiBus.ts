/**
 * Bus des commandes MIDI (V25) : menus, glisser-déposer et piano roll envoient
 * une demande, components/MidiHost l'exécute (une seule écriture du projet).
 * Ainsi les fichiers partagés (ArrangementView, TransportBar, PianoRoll…) ne
 * gagnent qu'une ligne chacun.
 */
export type MidiBusEvent =
  /** Un .mid lâché sur l'arrangement (piste visée et instant du dépôt) ou choisi dans le menu. */
  | { type: 'import-file'; file: File; trackId?: string | null; time?: number }
  /** Ouvre le choix d'un fichier .mid. */
  | { type: 'import-pick'; trackId?: string | null; time?: number }
  /** Export .mid : un clip, une piste, ou toutes les pistes MIDI. */
  | { type: 'export'; scope: 'clip' | 'track' | 'all'; trackId?: string; clipId?: string }
  /** Fenêtre « Groove et swing » d'un clip (MIDI : appliquer ; audio : extraire). */
  | { type: 'groove'; trackId?: string; clipId?: string }
  /** Capture MIDI : crée un clip avec ce qui vient d'être joué. */
  | { type: 'capture'; trackId?: string | null };

const EVENT = 'nova:midi';

export const midiBus = {
  emit(e: MidiBusEvent) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<MidiBusEvent>(EVENT, { detail: e }));
  },
  on(fn: (e: MidiBusEvent) => void): () => void {
    const h = (ev: Event) => fn((ev as CustomEvent<MidiBusEvent>).detail);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  },
};

/** Fichier MIDI d'après le nom ou le type (Windows ne donne pas toujours le type). */
export const isMidiFile = (f: { name: string; type?: string }): boolean =>
  /\.(mid|midi|smf|kar)$/i.test(f.name) || /audio\/(x-)?midi/i.test(f.type || '');
