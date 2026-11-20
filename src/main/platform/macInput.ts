import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { shell } from 'electron'
import type * as KoffiNS from 'koffi'
import { MAX_TRANSLATE_CHARS } from '../../shared/types'
import { createCooldownGate } from '../core/redact'
import { logWarn } from '../services/logger'

const execFileAsync = promisify(execFile)

export const MAC_VK_C = 0x08
export const MAC_VK_V = 0x09
export const MAC_VK_DELETE = 0x33
export const CG_EVENT_FLAG_MASK_COMMAND = 0x100000
export const CG_HID_EVENT_TAP = 0
export const MAC_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

const BACKSPACE_BATCH_CHARS = 20
const BACKSPACE_BATCH_INTERVAL_MS = 8

export interface MacNativeApi {
  axIsProcessTrusted: () => boolean
  cgEventCreateKeyboardEvent: (source: unknown, virtualKey: number, keyDown: boolean) => unknown
  cgEventSetFlags: (event: unknown, flags: number) => void
  cgEventPost: (tap: number, event: unknown) => void
  cfRelease: (ref: unknown) => void
}

export interface MacInputTestOverrides {
  api?: Partial<MacNativeApi> | null
  openAccessibilitySettings?: () => void
  runOsascriptSync?: (args: string[]) => string | null
  runOsascriptAsync?: (args: string[]) => Promise<boolean>
}

let cachedMacApi: MacNativeApi | null = null
let macApiLoadAttempted = false
let testOverrides: MacInputTestOverrides | null = null
const settingsPromptCooldown = createCooldownGate(60_000)

function createDefaultMockMacApi(): MacNativeApi {
  return {
    axIsProcessTrusted: () => true,
    cgEventCreateKeyboardEvent: () => ({ mockEvent: true }),
    cgEventSetFlags: () => {},
    cgEventPost: () => {},
    cfRelease: () => {}
  }
}

export function setMacApiForTest(overrides: MacInputTestOverrides | null): void {
  testOverrides = overrides
  if (overrides === null) {
    cachedMacApi = null
    macApiLoadAttempted = false
  }
}

function defaultRunOsascriptSync(args: string[], timeout = 400): string | null {
  try {
    return execFileSync('osascript', args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

async function defaultRunOsascriptAsync(args: string[], timeout = 1500): Promise<boolean> {
  try {
    await execFileAsync('osascript', args, { timeout })
    return true
  } catch {
    return false
  }
}

function openMacAccessibilitySettingsOnce(): void {
  if (!settingsPromptCooldown.shouldEmit()) return
  if (testOverrides?.openAccessibilitySettings) {
    testOverrides.openAccessibilitySettings()
    return
  }
  try {
    void shell.openExternal(MAC_ACCESSIBILITY_SETTINGS_URL).catch(() => {})
  } catch {
    // Ignore in headless or test environments
  }
}

function ensureMacApi(): MacNativeApi | null {
  if (testOverrides !== null) {
    if (testOverrides.api === null) return null
    if (testOverrides.api !== undefined) {
      return {
        ...createDefaultMockMacApi(),
        ...testOverrides.api
      }
    }
  }
  if (macApiLoadAttempted) return cachedMacApi
  macApiLoadAttempted = true
  if (process.platform !== 'darwin') return null

  try {
    const koffi = require('koffi') as typeof KoffiNS
    const appServices = koffi.load(
      '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
    )
    const coreFoundation = koffi.load(
      '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
    )

    const axIsProcessTrustedRaw = appServices.func('bool AXIsProcessTrusted()') as () => boolean
    const cgEventCreateKeyboardEvent = appServices.func(
      'void *CGEventCreateKeyboardEvent(void *source, uint16 virtualKey, bool keyDown)'
    ) as (source: unknown, virtualKey: number, keyDown: boolean) => unknown
    const cgEventSetFlags = appServices.func(
      'void CGEventSetFlags(void *event, uint64 flags)'
    ) as (event: unknown, flags: number) => void
    const cgEventPost = appServices.func(
      'void CGEventPost(uint32 tap, void *event)'
    ) as (tap: number, event: unknown) => void
    const cfRelease = coreFoundation.func('void CFRelease(void *cf)') as (ref: unknown) => void

    cachedMacApi = {
      axIsProcessTrusted: () => Boolean(axIsProcessTrustedRaw()),
      cgEventCreateKeyboardEvent,
      cgEventSetFlags,
      cgEventPost,
      cfRelease
    }
    return cachedMacApi
  } catch (err) {
    logWarn(
      `macOS native koffi framework load failed, falling back to osascript: ${err instanceof Error ? err.message : String(err)}`
    )
    cachedMacApi = null
    return null
  }
}

export function isMacAccessibilityTrusted(): boolean {
  const api = ensureMacApi()
  if (!api) return true
  try {
    return api.axIsProcessTrusted()
  } catch {
    return false
  }
}

function postSingleKeyEvent(api: MacNativeApi, virtualKey: number, keyDown: boolean, flags: number): void {
  const ev = api.cgEventCreateKeyboardEvent(null, virtualKey, keyDown)
  if (!ev) {
    throw new Error(`CGEventCreateKeyboardEvent returned null for vk=0x${virtualKey.toString(16)}`)
  }
  try {
    if (flags !== 0) {
      api.cgEventSetFlags(ev, flags)
    }
    api.cgEventPost(CG_HID_EVENT_TAP, ev)
  } finally {
    api.cfRelease(ev)
  }
}

/**
 * Dispatch a macOS keystroke chord via native CGEvent (koffi) with zero subprocess spawn overhead.
 * Returns `false` only when native frameworks could not be loaded (caller should fall back to osascript).
 */
export function sendMacKeyCombo(virtualKey: number, flags: number): boolean {
  const api = ensureMacApi()
  if (!api) return false

  if (!api.axIsProcessTrusted()) {
    openMacAccessibilitySettingsOnce()
    throw new Error('MACOS_ACCESSIBILITY_DENIED')
  }

  postSingleKeyEvent(api, virtualKey, true, flags)
  postSingleKeyEvent(api, virtualKey, false, flags)
  return true
}

function runOsaFallbackSync(script: string): void {
  const runner = testOverrides?.runOsascriptSync ?? defaultRunOsascriptSync
  const res = runner(['-e', script])
  if (res === null) {
    openMacAccessibilitySettingsOnce()
    throw new Error('MACOS_ACCESSIBILITY_DENIED')
  }
}

export function sendMacCopyShortcut(): void {
  if (sendMacKeyCombo(MAC_VK_C, CG_EVENT_FLAG_MASK_COMMAND)) {
    return
  }
  runOsaFallbackSync('tell application "System Events" to keystroke "c" using command down')
}

export function sendMacPasteShortcut(): void {
  if (sendMacKeyCombo(MAC_VK_V, CG_EVENT_FLAG_MASK_COMMAND)) {
    return
  }
  runOsaFallbackSync('tell application "System Events" to keystroke "v" using command down')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function sendMacBackspaces(charCount: number): Promise<void> {
  const safeCount = Math.min(MAX_TRANSLATE_CHARS, Math.max(0, Math.floor(charCount)))
  if (safeCount === 0) return

  const api = ensureMacApi()
  if (api) {
    if (!api.axIsProcessTrusted()) {
      openMacAccessibilitySettingsOnce()
      throw new Error('MACOS_ACCESSIBILITY_DENIED')
    }
    let remaining = safeCount
    while (remaining > 0) {
      const batch = Math.min(BACKSPACE_BATCH_CHARS, remaining)
      for (let i = 0; i < batch; i++) {
        postSingleKeyEvent(api, MAC_VK_DELETE, true, 0)
        postSingleKeyEvent(api, MAC_VK_DELETE, false, 0)
      }
      remaining -= batch
      if (remaining > 0) {
        await sleep(BACKSPACE_BATCH_INTERVAL_MS)
      }
    }
    return
  }

  const asyncRunner = testOverrides?.runOsascriptAsync ?? defaultRunOsascriptAsync
  let remaining = safeCount
  while (remaining > 0) {
    const batch = Math.min(BACKSPACE_BATCH_CHARS, remaining)
    const ok = await asyncRunner([
      '-e',
      `tell application "System Events" to repeat ${batch} times\nkey code 51\nend repeat`
    ])
    if (!ok) {
      openMacAccessibilitySettingsOnce()
      throw new Error('MACOS_ACCESSIBILITY_DENIED')
    }
    remaining -= batch
    if (remaining > 0) {
      await sleep(BACKSPACE_BATCH_INTERVAL_MS)
    }
  }
}
