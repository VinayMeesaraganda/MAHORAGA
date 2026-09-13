import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = process.env.MAHORAGA_API_URL || `http://localhost:${process.env.WRANGLER_PORT || '8787'}`
// Development-only: Vite forwards this header from its Node process. It is
// never exposed through Vite's client-side environment or bundled assets.
const proxyApiToken = process.env.MAHORAGA_API_TOKEN

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: true,
        ...(proxyApiToken ? { headers: { Authorization: `Bearer ${proxyApiToken}` } } : {}),
        rewrite: (path) => path.replace(/^\/api/, '/agent'),
      },
    },
  },
})
