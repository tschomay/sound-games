/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true },
  build: { target: 'es2022' },
  test: {
    // Detector and game-logic tests are pure maths and need no DOM, but the
    // calibration store talks to localStorage.
    environment: 'jsdom',
  },
});
