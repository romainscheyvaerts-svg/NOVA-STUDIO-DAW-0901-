/**
 * File d'exports (R1) : plusieurs exports lancés à la suite (le mix en WAV,
 * puis en MP3, puis les stems…) pendant qu'on continue à travailler, comme la
 * file de Bounce de Pro Tools 2023+ ou la file de rendu de Logic.
 *
 * Chaque export garde les réglages ET l'état du projet au moment où il a été
 * ajouté. À la fin, une notification propose « Ouvrir le dossier » (appli
 * Windows) ou « Télécharger » (site, téléphone).
 */
import { saveBlob } from '../utils/saveBlob';
import type { ExportResult } from './ExportPipeline';

export type ExportJobStatus = 'waiting' | 'running' | 'done' | 'error';

export interface ExportJob {
  id: string;
  label: string;
  status: ExportJobStatus;
  progress: number;
  text: string;
  result?: ExportResult;
  error?: string;
  /** Fichier déjà enregistré automatiquement (sinon : bouton « Télécharger »). */
  saved?: boolean;
  createdAt: number;
}

type Runner = (onProgress: (pct: number, text: string) => void) => Promise<ExportResult>;
type Listener = (jobs: ExportJob[]) => void;

/** Le navigateur n'autorise le partage (iPhone, Android) qu'après un geste : pas d'enregistrement automatique sur écran tactile. */
const autoSaveAllowed = () => {
  try { return !(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches); } catch { return true; }
};

/** Appli Windows : elle sait montrer le fichier téléchargé dans l'Explorateur. */
export function canRevealDownloads(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  const f = w.__novaDesktop?.features;
  return Array.isArray(f) && f.includes('reveal-download') && typeof w.chrome?.webview?.postMessage === 'function';
}

export function revealDownload(name: string): boolean {
  if (!canRevealDownloads()) return false;
  try { (window as any).chrome.webview.postMessage(`nova-desktop:reveal:${name}`); return true; } catch { return false; }
}

class ExportQueueStore {
  private jobs: ExportJob[] = [];
  private runners = new Map<string, Runner>();
  private listeners = new Set<Listener>();
  private running = false;
  /** Réglage des tests : enregistrer ou non les fichiers à la fin. */
  autoSave: () => boolean = autoSaveAllowed;
  save: (blob: Blob, name: string) => Promise<void> | void = saveBlob;
  autoDismissMs = 30000;

  get(): ExportJob[] { return this.jobs; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.jobs);
    return () => { this.listeners.delete(fn); };
  }

  private emit() { this.jobs = [...this.jobs]; this.listeners.forEach(l => l(this.jobs)); }

  private patch(id: string, p: Partial<ExportJob>) {
    this.jobs = this.jobs.map(j => (j.id === id ? { ...j, ...p } : j));
    this.listeners.forEach(l => l(this.jobs));
  }

  /** Ajoute un export ; il démarre dès que le précédent est fini. Renvoie son id. */
  enqueue(label: string, run: Runner): string {
    const id = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.jobs = [...this.jobs, { id, label, status: 'waiting', progress: 0, text: 'En attente…', createdAt: Date.now() }];
    this.runners.set(id, run);
    this.emit();
    void this.pump();
    return id;
  }

  /** Attend la fin d'un export (fenêtre « Exporter » : bouton qui suit son export). */
  wait(id: string): Promise<ExportJob> {
    return new Promise(resolve => {
      const check = (jobs: ExportJob[]) => {
        const j = jobs.find(x => x.id === id);
        if (!j || j.status === 'done' || j.status === 'error') { off(); resolve(j || { id, label: '', status: 'error', progress: 0, text: '', error: 'Export retiré', createdAt: 0 }); }
      };
      let off = () => {};
      off = this.subscribe(check);
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.jobs.find(j => j.status === 'waiting');
        if (!next) break;
        const run = this.runners.get(next.id);
        this.runners.delete(next.id);
        if (!run) { this.patch(next.id, { status: 'error', error: 'Export introuvable' }); continue; }
        this.patch(next.id, { status: 'running', progress: 0, text: 'Préparation…' });
        try {
          let last = 0;
          const result = await run((pct, text) => {
            const now = Date.now();
            // Pas plus de 10 rafraîchissements par seconde.
            if (now - last < 100 && pct < 100) return;
            last = now;
            this.patch(next.id, { progress: Math.max(0, Math.min(100, pct)), text });
          });
          let saved = false;
          if (this.autoSave()) {
            try { await this.save(result.download.blob, result.download.name); saved = true; } catch { saved = false; }
          }
          this.patch(next.id, { status: 'done', progress: 100, text: 'Terminé', result, saved });
          // Fichier déjà enregistré : la notification se range seule (30 s), le rapport a été lu.
          if (saved && this.autoDismissMs > 0) setTimeout(() => this.remove(next.id), this.autoDismissMs);
        } catch (e: any) {
          this.patch(next.id, { status: 'error', error: e?.message || String(e), text: 'Échec' });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Télécharge (encore) le fichier d'un export terminé : geste de l'utilisateur. */
  async download(id: string) {
    const j = this.jobs.find(x => x.id === id);
    if (!j?.result) return;
    await this.save(j.result.download.blob, j.result.download.name);
    const first = !j.saved;
    this.patch(id, { saved: true });
    // Téléchargé à la main (tablette, téléphone) : la notification s'efface comme après un
    // enregistrement automatique (avant : elle restait et cachait le bas de l'écran, dont Collaborer / Chat).
    if (first && this.autoDismissMs > 0) setTimeout(() => this.remove(id), this.autoDismissMs);
  }

  remove(id: string) {
    this.runners.delete(id);
    this.jobs = this.jobs.filter(j => j.id !== id || j.status === 'running');
    this.emit();
  }

  clearFinished() {
    this.jobs = this.jobs.filter(j => j.status === 'waiting' || j.status === 'running');
    this.emit();
  }
}

export const exportQueue = new ExportQueueStore();
