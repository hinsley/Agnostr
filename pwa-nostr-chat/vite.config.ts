import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const require = createRequire(import.meta.url)
const mathjaxPkg = require('mathjax-full/package.json') as { version: string }
const mathjaxVersion = mathjaxPkg.version

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  define: {
    PACKAGE_VERSION: JSON.stringify(mathjaxVersion),
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        PACKAGE_VERSION: JSON.stringify(mathjaxVersion),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep Rollup/Vite virtual helpers in a dedicated tiny precached chunk so lazy
          // chunks (jsqr, mathjax, qrcode, globe) never swallow helpers imported by index.js.
          if (
            id.includes('commonjsHelpers') ||
            id.includes('commonjs-dynamic-modules') ||
            id.includes('vite/preload-helper')
          ) {
            return 'vendor-helpers'
          }
          if (id.includes('/node_modules/mathjax-full/')) {
            return 'mathjax'
          }
          if (id.includes('/node_modules/jsqr/')) {
            return 'jsqr'
          }
          if (id.includes('/node_modules/qrcode/')) {
            return 'qrcode'
          }
          if (id.includes('/node_modules/three/')) {
            return 'globe'
          }
          if (id.includes('/node_modules/@scure/base/')) {
            return 'nostr-core'
          }
          if (
            id.includes('/node_modules/@cashu/cashu-ts/') ||
            id.includes('/node_modules/@scure/bip39/') ||
            id.includes('/node_modules/@scure/bip32/')
          ) {
            return 'cashu'
          }
          if (
            id.includes('/node_modules/nostr-tools/') ||
            id.includes('/node_modules/@noble/')
          ) {
            return 'nostr-core'
          }
          return undefined
        },
      },
    },
  },
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
    {
      name: 'mathjax-version-browser-shim',
      enforce: 'pre',
      load(id) {
        if (id.replace(/\\/g, '/').endsWith('/mathjax-full/js/components/version.js')) {
          return `export const VERSION = ${JSON.stringify(mathjaxVersion)};\n`
        }
        return null
      },
    },
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
        id: '/',
        name: 'Agnostr',
        short_name: 'Agnostr',
        description: 'Geohash Bitchat, encrypted DMs, groups, Agmail, and Cashu wallet over Nostr.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        handle_links: 'preferred',
        launch_handler: {
          client_mode: ['focus-existing', 'auto'],
        },
        protocol_handlers: [
          {
            protocol: 'web+nostr',
            url: '/#agora=%s',
          },
        ],
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
            url: '/#9q',
            icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Agnostr Lounge',
            short_name: 'Lounge',
            url: '/#4gn0str',
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
            label: 'Agnostr Mobile Bitchat',
          },
        ],
      },
      injectManifest: {
        // Only the shared preview is part of the offline install, never the detail catalog.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}', '**/solar-overview-*.webp'],
        // Precache the small filter worker entry with the app version that creates it.
        // The large on-demand inference chunks and model remain outside the app shell.
        globIgnores: [
          '**/transformers.web-*.js',
          '**/parakeet-*.js',
          '**/ort.bundle*.js',
          '**/ort.webgpu*.js',
          '**/ort-wasm-*.wasm',
          '**/translator.worker-*.js',
          '**/mathjax-*.js',
          '**/jsqr-*.js',
        ],
      },
    }),
  ],
})
