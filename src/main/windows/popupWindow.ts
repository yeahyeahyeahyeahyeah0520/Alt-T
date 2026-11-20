import { join } from 'node:path'
import { BrowserWindow, nativeTheme, type WebContents } from 'electron'
import {
  IPC_CHANNELS,
  type AppConfig,
  type NotifyPush,
  type PopupShowPush
} from '../../shared/types'
import { isQuitting } from '../appState'
import {
  focusTarget,
  getActiveTargetHandle,
  isValidExternalTarget
} from '../platform/hostPlatform'
import {
  clampHeightForBounds,
  clampRectToDisplay,
  getPopupRectAtCursor,
  getPopupRectCentered
} from '../platform/screenGeometry'
import { logError, logWarn } from '../services/logger'

export interface PopupWindowDeps {
  getConfig: () => AppConfig
  onResized?: (width: number, height: number) => void
}

export interface PopupWindowController {
  showAtCursor(payload?: PopupShowPush): void
  showInactiveAtCursor(payload?: PopupShowPush): void
  showInput(): void
  showDirectInput(targetHandleOverride?: number): void
  toggleInput(): void
  toggleDirectInput(): void
  pin(pinned: boolean): boolean
  hide(): void
  getLastTargetHandle(): number
  resize(height: number): void
  pushNotify(payload: NotifyPush): void
  send(channel: string, payload: unknown): void
  beginTranslation(requestId: string): void
  endTranslation(requestId: string): void
  setPasting(active: boolean): void
  getWebContents(): WebContents | null
  whenLoaded(): Promise<boolean>
}

interface QueuedMessage {
  channel: string
  payload: unknown
}

const CRASH_WINDOW_MS = 5000
const MAX_CRASH_RELOADS_IN_WINDOW = 3
const PROGRAMMATIC_RESIZE_GUARD_MS = 250
const MAX_PENDING_QUEUE = 32

export function createPopupWindow(deps: PopupWindowDeps): PopupWindowController {
  const cfg = deps.getConfig()
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff'

  const win = new BrowserWindow({
    width: cfg.popupWidth,
    height: cfg.popupHeight,
    minWidth: 360,
    minHeight: 200,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    backgroundColor,
    alwaysOnTop: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => {
    e.preventDefault()
  })

  let pinned = false
  let pasting = false
  let loaded = false
  let crashHalted = false
  let initialLoadSettled = false
  let lastTargetHandle = 0
  const pendingQueue: QueuedMessage[] = []
  const activeTranslations = new Set<string>()
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let crashReloadTimer: ReturnType<typeof setTimeout> | null = null
  let programmaticResizeUntil = 0
  let crashWindowStartAt = 0
  let crashCountInWindow = 0

  let resolveLoaded!: (ok: boolean) => void
  const loadedPromise = new Promise<boolean>((resolve) => {
    resolveLoaded = resolve
  })

  const onThemeUpdated = (): void => {
    if (win.isDestroyed()) return
    win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff')
  }
  nativeTheme.on('updated', onThemeUpdated)

  function setBoundsProgrammatically(rect: Electron.Rectangle): void {
    if (win.isDestroyed()) return
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer)
      resizeTimer = null
    }
    programmaticResizeUntil = Date.now() + PROGRAMMATIC_RESIZE_GUARD_MS
    win.setBounds(rect)
  }

  function loadPopupPage(): void {
    if (win.isDestroyed()) return
    crashHalted = false
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      void win.loadURL(`${devUrl}/main.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/main.html'))
    }
  }

  function flushQueue(): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      pendingQueue.length = 0
      return
    }
    while (pendingQueue.length > 0) {
      const msg = pendingQueue.shift()
      if (msg) {
        win.webContents.send(msg.channel, msg.payload)
      }
    }
  }

  win.webContents.on('did-finish-load', () => {
    loaded = true
    crashHalted = false
    crashCountInWindow = 0
    crashWindowStartAt = 0
    flushQueue()
    if (!initialLoadSettled) {
      initialLoadSettled = true
      resolveLoaded(true)
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting() || win.isDestroyed() || details.reason === 'clean-exit') {
      return
    }
    loaded = false
    activeTranslations.clear()

    const now = Date.now()
    if (now - crashWindowStartAt > CRASH_WINDOW_MS) {
      crashWindowStartAt = now
      crashCountInWindow = 1
    } else {
      crashCountInWindow++
    }

    if (crashCountInWindow > MAX_CRASH_RELOADS_IN_WINDOW) {
      crashHalted = true
      pendingQueue.length = 0
      logError(`popup renderer crash loop detected (reason=${details.reason}), halting auto-reload`)
      return
    }

    const delayMs = crashCountInWindow === 1 ? 150 : 1500 * (crashCountInWindow - 1)
    logWarn(
      `popup renderer gone (reason=${details.reason}), reloading view in ${delayMs}ms (attempt ${crashCountInWindow}/${MAX_CRASH_RELOADS_IN_WINDOW})`
    )
    if (crashReloadTimer !== null) {
      clearTimeout(crashReloadTimer)
    }
    crashReloadTimer = setTimeout(() => {
      crashReloadTimer = null
      if (!isQuitting() && !win.isDestroyed()) {
        loadPopupPage()
      }
    }, delayMs)
  })

  win.on('close', (e) => {
    if (isQuitting()) return
    e.preventDefault()
    win.hide()
  })

  win.on('blur', () => {
    if (win.isDestroyed()) return
    if (!pinned && activeTranslations.size === 0 && !pasting) {
      win.hide()
    }
  })

  win.on('resized', () => {
    if (Date.now() < programmaticResizeUntil) {
      return
    }
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer)
    }
    resizeTimer = setTimeout(() => {
      resizeTimer = null
      if (win.isDestroyed() || Date.now() < programmaticResizeUntil) return
      const bounds = win.getBounds()
      deps.onResized?.(bounds.width, bounds.height)
    }, 500)
  })

  win.on('closed', () => {
    nativeTheme.removeListener('updated', onThemeUpdated)
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer)
      resizeTimer = null
    }
    if (crashReloadTimer !== null) {
      clearTimeout(crashReloadTimer)
      crashReloadTimer = null
    }
    pendingQueue.length = 0
    activeTranslations.clear()
    if (!initialLoadSettled) {
      initialLoadSettled = true
      resolveLoaded(false)
    }
  })

  loadPopupPage()

  function send(channel: string, payload: unknown): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    if (!loaded) {
      if (crashHalted) return
      if (channel === IPC_CHANNELS.popupShow) {
        for (let i = pendingQueue.length - 1; i >= 0; i--) {
          if (pendingQueue[i].channel === IPC_CHANNELS.popupShow) {
            pendingQueue.splice(i, 1)
          }
        }
      }
      if (pendingQueue.length >= MAX_PENDING_QUEUE) {
        pendingQueue.shift()
      }
      pendingQueue.push({ channel, payload })
      return
    }
    win.webContents.send(channel, payload)
  }

  function pushShow(payload: PopupShowPush): void {
    send(IPC_CHANNELS.popupShow, payload)
  }

  function pushNotify(payload: NotifyPush): void {
    send(IPC_CHANNELS.notify, payload)
  }

  function captureExternalTarget(): void {
    if (win.isDestroyed() || win.isFocused()) return
    try {
      const fg = getActiveTargetHandle()
      if (fg !== 0 && isValidExternalTarget(fg)) {
        lastTargetHandle = fg
      }
    } catch {
      // Ignore foreground query failure in headless/smoke contexts
    }
  }

  function showAtCursor(payload?: PopupShowPush): void {
    if (win.isDestroyed()) return
    captureExternalTarget()
    const latest = deps.getConfig()
    const rect = getPopupRectAtCursor({ width: latest.popupWidth, height: latest.popupHeight })
    setBoundsProgrammatically(rect)
    if (payload) {
      pushShow(payload)
    }
    win.show()
    setBoundsProgrammatically(rect)
    win.focus()
  }

  function showInactiveAtCursor(payload?: PopupShowPush): void {
    if (win.isDestroyed()) return
    captureExternalTarget()
    const latest = deps.getConfig()
    const rect = getPopupRectAtCursor({ width: latest.popupWidth, height: latest.popupHeight })
    setBoundsProgrammatically(rect)
    if (payload) {
      pushShow(payload)
    }
    win.showInactive()
    setBoundsProgrammatically(rect)
  }

  function showInput(): void {
    if (win.isDestroyed()) return
    captureExternalTarget()
    const latest = deps.getConfig()
    const rect = getPopupRectCentered({ width: latest.popupWidth, height: latest.popupHeight })
    setBoundsProgrammatically(rect)
    pushShow({
      mode: 'input',
      text: '',
      to: latest.defaultTargetLang,
      directPaste: false
    })
    win.show()
    setBoundsProgrammatically(rect)
    win.focus()
  }

  function showDirectInput(targetHandleOverride?: number): void {
    if (win.isDestroyed()) return
    if (
      targetHandleOverride &&
      targetHandleOverride !== 0 &&
      isValidExternalTarget(targetHandleOverride)
    ) {
      lastTargetHandle = targetHandleOverride
    } else {
      captureExternalTarget()
    }
    const latest = deps.getConfig()
    const rect = getPopupRectAtCursor({ width: latest.popupWidth, height: latest.popupHeight })
    setBoundsProgrammatically(rect)
    pushShow({
      mode: 'input',
      text: '',
      to: 'en',
      directPaste: true
    })
    win.show()
    setBoundsProgrammatically(rect)
    win.focus()
  }

  function hide(): void {
    if (win.isDestroyed()) return
    win.hide()
  }

  function getLastTargetHandle(): number {
    return lastTargetHandle
  }

  function toggleInput(): void {
    if (win.isDestroyed()) return
    if (win.isVisible() && win.isFocused()) {
      hide()
      return
    }
    showInput()
  }

  function toggleDirectInput(): void {
    if (win.isDestroyed()) return
    if (win.isVisible() && win.isFocused()) {
      hide()
      return
    }
    showDirectInput()
  }

  function pin(nextPinned: boolean): boolean {
    pinned = nextPinned
    if (!win.isDestroyed()) {
      if (pinned) {
        win.setAlwaysOnTop(true, 'screen-saver')
      } else {
        win.setAlwaysOnTop(false)
      }
    }
    return pinned
  }

  function resize(height: number): void {
    if (win.isDestroyed()) return
    const bounds = win.getBounds()
    const clampedHeight = clampHeightForBounds(height, bounds)
    if (clampedHeight <= bounds.height) return
    const nextBounds = clampRectToDisplay({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: clampedHeight
    })
    setBoundsProgrammatically(nextBounds)
  }

  function beginTranslation(requestId: string): void {
    activeTranslations.add(requestId)
  }

  function endTranslation(requestId: string): void {
    activeTranslations.delete(requestId)
  }

  function setPasting(active: boolean): void {
    pasting = active
  }

  function getWebContents(): WebContents | null {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return null
    return win.webContents
  }

  function whenLoaded(): Promise<boolean> {
    return loadedPromise
  }

  return {
    showAtCursor,
    showInactiveAtCursor,
    showInput,
    showDirectInput,
    toggleInput,
    toggleDirectInput,
    pin,
    hide,
    getLastTargetHandle,
    resize,
    pushNotify,
    send,
    beginTranslation,
    endTranslation,
    setPasting,
    getWebContents,
    whenLoaded
  }
}
