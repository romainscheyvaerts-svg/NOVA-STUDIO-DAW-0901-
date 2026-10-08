import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Tests automatiques (npm test). Configuration séparée de vite.config.ts :
 * pas de plugin de dev, environnement Node par défaut (les fichiers qui ont
 * besoin du DOM le demandent avec « @vitest-environment jsdom »).
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    // 5 s par défaut : trop court quand la suite tourne en parallèle sur une machine
    // chargée (Pro Tools ouvert) — les 1ers imports à froid du moteur dépassaient
    // 5 s sans aucun défaut. Un vrai blocage reste détecté.
    testTimeout: 30_000,
  },
});
