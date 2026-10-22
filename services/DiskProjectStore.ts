/**
 * Nova Studio : la sauvegarde automatique va AUSSI sur le disque, par le pont
 * (bridge-python/project_store.py) : Documents\Nova Studio\Projets\<nom>\.
 *
 * Pourquoi : IndexedDB (sauvegarde automatique, récupération après plantage) peut
 * être vidé (stockage plein, nettoyage, profil WebView2 réinitialisé). Le disque, lui,
 * reste. Au démarrage, « Récupérer » propose la plus récente des deux.
 *
 * Fil de l'interface : rien de lourd. Chaque son n'est envoyé qu'une fois (le pont
 * dit lesquels manquent), un par un, avec une pause entre deux pour laisser
 * l'interface respirer ; l'écriture elle-même (WAV, JSON, renommage atomique) se fait
 * dans le pont. Une copie en cours n'est jamais doublée : si plusieurs versions
 * arrivent pendant ce temps, seule la plus récente est copiée ensuite.
 */
import type { StoredAudio, VersionMeta, VersionRecord } from '../utils/recoveryStore';
import { novaBridge, type DiskAudio, type DiskProjectInfo, type DiskVersionRecord } from './NovaBridge';

export interface DiskBackend {
  /** Pont connecté et capable d'écrire les projets. */
  available(): boolean;
  missingAudio(projectId: string, name: string, ids: string[]): Promise<string[]>;
  putAudio(projectId: string, name: string, id: string, sampleRate: number, channels: Float32Array[]): Promise<void>;
  saveVersion(projectId: string, name: string, record: DiskVersionRecord): Promise<{ folder: string; versionId: number }>;
  listProjects(): Promise<DiskProjectInfo[]>;
  loadVersion(projectId: string, versionId?: number): Promise<{ record: DiskVersionRecord; missing: string[]; audio: DiskAudio[] }>;
}

export function bridgeDiskBackend(bridge = novaBridge): DiskBackend {
  return {
    available: () => bridge.projectsOnDisk(),
    missingAudio: (p, n, ids) => bridge.projectAudioMissing(p, n, ids),
    putAudio: (p, n, id, sr, ch) => bridge.putProjectAudio(p, n, id, sr, ch),
    saveVersion: (p, n, r) => bridge.saveProjectVersion(p, n, r),
    listProjects: async () => (await bridge.listDiskProjects()).projects,
    loadVersion: (p, v) => bridge.loadDiskProject(p, v),
  };
}

export type AudioSource = (id: string) => Promise<{ sampleRate: number; channels: Float32Array[] } | null> | { sampleRate: number; channels: Float32Array[] } | null;

export interface MirrorResult { versionId: number; folder: string; audioSent: number; ms: number }

export interface DiskMirrorStatus {
  /** Dernière version écrite sur le disque. */
  last: MirrorResult | null;
  /** Dernière erreur (null si la dernière copie a réussi). */
  error: string | null;
  busy: boolean;
}

const pause = () => new Promise<void>(r => setTimeout(r, 0));

export class DiskMirror {
  private running: Promise<void> | null = null;
  private queued: { record: VersionRecord; audio: AudioSource } | null = null;
  readonly status: DiskMirrorStatus = { last: null, error: null, busy: false };
  private listeners = new Set<(s: DiskMirrorStatus) => void>();

  constructor(private backend: DiskBackend, private yieldToUi: () => Promise<void> = pause) {}

  onChange(cb: (s: DiskMirrorStatus) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private emit() { this.listeners.forEach(cb => { try { cb(this.status); } catch { /* écouteur fautif */ } }); }

  available(): boolean { return this.backend.available(); }

  /**
   * Copie une version sur le disque (sans attendre : renvoie quand la copie EN COURS
   * — celle-ci ou la plus récente arrivée entre-temps — est finie).
   */
  mirror(record: VersionRecord, audio: AudioSource): Promise<void> {
    if (!this.backend.available()) return Promise.resolve();
    this.queued = { record, audio };
    if (!this.running) {
      this.running = this.drain().finally(() => { this.running = null; });
    }
    return this.running;
  }

  /** Attend la fin de la copie en cours (fermeture de l'appli, test). */
  async idle(): Promise<void> { while (this.running) await this.running; }

  private async drain() {
    this.status.busy = true; this.emit();
    while (this.queued) {
      const job = this.queued;
      this.queued = null;
      try {
        this.status.last = await this.copy(job.record, job.audio);
        this.status.error = null;
      } catch (e: any) {
        this.status.error = e?.message || String(e);
        console.warn('[Disque] Copie de la version impossible', e);
      }
    }
    this.status.busy = false; this.emit();
  }

  private async copy(record: VersionRecord, audio: AudioSource): Promise<MirrorResult> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { projectId, name } = record;
    const missing = await this.backend.missingAudio(projectId, name, record.audioIds);
    let sent = 0;
    for (const id of missing) {
      const a = await audio(id);
      if (!a) continue;
      await this.backend.putAudio(projectId, name, id, a.sampleRate, a.channels);
      sent++;
      await this.yieldToUi();
    }
    const { json, audioIds, ...meta } = record;
    const r = await this.backend.saveVersion(projectId, name, { ...meta, json, audioIds } as DiskVersionRecord);
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { versionId: r.versionId, folder: r.folder, audioSent: sent, ms: Math.round(t1 - t0) };
  }
}

/**
 * Plus récente version gardée sur le disque (tous projets confondus) ; avec `projectId`
 * (projet ouvert au moment d'un plantage), celle de CE projet s'il est sur le disque.
 */
export async function latestOnDisk(backend: DiskBackend, projectId?: string | null): Promise<DiskProjectInfo | null> {
  if (!backend.available()) return null;
  const list = (await backend.listProjects()).sort((a, b) => b.latest.savedAt - a.latest.savedAt);
  return (projectId ? list.find(p => p.projectId === projectId) : undefined) || list[0] || null;
}

export type RecoverySource = 'appareil' | 'disque';

/**
 * Que proposer à « Récupérer » : la plus récente entre l'appareil (IndexedDB) et le
 * disque. À égalité, l'appareil (déjà là, rien à relire).
 */
export function pickMostRecent(device: VersionMeta | null, disk: DiskProjectInfo | null): { meta: VersionMeta; source: RecoverySource } | null {
  const d = disk ? ({ ...disk.latest, projectId: disk.projectId } as VersionMeta) : null;
  if (device && (!d || device.savedAt >= d.savedAt)) return { meta: device, source: 'appareil' };
  if (d) return { meta: d, source: 'disque' };
  return null;
}

/**
 * Relit une version sur le disque et la remet sur l'appareil (pour la rouvrir avec le
 * chemin habituel de récupération). Renvoie les sons introuvables.
 */
export async function importFromDisk(
  backend: DiskBackend,
  store: { importVersion(r: VersionRecord, a: DiskAudio[]): Promise<void> },
  projectId: string,
  versionId?: number,
): Promise<{ record: VersionRecord; missing: string[] }> {
  const { record, audio, missing } = await backend.loadVersion(projectId, versionId);
  await store.importVersion(record as unknown as VersionRecord, audio);
  return { record: record as unknown as VersionRecord, missing };
}

/** Source des sons pour la copie : mémoire du studio d'abord, sinon l'appareil. */
export function audioFrom(
  memory: (id: string) => { sampleRate: number; channels: Float32Array[] } | null,
  device: (id: string) => Promise<StoredAudio | null>,
): AudioSource {
  return async id => memory(id) || (await device(id).catch(() => null));
}
