/**
 * Vitrine QA : monte un composant isolé dans la page du serveur Vite (navigateur headless),
 * pour capturer des écrans difficiles à atteindre en parcours (panneau admin réservé au
 * compte de Romain). Jamais importé par l'appli.
 *
 *   const v = await import('/qa/vitrine.tsx'); await v.montrerAdmin('light');
 *
 * Les lectures du catalogue passent ; toute écriture vers Supabase est bloquée par le
 * navigateur de test (qalib.new_page).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import AdminPanel from '../components/AdminPanel';

export async function montrerAdmin(theme: 'dark' | 'light' = 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  const host = document.createElement('div');
  host.id = 'qa-vitrine';
  document.body.appendChild(host);
  const user: any = { id: 'qa', email: 'romain.scheyvaerts@gmail.com', username: 'Romain', plan: 'PRO', owned_instruments: [] };
  createRoot(host).render(<AdminPanel user={user} existingInstruments={[]} onSuccess={() => {}} onClose={() => host.remove()} />);
  return true;
}
