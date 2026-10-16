// Entrée de la page PUBLIQUE d'un morceau (morceau.html, lot 9b de la 1.5.1) : chargée SANS le
// DAW (ni App, ni moteur audio), pour s'ouvrir vite sur un téléphone et dans une <iframe>.
import './styles/tailwind.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import PublicTrackPage from './components/PublicTrackPage';

const root = document.getElementById('morceau');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <PublicTrackPage />
    </React.StrictMode>
  );
}
