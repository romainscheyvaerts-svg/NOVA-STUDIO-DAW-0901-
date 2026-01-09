
import React, { useEffect } from 'react';

/**
 * GlobalClipMenu (Emergency Fallback)
 * Ce composant attache un écouteur radical sur le body pour intercepter
 * les clics droits sur les éléments identifiés comme '.audio-clip' ou via détection spatiale sur le canvas.
 */
const GlobalClipMenu: React.FC = () => {
  useEffect(() => {
    // Nettoyage des vieux menus éventuels
    const removeExistingMenu = () => {
      const existing = document.getElementById('forced-context-menu');
      if (existing) existing.remove();
    };

    const handleGlobalContextMenu = (e: MouseEvent) => {
      // 1. Détection via Délégation (Target ou parents)
      // On cherche d'abord des éléments DOM explicites (ex: Live Clips)
      let target = e.target as HTMLElement;
      let clipId: string | null = null;
      let trackId: string | null = null;
      let clickTime = 0;

      // A. Recherche DOM directe
      const clipElement = target.closest('.audio-clip') || target.closest('[data-clip-id]');
      if (clipElement) {
        clipId = clipElement.getAttribute('data-clip-id');
        trackId = clipElement.getAttribute('data-track-id');
      } 
      // B. Recherche Virtuelle (Canvas Hit-Test)
      else if (target.tagName === 'CANVAS') {
        const daw = window.DAW_CONTROL;
        if (daw) {
            const state = daw.getState();
            const rect = target.getBoundingClientRect();
            // On doit trouver le conteneur scrollable parent pour l'offset
            const scrollContainer = target.parentElement; 
            const scrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
            const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

            const x = e.clientX - rect.left + scrollLeft;
            const y = e.clientY - rect.top + scrollTop;
            
            // Calculs inverses (Pixels -> Temps/Track)
            // Note: On suppose ici zoomV=120 et zoomH=40 (ou valeurs actuelles si exposées)
            // Pour être robuste, on devrait lire ces valeurs du state, mais simplifions avec les valeurs par défaut
            // ou accédons via une API globale si disponible.
            // On va itérer sur les pistes visuelles.
            
            const zoomV = 120; // Hauteur par défaut
            const zoomH = 40;  // Largeur par défaut
            clickTime = x / zoomH;

            let currentY = 40; // Header offset
            for (const t of state.tracks) {
                // Filtre de visibilité basique (similaire à ArrangementView)
                if (t.type === 'AUDIO' || t.type === 'MIDI' || t.type === 'BUS' || t.id === 'instrumental' || t.id === 'track-rec-main') {
                    const trackH = zoomV;
                    if (y >= currentY && y < currentY + trackH) {
                        // On est sur cette piste, cherchons le clip
                        const clip = t.clips.find(c => clickTime >= c.start && clickTime <= c.start + c.duration);
                        if (clip) {
                            clipId = clip.id;
                            trackId = t.id;
                        }
                        break;
                    }
                    currentY += trackH;
                    // Skip automation lanes height approximation
                    t.automationLanes.forEach(l => { if (l.isExpanded) currentY += 80; });
                }
            }
        }
      }

      // SI CLIP TROUVÉ
      if (clipId && trackId) {
        e.preventDefault(); // Bloque le menu système
        e.stopImmediatePropagation(); // Bloque React

        removeExistingMenu();

        // 2. Création "Instantanée" du Menu DOM
        const menu = document.createElement('div');
        menu.id = 'forced-context-menu';
        
        // Style Inline "Nucléaire"
        Object.assign(menu.style, {
          position: 'fixed',
          top: `${e.clientY}px`,
          left: `${e.clientX}px`,
          zIndex: '9999999',
          backgroundColor: '#1a1c22',
          color: '#e2e8f0',
          border: '1px solid #334155',
          borderRadius: '8px',
          padding: '4px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.9)',
          fontFamily: 'Inter, sans-serif',
          fontSize: '11px',
          minWidth: '160px',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          animation: 'fadeIn 0.1s ease-out'
        });

        // Générateur d'options
        const createBtn = (label: string, icon: string, action: () => void, danger = false) => {
          const btn = document.createElement('div');
          btn.innerHTML = `<i class="fas ${icon}" style="width: 16px; margin-right: 8px; text-align: center; opacity: 0.7;"></i> ${label}`;
          
          Object.assign(btn.style, {
            padding: '8px 12px',
            cursor: 'pointer',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            fontWeight: '600',
            color: danger ? '#ef4444' : '#e2e8f0',
            transition: 'background 0.1s, color 0.1s'
          });

          btn.onmouseenter = () => { 
              btn.style.backgroundColor = danger ? 'rgba(239, 68, 68, 0.15)' : '#00f2ff'; 
              btn.style.color = danger ? '#ef4444' : '#000';
          };
          btn.onmouseleave = () => { 
              btn.style.backgroundColor = 'transparent'; 
              btn.style.color = danger ? '#ef4444' : '#e2e8f0';
          };
          
          btn.onclick = (ev) => {
            ev.stopPropagation();
            action();
            removeExistingMenu();
          };
          
          return btn;
        };

        const daw = window.DAW_CONTROL;

        // 3. Actions du Menu
        menu.appendChild(createBtn('Scinder (Split)', 'fa-cut', () => {
            // Split au point de clic ou au curseur de lecture si indéterminé
            const time = clickTime > 0 ? clickTime : daw.getState().currentTime;
            daw.splitClip(trackId!, clipId!, time);
        }));

        menu.appendChild(createBtn('Renommer', 'fa-pen', () => {
            const currentName = daw.getState().tracks.find(t => t.id === trackId)?.clips.find(c => c.id === clipId)?.name;
            const newName = prompt("Nouveau nom du clip :", currentName || "");
            if (newName) {
                // Utilisation de l'API générique editClip
                if ((daw as any).editClip) (daw as any).editClip(trackId, clipId, 'RENAME', { name: newName });
            }
        }));

        menu.appendChild(createBtn('Dupliquer', 'fa-clone', () => {
             if ((daw as any).editClip) (daw as any).editClip(trackId, clipId, 'DUPLICATE');
        }));
        
        menu.appendChild(createBtn('Normaliser', 'fa-wave-square', () => {
             daw.normalizeClip(trackId!, clipId!);
        }));

        // Séparateur
        const sep = document.createElement('div');
        sep.style.height = '1px';
        sep.style.backgroundColor = 'rgba(255,255,255,0.1)';
        sep.style.margin = '4px 0';
        menu.appendChild(sep);

        menu.appendChild(createBtn('Supprimer', 'fa-trash', () => {
             if ((daw as any).editClip) (daw as any).editClip(trackId, clipId, 'DELETE');
        }, true));

        // Ajout au DOM
        document.body.appendChild(menu);
      }
    };

    // 4. Nettoyage Global
    const handleGlobalClick = (e: MouseEvent) => {
        // Si clic gauche n'importe où (sauf sur le menu lui-même)
        if (!e.target || !(e.target as HTMLElement).closest('#forced-context-menu')) {
            removeExistingMenu();
        }
    };

    // Écouteur en phase de CAPTURE (true) pour passer avant tout le monde
    window.addEventListener('contextmenu', handleGlobalContextMenu, true);
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('scroll', removeExistingMenu, true);

    // Style pour l'animation
    const style = document.createElement('style');
    style.innerHTML = `@keyframes fadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }`;
    document.head.appendChild(style);

    return () => {
      window.removeEventListener('contextmenu', handleGlobalContextMenu, true);
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('scroll', removeExistingMenu, true);
      style.remove();
      removeExistingMenu();
    };
  }, []);

  return null;
};

export default GlobalClipMenu;
