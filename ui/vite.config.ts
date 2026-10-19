import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The page is served by the bridge server (server/server.mjs) from ui/dist. In development the server runs
// on its own port and this dev server sends it everything under /api.
const server = process.env.BRIDGE_URL || 'http://localhost:4399'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    // React in a file of its own: it changes far less often than the page, so after a deploy the browser
    // still has it cached and fetches only the page's own code.
    rollupOptions: { output: { manualChunks: (id) => (/node_modules\/(react|react-dom|scheduler)\//.test(id) ? 'react' : undefined) } },
  },
  server: {
    port: 5199,
    fs: { allow: ['..'] },
    proxy: { '/api': { target: server, changeOrigin: false }, '/sw.js': server, '/icon.svg': server, '/manifest.webmanifest': server },
  },
})
