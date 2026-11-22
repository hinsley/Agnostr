import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/Agnostr/',
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/parakeet.js/')) {
            return 'parakeet'
          }
          return undefined
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      includeAssets: [
        'icon.svg',
        'icon-192.png',
        'icon-512.png',
        'icon-512-maskable.png',
        'apple-touch-icon.png',
        'screenshot-wide.png',
        'screenshot-narrow.png',
      ],
      manifest: {
        id: '/Agnostr/',
        name: 'Agnostr',
        short_name: 'Agnostr',
        description: 'Geohash radio, encrypted DMs, and Nostr servers.',
        start_url: '/Agnostr/',
        scope: '/Agnostr/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        background_color: '#0B0C0F',
        theme_color: '#0B0C0F',
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
            purpose: 'any',
          },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Geohash Radar',
            short_name: 'Radar',
            url: '/Agnostr/#9q',
            icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Agnostr Lounge',
            short_name: 'Lounge',
            url: '/Agnostr/#4gn0str',
            icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
        screenshots: [
          {
            src: 'screenshot-wide.png',
            sizes: '1280x720',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Agnostr Desktop Transceiver',
          },
          {
            src: 'screenshot-narrow.png',
            sizes: '390x844',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Agnostr Mobile Geohash Radio',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
        globIgnores: [
          '**/transformers.web-*.js',
          '**/parakeet-*.js',
          '**/ort.bundle*.js',
          '**/ort-wasm-*.wasm',
        ],
      },
    }),
  ],
})
