import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Tests automatiques (npm test). Configuration séparée de vite.config.ts :
 * pas de plugin de dev, environnement Node par défaut (les fichiers qui ont
 * besoin du DOM le demandent avec « @vitest-environment jsdom »).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // Fonctions serveur (Deno) testées telles quelles : leurs imports distants
      // sont remplacés par des faux en mémoire (supabase/tests/fakes).
      'https://deno.land/std@0.190.0/http/server.ts': path.resolve(__dirname, 'supabase/tests/fakes/denoServe.ts'),
      'https://esm.sh/@supabase/supabase-js@2.49.1': path.resolve(__dirname, 'supabase/tests/fakes/supabase.ts'),
      'https://esm.sh/stripe@18.5.0': path.resolve(__dirname, 'supabase/tests/fakes/stripe.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'supabase/tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    // 5 s par défaut : trop court quand la suite tourne en parallèle sur une machine
    // chargée (Pro Tools ouvert) — les 1ers imports à froid du moteur dépassaient
    // 5 s sans aucun défaut. Un vrai blocage reste détecté.
    testTimeout: 30_000,
  },
});
