// Tailwind compile par le build (remplace le script CDN cdn.tailwindcss.com).
// Le CDN etait un point de defaillance unique : une coupure reseau affichait
// l'application entierement sans style.
import './styles/tailwind.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DesktopAccessGate from './components/DesktopAccessGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorLog } from './utils/errorLog';
import { installActionLog, installConsoleRing } from './utils/feedbackLog';
import { startFeedbackQueue } from './services/feedback';
import { FeedbackHost } from './components/FeedbackHost';
import { themeStore } from './utils/themeStore';

// Tampon des 30 dernières erreurs et des 20 dernières actions (anonymes), joint
// aux signalements « Signaler un bug / proposer une idée » ; file d'envoi hors ligne.
// Thème mémorisé (sombre / clair / auto) appliqué avant le premier rendu.
themeStore.init();
installConsoleRing();
installActionLog();
installGlobalErrorLog();
startFeedbackQueue();

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
      <DesktopAccessGate>
        <App />
      </DesktopAccessGate>
    </ErrorBoundary>
    {/* Hors du ErrorBoundary du studio : on peut signaler un plantage. */}
    <ErrorBoundary fallback={<span hidden />}>
      <FeedbackHost />
    </ErrorBoundary>
  </React.StrictMode>
);