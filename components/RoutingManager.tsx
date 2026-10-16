
import { Track, TrackType } from '../types';

/**
 * RoutingManager
 * Gère la logique de connexion entre les pistes et les bus.
 * Empêche les boucles de feedback (Larsen numérique).
 */

export const getValidDestinations = (sourceTrackId: string, tracks: Track[]): Track[] => {
  // 1. Récupérer les bus existants
  // On exclut le master ici: il est ajoute explicitement plus bas (sinon doublon)
  const busTracks = tracks.filter(t => t.type === TrackType.BUS && t.id !== 'master');
  
  // 2. Créer une liste de destinations potentielles
  // On injecte TOUJOURS le Master virtuellement s'il n'est pas dans la liste des pistes
  const masterTrack = tracks.find(t => t.id === 'master') || {
    id: 'master',
    name: 'Master (sortie)',
    type: TrackType.BUS,
    color: '#00f2ff',
    isMuted: false,
    isSolo: false,
    isTrackArmed: false,
    isFrozen: false,
    volume: 1,
    pan: 0,
    outputTrackId: '',
    sends: [],
    clips: [],
    plugins: [],
    automationLanes: [],
    totalLatency: 0
  };

  const potentialDestinations = [masterTrack, ...busTracks];

  const valid = potentialDestinations.filter(dest => {
    // A. On ne peut pas s'envoyer dans soi-même
    if (dest.id === sourceTrackId) return false;

    // B. Le Master accepte tout le monde (sauf lui-même, déjà filtré)
    if (dest.id === 'master') return true;

    // C. Détection de Boucle (Cycle Check)
    // Si on connecte Source -> Dest, on doit vérifier que Dest ne finit pas par revenir dans Source.
    let currentPointer: Track | undefined = dest;
    let iterations = 0;
    const MAX_DEPTH = 20; // Sécurité anti-boucle infinie

    while (currentPointer && currentPointer.id !== 'master' && iterations < MAX_DEPTH) {
      // Si la destination pointe vers notre source, c'est une boucle !
      if (currentPointer.outputTrackId === sourceTrackId) {
        return false;
      }
      
      // On avance au maillon suivant
      const nextId = currentPointer.outputTrackId;
      currentPointer = tracks.find(t => t.id === nextId);
      iterations++;
    }

    return true;
  });

  // TRI : Master toujours en premier, puis alphabétique pour les bus
  return valid.sort((a, b) => {
    if (a.id === 'master') return -1;
    if (b.id === 'master') return 1;
    return a.name.localeCompare(b.name);
  });
};
