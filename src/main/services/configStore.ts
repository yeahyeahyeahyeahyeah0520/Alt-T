import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import { isRecord, mergeConfig, pruneHistoryItems } from '../../shared/config'
import type { ApiKeyPersistence, AppConfig, HistoryItem } from '../../shared/types'
import { logError, logWarn } from './logger'

const CLEAN_EXIT_FLAG_NAME = 'clean-exit.flag'
const RENAME_BACKOFF_MS = [15, 35, 70] as const
const RETRYABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

export interface ConfigStoreDeps {
  getUserDataDir: () => string
  fs: Pick<
    typeof fs,
    'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync'
  >
  safeStorage: {
    isEncryptionAvailable: () => boolean
    encryptString: (plainText: string) => Buffer
    decryptString: (encrypted: Buffer) => string
    getSelectedStorageBackend?: () => string
  }
  sleepSync: (ms: number) => void
  now?: () => number
}

export interface ConfigStoreSetOptions {
  clearStoredEncryptedKey?: boolean
}

export interface ConfigStoreInstance {
  hasSavedConfigFile: () => boolean
  load: () => AppConfig
  get: () => AppConfig
  set: (next: unknown, opts?: ConfigStoreSetOptions) => AppConfig
  addHistory: (item: HistoryItem) => AppConfig | null
  clearHistory: () => AppConfig
  getCleanExitFlagPath: () => string
  markCleanExit: () => void
  clearCleanExit: () => void
  getCachedApiKey: () => string
  getApiKeyPersistence: () => ApiKeyPersistence
  hasUnreadableEncryptedKey: () => boolean
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
    fs,
    safeStorage,
    sleepSync: defaultSleepSync
  }
}

export function createConfigStore(overrides?: Partial<ConfigStoreDeps>): ConfigStoreInstance {
  const deps: ConfigStoreDeps = {
    ...defaultDeps(),
    ...overrides
  }

  let cachedConfig: AppConfig | null = null
  let writeSeq = 0
  let preservedEncryptedKey = ''
  let decryptFailedOnLoad = false
  let apiKeyPersistence: ApiKeyPersistence = 'empty'
  const ephemeralHistoryIds = new Set<string>()

  function nowMs(): number {
    return typeof deps.now === 'function' ? deps.now() : Date.now()
  }

  function applyHistoryRetention(cfg: AppConfig): AppConfig {
    const pruned = pruneHistoryItems(cfg.history, cfg, nowMs())
    return {
      ...cfg,
      history: pruned
    }
  }

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

  function markCleanExit(): void {
    try {
      const flagPath = getCleanExitFlagPath()
      deps.fs.mkdirSync(dirname(flagPath), { recursive: true })
      deps.fs.writeFileSync(flagPath, String(Date.now()), 'utf8')
    } catch {
      // Best effort on shutdown
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
  }

  function canUseSafeStorage(): boolean {
    try {
      if (
        typeof deps.safeStorage?.isEncryptionAvailable !== 'function' ||
        !deps.safeStorage.isEncryptionAvailable()
      ) {
        return false
      }
      if (typeof deps.safeStorage.getSelectedStorageBackend === 'function') {
        if (deps.safeStorage.getSelectedStorageBackend() === 'basic_text') {
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  function serializeForDisk(
    cfg: AppConfig,
    previousSecret = '',
    clearStoredEncryptedKey = false
  ): {
    payload: Record<string, unknown>
    nextPreservedEncryptedKey: string
    nextDecryptFailedOnLoad: boolean
    nextPersistence: ApiKeyPersistence
  } {
    const secret = cfg.openai.apiKey.trim()
    const diskHistory =
      cfg.historyEnabled && cfg.historyLimit > 0 && cfg.historyRetentionDays > 0
        ? cfg.history.filter((entry) => !ephemeralHistoryIds.has(entry.id))
        : []
    const diskOpenaiBase = {
      ...cfg.openai,
      apiKey: ''
    }

    if (secret === '') {
      if (!clearStoredEncryptedKey && decryptFailedOnLoad && preservedEncryptedKey !== '') {
        return {
          payload: {
            ...cfg,
            history: diskHistory,
            openai: {
              ...diskOpenaiBase,
              encryptedKey: preservedEncryptedKey
            }
          },
          nextPreservedEncryptedKey: preservedEncryptedKey,
          nextDecryptFailedOnLoad: true,
          nextPersistence: 'memory-only'
        }
      }
      return {
        payload: {
          ...cfg,
          history: diskHistory,
          openai: diskOpenaiBase
        },
        nextPreservedEncryptedKey: '',
        nextDecryptFailedOnLoad: false,
        nextPersistence: 'empty'
      }
    }

    if (canUseSafeStorage()) {
      try {
        const encryptedBase64 = deps.safeStorage.encryptString(secret).toString('base64')
        return {
          payload: {
            ...cfg,
            history: diskHistory,
            openai: {
              ...diskOpenaiBase,
              encryptedKey: encryptedBase64
            }
          },
          nextPreservedEncryptedKey: encryptedBase64,
          nextDecryptFailedOnLoad: false,
          nextPersistence: 'encrypted'
        }
      } catch (err) {
        logWarn(
          `safeStorage encryption failed; keeping API key in memory only without writing plaintext: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    } else {
      logWarn('safeStorage unavailable; keeping API key in memory only without writing plaintext')
    }

    // Encryption failed or is unavailable: NEVER write plaintext apiKey to disk.
    // Preserve prior encryptedKey only if user is keeping the same decrypted secret.
    if (
      !clearStoredEncryptedKey &&
      preservedEncryptedKey !== '' &&
      previousSecret !== '' &&
      secret === previousSecret
    ) {
      return {
        payload: {
          ...cfg,
          history: diskHistory,
          openai: {
            ...diskOpenaiBase,
            encryptedKey: preservedEncryptedKey
          }
        },
        nextPreservedEncryptedKey: preservedEncryptedKey,
        nextDecryptFailedOnLoad: false,
        nextPersistence: 'memory-only'
      }
    }
    return {
      payload: {
        ...cfg,
        history: diskHistory,
        openai: diskOpenaiBase
      },
      nextPreservedEncryptedKey: '',
      nextDecryptFailedOnLoad: false,
      nextPersistence: 'memory-only'
    }
  }

  function hydrateFromDisk(raw: unknown): {
    hydrated: unknown
    hadLegacyPlaintext: boolean
  } {
    if (!isRecord(raw) || !isRecord(raw.openai)) {
      preservedEncryptedKey = ''
      decryptFailedOnLoad = false
      apiKeyPersistence = 'empty'
      return { hydrated: raw, hadLegacyPlaintext: false }
    }
    const openaiRaw = raw.openai
    const rawPlain = typeof openaiRaw.apiKey === 'string' ? openaiRaw.apiKey.trim() : ''
    const hasPlain = rawPlain !== ''
    const encryptedBase64 =
      typeof openaiRaw.encryptedKey === 'string' ? openaiRaw.encryptedKey.trim() : ''
    preservedEncryptedKey = encryptedBase64

    if (hasPlain) {
      decryptFailedOnLoad = false
      apiKeyPersistence = 'memory-only'
      return { hydrated: raw, hadLegacyPlaintext: true }
    }

    if (encryptedBase64 !== '') {
      if (canUseSafeStorage()) {
        try {
          const decrypted = deps.safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'))
          decryptFailedOnLoad = false
          apiKeyPersistence = 'encrypted'
          return {
            hydrated: {
              ...raw,
              openai: {
                ...openaiRaw,
                apiKey: decrypted
              }
            },
            hadLegacyPlaintext: false
          }
        } catch (err) {
          decryptFailedOnLoad = true
          apiKeyPersistence = 'memory-only'
          logWarn(
            `Failed to decrypt stored credential (preserving ciphertext on disk): ${err instanceof Error ? err.message : String(err)}`
          )
        }
      } else {
        decryptFailedOnLoad = true
        apiKeyPersistence = 'memory-only'
        logWarn('safeStorage unavailable on load; preserving stored ciphertext on disk')
      }
      return { hydrated: raw, hadLegacyPlaintext: false }
    }

    decryptFailedOnLoad = false
    apiKeyPersistence = 'empty'
    return { hydrated: raw, hadLegacyPlaintext: false }
  }

  function writeAtomic(
    filePath: string,
    cfg: AppConfig,
    previousSecret = '',
    clearStoredEncryptedKey = false
  ): void {
    deps.fs.mkdirSync(dirname(filePath), { recursive: true })
    const serialized = serializeForDisk(cfg, previousSecret, clearStoredEncryptedKey)
    const payload = JSON.stringify(serialized.payload, null, 2)
    const tmpPath = `${filePath}.${process.pid}.${++writeSeq}.tmp`

    const commitCryptoState = (): void => {
      preservedEncryptedKey = serialized.nextPreservedEncryptedKey
      decryptFailedOnLoad = serialized.nextDecryptFailedOnLoad
      apiKeyPersistence = serialized.nextPersistence
    }

    deps.fs.writeFileSync(tmpPath, payload, 'utf8')
    try {
      let lastErr: unknown = null
      for (let attempt = 0; attempt <= RENAME_BACKOFF_MS.length; attempt++) {
        try {
          deps.fs.renameSync(tmpPath, filePath)
          commitCryptoState()
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
        commitCryptoState()
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
    ephemeralHistoryIds.clear()
    if (!deps.fs.existsSync(configPath)) {
      preservedEncryptedKey = ''
      decryptFailedOnLoad = false
      apiKeyPersistence = 'empty'
      cachedConfig = mergeConfig(null)
      return get()
    }

    try {
      const rawText = deps.fs.readFileSync(configPath, 'utf8')
      const parsed: unknown = JSON.parse(rawText)
      const { hydrated, hadLegacyPlaintext } = hydrateFromDisk(parsed)
      const merged = mergeConfig(hydrated)
      const beforeHistoryLen = merged.history.length
      cachedConfig = applyHistoryRetention(merged)
      const expiredOnLoad = cachedConfig.history.length !== beforeHistoryLen
      if ((hadLegacyPlaintext && canUseSafeStorage()) || expiredOnLoad) {
        try {
          writeAtomic(configPath, cachedConfig, cachedConfig.openai.apiKey.trim())
        } catch (migrateErr) {
          logWarn(
            `Failed to rewrite migrated/pruned config on load: ${migrateErr instanceof Error ? migrateErr.message : String(migrateErr)}`
          )
        }
      }
    } catch (err) {
      const bakPath = `${configPath}.bak-${Date.now()}`
      try {
        deps.fs.renameSync(configPath, bakPath)
        logWarn(`corrupt config.json backed up to: ${bakPath}`)
      } catch (renameErr) {
        logError('failed to backup corrupt config.json', renameErr ?? err)
      }
      preservedEncryptedKey = ''
      decryptFailedOnLoad = false
      apiKeyPersistence = 'empty'
      cachedConfig = mergeConfig(null)
    }
    return get()
  }

  function get(): AppConfig {
    if (cachedConfig === null) {
      return load()
    }
    cachedConfig = applyHistoryRetention(cachedConfig)
    return structuredClone(cachedConfig)
  }

  function set(next: unknown, opts?: ConfigStoreSetOptions): AppConfig {
    const previousSecret = cachedConfig?.openai.apiKey.trim() ?? ''
    const merged = applyHistoryRetention(mergeConfig(next))
    const configPath = getConfigPath()
    writeAtomic(configPath, merged, previousSecret, Boolean(opts?.clearStoredEncryptedKey))
    cachedConfig = merged
    return get()
  }

  function addHistory(item: HistoryItem): AppConfig | null {
    try {
      const current = get()
      if (!current.historyEnabled || current.historyLimit <= 0) {
        return null
      }
      const nextHistory = pruneHistoryItems([item, ...current.history], current, nowMs())
      if (current.historyRetentionDays === 0) {
        ephemeralHistoryIds.add(item.id)
        cachedConfig = {
          ...current,
          history: nextHistory
        }
        return get()
      }
      return set({
        ...current,
        history: nextHistory
      })
    } catch (err) {
      logWarn(
        `persist history skipped due to write error: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  function clearHistory(): AppConfig {
    ephemeralHistoryIds.clear()
    const current = get()
    return set({
      ...current,
      history: []
    })
  }

  function getCachedApiKey(): string {
    return cachedConfig?.openai.apiKey ?? ''
  }

  function getApiKeyPersistence(): ApiKeyPersistence {
    return apiKeyPersistence
  }

  function hasUnreadableEncryptedKey(): boolean {
    return decryptFailedOnLoad && preservedEncryptedKey !== ''
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
    getCachedApiKey,
    getApiKeyPersistence,
    hasUnreadableEncryptedKey
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

export const configStore: Omit<ConfigStoreInstance, 'getCleanExitFlagPath'> = {
  hasSavedConfigFile: () => getActiveStore().hasSavedConfigFile(),
  load: () => getActiveStore().load(),
  get: () => getActiveStore().get(),
  set: (next: unknown, opts?: ConfigStoreSetOptions) => getActiveStore().set(next, opts),
  addHistory: (item: HistoryItem) => getActiveStore().addHistory(item),
  clearHistory: () => getActiveStore().clearHistory(),
  markCleanExit: () => getActiveStore().markCleanExit(),
  clearCleanExit: () => getActiveStore().clearCleanExit(),
  getCachedApiKey: () => getActiveStore().getCachedApiKey(),
  getApiKeyPersistence: () => getActiveStore().getApiKeyPersistence(),
  hasUnreadableEncryptedKey: () => getActiveStore().hasUnreadableEncryptedKey()
}
