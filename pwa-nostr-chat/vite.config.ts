import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/Agnostr/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Agnostr — Geohash Radio over Nostr',
        short_name: 'Agnostr',
        description: 'Ephemeral location-based geohash radio & encrypted Bitchat messenger over Nostr.',
        start_url: '/Agnostr/',
        scope: '/Agnostr/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#090C0A',
        theme_color: '#090C0A',
        categories: ['social', 'communication', 'utilities'],
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
})
