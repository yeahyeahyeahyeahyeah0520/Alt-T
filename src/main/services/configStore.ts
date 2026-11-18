import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import { mergeConfig } from '../../shared/config'
import type { AppConfig, HistoryItem } from '../../shared/types'
import { logError, logWarn } from './logger'

const CLEAN_EXIT_FLAG_NAME = 'clean-exit.flag'
const LEGACY_APP_DIR_NAME = 'TTime Lite'
const LEGACY_INTENTIONAL_QUIT_FLAG_NAME = 'intentional-quit.flag'
const RENAME_BACKOFF_MS = [15, 35, 70] as const
const RETRYABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

export interface ConfigStoreDeps {
  getUserDataDir: () => string
  getAppDataDir: () => string
  fs: Pick<
    typeof fs,
    'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync'
  >
  safeStorage: {
    isEncryptionAvailable: () => boolean
    encryptString: (plainText: string) => Buffer
    decryptString: (encrypted: Buffer) => string
  }
  sleepSync: (ms: number) => void
  isSmoke: () => boolean
}

export interface ConfigStoreInstance {
  hasSavedConfigFile: () => boolean
  load: () => AppConfig
  get: () => AppConfig
  set: (next: unknown) => AppConfig
  addHistory: (item: HistoryItem) => void
  clearHistory: () => void
  getCleanExitFlagPath: () => string
  markCleanExit: () => void
  clearCleanExit: () => void
  getCachedApiKey: () => string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function defaultSleepSync(ms: number): void {
  if (ms <= 0) return
  try {
    const sab = new SharedArrayBuffer(4)
    const view = new Int32Array(sab)
    Atomics.wait(view, 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Fallback busy wait if SharedArrayBuffer is disabled
    }
  }
}

function isRetryableFsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && RETRYABLE_FS_CODES.has(code)
}

function defaultDeps(): ConfigStoreDeps {
  return {
    getUserDataDir: () => app.getPath('userData'),
    getAppDataDir: () => app.getPath('appData'),
    fs,
    safeStorage,
    sleepSync: defaultSleepSync,
    isSmoke: () => process.env['TTL_SMOKE'] === '1' || process.env['FP_SMOKE'] === '1'
  }
}

export function createConfigStore(overrides?: Partial<ConfigStoreDeps>): ConfigStoreInstance {
  const deps: ConfigStoreDeps = {
    ...defaultDeps(),
    ...overrides
  }

  let cachedConfig: AppConfig | null = null
  let writeSeq = 0

  function getConfigPath(): string {
    return join(deps.getUserDataDir(), 'config.json')
  }

  function hasSavedConfigFile(): boolean {
    try {
      return deps.fs.existsSync(getConfigPath())
    } catch {
      return false
    }
  }

  function getCleanExitFlagPath(): string {
    return join(deps.getUserDataDir(), CLEAN_EXIT_FLAG_NAME)
  }

  function getLegacyIntentionalQuitFlagPath(): string | null {
    try {
      const appDataDir = deps.getAppDataDir()
      if (!appDataDir) return null
      const legacyDir = join(appDataDir, LEGACY_APP_DIR_NAME)
      if (!deps.fs.existsSync(legacyDir)) return null
      return join(legacyDir, LEGACY_INTENTIONAL_QUIT_FLAG_NAME)
    } catch {
      return null
    }
  }

  function markCleanExit(): void {
    try {
      const flagPath = getCleanExitFlagPath()
      deps.fs.mkdirSync(dirname(flagPath), { recursive: true })
      deps.fs.writeFileSync(flagPath, String(Date.now()), 'utf8')
    } catch {
      // Best effort on shutdown
    }
    if (!deps.isSmoke()) {
      try {
        const legacyFlagPath = getLegacyIntentionalQuitFlagPath()
        if (legacyFlagPath) {
          deps.fs.writeFileSync(legacyFlagPath, String(Date.now()), 'utf8')
        }
      } catch {
        // Best effort legacy watchdog compatibility
      }
    }
  }

  function clearCleanExit(): void {
    try {
      const flagPath = getCleanExitFlagPath()
      if (deps.fs.existsSync(flagPath)) {
        deps.fs.unlinkSync(flagPath)
      }
    } catch {
      // Best effort on startup
    }
    if (!deps.isSmoke()) {
      try {
        const legacyFlagPath = getLegacyIntentionalQuitFlagPath()
        if (legacyFlagPath && deps.fs.existsSync(legacyFlagPath)) {
          deps.fs.unlinkSync(legacyFlagPath)
        }
      } catch {
        // Best effort legacy watchdog compatibility
      }
    }
  }

  function canUseSafeStorage(): boolean {
    try {
      return (
        typeof deps.safeStorage?.isEncryptionAvailable === 'function' &&
        deps.safeStorage.isEncryptionAvailable()
      )
    } catch {
      return false
    }
  }

  function serializeForDisk(cfg: AppConfig): Record<string, unknown> {
    const plain: Record<string, unknown> = {
      ...cfg,
      openai: { ...cfg.openai }
    }
    const secret = cfg.openai.apiKey
    if (secret !== '' && canUseSafeStorage()) {
      try {
        const encryptedBase64 = deps.safeStorage.encryptString(secret).toString('base64')
        plain.openai = {
          ...cfg.openai,
          apiKey: '',
          encryptedKey: encryptedBase64
        }
      } catch (err) {
        logWarn(
          `DPAPI encryption unavailable, falling back to plain config: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    return plain
  }

  function hydrateFromDisk(raw: unknown): unknown {
    if (!isRecord(raw) || !isRecord(raw.openai)) return raw
    const openaiRaw = raw.openai
    const hasPlain = typeof openaiRaw.apiKey === 'string' && openaiRaw.apiKey.trim() !== ''
    const encryptedBase64 =
      typeof openaiRaw.encryptedKey === 'string' ? openaiRaw.encryptedKey.trim() : ''

    if (!hasPlain && encryptedBase64 !== '' && canUseSafeStorage()) {
      try {
        const decrypted = deps.safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'))
        return {
          ...raw,
          openai: {
            ...openaiRaw,
            apiKey: decrypted
          }
        }
      } catch (err) {
        logWarn(
          `Failed to decrypt stored credential: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    return raw
  }

  function writeAtomic(filePath: string, cfg: AppConfig): void {
    deps.fs.mkdirSync(dirname(filePath), { recursive: true })
    const payload = JSON.stringify(serializeForDisk(cfg), null, 2)
    const tmpPath = `${filePath}.${process.pid}.${++writeSeq}.tmp`

    deps.fs.writeFileSync(tmpPath, payload, 'utf8')
    try {
      let lastErr: unknown = null
      for (let attempt = 0; attempt <= RENAME_BACKOFF_MS.length; attempt++) {
        try {
          deps.fs.renameSync(tmpPath, filePath)
          return
        } catch (err) {
          lastErr = err
          if (attempt < RENAME_BACKOFF_MS.length && isRetryableFsError(err)) {
            deps.sleepSync(RENAME_BACKOFF_MS[attempt])
            continue
          }
          if (!isRetryableFsError(err)) {
            break
          }
        }
      }
      // Fallback if Windows antivirus / indexer holds a transient share lock blocking MoveFileEx
      try {
        deps.fs.writeFileSync(filePath, payload, 'utf8')
      } catch {
        throw lastErr
      }
    } finally {
      try {
        if (deps.fs.existsSync(tmpPath)) {
          deps.fs.unlinkSync(tmpPath)
        }
      } catch {
        // Ignore temp cleanup failure
      }
    }
  }

  function load(): AppConfig {
    const configPath = getConfigPath()
    if (!deps.fs.existsSync(configPath)) {
      cachedConfig = mergeConfig(null)
      return get()
    }

    try {
      const rawText = deps.fs.readFileSync(configPath, 'utf8')
      const parsed: unknown = JSON.parse(rawText)
      const hydrated = hydrateFromDisk(parsed)
      cachedConfig = mergeConfig(hydrated)
    } catch (err) {
      const bakPath = `${configPath}.bak-${Date.now()}`
      try {
        deps.fs.renameSync(configPath, bakPath)
        logWarn(`corrupt config.json backed up to: ${bakPath}`)
      } catch (renameErr) {
        logError('failed to backup corrupt config.json', renameErr ?? err)
      }
      cachedConfig = mergeConfig(null)
    }
    return get()
  }

  function get(): AppConfig {
    if (cachedConfig === null) {
      return load()
    }
    return structuredClone(cachedConfig)
  }

  function set(next: unknown): AppConfig {
    const merged = mergeConfig(next)
    const configPath = getConfigPath()
    writeAtomic(configPath, merged)
    cachedConfig = merged
    return get()
  }

  function addHistory(item: HistoryItem): void {
    try {
      const current = get()
      if (!current.historyEnabled || current.historyLimit <= 0) {
        return
      }
      const nextHistory = [item, ...current.history]
      set({
        ...current,
        history: nextHistory
      })
    } catch (err) {
      logWarn(
        `persist history skipped due to write error: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  function clearHistory(): void {
    const current = get()
    set({
      ...current,
      history: []
    })
  }

  function getCachedApiKey(): string {
    return cachedConfig?.openai.apiKey ?? ''
  }

  return {
    hasSavedConfigFile,
    load,
    get,
    set,
    addHistory,
    clearHistory,
    getCleanExitFlagPath,
    markCleanExit,
    clearCleanExit,
    getCachedApiKey
  }
}

let activeStore: ConfigStoreInstance | null = null

function getActiveStore(): ConfigStoreInstance {
  if (activeStore === null) {
    activeStore = createConfigStore()
  }
  return activeStore
}

export function setConfigStoreDepsForTest(overrides: Partial<ConfigStoreDeps> | null): void {
  activeStore = overrides === null ? null : createConfigStore(overrides)
}

export function getCleanExitFlagPath(): string {
  return getActiveStore().getCleanExitFlagPath()
}

export function markCleanExit(): void {
  getActiveStore().markCleanExit()
}

export function clearCleanExit(): void {
  getActiveStore().clearCleanExit()
}

export function hasSavedConfigFile(): boolean {
  return getActiveStore().hasSavedConfigFile()
}

export function load(): AppConfig {
  return getActiveStore().load()
}

export function get(): AppConfig {
  return getActiveStore().get()
}

export function set(next: unknown): AppConfig {
  return getActiveStore().set(next)
}

export function addHistory(item: HistoryItem): void {
  getActiveStore().addHistory(item)
}

export function clearHistory(): void {
  getActiveStore().clearHistory()
}

export const configStore = {
  hasSavedConfigFile,
  load,
  get,
  set,
  addHistory,
  clearHistory,
  markCleanExit,
  clearCleanExit,
  getCachedApiKey: (): string => getActiveStore().getCachedApiKey()
}
