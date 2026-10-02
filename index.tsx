// Tailwind compile par le build (remplace le script CDN cdn.tailwindcss.com).
// Le CDN etait un point de defaillance unique : une coupure reseau affichait
// l'application entierement sans style.
import './styles/tailwind.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// Remove loading indicator once React mounts
const loadingEl = document.getElementById('loading-screen');
if (loadingEl) {
  loadingEl.style.opacity = '0';
  setTimeout(() => loadingEl.remove(), 300);
}

// Application installable : service worker seulement en ligne (https), en page
// principale (pas dans le cadre du site) et hors application iPhone (Capacitor).
if (
  'serviceWorker' in navigator &&
  window.location.protocol === 'https:' &&
  window.top === window.self &&
  !(window as any).Capacitor
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* pas bloquant */ });
  });
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);