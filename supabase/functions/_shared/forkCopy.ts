// Lot 9a (1.5.1) · « Faire sa version » : ce que le lien fige de la séance de l'hôte.
//
// Fonctions PURES (sans base, sans Deno), partagées par daw-fork et testées par
// supabase/tests/daw-fork.test.ts.
//
// Règle des droits : une instru / mélodie du CATALOGUE (piste avec instrumentId) n'est
// jamais copiée chez les autres, même si l'hôte l'a achetée : chacun la retrouve depuis le
// catalogue, et son export reste soumis aux règles habituelles (licence à acheter).

const PART_RE = /^[a-f0-9]{40}$/;

export interface FrozenManifest {
  format?: number;
  project: Record<string, unknown> & { tracks?: unknown[] };
  files: Record<string, { parts: string[]; size: number }>;
}

const hasCatalogId = (t: any) => t && t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== "";

/**
 * Copie figée du manifeste d'une séance, sans les fichiers des pistes du catalogue.
 * Renvoie aussi les fichiers retirés (pour le dire à l'hôte) et le nombre de pistes du catalogue.
 */
export function freezeForFork(manifest: any): { manifest: FrozenManifest; removedFiles: string[]; catalogTracks: number } {
  if (!manifest || typeof manifest !== "object" || !manifest.project || typeof manifest.project !== "object") {
    throw new Error("manifeste vide");
  }
  const project = JSON.parse(JSON.stringify(manifest.project));
  const tracks: any[] = Array.isArray(project.tracks) ? project.tracks : [];
  const catalogRefs = new Set<string>();
  let catalogTracks = 0;
  for (const t of tracks) {
    if (!hasCatalogId(t)) continue;
    catalogTracks++;
    for (const c of (Array.isArray(t.clips) ? t.clips : [])) if (c && typeof c.audioRef === "string") catalogRefs.add(c.audioRef);
  }
  const files: FrozenManifest["files"] = {};
  const removedFiles: string[] = [];
  const src = manifest.files && typeof manifest.files === "object" ? manifest.files : {};
  for (const [name, f] of Object.entries(src) as [string, any][]) {
    if (catalogRefs.has(name)) { removedFiles.push(name); continue; }
    const parts = (Array.isArray(f?.parts) ? f.parts : []).filter((p: unknown) => typeof p === "string" && PART_RE.test(p));
    files[name] = { parts, size: Math.max(0, Number(f?.size) || 0) };
  }
  return { manifest: { format: 1, project, files }, removedFiles, catalogTracks };
}

/** Morceaux audio d'un manifeste figé (dans l'ordre, sans doublon). */
export function partsOfFrozen(m: Pick<FrozenManifest, "files"> | null | undefined): string[] {
  const out = new Set<string>();
  for (const f of Object.values(m?.files || {})) for (const p of f?.parts || []) if (PART_RE.test(p)) out.add(p);
  return [...out];
}
