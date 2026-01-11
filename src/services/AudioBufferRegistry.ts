/**
 * AudioBufferRegistry - Stockage des AudioBuffers en dehors du state React/Immer
 *
 * PROBLÈME RÉSOLU:
 * Immer (utilisé par produce()) ne peut pas créer de proxy sur les objets natifs
 * du navigateur comme AudioBuffer. Stocker un AudioBuffer dans le state React
 * cause un crash silencieux ou un blackscreen.
 *
 * SOLUTION:
 * Ce registre stocke les AudioBuffers dans une Map JavaScript standard,
 * en dehors du système de state React. Les clips ne stockent qu'un bufferId
 * (string) qui référence le buffer dans ce registre.
 */

class AudioBufferRegistryClass {
  private buffers: Map<string, AudioBuffer> = new Map();
  private objectUrls: Map<string, string> = new Map();

  /**
   * Enregistre un AudioBuffer et retourne son ID unique
   */
  register(buffer: AudioBuffer, objectUrl?: string): string {
    const id = `buf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.buffers.set(id, buffer);
    if (objectUrl) {
      this.objectUrls.set(id, objectUrl);
    }
    console.log(`[AudioRegistry] ✅ Registered buffer: ${id} (duration: ${buffer.duration.toFixed(2)}s, channels: ${buffer.numberOfChannels})`);
    return id;
  }

  /**
   * Récupère un AudioBuffer par son ID
   */
  get(id: string): AudioBuffer | undefined {
    const buffer = this.buffers.get(id);
    if (!buffer) {
      console.warn(`[AudioRegistry] ⚠️ Buffer not found: ${id}`);
    }
    return buffer;
  }

  /**
   * Vérifie si un buffer existe dans le registre
   */
  has(id: string): boolean {
    return this.buffers.has(id);
  }

  /**
   * Récupère l'URL de l'objet associé au buffer
   */
  getUrl(id: string): string | undefined {
    return this.objectUrls.get(id);
  }

  /**
   * Supprime un buffer du registre et libère les ressources
   */
  remove(id: string): void {
    const url = this.objectUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(id);
    }
    this.buffers.delete(id);
    console.log(`[AudioRegistry] 🗑️ Removed buffer: ${id}`);
  }

  /**
   * Nettoie tous les buffers du registre
   */
  clear(): void {
    this.objectUrls.forEach(url => URL.revokeObjectURL(url));
    this.buffers.clear();
    this.objectUrls.clear();
    console.log('[AudioRegistry] 🧹 Cleared all buffers');
  }

  /**
   * Retourne le nombre de buffers dans le registre
   */
  get size(): number {
    return this.buffers.size;
  }

  /**
   * Debug: affiche le contenu du registre
   */
  debug(): void {
    console.log('[AudioRegistry] Current buffers:', Array.from(this.buffers.keys()));
    console.log('[AudioRegistry] Total count:', this.buffers.size);
  }
}

// Singleton exporté
export const audioBufferRegistry = new AudioBufferRegistryClass();

// Expose pour debug dans la console du navigateur
if (typeof window !== 'undefined') {
  (window as any).audioBufferRegistry = audioBufferRegistry;
}
