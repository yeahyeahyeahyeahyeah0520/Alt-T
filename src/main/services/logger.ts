import fs from 'node:fs'
import { dirname, join } from 'node:path'
import * as electronNs from 'electron'
import { redactSecretsInText } from '../core/redact'

const DEFAULT_MAX_LOG_SIZE = 512 * 1024
const LOG_FILE_NAME = 'alt-t.log'

export interface LoggerDeps {
  getLogDir: () => string | null
  fs: Pick<typeof fs, 'mkdirSync' | 'statSync' | 'unlinkSync' | 'renameSync' | 'appendFileSync'>
  console: Pick<Console, 'log' | 'warn' | 'error'>
  maxLogSize: number
  getSecrets?: () => string[]
}

export interface LoggerInstance {
  logInfo: (msg: string) => void
  logWarn: (msg: string) => void
  logError: (msg: string, err?: unknown) => void
  getLogFilePath: () => string | null
  reset: () => void
}

function defaultGetLogDir(): string | null {
  try {
    const maybeApp = (
      electronNs as { app?: { getPath?: (name: string) => string } }
    ).app
    if (!maybeApp || typeof maybeApp.getPath !== 'function') {
      return null
    }
    return maybeApp.getPath('userData')
  } catch {
    return null
  }
}

export function createLogger(overrides?: Partial<LoggerDeps>): LoggerInstance {
  const deps: LoggerDeps = {
    getLogDir: defaultGetLogDir,
    fs,
    console,
    maxLogSize: DEFAULT_MAX_LOG_SIZE,
    ...overrides
  }

  let logFilePath: string | null = null
  let logPathResolved = false
  let writesSinceSizeCheck = 0

  function scrub(text: string): string {
    const secrets = deps.getSecrets ? deps.getSecrets() : []
    return redactSecretsInText(text, secrets)
  }

  function resolveLogPath(): string | null {
    if (logPathResolved) return logFilePath
    logPathResolved = true
    try {
      const dir = deps.getLogDir()
      if (!dir) return null
      const resolved = join(dir, LOG_FILE_NAME)
      deps.fs.mkdirSync(dirname(resolved), { recursive: true })
      logFilePath = resolved
      return resolved
    } catch {
      logFilePath = null
      return null
    }
  }

  function rotateIfNeeded(filePath: string): void {
    writesSinceSizeCheck++
    if (writesSinceSizeCheck < 25 && writesSinceSizeCheck !== 1) return
    writesSinceSizeCheck = 1
    try {
      const stat = deps.fs.statSync(filePath)
      if (stat.size > deps.maxLogSize) {
        const bakPath = `${filePath}.old`
        try {
          deps.fs.unlinkSync(bakPath)
        } catch {
          // OK if previous backup does not exist
        }
        deps.fs.renameSync(filePath, bakPath)
      }
    } catch {
      // File may not exist yet
    }
  }

  function appendLogLine(level: 'INFO' | 'WARN' | 'ERROR', body: string): void {
    const filePath = resolveLogPath()
    if (filePath === null) return
    const line = `[${new Date().toISOString()}] [${level}] ${body}\n`
    try {
      rotateIfNeeded(filePath)
      deps.fs.appendFileSync(filePath, line, 'utf8')
    } catch {
      // Best effort file logging
    }
  }

  function logInfo(msg: string): void {
    const safeMsg = scrub(msg)
    appendLogLine('INFO', safeMsg)
    deps.console.log(`[fp] ${safeMsg}`)
  }

  function logWarn(msg: string): void {
    const safeMsg = scrub(msg)
    appendLogLine('WARN', safeMsg)
    deps.console.warn(`[fp] ${safeMsg}`)
  }

  function logError(msg: string, err?: unknown): void {
    const safeMsg = scrub(msg)
    const rawErr =
      err instanceof Error
        ? `${err.message}${err.stack ? '\n' + err.stack : ''}`
        : err !== undefined
          ? String(err)
          : ''
    const safeErr = rawErr !== '' ? scrub(rawErr) : ''
    appendLogLine('ERROR', `${safeMsg}${safeErr ? ' | ' + safeErr : ''}`)
    if (safeErr !== '') {
      deps.console.error(`[fp] ${safeMsg}`, safeErr)
    } else {
      deps.console.error(`[fp] ${safeMsg}`)
    }
  }

  function getLogFilePath(): string | null {
    return resolveLogPath()
  }

  function reset(): void {
    logFilePath = null
    logPathResolved = false
    writesSinceSizeCheck = 0
  }

  return {
    logInfo,
    logWarn,
    logError,
    getLogFilePath,
    reset
  }
}

let activeLogger: LoggerInstance | null = null
let extraSecretProvider: (() => string[]) | null = null

export function setRedactedSecretProvider(provider: (() => string[]) | null): void {
  extraSecretProvider = provider
}

function getActiveLogger(): LoggerInstance {
  if (activeLogger === null) {
    activeLogger = createLogger({
      getSecrets: () => (extraSecretProvider ? extraSecretProvider() : [])
    })
  }
  return activeLogger
}

export function setLoggerDepsForTest(overrides: Partial<LoggerDeps> | null): void {
  activeLogger = overrides === null ? null : createLogger(overrides)
}

export function logInfo(msg: string): void {
  getActiveLogger().logInfo(msg)
}

export function logWarn(msg: string): void {
  getActiveLogger().logWarn(msg)
}

export function logError(msg: string, err?: unknown): void {
  getActiveLogger().logError(msg, err)
}

export function getLogFilePath(): string | null {
  return getActiveLogger().getLogFilePath()
}
