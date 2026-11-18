import { globalShortcut, powerMonitor } from 'electron'
import {
  findDuplicateHotkeys,
  isValidGlobalAccelerator,
  normalizeAcceleratorKey
} from '../../shared/config'
import type { HotkeyCheckReply, HotkeyConfig } from '../../shared/types'
import { injectMaskKey as hostInjectMaskKey } from '../platform/hostPlatform'
import { logError, logInfo, logWarn } from './logger'
import { cancelActiveReplaceFlow, runSelectionFlow } from './selectionService'

export type HotkeyConflict = { key: keyof HotkeyConfig; accelerator: string }

export interface HotkeyHandlers {
  onDirectInput: () => void
  onTogglePopup: () => void
}

export interface PowerMonitorLike {
  on: {
    (event: 'resume', listener: () => void): void
    (event: 'unlock-screen', listener: () => void): void
    (event: 'user-did-become-active', listener: () => void): void
  }
  removeListener: {
    (event: 'resume', listener: () => void): void
    (event: 'unlock-screen', listener: () => void): void
    (event: 'user-did-become-active', listener: () => void): void
  }
}

export interface HotkeyServiceDeps {
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => boolean
    unregister: (accelerator: string) => void
    unregisterAll: () => void
    isRegistered: (accelerator: string) => boolean
  }
  powerMonitor: PowerMonitorLike
  injectMaskKey: () => boolean
  cancelActiveReplaceFlow: () => void
  runSelectionFlow: (mode: 'replace' | 'show') => Promise<unknown>
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

export interface HotkeyServiceInstance {
  configureHotkeys: (nextHandlers: HotkeyHandlers) => void
  registerAll: (cfg: HotkeyConfig) => HotkeyConflict[]
  verifyHotkeys: () => { ok: boolean; missing: string[] }
  healMissingHotkeys: () => string[]
  checkHotkey: (accelerator: string) => HotkeyCheckReply
  dispose: () => void
}

const MAX_RETRY_ATTEMPTS = 5
const RETRY_BASE_MS = 500
const SESSION_DEBOUNCE_MS = 300

const HOTKEY_SLOTS: ReadonlyArray<keyof HotkeyConfig> = [
  'directInputTranslate',
  'replaceTranslate',
  'selectionTranslate',
  'togglePopup'
]

function defaultDeps(): HotkeyServiceDeps {
  return {
    globalShortcut,
    powerMonitor,
    injectMaskKey: hostInjectMaskKey,
    cancelActiveReplaceFlow,
    runSelectionFlow,
    setTimeout,
    clearTimeout
  }
}

export function createHotkeyService(
  overrides?: Partial<HotkeyServiceDeps>
): HotkeyServiceInstance {
  const deps: HotkeyServiceDeps = {
    ...defaultDeps(),
    ...overrides
  }

  let handlers: HotkeyHandlers | null = null
  let lastConfig: HotkeyConfig | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let sessionDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let sessionListenerAttached = false
  let sessionListeners: Array<{
    event: 'resume' | 'unlock-screen' | 'user-did-become-active'
    listener: () => void
  }> = []

  function configureHotkeys(nextHandlers: HotkeyHandlers): void {
    handlers = nextHandlers
  }

  function registerOne(
    key: keyof HotkeyConfig,
    accelRaw: string,
    handler: () => void,
    conflicts: HotkeyConflict[]
  ): void {
    const accel = accelRaw.trim()
    if (!isValidGlobalAccelerator(accel)) {
      conflicts.push({ key, accelerator: accelRaw })
      return
    }
    try {
      const ok = deps.globalShortcut.register(accel, handler)
      if (!ok) {
        conflicts.push({ key, accelerator: accel })
      }
    } catch (err) {
      logWarn(`${key} register threw: ${err instanceof Error ? err.message : String(err)}`)
      conflicts.push({ key, accelerator: accel })
    }
  }

  function buildHandlerMap(): Array<{
    key: keyof HotkeyConfig
    accel: string
    handler: () => void
  }> {
    if (!lastConfig) return []
    const cfg = lastConfig
    return [
      {
        key: 'directInputTranslate',
        accel: cfg.directInputTranslate,
        handler: () => {
          deps.injectMaskKey()
          deps.cancelActiveReplaceFlow()
          if (!handlers) {
            logWarn('directInputTranslate ignored: handlers not configured')
            return
          }
          try {
            handlers.onDirectInput()
          } catch (err) {
            logError('directInputTranslate error', err)
          }
        }
      },
      {
        key: 'replaceTranslate',
        accel: cfg.replaceTranslate,
        handler: () => {
          void deps.runSelectionFlow('replace').catch((err: unknown) => {
            logError('replaceTranslate error', err)
          })
        }
      },
      {
        key: 'selectionTranslate',
        accel: cfg.selectionTranslate,
        handler: () => {
          void deps.runSelectionFlow('show').catch((err: unknown) => {
            logError('selectionTranslate error', err)
          })
        }
      },
      {
        key: 'togglePopup',
        accel: cfg.togglePopup,
        handler: () => {
          deps.injectMaskKey()
          deps.cancelActiveReplaceFlow()
          if (!handlers) {
            logWarn('togglePopup ignored: handlers not configured')
            return
          }
          try {
            handlers.onTogglePopup()
          } catch (err) {
            logError('togglePopup error', err)
          }
        }
      }
    ]
  }

  function scheduleRetry(failedKeys: HotkeyConflict[], attempt: number): void {
    if (attempt > MAX_RETRY_ATTEMPTS || !lastConfig) return

    const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1)
    logWarn(
      `Hotkey conflicts: ${failedKeys.map((c) => c.accelerator).join(', ')}; retry #${attempt} in ${delayMs}ms`
    )

    retryTimer = deps.setTimeout(() => {
      retryTimer = null
      if (!lastConfig) return

      const stillConflicted: HotkeyConflict[] = []
      for (const failed of failedKeys) {
        const entry = buildHandlerMap().find((e) => e.key === failed.key)
        if (!entry) continue

        const accel = entry.accel.trim()
        if (!isValidGlobalAccelerator(accel)) continue
        if (deps.globalShortcut.isRegistered(accel)) continue

        try {
          const ok = deps.globalShortcut.register(accel, entry.handler)
          if (ok) {
            logInfo(`Retry #${attempt}: ${entry.key} (${accel}) registered successfully`)
          } else {
            stillConflicted.push(failed)
          }
        } catch (err) {
          logWarn(
            `Retry #${attempt}: ${entry.key} threw: ${err instanceof Error ? err.message : String(err)}`
          )
          stillConflicted.push(failed)
        }
      }

      if (stillConflicted.length > 0) {
        scheduleRetry(stillConflicted, attempt + 1)
      } else {
        logInfo('All hotkey conflicts resolved by retry')
      }
    }, delayMs)
  }

  function healMissingHotkeys(): string[] {
    if (!lastConfig) return []

    const duplicateKeys = new Set(findDuplicateHotkeys(lastConfig).map((d) => d.key))
    const healed: string[] = []

    for (const entry of buildHandlerMap()) {
      if (duplicateKeys.has(entry.key)) continue
      const accel = entry.accel.trim()
      if (!isValidGlobalAccelerator(accel)) continue
      if (deps.globalShortcut.isRegistered(accel)) continue

      try {
        if (deps.globalShortcut.register(accel, entry.handler)) {
          healed.push(`${entry.key}(${accel})`)
        }
      } catch {
        // Ignore invalid or still-occupied accelerator during background heal
      }
    }

    return healed
  }

  function attachSessionListeners(): void {
    const reRegisterAfterSessionEvent = (reason: string): void => {
      if (!lastConfig) return
      logInfo(`Session event (${reason}): scheduling hotkey verification`)
      if (sessionDebounceTimer !== null) {
        deps.clearTimeout(sessionDebounceTimer)
      }
      sessionDebounceTimer = deps.setTimeout(() => {
        sessionDebounceTimer = null
        if (!lastConfig) return
        const healed = healMissingHotkeys()
        if (healed.length > 0) {
          logInfo(`Re-registered hotkeys after ${reason}: ${healed.join(', ')}`)
        }
      }, SESSION_DEBOUNCE_MS)
    }

    const events: Array<{
      event: 'resume' | 'unlock-screen' | 'user-did-become-active'
      reason: string
    }> = [
      { event: 'resume', reason: 'system resume' },
      { event: 'unlock-screen', reason: 'screen unlock' },
      { event: 'user-did-become-active', reason: 'user became active' }
    ]

    sessionListeners = events.map(({ event, reason }) => {
      const listener = (): void => {
        reRegisterAfterSessionEvent(reason)
      }
      if (event === 'resume') {
        deps.powerMonitor.on('resume', listener)
      } else if (event === 'unlock-screen') {
        deps.powerMonitor.on('unlock-screen', listener)
      } else {
        deps.powerMonitor.on('user-did-become-active', listener)
      }
      return { event, listener }
    })

    logInfo('Session-aware hotkey listeners attached')
  }

  function registerAll(cfg: HotkeyConfig): HotkeyConflict[] {
    deps.globalShortcut.unregisterAll()
    lastConfig = { ...cfg }

    if (retryTimer !== null) {
      deps.clearTimeout(retryTimer)
      retryTimer = null
    }

    const duplicates = findDuplicateHotkeys(cfg)
    const duplicateKeys = new Set(duplicates.map((d) => d.key))
    const conflicts: HotkeyConflict[] = [...duplicates]

    for (const entry of buildHandlerMap()) {
      if (duplicateKeys.has(entry.key)) continue
      registerOne(entry.key, entry.accel, entry.handler, conflicts)
    }

    const externalConflicts = conflicts.filter(
      (c) => !duplicateKeys.has(c.key) && isValidGlobalAccelerator(c.accelerator)
    )
    if (externalConflicts.length > 0) {
      scheduleRetry(externalConflicts, 1)
    }

    if (!sessionListenerAttached) {
      attachSessionListeners()
      sessionListenerAttached = true
    }

    return conflicts
  }

  function verifyHotkeys(): { ok: boolean; missing: string[] } {
    if (!lastConfig) return { ok: true, missing: [] }

    const duplicateKeys = new Set(findDuplicateHotkeys(lastConfig).map((d) => d.key))
    const missing: string[] = []
    for (const entry of buildHandlerMap()) {
      if (duplicateKeys.has(entry.key)) continue
      const accel = entry.accel.trim()
      if (accel === '') continue
      if (!deps.globalShortcut.isRegistered(accel)) {
        missing.push(`${entry.key}(${accel})`)
      }
    }

    return { ok: missing.length === 0, missing }
  }

  function checkHotkey(accelerator: string): HotkeyCheckReply {
    const trimmed = accelerator.trim()
    if (!isValidGlobalAccelerator(trimmed)) {
      return { valid: false, occupied: false }
    }

    if (lastConfig !== null) {
      const targetNorm = normalizeAcceleratorKey(trimmed)
      for (const slot of HOTKEY_SLOTS) {
        const configured = lastConfig[slot].trim()
        if (configured !== '' && normalizeAcceleratorKey(configured) === targetNorm) {
          if (deps.globalShortcut.isRegistered(configured) || deps.globalShortcut.isRegistered(trimmed)) {
            return { valid: true, occupied: false }
          }
        }
      }
    }

    try {
      const ok = deps.globalShortcut.register(trimmed, () => {
        // Temporary registration probe
      })
      if (ok) {
        deps.globalShortcut.unregister(trimmed)
        return { valid: true, occupied: false }
      }
      return { valid: true, occupied: true }
    } catch {
      return { valid: false, occupied: false }
    }
  }

  function dispose(): void {
    if (retryTimer !== null) {
      deps.clearTimeout(retryTimer)
      retryTimer = null
    }
    if (sessionDebounceTimer !== null) {
      deps.clearTimeout(sessionDebounceTimer)
      sessionDebounceTimer = null
    }
    if (sessionListenerAttached) {
      for (const { event, listener } of sessionListeners) {
        if (event === 'resume') {
          deps.powerMonitor.removeListener('resume', listener)
        } else if (event === 'unlock-screen') {
          deps.powerMonitor.removeListener('unlock-screen', listener)
        } else {
          deps.powerMonitor.removeListener('user-did-become-active', listener)
        }
      }
      sessionListeners = []
      sessionListenerAttached = false
    }
    lastConfig = null
    try {
      deps.globalShortcut.unregisterAll()
    } catch {
      // Ignore unregister errors on shutdown
    }
  }

  return {
    configureHotkeys,
    registerAll,
    verifyHotkeys,
    healMissingHotkeys,
    checkHotkey,
    dispose
  }
}

let activeService: HotkeyServiceInstance | null = null

function getActiveService(): HotkeyServiceInstance {
  if (activeService === null) {
    activeService = createHotkeyService()
  }
  return activeService
}

export function setHotkeyDepsForTest(overrides: Partial<HotkeyServiceDeps> | null): void {
  if (activeService !== null) {
    activeService.dispose()
  }
  activeService = overrides === null ? null : createHotkeyService(overrides)
}

export function configureHotkeys(nextHandlers: HotkeyHandlers): void {
  getActiveService().configureHotkeys(nextHandlers)
}

export function registerAll(cfg: HotkeyConfig): HotkeyConflict[] {
  return getActiveService().registerAll(cfg)
}

export function verifyHotkeys(): { ok: boolean; missing: string[] } {
  return getActiveService().verifyHotkeys()
}

export function healMissingHotkeys(): string[] {
  return getActiveService().healMissingHotkeys()
}

export function checkHotkey(accelerator: string): HotkeyCheckReply {
  return getActiveService().checkHotkey(accelerator)
}

export function dispose(): void {
  getActiveService().dispose()
}

export const hotkeyService = {
  configureHotkeys,
  registerAll,
  checkHotkey,
  verifyHotkeys,
  healMissingHotkeys,
  dispose
}
