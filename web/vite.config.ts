import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { buildId } from './scripts/build-id.mjs';

const build = buildId();

/** Publishes the build identifier at /build.json so the served bundle can be checked with curl. */
function buildManifest(): Plugin {
  return {
    name: 'sabre-build-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: `${JSON.stringify({ build })}\n` });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), buildManifest()],
  define: { 'import.meta.env.VITE_SABRE_BUILD': JSON.stringify(build) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Browser journeys run with SABRE_E2E=1 and no proxy: an unmocked request fails in the test
  // instead of reaching the owner's real factory on :8000.
  server: process.env.SABRE_E2E
    ? {}
    : { proxy: { '/api': 'http://127.0.0.1:8000', '/mcp': 'http://127.0.0.1:8000' } },
  build: { sourcemap: false },
});
