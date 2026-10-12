// Entrée de la page d'écoute du client (ecoute.html) : chargée SANS le DAW
// (ni App, ni moteur audio), pour s'ouvrir vite sur un téléphone.
import './styles/tailwind.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import ListenPage from './components/ListenPage';

const root = document.getElementById('ecoute');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ListenPage />
    </React.StrictMode>
  );
}
