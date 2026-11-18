#!/usr/bin/env node
/**
 * FlashPrompt Safe Environment & Hotkey Diagnostics
 * Usage:
 *   node scripts/diagnose-hotkeys.mjs                 (Safe read-only runtime check)
 *   node scripts/diagnose-hotkeys.mjs --probe-hotkeys (Temporarily probes global shortcuts when no live instance is running)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

function stripUrlCredentials(rawUrl) {
  return String(rawUrl).replace(/\b(https?:\/\/)(?:[^/\s:@]+:[^/\s]+|[^/\s:@]+)@/gi, '$1[REDACTED]@')
}

function probeLockFilesReadOnly(dirPath) {
  const found = []
  for (const name of ['SingletonLock', 'lockfile']) {
    const candidate = path.join(dirPath, name)
    try {
      const stat = fs.lstatSync(candidate)
      found.push({
        name,
        kind: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other'
      })
    } catch {
      // File does not exist or cannot be stat'd
    }
  }
  return found
}

function readConfigSummaryReadOnly(configPath) {
  if (!fs.existsSync(configPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { parseError: 'config root is not an object' }
    }
    const openai =
      typeof parsed.openai === 'object' && parsed.openai !== null ? parsed.openai : {}
    const proxy = typeof parsed.proxy === 'object' && parsed.proxy !== null ? parsed.proxy : {}
    const hotkeys =
      typeof parsed.hotkeys === 'object' && parsed.hotkeys !== null ? parsed.hotkeys : {}
    const hasPlainKey = typeof openai.apiKey === 'string' && openai.apiKey.trim() !== ''
    const hasEncryptedKey =
      typeof openai.encryptedKey === 'string' && openai.encryptedKey.trim() !== ''

    return {
      primaryProvider: typeof parsed.primaryProvider === 'string' ? parsed.primaryProvider : 'unknown',
      enableFallback: Boolean(parsed.enableFallback),
      defaultTargetLang:
        typeof parsed.defaultTargetLang === 'string' ? parsed.defaultTargetLang : 'unknown',
      terminalAutoBackspace: Boolean(parsed.terminalAutoBackspace),
      autoLaunch: Boolean(parsed.autoLaunch),
      hotkeys: {
        directInputTranslate:
          typeof hotkeys.directInputTranslate === 'string' ? hotkeys.directInputTranslate : '',
        replaceTranslate:
          typeof hotkeys.replaceTranslate === 'string' ? hotkeys.replaceTranslate : '',
        selectionTranslate:
          typeof hotkeys.selectionTranslate === 'string' ? hotkeys.selectionTranslate : '',
        togglePopup: typeof hotkeys.togglePopup === 'string' ? hotkeys.togglePopup : ''
      },
      openai: {
        baseUrl: typeof openai.baseUrl === 'string' ? stripUrlCredentials(openai.baseUrl) : '',
        model: typeof openai.model === 'string' ? openai.model : '',
        stream: Boolean(openai.stream),
        activePromptId: typeof openai.activePromptId === 'string' ? openai.activePromptId : '',
        apiKeyConfigured: hasPlainKey || hasEncryptedKey
      },
      proxy: {
        enabled: Boolean(proxy.enabled),
        url: typeof proxy.url === 'string' && proxy.url.trim() !== '' ? stripUrlCredentials(proxy.url) : ''
      }
    }
  } catch (err) {
    return { parseError: err instanceof Error ? err.message : String(err) }
  }
}

const isElectronRuntime = Boolean(process.versions.electron) && !process.env.ELECTRON_RUN_AS_NODE

if (!isElectronRuntime) {
  const require = createRequire(import.meta.url)
  const electronExe = require('electron')
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE

  const child = spawn(electronExe, [process.argv[1], ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: 'inherit'
  })
  child.on('close', (code) => process.exit(code ?? 1))
} else {
  const require = createRequire(import.meta.url)
  const { app, globalShortcut } = require('electron')
  const probeHotkeys = process.argv.includes('--probe-hotkeys')

  app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity')
  app.disableHardwareAcceleration()

  const appDataDir = app.getPath('appData')
  if (!probeHotkeys) {
    app.setPath('userData', path.join(os.tmpdir(), 'fp-diag'))
  }

  const HOTKEYS = {
    directInputTranslate: 'Alt+T',
    replaceTranslate: 'Alt+R',
    selectionTranslate: 'Alt+E',
    togglePopup: 'Alt+Q'
  }

  app.whenReady().then(() => {
    console.log('[fp] === FlashPrompt Diagnostics ===')
    console.log(
      `[fp] Platform: ${os.platform()} ${os.arch()} | Electron: ${process.versions.electron} | Node: ${process.versions.node}`
    )

    const userDataCandidates = ['FlashPrompt', 'TTime Lite', 'ttime-lite']
    let detectedLocks = 0
    let loadedHotkeys = null

    for (const dirName of userDataCandidates) {
      const candidateDir = path.join(appDataDir, dirName)
      if (!fs.existsSync(candidateDir)) continue

      const locks = probeLockFilesReadOnly(candidateDir)
      if (locks.length > 0) {
        detectedLocks += locks.length
        const summary = locks.map((l) => `${l.name}(${l.kind})`).join(', ')
        console.log(`[fp] Lock probe (${dirName}): ${summary} [read-only]`)
      }

      const cfgPath = path.join(candidateDir, 'config.json')
      const summary = readConfigSummaryReadOnly(cfgPath)
      if (summary !== null) {
        console.log(`[fp] Config (${dirName}/config.json): ${JSON.stringify(summary)}`)
        if (!loadedHotkeys && summary.hotkeys) {
          loadedHotkeys = summary.hotkeys
        }
      }
    }

    if (detectedLocks === 0) {
      console.log('[fp] Lock probe: no SingletonLock/lockfile present (read-only)')
    }

    if (os.platform() === 'win32') {
      try {
        const koffi = require('koffi')
        const user32 = koffi.load('user32.dll')
        const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
        const hwnd = Number(GetForegroundWindow())
        console.log(`[fp] Win32 koffi OK | Foreground HWND=${hwnd}`)
      } catch (err) {
        console.error('[fp] Win32 koffi check failed:', err)
        app.exit(1)
        return
      }
    }

    if (!probeHotkeys) {
      console.log('[fp] Skipping hotkey registration probe to protect any live running instance.')
      app.exit(0)
      return
    }

    const hotkeysToProbe = {
      directInputTranslate: loadedHotkeys?.directInputTranslate || HOTKEYS.directInputTranslate,
      replaceTranslate: loadedHotkeys?.replaceTranslate || HOTKEYS.replaceTranslate,
      selectionTranslate: loadedHotkeys?.selectionTranslate || HOTKEYS.selectionTranslate,
      togglePopup: loadedHotkeys?.togglePopup || HOTKEYS.togglePopup
    }

    for (const [name, accel] of Object.entries(hotkeysToProbe)) {
      try {
        const ok = globalShortcut.register(accel, () => {
          console.log(`[fp] HOTKEY FIRED: ${name} (${accel})`)
        })
        console.log(`[fp] ${name} (${accel}): ${ok ? 'AVAILABLE' : 'OCCUPIED'}`)
      } catch (err) {
        console.error(`[fp] ${name} (${accel}) threw:`, err)
      }
    }

    globalShortcut.unregisterAll()
    app.exit(0)
  })
}
