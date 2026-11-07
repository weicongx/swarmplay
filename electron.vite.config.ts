import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // The app window, and the phone companion's page (served by src/main/companion/server.ts).
        input: {
          index: resolve('src/renderer/index.html'),
          companion: resolve('src/renderer/companion.html')
        }
      }
    }
  }
})
