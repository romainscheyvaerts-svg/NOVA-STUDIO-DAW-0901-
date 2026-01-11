
/**
 * Audio Buffer Registry
 * ---------------------
 * Stockage externe des AudioBuffers pour éviter les problèmes avec Immer.
 * Les AudioBuffers ne peuvent pas être proxifiés par Immer, donc on les
 * stocke ici et on référence par ID dans le state.
 */

class AudioBufferRegistry {
    private buffers: Map<string, AudioBuffer> = new Map();
    private objectUrls: Map<string, string> = new Map();
    
    /**
     * Enregistre un AudioBuffer et retourne son ID
     */
    register(buffer: AudioBuffer, clipId?: string): string {
        const id = clipId || `buffer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.buffers.set(id, buffer);
        console.log(`[BufferRegistry] Registered buffer: ${id} (${buffer.duration.toFixed(2)}s)`);
        return id;
    }

    /**
     * Enregistre un AudioBuffer avec une Object URL associée
     */
    registerWithUrl(buffer: AudioBuffer, objectUrl: string, clipId?: string): string {
        const id = this.register(buffer, clipId);
        this.objectUrls.set(id, objectUrl);
        return id;
    }
    
    /**
     * Récupère un AudioBuffer par son ID
     */
    get(id: string): AudioBuffer | undefined {
        return this.buffers.get(id);
    }
    
    /**
     * Vérifie si un buffer existe
     */
    has(id: string): boolean {
        return this.buffers.has(id);
    }
    
    /**
     * Supprime un buffer (libération mémoire)
     */
    remove(id: string): boolean {
        const url = this.objectUrls.get(id);
        if (url) {
            URL.revokeObjectURL(url);
            this.objectUrls.delete(id);
        }
        
        const existed = this.buffers.delete(id);
        if (existed) {
            console.log(`[BufferRegistry] Removed buffer: ${id}`);
        }
        return existed;
    }
    
    /**
     * Supprime plusieurs buffers
     */
    removeMany(ids: string[]): void {
        ids.forEach(id => this.remove(id));
    }
    
    /**
     * Vide le registre (reset)
     */
    clear(): void {
        console.log(`[BufferRegistry] Clearing ${this.buffers.size} buffers`);
        this.objectUrls.forEach(url => URL.revokeObjectURL(url));
        this.objectUrls.clear();
        this.buffers.clear();
    }
    
    /**
     * Retourne le nombre de buffers stockés
     */
    get size(): number {
        return this.buffers.size;
    }
}

// Singleton global
export const audioBufferRegistry = new AudioBufferRegistry();
