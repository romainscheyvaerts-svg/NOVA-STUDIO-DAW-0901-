
import { DAWState, Track, Clip } from '../types';

/**
 * Service dédié à la sérialisation de la session pour sauvegarde
 * JSON Léger (MIDI, Settings, FX) sans les gros blobs audio.
 */
export class SessionSerializer {

  /**
   * Convertit l'état complet du DAW en objet JSON optimisé pour le stockage.
   * Nettoie les AudioBuffers (non sérialisables) et préserve les réglages.
   */
  public static serializeSession(state: DAWState): any {
    // Copie profonde pour ne pas muter l'état original
    const session = JSON.parse(JSON.stringify(state));

    // Nettoyage spécifique par piste
    session.tracks = session.tracks.map((track: Track) => {
      return {
        ...track,
        // On s'assure de garder les plugins et leurs paramètres (ADSR, etc.)
        plugins: track.plugins, 
        // On nettoie les clips (retrait du buffer binaire)
        clips: track.clips.map((clip: Clip) => {
          const { buffer, ...cleanClip } = clip; // On exclut 'buffer'
          return cleanClip;
        })
      };
    });

    return session;
  }

  /**
   * Déclenche le téléchargement local du fichier .json
   */
  public static downloadLocalJSON(state: DAWState, filename: string = 'session') {
    const data = this.serializeSession(state);
    const jsonStr = JSON.stringify(data, null, 2);
    
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    // Format demandé : session_nom_du_projet.json
    const safeName = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    a.download = `session_${safeName}.json`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
