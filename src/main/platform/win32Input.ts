import { MAX_TRANSLATE_CHARS } from '../../shared/types'
import { logInfo, logWarn } from '../services/logger'
import {
  classifyTerminalWindow,
  isNonTargetWindowClass,
  resolveIdeWindowClassification,
  type WindowClassification,
  type WindowInputKind
} from './win32Classifier'
import {
  ensureWin32,
  getCachedSelfRid,
  hasTestWin32ApiOverride,
  setCachedSelfRid,
  setWin32ApiForTest,
  type InputEvent,
  type Win32Api
} from './win32Ffi'
import {
  isFocusedIdeIntegratedTerminal,
  isIdeHostExeName,
  probeFocusedIdeRegion,
  setUiaWarnLogger
} from './win32Uia'

export {
  classifyExeName,
  classifyTerminalWindow,
  isNonTargetWindowClass,
  resolveIdeWindowClassification,
  type WindowClassification,
  type WindowInputKind
} from './win32Classifier'
export { setWin32ApiForTest, type Win32Api } from './win32Ffi'

setUiaWarnLogger(logWarn)

const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002

const VK_BACK = 0x08
const VK_SHIFT = 0x10
const VK_CONTROL = 0x11
const VK_MENU = 0x12
const VK_INSERT = 0x2d
const VK_C = 0x43
const VK_V = 0x56

const VK_LSHIFT = 0xa0
const VK_RSHIFT = 0xa1
const VK_LCONTROL = 0xa2
const VK_RCONTROL = 0xa3
const VK_LMENU = 0xa4
const VK_RMENU = 0xa5
const VK_LWIN = 0x5b
const VK_RWIN = 0x5c
const VK_MASK = 0xe8

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const CF_UNICODETEXT = 13
const GHND = 0x0042
const MAPVK_VK_TO_VSC = 0
const UOI_NAME = 2

const BACKSPACE_BATCH_CHARS = 20
const BACKSPACE_BATCH_INTERVAL_MS = 8

const MODIFIER_VKS = [
  VK_SHIFT,
  VK_LSHIFT,
  VK_RSHIFT,
  VK_CONTROL,
  VK_LCONTROL,
  VK_RCONTROL,
  VK_MENU,
  VK_LMENU,
  VK_RMENU,
  VK_LWIN,
  VK_RWIN
] as const

const EXTENDED_VKS = new Set<number>([VK_RCONTROL, VK_RMENU, VK_LWIN, VK_RWIN])
const MASK_TRIGGER_VKS = new Set<number>([VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN])

function makeKeyEvent(wVk: number, dwFlags: number, apiOverride?: Win32Api): InputEvent {
  const api = apiOverride ?? ensureWin32()
  const wScan = wVk === VK_MASK ? 0 : api.mapVirtualKeyW(wVk, MAPVK_VK_TO_VSC) & 0xffff
  const finalFlags = dwFlags | (EXTENDED_VKS.has(wVk) ? KEYEVENTF_EXTENDEDKEY : 0)
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk,
        wScan,
        dwFlags: finalFlags,
        time: 0,
        dwExtraInfo: 0
      }
    }
  }
}

export function injectMaskKey(): boolean {
  try {
    const api = ensureWin32()
    sendEvents([makeKeyEvent(VK_MASK, 0, api), makeKeyEvent(VK_MASK, KEYEVENTF_KEYUP, api)])
    return true
  } catch {
    return false
  }
}

function sendEvents(events: InputEvent[]): void {
  const api = ensureWin32()
  const injected = api.sendInput(events.length, events, api.inputSize)
  if (injected !== events.length) {
    throw new Error(`SendInput injected ${injected} of ${events.length}`)
  }
}

/**
 * Atomically prepend Alt/Win keyup + mask key if hardware auto-repeat re-engaged modifiers
 * during async clipboard I/O right before dispatching a Ctrl/Shift shortcut chord.
 */
function sendChordWithModifierGuard(buildChord: (api: Win32Api) => InputEvent[]): void {
  const api = ensureWin32()
  const prefix: InputEvent[] = []
  const stuckAltOrWin = [VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN].filter((vk) =>
    isKeyDown(api, vk)
  )
  if (stuckAltOrWin.length > 0) {
    prefix.push(makeKeyEvent(VK_MASK, 0, api))
    prefix.push(makeKeyEvent(VK_MASK, KEYEVENTF_KEYUP, api))
    for (const vk of stuckAltOrWin) {
      prefix.push(makeKeyEvent(vk, KEYEVENTF_KEYUP, api))
    }
  }
  const allEvents = prefix.length > 0 ? [...prefix, ...buildChord(api)] : buildChord(api)
  sendEvents(allEvents)
}

function isKeyDown(api: Win32Api, vk: number): boolean {
  return (api.getAsyncKeyState(vk) & 0x8000) !== 0
}

function getDownModifiers(api: Win32Api): number[] {
  const down: number[] = []
  for (const vk of MODIFIER_VKS) {
    if (isKeyDown(api, vk)) {
      down.push(vk)
    }
  }
  return down
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isWindow(hwnd: number): boolean {
  if (!hwnd) return false
  try {
    return ensureWin32().isWindow(hwnd) !== 0
  } catch {
    return false
  }
}

export function isWindowMinimized(hwnd: number): boolean {
  if (!hwnd) return false
  try {
    return ensureWin32().isIconic(hwnd) !== 0
  } catch {
    return false
  }
}

export function getWindowPid(hwnd: number): number {
  if (!hwnd) return 0
  try {
    const api = ensureWin32()
    const pidOut = [0]
    api.getWindowThreadProcessId(hwnd, pidOut)
    return pidOut[0] ?? 0
  } catch {
    return 0
  }
}

export function getWindowClassName(hwnd: number): string {
  if (!hwnd) return ''
  try {
    const api = ensureWin32()
    const buf = new Uint16Array(256)
    const count = api.getClassNameW(hwnd, buf, buf.length)
    if (count <= 0) return ''
    return Buffer.from(buf.buffer, 0, count * 2).toString('utf16le')
  } catch {
    return ''
  }
}

export function getWindowExeName(hwnd: number): string {
  if (!hwnd) return ''
  try {
    const api = ensureWin32()
    const pid = getWindowPid(hwnd)
    if (pid <= 0) return ''

    const hProc = Number(api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))
    if (hProc === 0) return ''

    try {
      const buf = new Uint16Array(1024)
      const sizeInOut = [buf.length]
      const ok = api.queryFullProcessImageNameW(hProc, 0, buf, sizeInOut)
      const charCount = sizeInOut[0] ?? 0
      if (!ok || charCount <= 0) return ''
      const fullPath = Buffer.from(buf.buffer, 0, charCount * 2).toString('utf16le')
      const parts = fullPath.split(/[\\/]/)
      return (parts[parts.length - 1] ?? '').toLowerCase()
    } finally {
      api.closeHandle(hProc)
    }
  } catch (err) {
    logWarn(`getWindowExeName failed: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

export function getWindowTitle(hwnd: number): string {
  if (!hwnd) return ''
  try {
    const api = ensureWin32()
    const buf = new Uint16Array(512)
    const count = api.getWindowTextW(hwnd, buf, buf.length)
    if (count <= 0) return ''
    return Buffer.from(buf.buffer, 0, count * 2).toString('utf16le')
  } catch {
    return ''
  }
}

export function getClipboardSequenceNumber(): number {
  try {
    return ensureWin32().getClipboardSequenceNumber() >>> 0
  } catch {
    return 0
  }
}

export function classifyWindowKind(
  hwnd: number,
  extraWtExes: ReadonlySet<string> = new Set(),
  extraConhostExes: ReadonlySet<string> = new Set()
): WindowInputKind {
  const className = getWindowClassName(hwnd)
  const exeName = getWindowExeName(hwnd)
  const baseKind = classifyTerminalWindow(className, exeName, extraWtExes, extraConhostExes)
  if (baseKind === 'normal' && isIdeHostExeName(exeName)) {
    const pid = getWindowPid(hwnd)
    if (isFocusedIdeIntegratedTerminal(pid, exeName)) {
      return 'wt'
    }
  }
  return baseKind
}

export async function classifyWindowContext(
  hwnd: number,
  extraWtExes: ReadonlySet<string> = new Set(),
  extraConhostExes: ReadonlySet<string> = new Set()
): Promise<WindowClassification> {
  const className = getWindowClassName(hwnd)
  const exeName = getWindowExeName(hwnd)
  const baseKind = classifyTerminalWindow(className, exeName, extraWtExes, extraConhostExes)
  if (baseKind === 'normal' && isIdeHostExeName(exeName)) {
    const pid = getWindowPid(hwnd)
    const probe = await probeFocusedIdeRegion(pid, exeName)
    return resolveIdeWindowClassification(baseKind, probe.region, probe.reason)
  }
  return { inputKind: baseKind }
}

export function isOwnProcessWindow(hwnd: number, selfPid = process.pid): boolean {
  if (!hwnd) return false
  const pid = getWindowPid(hwnd)
  return pid > 0 && pid === selfPid
}

export function isValidExternalTargetWindow(hwnd: number, selfPid = process.pid): boolean {
  if (!hwnd || !isWindow(hwnd) || isWindowMinimized(hwnd)) return false
  const pid = getWindowPid(hwnd)
  if (pid <= 0 || pid === selfPid) return false
  const cls = getWindowClassName(hwnd)
  return !isNonTargetWindowClass(cls)
}

function getSelfIntegrityRid(api: Win32Api): number | null {
  const override = hasTestWin32ApiOverride()
  const cached = getCachedSelfRid()
  if (!override && cached !== null) {
    return cached
  }
  const tokOut = [0]
  try {
    const ok = api.openProcessToken(api.getCurrentProcess(), TOKEN_QUERY, tokOut)
    const hTok = tokOut[0] ?? 0
    if (!ok || hTok === 0) {
      return null
    }
    try {
      const rid = api.getTokenIntegrityRid(hTok)
      if (!override && rid !== null) {
        setCachedSelfRid(rid)
      }
      return rid
    } finally {
      api.closeHandle(hTok)
    }
  } catch {
    return null
  }
}

/**
 * Detect whether Win32 UIPI will block SendInput from reaching `hwnd`
 * because the target window runs at a higher integrity level than our process.
 *
 * When self integrity level cannot be determined (`selfRid === null`), this conservatively
 * returns `false` so elevated instances never falsely reject peers; actual SendInput
 * failures fall back safely to keeping the translation in the clipboard.
 */
export function isWindowElevatedOverSelf(hwnd: number, selfPid = process.pid): boolean {
  if (!hwnd) return false
  try {
    const api = ensureWin32()
    const selfRid = getSelfIntegrityRid(api)
    if (selfRid === null) {
      return false
    }

    const pid = getWindowPid(hwnd)
    if (pid <= 0 || pid === selfPid) return false

    const hProc = Number(api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))
    if (hProc === 0) {
      return true
    }

    try {
      const tokOut = [0]
      const ok = api.openProcessToken(hProc, TOKEN_QUERY, tokOut)
      const hTok = tokOut[0] ?? 0
      if (!ok || hTok === 0) {
        return true
      }
      try {
        const targetRid = api.getTokenIntegrityRid(hTok)
        if (targetRid === null) return false
        return targetRid > selfRid
      } finally {
        api.closeHandle(hTok)
      }
    } finally {
      api.closeHandle(hProc)
    }
  } catch {
    return false
  }
}

/**
 * Reliably transfer foreground focus to `hwnd` and verify `GetForegroundWindow() === hwnd`.
 * Never restores minimized windows unexpectedly.
 */
export function focusWindow(hwnd: number): boolean {
  if (!hwnd || !isWindow(hwnd) || isWindowMinimized(hwnd)) return false
  try {
    const api = ensureWin32()
    if (Number(api.getForegroundWindow()) === hwnd) return true

    api.setForegroundWindow(hwnd)
    if (Number(api.getForegroundWindow()) === hwnd) return true

    const fg = Number(api.getForegroundWindow())
    const curTid = api.getCurrentThreadId()
    const dummyPid = [0]
    const fgTid = fg !== 0 ? api.getWindowThreadProcessId(fg, dummyPid) : 0

    try {
      sendEvents([makeKeyEvent(VK_MASK, 0, api), makeKeyEvent(VK_MASK, KEYEVENTF_KEYUP, api)])
    } catch {
      // Ignore mask send failure
    }

    let attached = false
    try {
      if (fgTid !== 0 && fgTid !== curTid) {
        attached = api.attachThreadInput(curTid, fgTid, 1) !== 0
      }
      api.setForegroundWindow(hwnd)
    } finally {
      if (attached) {
        api.attachThreadInput(curTid, fgTid, 0)
      }
    }

    return Number(api.getForegroundWindow()) === hwnd
  } catch (err) {
    logWarn(`focusWindow failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

function setZeroDwordFormat(api: Win32Api, formatId: number): void {
  if (!formatId) return
  const hMem = Number(api.globalAlloc(GHND, 4))
  if (hMem === 0) return
  const placed = Number(api.setClipboardData(formatId, hMem))
  if (placed === 0) {
    api.globalFree(hMem)
  }
}

/**
 * Write UTF-16 text to the Win32 clipboard tagged with Microsoft's exclusion formats
 * so sentinels and transient translations never pollute `Win+V` Clipboard History or Cloud Sync.
 */
export async function writePrivateClipboardText(text: string): Promise<boolean> {
  if (!hasTestWin32ApiOverride() && process.platform !== 'win32') return false
  try {
    const api = ensureWin32()
    const utf16Buf = Buffer.from(text + '\0', 'utf16le')

    let opened = false
    for (let attempt = 0; attempt < 5; attempt++) {
      if (api.openClipboard(0) !== 0) {
        opened = true
        break
      }
      await sleep(12)
    }
    if (!opened) return false

    try {
      api.emptyClipboard()

      const hText = Number(api.globalAlloc(GHND, utf16Buf.length))
      if (hText === 0) return false

      const ptr = Number(api.globalLock(hText))
      if (ptr === 0) {
        api.globalFree(hText)
        return false
      }
      try {
        api.rtlMoveMemory(ptr, utf16Buf, utf16Buf.length)
      } finally {
        api.globalUnlock(hText)
      }

      const textPlaced = Number(api.setClipboardData(CF_UNICODETEXT, hText))
      if (textPlaced === 0) {
        api.globalFree(hText)
        return false
      }

      setZeroDwordFormat(api, api.cfExcludeMonitor)
      setZeroDwordFormat(api, api.cfCanIncludeHistory)
      setZeroDwordFormat(api, api.cfCanUploadCloud)
      return true
    } finally {
      api.closeClipboard()
    }
  } catch (err) {
    logWarn(`writePrivateClipboardText failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export async function releaseModifiers(): Promise<void> {
  try {
    const api = ensureWin32()
    const deadline = Date.now() + 120
    let stillDown = getDownModifiers(api)
    while (stillDown.length > 0 && Date.now() < deadline) {
      await sleep(10)
      stillDown = getDownModifiers(api)
    }
    if (stillDown.length === 0) return

    const events: InputEvent[] = []
    if (stillDown.some((vk) => MASK_TRIGGER_VKS.has(vk))) {
      events.push(makeKeyEvent(VK_MASK, 0, api))
      events.push(makeKeyEvent(VK_MASK, KEYEVENTF_KEYUP, api))
    }
    for (const vk of stillDown) {
      events.push(makeKeyEvent(vk, KEYEVENTF_KEYUP, api))
    }

    try {
      sendEvents(events)
    } catch (err) {
      logWarn(`releaseModifiers SendInput warning: ${err instanceof Error ? err.message : String(err)}`)
    }

    await sleep(10)
    const remaining = getDownModifiers(api)
    for (const vk of remaining) {
      logInfo(`modifier still down: 0x${vk.toString(16)}`)
    }
  } catch (err) {
    logWarn(`releaseModifiers failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function sendCopyForWindow(kind: WindowInputKind): void {
  if (kind === 'wt') {
    sendChordWithModifierGuard((api) => [
      makeKeyEvent(VK_LCONTROL, 0, api),
      makeKeyEvent(VK_LSHIFT, 0, api),
      makeKeyEvent(VK_C, 0, api),
      makeKeyEvent(VK_C, KEYEVENTF_KEYUP, api),
      makeKeyEvent(VK_LSHIFT, KEYEVENTF_KEYUP, api),
      makeKeyEvent(VK_LCONTROL, KEYEVENTF_KEYUP, api)
    ])
    return
  }
  if (kind === 'conhost') {
    sendChordWithModifierGuard((api) => [
      makeKeyEvent(VK_LCONTROL, 0, api),
      makeKeyEvent(VK_INSERT, KEYEVENTF_EXTENDEDKEY, api),
      makeKeyEvent(VK_INSERT, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, api),
      makeKeyEvent(VK_LCONTROL, KEYEVENTF_KEYUP, api)
    ])
    return
  }
  sendChordWithModifierGuard((api) => [
    makeKeyEvent(VK_LCONTROL, 0, api),
    makeKeyEvent(VK_C, 0, api),
    makeKeyEvent(VK_C, KEYEVENTF_KEYUP, api),
    makeKeyEvent(VK_LCONTROL, KEYEVENTF_KEYUP, api)
  ])
}

export function sendPasteForWindow(kind: WindowInputKind): void {
  if (kind === 'wt') {
    sendChordWithModifierGuard((api) => [
      makeKeyEvent(VK_LCONTROL, 0, api),
      makeKeyEvent(VK_LSHIFT, 0, api),
      makeKeyEvent(VK_V, 0, api),
      makeKeyEvent(VK_V, KEYEVENTF_KEYUP, api),
      makeKeyEvent(VK_LSHIFT, KEYEVENTF_KEYUP, api),
      makeKeyEvent(VK_LCONTROL, KEYEVENTF_KEYUP, api)
    ])
    return
  }
  if (kind === 'conhost') {
    sendChordWithModifierGuard((api) => [
      makeKeyEvent(VK_LSHIFT, 0, api),
      makeKeyEvent(VK_INSERT, KEYEVENTF_EXTENDEDKEY, api),
      makeKeyEvent(VK_INSERT, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, api),
      makeKeyEvent(VK_LSHIFT, KEYEVENTF_KEYUP, api)
    ])
    return
  }
  sendChordWithModifierGuard((api) => [
    makeKeyEvent(VK_LCONTROL, 0, api),
    makeKeyEvent(VK_V, 0, api),
    makeKeyEvent(VK_V, KEYEVENTF_KEYUP, api),
    makeKeyEvent(VK_LCONTROL, KEYEVENTF_KEYUP, api)
  ])
}

export async function sendBackspaces(charCount: number): Promise<void> {
  const safeCount = Math.min(MAX_TRANSLATE_CHARS, Math.max(0, Math.floor(charCount)))
  if (safeCount === 0) return

  const api = ensureWin32()
  let remaining = safeCount
  while (remaining > 0) {
    const batch = Math.min(BACKSPACE_BATCH_CHARS, remaining)
    const events: InputEvent[] = []
    for (let i = 0; i < batch; i++) {
      events.push(makeKeyEvent(VK_BACK, 0, api))
      events.push(makeKeyEvent(VK_BACK, KEYEVENTF_KEYUP, api))
    }
    sendEvents(events)
    remaining -= batch
    if (remaining > 0) {
      await sleep(BACKSPACE_BATCH_INTERVAL_MS)
    }
  }
}

export function getForegroundWindow(): number {
  try {
    const api = ensureWin32()
    return Number(api.getForegroundWindow())
  } catch {
    return 0
  }
}

/**
 * Return the Win32 desktop name attached to the current thread (e.g. "Default" on interactive WinSta0\Default).
 */
export function getCurrentDesktopName(): string {
  if (process.platform !== 'win32') return 'Default'
  try {
    const api = ensureWin32()
    const hDesk = Number(api.getThreadDesktop(api.getCurrentThreadId()))
    if (hDesk === 0) return ''
    const buf = new Uint16Array(128)
    const needed = [0]
    const ok = api.getUserObjectInformationW(hDesk, UOI_NAME, buf, buf.byteLength, needed)
    const bytes = needed[0] ?? 0
    if (!ok || bytes <= 2) return ''
    return Buffer.from(buf.buffer, 0, bytes - 2).toString('utf16le')
  } catch {
    return ''
  }
}
