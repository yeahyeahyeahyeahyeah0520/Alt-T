import os from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, Notification, session } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import { setQuitting } from './appState'
import { createCooldownGate, redactSecretsInText } from './core/redact'
import { registerIpc } from './ipc'
import { syncAutoLaunch } from './platform/autoLaunch'
import { isRunningOnHiddenDesktop } from './platform/hostPlatform'
import { configStore } from './services/configStore'
import { hotkeyService } from './services/hotkeyService'
import { logError, logInfo, logWarn, setRedactedSecretProvider } from './services/logger'
import {
  configureSelectionService,
  pasteTextToWindow,
  validatePastePreconditions
} from './services/selectionService'
import { createTranslateService, type TranslateService } from './services/translateService'
import { createTray, type TrayController } from './tray'
import { createPopupWindow, type PopupWindowController } from './windows/popupWindow'
import { openSettingsWindow } from './windows/settingsWindow'

const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'"

function main(): void {
  const SMOKE = process.env['TTL_SMOKE'] === '1' || process.env['FP_SMOKE'] === '1'
  const errorNotifyCooldown = createCooldownGate(60_000)

  setRedactedSecretProvider(() => {
    const key = configStore.getCachedApiKey()
    return key ? [key] : []
  })

  const scrubErrorText = (raw: string): string => {
    const key = configStore.getCachedApiKey()
    return redactSecretsInText(raw, key ? [key] : [])
  }

  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err)
    if (!errorNotifyCooldown.shouldEmit()) {
      return
    }
    try {
      if (Notification.isSupported()) {
        const safeMsg = scrubErrorText(err instanceof Error ? err.message : String(err))
        new Notification({
          title: 'FlashPrompt 错误',
          body: `发生未捕获异常: ${safeMsg}\n请查看日志或重启 FlashPrompt`
        }).show()
      }
    } catch {
      // Best effort
    }
  })

  process.on('unhandledRejection', (reason) => {
    logError(
      'unhandledRejection',
      reason instanceof Error ? reason : new Error(String(reason))
    )
  })

  app.commandLine.appendSwitch('wm-window-animations-disabled')
  app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity')
  app.disableHardwareAcceleration()

  if (SMOKE) {
    app.setPath('userData', join(os.tmpdir(), 'flashprompt-smoke'))
  }

  let popupWindow: PopupWindowController | null = null
  let translateService: TranslateService | null = null
  let tray: TrayController | null = null
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null

  if (!SMOKE) {
    if (isRunningOnHiddenDesktop()) {
      console.error(
        '[fp] Refusing to start persistent GUI inside non-interactive sandbox desktop. Launch FlashPrompt from your desktop shortcut instead.'
      )
      app.exit(1)
      return
    }
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      return
    }
    app.on('second-instance', () => {
      try {
        popupWindow?.showInput()
      } catch (err) {
        logError('second-instance error', err)
      }
    })
  }

  void app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('com.flashprompt.app')
      Menu.setApplicationMenu(null)
      if (os.platform() === 'darwin' && app.dock) {
        app.dock.hide()
      }

      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
        callback(false)
      })
      session.defaultSession.setPermissionCheckHandler(() => false)

      if (!process.env['ELECTRON_RENDERER_URL']) {
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
          const headers = { ...(details.responseHeaders ?? {}) }
          headers['Content-Security-Policy'] = [PRODUCTION_CSP]
          callback({ responseHeaders: headers })
        })
      }

      if (!SMOKE) {
        configStore.clearCleanExit()
      }

      logInfo(
        `boot: Electron ${process.versions.electron}, Node ${process.versions.node}, ${os.platform()} ${os.arch()}`
      )

      const isFirstRun = !SMOKE && !configStore.hasSavedConfigFile()
      const cfg = configStore.load()
      if (isFirstRun) {
        configStore.set(cfg)
      }
      translateService = createTranslateService({
        getConfig: () => configStore.get()
      })

      popupWindow = createPopupWindow({
        getConfig: () => configStore.get(),
        onResized: (width, height) => {
          try {
            const current = configStore.get()
            if (current.popupWidth === width && current.popupHeight === height) {
              return
            }
            const updated = configStore.set({
              ...current,
              popupWidth: width,
              popupHeight: height
            })
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                win.webContents.send(IPC_CHANNELS.configChanged, updated)
              }
            }
          } catch (err) {
            logError('persist popup size error', err)
          }
        }
      })

      const activePopup = popupWindow

      configureSelectionService({
        translateService,
        showPopupAtCursor: (payload) => {
          activePopup.showAtCursor(payload)
        },
        showInactiveAtCursor: (payload) => {
          activePopup.showInactiveAtCursor(payload)
        },
        openDirectInput: (targetHandle) => {
          activePopup.showDirectInput(targetHandle)
        },
        pushToPopup: (channel, payload) => {
          activePopup.send(channel, payload)
        },
        onTranslationStart: (requestId) => {
          activePopup.beginTranslation(requestId)
        },
        onTranslationEnd: (requestId) => {
          activePopup.endTranslation(requestId)
        },
        notifyPopup: (payload) => {
          activePopup.pushNotify(payload)
        }
      })

      tray = SMOKE
        ? null
        : createTray({
            getConfig: () => configStore.get(),
            onTogglePopup: () => {
              activePopup.toggleInput()
            },
            onDirectInput: () => {
              activePopup.toggleDirectInput()
            },
            onToggleAutoLaunch: (enabled) => {
              const current = configStore.get()
              const updated = configStore.set({
                ...current,
                autoLaunch: enabled
              })
              if (!SMOKE) {
                syncAutoLaunch(updated.autoLaunch)
              }
              tray?.rebuildMenu()
              for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                  win.webContents.send(IPC_CHANNELS.configChanged, updated)
                }
              }
            },
            onOpenSettings: () => {
              openSettingsWindow()
            },
            onQuit: () => {
              app.quit()
            }
          })

      registerIpc({
        configStore,
        translateService,
        hotkeyService,
        popupWindow: activePopup,
        tray: {
          rebuildMenu: () => {
            tray?.rebuildMenu()
          }
        },
        openSettingsWindow: () => {
          openSettingsWindow()
        },
        validatePastePreconditions: (targetHandle, text) =>
          validatePastePreconditions(targetHandle, text),
        pasteToTargetWindow: (targetHandle, text, hidePopup) =>
          pasteTextToWindow(targetHandle, text, hidePopup),
        syncAutoLaunch: (enabled) => {
          if (!SMOKE) {
            syncAutoLaunch(enabled)
          }
        }
      })

      hotkeyService.configureHotkeys({
        onDirectInput: () => {
          activePopup.toggleDirectInput()
        },
        onTogglePopup: () => {
          activePopup.toggleInput()
        }
      })

      if (!SMOKE) {
        syncAutoLaunch(cfg.autoLaunch)
        const conflicts = hotkeyService.registerAll(cfg.hotkeys)
        if (conflicts.length > 0) {
          const summary = conflicts.map((c) => `${c.key}: ${c.accelerator}`).join(', ')
          logWarn(`hotkey conflicts at boot: ${summary}`)
          if (Notification.isSupported()) {
            new Notification({
              title: 'FlashPrompt',
              body: `以下快捷键注册冲突（将自动重试）：${summary}`
            }).show()
          }
        }

        healthCheckTimer = setInterval(() => {
          try {
            const healed = hotkeyService.healMissingHotkeys()
            if (healed.length > 0) {
              logInfo(`Health check healed shortcuts: ${healed.join(', ')}`)
            }
          } catch (err) {
            logError('Health check error', err)
          }
        }, 60_000)

        logInfo('boot complete')
        if (isFirstRun) {
          activePopup.showInput()
        }
        return
      }

      const smokeTimeout = setTimeout(() => {
        console.error('[fp] SMOKE_FAIL: timed out after 20000ms')
        app.exit(1)
      }, 20000)

      try {
        const loaded = await activePopup.whenLoaded()
        if (!loaded) {
          clearTimeout(smokeTimeout)
          console.error('[fp] SMOKE_FAIL: popup window closed before load')
          app.exit(1)
          return
        }
        const wc = activePopup.getWebContents()
        if (!wc) {
          clearTimeout(smokeTimeout)
          console.error('[fp] SMOKE_FAIL: popup webContents unavailable')
          app.exit(1)
          return
        }
        const pingResult: unknown = await wc.executeJavaScript('window.api.appPing()')
        clearTimeout(smokeTimeout)
        if (
          typeof pingResult === 'object' &&
          pingResult !== null &&
          'ok' in pingResult &&
          (pingResult as { ok: unknown }).ok === true
        ) {
          console.log('[fp] SMOKE_OK')
          app.exit(0)
        } else {
          console.error('[fp] SMOKE_FAIL: unexpected appPing result')
          app.exit(1)
        }
      } catch (err) {
        clearTimeout(smokeTimeout)
        console.error('[fp] SMOKE_FAIL:', err)
        app.exit(1)
      }
    })
    .catch((err: unknown) => {
      logError('boot error', err)
      if (SMOKE) {
        console.error('[fp] SMOKE_FAIL')
        app.exit(1)
      }
    })

  app.on('window-all-closed', () => {
    // Keep resident in tray / menubar
  })

  app.on('before-quit', () => {
    setQuitting(true)
    if (!SMOKE) {
      configStore.markCleanExit()
    }
    if (healthCheckTimer !== null) {
      clearInterval(healthCheckTimer)
      healthCheckTimer = null
    }
    hotkeyService.dispose()
    tray?.destroy()
    translateService?.disposeAll()
    logInfo('quit')
  })
}

main()
