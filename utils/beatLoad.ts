/**
 * Chargement du beat sous surveillance (audit B6).
 *
 * Avant : un réseau coupé en plein téléchargement laissait « Chargement :
 * NOCTAMBULE… » à l'écran indéfiniment, et REC enregistrait sur du silence.
 * Ici :
 * - au bout de 15 s, l'état passe à « slow » : l'interface propose
 *   « Réessayer » ou « Choisir un autre beat » ;
 * - une erreur réseau passe à « failed » (mêmes choix) au lieu d'abandonner ;
 * - « Réessayer » coupe le téléchargement en cours et en relance un neuf ;
 *   la promesse de l'appelant reste la même et se résout au premier succès ;
 * - « Choisir un autre beat » (ou un nouveau beat chargé par-dessus) annule
 *   avec BeatLoadCancelled ;
 * - isBeatLoading() sert à bloquer REC tant que le beat n'est pas là.
 */
export type BeatLoadPhase = 'idle' | 'loading' | 'slow' | 'failed';
export interface BeatLoadStatus { phase: BeatLoadPhase; title: string; error?: string; attempt: number }

export class BeatLoadCancelled extends Error {
  constructor(public reason: 'user' | 'replaced') { super('Chargement du beat annulé'); this.name = 'BeatLoadCancelled'; }
}

export const BEAT_SLOW_MS = 15000;

let status: BeatLoadStatus = { phase: 'idle', title: '', attempt: 0 };
const listeners = new Set<() => void>();
let current: { retry: () => void; cancel: (reason: 'user' | 'replaced') => void } | null = null;

const set = (s: BeatLoadStatus) => { status = s; listeners.forEach(l => l()); };

export const beatLoadStore = {
  get: () => status,
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
};

export const isBeatLoading = () => status.phase !== 'idle';
let lastCancel: 'user' | 'replaced' | null = null;
/** Vrai si le dernier chargement a été abandonné par l'artiste (« Choisir un autre beat »). */
export const beatLoadCancelledByUser = () => lastCancel === 'user';
export const retryBeatLoad = () => current?.retry();
export const cancelBeatLoad = () => current?.cancel('user');

type Fetcher = (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;

export function loadBeatAudio(url: string, title: string, fetcher: Fetcher, slowMs = BEAT_SLOW_MS): Promise<ArrayBuffer> {
  // Un nouveau beat remplace celui qui n'arrivait pas.
  current?.cancel('replaced');
  lastCancel = null;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    let attempt = 0;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; };
    const finish = () => { settled = true; clear(); if (current === handle) current = null; };

    const start = () => {
      if (settled) return;
      ctrl?.abort();
      clear();
      const mine = ++attempt;
      const c = new AbortController();
      ctrl = c;
      set({ phase: 'loading', title, attempt: mine });
      timer = setTimeout(() => {
        if (!settled && mine === attempt) set({ phase: 'slow', title, attempt: mine });
      }, slowMs);
      fetcher(url, c.signal).then(
        buf => {
          if (settled || mine !== attempt) return;
          finish();
          set({ phase: 'idle', title: '', attempt: 0 });
          resolve(buf);
        },
        err => {
          if (settled || mine !== attempt) return; // coupé par « Réessayer »
          clear();
          set({ phase: 'failed', title, attempt: mine, error: err?.message || String(err) });
        },
      );
    };

    const handle = {
      retry: start,
      cancel: (reason: 'user' | 'replaced') => {
        if (settled) return;
        ctrl?.abort();
        finish();
        lastCancel = reason;
        if (reason === 'user') set({ phase: 'idle', title: '', attempt: 0 });
        reject(new BeatLoadCancelled(reason));
      },
    };
    current = handle;
    start();
  });
}

/** Pour les tests : remet l'état à zéro. */
export function __resetBeatLoad() { current = null; lastCancel = null; status = { phase: 'idle', title: '', attempt: 0 }; }
