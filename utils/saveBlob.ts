/**
 * Enregistre un fichier généré (projet, export audio, session).
 *
 * - Sur écran tactile, la feuille de partage (« Enregistrer dans Fichiers »)
 *   quand le navigateur sait partager des fichiers : dans l'application iPhone
 *   (WKWebView), un lien <a download> vers un blob ne fait rien.
 * - Sinon, téléchargement classique. L'URL n'est plus révoquée tout de suite :
 *   Safari pouvait annuler le téléchargement avant qu'il ait commencé.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  try {
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    if (coarse && typeof navigator !== 'undefined' && 'canShare' in navigator) {
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    }
  } catch (e) {
    // Partage annulé par l'utilisateur : rien d'autre à faire.
    if ((e as DOMException)?.name === 'AbortError') return;
    // Autre échec (geste utilisateur expiré…) : repli sur le téléchargement.
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
