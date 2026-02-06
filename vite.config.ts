import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const base =
    process.env.VITE_BASE_PATH ||
    (process.env.VERCEL ? '/' : mode === 'production' ? '/music-app/' : '/')

  return {
    base,
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'icons/apple-touch-icon.png',
          'icons/icon-192x192.png',
          'icons/icon-512x512.png',
          'icons/icon-32x32.png',
        ],
        manifest: {
          name: 'Music App',
          short_name: 'Music App',
          description: 'Offline-friendly personal music library.',
          theme_color: '#0b1020',
          background_color: '#0b1020',
          display: 'standalone',
          start_url: base,
          scope: base,
          icons: [
            {
              src: 'icons/icon-192x192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: 'icons/icon-512x512.png',
              sizes: '512x512',
              type: 'image/png',
            },
            {
              src: 'icons/icon-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
  }
})
