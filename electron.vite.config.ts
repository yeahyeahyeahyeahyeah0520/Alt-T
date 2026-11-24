import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'

function tightenProductionCspPlugin(): Plugin {
  return {
    name: 'tighten-production-csp',
    apply: 'build',
    transformIndexHtml(html: string): string {
      return html.replace(
        /connect-src\s+'self'\s+ws:\/\/localhost:\*\s+http:\/\/localhost:\*/g,
        "connect-src 'self'"
      )
    }
  }
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          win32UiaWorker: resolve(__dirname, 'src/main/platform/win32UiaWorker.ts')
        }
      }
    }
  },
  preload: {
    build: { outDir: 'out/preload' }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [vue(), tightenProductionCspPlugin()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/main.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    }
  }
})
