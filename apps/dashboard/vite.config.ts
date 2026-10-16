import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// The dashboard is served by the server itself (same origin): `npm run build`
// writes it into apps/server/public. In development, `npm run dev` proxies the
// API and the events socket to a running server (`npm run server`, :28470 or
// PLAYPEX_SERVER), rewriting Origin so the server sees a same-origin request.
const server = process.env.PLAYPEX_SERVER ?? 'http://localhost:28470'

const api: ProxyOptions = {
  target: server,
  changeOrigin: true,
  ws: true,
  configure(proxy) {
    proxy.on('proxyReq', (req) => req.setHeader('origin', server))
    proxy.on('proxyReqWs', (req) => req.setHeader('origin', server))
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    proxy: { '/api': api },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, '../server/public'),
    emptyOutDir: true,
    // Served from the LAN by the server itself, cached for a year (hashed names)
    chunkSizeWarningLimit: 1000,
  },
})
