import { defineConfig } from 'vite'

// The picker is the app's own page (https://localhost in the WebView); the
// dashboard it opens is the chosen server's, loaded from that server.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
})
