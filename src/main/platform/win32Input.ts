import type * as KoffiNS from 'koffi'

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
const TOKEN_INTEGRITY_LEVEL_CLASS = 25
const SECURITY_MANDATORY_HIGH_RID = 0x3000
const CF_UNICODETEXT = 13
const GHND = 0x0042
const MAPVK_VK_TO_VSC = 0
const UOI_NAME = 2

export const BACKSPACE_BATCH_CHARS = 20
export const BACKSPACE_BATCH_INTERVAL_MS = 8
const MAX_BACKSPACE_CHARS = 5000

export type WindowInputKind = 'normal' | 'wt' | 'conhost'

const WT_CLASS_NAMES = new Set<string>([
  'cascadia_hosting_window_class',
  'org.wezfurlong.wezterm'
])

const CONHOST_CLASS_NAMES = new Set<string>([
  'consolewindowclass',
  'virtualconsoleclass',
  'mintty',
  'putty',
  'putty-nd'
])

const WT_EXE_NAMES = new Set<string>([
  'windowsterminal.exe',
  'wt.exe',
  'wezterm-gui.exe',
  'alacritty.exe',
  'ghostty.exe',
  'kitty.exe',
  'tabby.exe',
  'hyper.exe',
  'rio.exe',
  'warp.exe',
  'wave.exe',
  'waveterm.exe',
  'terminus.exe'
])

const CONHOST_EXE_NAMES = new Set<string>([
  'conhost.exe',
  'openconsole.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'mintty.exe',
  'wsl.exe',
  'bash.exe',
  'putty.exe',
  'xshell.exe',
  'mobaxterm.exe'
])

const CONHOST_COPY_PASTE_EXES = new Set<string>([
  'putty.exe',
  'kitty.exe',
  'xshell.exe',
  'mobaxterm.exe'
])

const NON_TARGET_WINDOW_CLASSES = new Set<string>([
  'shell_traywnd',
  'shell_secondarytraywnd',
  'notifyiconoverflowwindow',
  'toplevelwindowforoverflowxamlisland',
  'xamlexplorerhostislandwindow',
  'progman',
  'workerw',
  'dv2controlhost',
  'tasklistthumbnailwnd',
  'multitaskingviewframe',
  'windows.ui.core.corewindow'
])

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

export interface KeybdInputPayload {
  wVk: number
  wScan: number
  dwFlags: number
  time: number
  dwExtraInfo: number
}

export interface InputEvent {
  type: number
  u: {
    ki: KeybdInputPayload
  }
}

export interface Win32Api {
  inputSize: number
  sendInput: (cInputs: number, pInputs: InputEvent[], cbSize: number) => number
  getAsyncKeyState: (vKey: number) => number
  getForegroundWindow: () => number
  setForegroundWindow: (hWnd: number) => number
  isWindow: (hWnd: number) => number
  isIconic: (hWnd: number) => number
  getWindowThreadProcessId: (hWnd: number, lpdwProcessId: number[]) => number
  getClassNameW: (hWnd: number, lpClassName: Uint16Array, nMaxCount: number) => number
  getWindowTextW: (hWnd: number, lpString: Uint16Array, nMaxCount: number) => number
  getClipboardSequenceNumber: () => number
  mapVirtualKeyW: (uCode: number, uMapType: number) => number
  attachThreadInput: (idAttach: number, idAttachTo: number, fAttach: number) => number
  registerClipboardFormatW: (lpszFormat: string) => number
  openClipboard: (hWndNewOwner: number) => number
  emptyClipboard: () => number
  setClipboardData: (uFormat: number, hMem: number) => number
  closeClipboard: () => number
  getThreadDesktop: (dwThreadId: number) => number
  getUserObjectInformationW: (
    hObj: number,
    nIndex: number,
    pvInfo: Uint16Array,
    nLength: number,
    lpnLengthNeeded: number[]
  ) => number
  getCurrentThreadId: () => number
  getCurrentProcess: () => number
  openProcess: (dwDesiredAccess: number, bInheritHandle: number, dwProcessId: number) => number
  queryFullProcessImageNameW: (
    hProcess: number,
    dwFlags: number,
    lpExeName: Uint16Array,
    lpdwSize: number[]
  ) => number
  closeHandle: (hObject: number) => number
  globalAlloc: (uFlags: number, dwBytes: number) => number
  globalLock: (hMem: number) => number
  globalUnlock: (hMem: number) => number
  globalFree: (hMem: number) => number
  rtlMoveMemory: (destination: number, source: Uint8Array, length: number) => void
  openProcessToken: (
    processHandle: number,
    desiredAccess: number,
    tokenHandle: number[]
  ) => number
  getTokenIntegrityRid: (tokenHandle: number) => number | null
  cfExcludeMonitor: number
  cfCanIncludeHistory: number
  cfCanUploadCloud: number
}

let cachedApi: Win32Api | null = null
let testApiOverride = false
let cachedSelfIntegrityRid: number | null = null

function createDefaultMockApi(): Win32Api {
  return {
    inputSize: 40,
    sendInput: (cInputs) => cInputs,
    getAsyncKeyState: () => 0,
    getForegroundWindow: () => 0,
    setForegroundWindow: () => 1,
    isWindow: () => 1,
    isIconic: () => 0,
    getWindowThreadProcessId: () => 1,
    getClassNameW: () => 0,
    getWindowTextW: () => 0,
    getClipboardSequenceNumber: () => 0,
    mapVirtualKeyW: (vk) => vk,
    attachThreadInput: () => 1,
    registerClipboardFormatW: () => 0,
    openClipboard: () => 1,
    emptyClipboard: () => 1,
    setClipboardData: () => 1,
    closeClipboard: () => 1,
    getThreadDesktop: () => 1,
    getUserObjectInformationW: () => 0,
    getCurrentThreadId: () => 1,
    getCurrentProcess: () => 1,
    openProcess: () => 0,
    queryFullProcessImageNameW: () => 0,
    closeHandle: () => 1,
    globalAlloc: () => 1,
    globalLock: () => 1,
    globalUnlock: () => 1,
    globalFree: () => 0,
    rtlMoveMemory: () => {},
    openProcessToken: () => 0,
    getTokenIntegrityRid: () => 0x2000,
    cfExcludeMonitor: 0xc001,
    cfCanIncludeHistory: 0xc002,
    cfCanUploadCloud: 0xc003
  }
}

export function setWin32ApiForTest(api: Partial<Win32Api> | null): void {
  cachedSelfIntegrityRid = null
  if (api === null) {
    cachedApi = null
    testApiOverride = false
    return
  }
  cachedApi = {
    ...createDefaultMockApi(),
    ...api
  }
  testApiOverride = true
}

function ensureWin32(): Win32Api {
  if (cachedApi !== null) return cachedApi
  if (process.platform !== 'win32') {
    throw new Error('win32Input is only supported on win32')
  }
  const koffi = require('koffi') as typeof KoffiNS
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
  })
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
  })
  const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT })
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION })

  const inputSize = koffi.sizeof(INPUT)
  if (inputSize !== 40) {
    throw new Error(`INPUT size != 40 (got ${inputSize})`)
  }

  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')

  const sendInput = user32.func(
    'uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)'
  ) as (cInputs: number, pInputs: InputEvent[], cbSize: number) => number
  const getAsyncKeyState = user32.func(
    'int16 __stdcall GetAsyncKeyState(int vKey)'
  ) as (vKey: number) => number
  const getForegroundWindow = user32.func(
    'intptr_t __stdcall GetForegroundWindow()'
  ) as () => number
  const setForegroundWindow = user32.func(
    'int __stdcall SetForegroundWindow(intptr_t hWnd)'
  ) as (hWnd: number) => number
  const isWindow = user32.func(
    'int __stdcall IsWindow(intptr_t hWnd)'
  ) as (hWnd: number) => number
  const isIconic = user32.func(
    'int __stdcall IsIconic(intptr_t hWnd)'
  ) as (hWnd: number) => number
  const getWindowThreadProcessId = user32.func(
    'uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *lpdwProcessId)'
  ) as (hWnd: number, lpdwProcessId: number[]) => number
  const getClassNameW = user32.func(
    'int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint16 *lpClassName, int nMaxCount)'
  ) as (hWnd: number, lpClassName: Uint16Array, nMaxCount: number) => number
  const getWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ uint16 *lpString, int nMaxCount)'
  ) as (hWnd: number, lpString: Uint16Array, nMaxCount: number) => number
  const getClipboardSequenceNumber = user32.func(
    'uint32 __stdcall GetClipboardSequenceNumber()'
  ) as () => number
  const mapVirtualKeyW = user32.func(
    'uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)'
  ) as (uCode: number, uMapType: number) => number
  const attachThreadInput = user32.func(
    'int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)'
  ) as (idAttach: number, idAttachTo: number, fAttach: number) => number
  const registerClipboardFormatW = user32.func(
    'uint32 __stdcall RegisterClipboardFormatW(str16 lpszFormat)'
  ) as (lpszFormat: string) => number
  const openClipboard = user32.func(
    'int __stdcall OpenClipboard(intptr_t hWndNewOwner)'
  ) as (hWndNewOwner: number) => number
  const emptyClipboard = user32.func(
    'int __stdcall EmptyClipboard()'
  ) as () => number
  const setClipboardData = user32.func(
    'intptr_t __stdcall SetClipboardData(uint32 uFormat, intptr_t hMem)'
  ) as (uFormat: number, hMem: number) => number
  const closeClipboard = user32.func(
    'int __stdcall CloseClipboard()'
  ) as () => number
  const getThreadDesktop = user32.func(
    'intptr_t __stdcall GetThreadDesktop(uint32 dwThreadId)'
  ) as (dwThreadId: number) => number
  const getUserObjectInformationW = user32.func(
    'int __stdcall GetUserObjectInformationW(intptr_t hObj, int nIndex, _Out_ uint16 *pvInfo, uint32 nLength, _Out_ uint32 *lpnLengthNeeded)'
  ) as (
    hObj: number,
    nIndex: number,
    pvInfo: Uint16Array,
    nLength: number,
    lpnLengthNeeded: number[]
  ) => number

  const getCurrentThreadId = kernel32.func(
    'uint32 __stdcall GetCurrentThreadId()'
  ) as () => number
  const getCurrentProcess = kernel32.func(
    'intptr_t __stdcall GetCurrentProcess()'
  ) as () => number
  const openProcess = kernel32.func(
    'intptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)'
  ) as (dwDesiredAccess: number, bInheritHandle: number, dwProcessId: number) => number
  const queryFullProcessImageNameW = kernel32.func(
    'int __stdcall QueryFullProcessImageNameW(intptr_t hProcess, uint32 dwFlags, _Out_ uint16 *lpExeName, _Inout_ uint32 *lpdwSize)'
  ) as (
    hProcess: number,
    dwFlags: number,
    lpExeName: Uint16Array,
    lpdwSize: number[]
  ) => number
  const closeHandle = kernel32.func(
    'int __stdcall CloseHandle(intptr_t hObject)'
  ) as (hObject: number) => number
  const globalAlloc = kernel32.func(
    'intptr_t __stdcall GlobalAlloc(uint32 uFlags, uintptr_t dwBytes)'
  ) as (uFlags: number, dwBytes: number) => number
  const globalLock = kernel32.func(
    'intptr_t __stdcall GlobalLock(intptr_t hMem)'
  ) as (hMem: number) => number
  const globalUnlock = kernel32.func(
    'int __stdcall GlobalUnlock(intptr_t hMem)'
  ) as (hMem: number) => number
  const globalFree = kernel32.func(
    'intptr_t __stdcall GlobalFree(intptr_t hMem)'
  ) as (hMem: number) => number
  const rtlMoveMemory = kernel32.func(
    'void __stdcall RtlMoveMemory(intptr_t Destination, const uint8 *Source, uintptr_t Length)'
  ) as (destination: number, source: Uint8Array, length: number) => void

  const openProcessToken = advapi32.func(
    'int __stdcall OpenProcessToken(intptr_t ProcessHandle, uint32 DesiredAccess, _Out_ intptr_t *TokenHandle)'
  ) as (processHandle: number, desiredAccess: number, tokenHandle: number[]) => number
  const getTokenInformationRaw = advapi32.func(
    'int __stdcall GetTokenInformation(intptr_t TokenHandle, int TokenInformationClass, _Out_ uint8 *TokenInformation, uint32 TokenInformationLength, _Out_ uint32 *ReturnLength)'
  ) as (
    tokenHandle: number,
    tokenInformationClass: number,
    tokenInformation: Uint8Array,
    tokenInformationLength: number,
    returnLength: number[]
  ) => number
  const getSidSubAuthorityCount = advapi32.func(
    'void* __stdcall GetSidSubAuthorityCount(void* pSid)'
  ) as (pSid: unknown) => unknown
  const getSidSubAuthority = advapi32.func(
    'void* __stdcall GetSidSubAuthority(void* pSid, uint32 nSubAuthority)'
  ) as (pSid: unknown, nSubAuthority: number) => unknown

  const getTokenIntegrityRid = (tokenHandle: number): number | null => {
    const buf = new Uint8Array(128)
    const retLen = [0]
    let ok = getTokenInformationRaw(
      tokenHandle,
      TOKEN_INTEGRITY_LEVEL_CLASS,
      buf,
      buf.length,
      retLen
    )
    let activeBuf = buf
    if (!ok && (retLen[0] ?? 0) > buf.length) {
      activeBuf = new Uint8Array(retLen[0])
      ok = getTokenInformationRaw(
        tokenHandle,
        TOKEN_INTEGRITY_LEVEL_CLASS,
        activeBuf,
        activeBuf.length,
        retLen
      )
    }
    if (!ok) return null
    const pSid = koffi.decode(activeBuf, 'void*') as unknown
    if (!pSid) return null
    const pCount = getSidSubAuthorityCount(pSid)
    if (!pCount) return null
    const subCount = koffi.decode(pCount, 'uint8') as number
    if (subCount <= 0) return null
    const pRid = getSidSubAuthority(pSid, subCount - 1)
    if (!pRid) return null
    return (koffi.decode(pRid, 'uint32') as number) >>> 0
  }

  const cfExcludeMonitor = Number(
    registerClipboardFormatW('ExcludeClipboardContentFromMonitorProcessing')
  )
  const cfCanIncludeHistory = Number(registerClipboardFormatW('CanIncludeInClipboardHistory'))
  const cfCanUploadCloud = Number(registerClipboardFormatW('CanUploadToCloudClipboard'))

  cachedApi = {
    inputSize,
    sendInput,
    getAsyncKeyState,
    getForegroundWindow,
    setForegroundWindow,
    isWindow,
    isIconic,
    getWindowThreadProcessId,
    getClassNameW,
    getWindowTextW,
    getClipboardSequenceNumber,
    mapVirtualKeyW,
    attachThreadInput,
    registerClipboardFormatW,
    openClipboard,
    emptyClipboard,
    setClipboardData,
    closeClipboard,
    getThreadDesktop,
    getUserObjectInformationW,
    getCurrentThreadId,
    getCurrentProcess,
    openProcess,
    queryFullProcessImageNameW,
    closeHandle,
    globalAlloc,
    globalLock,
    globalUnlock,
    globalFree,
    rtlMoveMemory,
    openProcessToken,
    getTokenIntegrityRid,
    cfExcludeMonitor,
    cfCanIncludeHistory,
    cfCanUploadCloud
  }
  return cachedApi
}

export function makeKeyEvent(
  wVk: number,
  dwFlags: number,
  apiOverride?: Win32Api
): InputEvent {
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
      const flags = KEYEVENTF_KEYUP | (EXTENDED_VKS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0)
      prefix.push(makeKeyEvent(vk, flags, api))
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

/**
 * Pure classifier by executable basename (fallback when window class is generic).
 */
export function classifyExeName(exeName: string): WindowInputKind {
  const lower = exeName.trim().toLowerCase()
  if (WT_EXE_NAMES.has(lower)) return 'wt'
  if (CONHOST_EXE_NAMES.has(lower)) return 'conhost'
  return 'normal'
}

/**
 * Pure classifier combining Win32 window class name and executable name.
 * Checking window class first ensures console client processes (e.g. claude.exe, agy.exe,
 * python.exe, ssh.exe) running inside ConsoleWindowClass are never misclassified as 'normal'.
 */
export function classifyTerminalWindow(className: string, exeName: string): WindowInputKind {
  const lowerClass = className.trim().toLowerCase()
  if (WT_CLASS_NAMES.has(lowerClass)) return 'wt'
  if (CONHOST_CLASS_NAMES.has(lowerClass) || lowerClass.startsWith('cygwin/x')) return 'conhost'
  return classifyExeName(exeName)
}

export function classifyTerminalCopyKind(className: string, exeName: string): WindowInputKind {
  const lowerClass = className.trim().toLowerCase()
  if (WT_CLASS_NAMES.has(lowerClass)) return 'wt'
  if (CONHOST_CLASS_NAMES.has(lowerClass) || lowerClass.startsWith('cygwin/x')) return 'conhost'
  const lowerExe = exeName.trim().toLowerCase()
  if (CONHOST_COPY_PASTE_EXES.has(lowerExe)) return 'conhost'
  return classifyExeName(lowerExe)
}

export function classifyTerminalPasteKind(className: string, exeName: string): WindowInputKind {
  const lowerClass = className.trim().toLowerCase()
  if (WT_CLASS_NAMES.has(lowerClass)) return 'wt'
  if (CONHOST_CLASS_NAMES.has(lowerClass) || lowerClass.startsWith('cygwin/x')) return 'conhost'
  const lowerExe = exeName.trim().toLowerCase()
  if (CONHOST_COPY_PASTE_EXES.has(lowerExe)) return 'conhost'
  return classifyExeName(lowerExe)
}

/**
 * Pure check for taskbar, desktop wallpaper, or OS shell overlay window classes
 * that should never be recorded as a paste target.
 */
export function isNonTargetWindowClass(className: string): boolean {
  const lower = className.trim().toLowerCase()
  return lower === '' || NON_TARGET_WINDOW_CLASSES.has(lower)
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
    console.warn('[fp] getWindowExeName failed:', err)
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

export function classifyWindowKind(hwnd: number): WindowInputKind {
  return classifyTerminalPasteKind(getWindowClassName(hwnd), getWindowExeName(hwnd))
}

export function classifyWindowCopyKind(hwnd: number): WindowInputKind {
  return classifyTerminalCopyKind(getWindowClassName(hwnd), getWindowExeName(hwnd))
}

export function classifyWindowPasteKind(hwnd: number): WindowInputKind {
  return classifyTerminalPasteKind(getWindowClassName(hwnd), getWindowExeName(hwnd))
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

export function captureExternalTargetHwnd(selfPid = process.pid): number {
  const hwnd = getForegroundWindow()
  if (!isValidExternalTargetWindow(hwnd, selfPid)) return 0
  return hwnd
}

function getSelfIntegrityRid(api: Win32Api): number | null {
  if (!testApiOverride && cachedSelfIntegrityRid !== null) {
    return cachedSelfIntegrityRid
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
      if (!testApiOverride && rid !== null) {
        cachedSelfIntegrityRid = rid
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
 */
export function isWindowElevatedOverSelf(hwnd: number, selfPid = process.pid): boolean {
  if (!hwnd) return false
  try {
    const api = ensureWin32()
    const selfRid = getSelfIntegrityRid(api)
    if (selfRid !== null && selfRid >= SECURITY_MANDATORY_HIGH_RID) {
      return false
    }

    const pid = getWindowPid(hwnd)
    if (pid <= 0 || pid === selfPid) return false

    const hProc = Number(api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))
    if (hProc === 0) {
      // Cannot open even LIMITED_INFORMATION -> protected / higher-integrity process
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
        const baselineRid = selfRid ?? 0x2000
        return targetRid > baselineRid
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

export const isBlockedByUipi = isWindowElevatedOverSelf

export function setForegroundWindow(hwnd: number): boolean {
  if (!hwnd) return false
  try {
    const api = ensureWin32()
    return api.setForegroundWindow(hwnd) !== 0
  } catch (err) {
    console.warn('[fp] setForegroundWindow failed:', err)
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

    // Unlock Win32 foreground lock with benign mask key before AttachThreadInput handoff
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
    console.warn('[fp] focusWindow failed:', err)
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
 * (`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory=0`,
 * `CanUploadToCloudClipboard=0`) so sentinels and transient translations never pollute
 * `Win+V` Clipboard History, Cloud Sync, or third-party clipboard managers.
 */
export async function writePrivateClipboardText(text: string): Promise<boolean> {
  if (!testApiOverride && process.platform !== 'win32') return false
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
    console.warn('[fp] writePrivateClipboardText failed:', err)
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
      const flags = KEYEVENTF_KEYUP | (EXTENDED_VKS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0)
      events.push(makeKeyEvent(vk, flags, api))
    }

    try {
      sendEvents(events)
    } catch (err) {
      console.warn('[fp] releaseModifiers SendInput warning:', err)
    }

    await sleep(10)
    const remaining = getDownModifiers(api)
    for (const vk of remaining) {
      console.log(`[fp] modifier still down: 0x${vk.toString(16)}`)
    }
  } catch (err) {
    console.warn('[fp] releaseModifiers failed:', err)
  }
}

export function sendCtrlC(): void {
  sendChordWithModifierGuard((api) => [
    makeKeyEvent(VK_LCONTROL, 0, api),
    makeKeyEvent(VK_C, 0, api),
    makeKeyEvent(VK_C, KEYEVENTF_KEYUP, api),
    makeKeyEvent(VK_LCONTROL, KEYEVENTF_KEYUP, api)
  ])
}

export function sendCtrlV(): void {
  sendChordWithModifierGuard((api) => [
    makeKeyEvent(VK_LCONTROL, 0, api),
    makeKeyEvent(VK_V, 0, api),
    makeKeyEvent(VK_V, KEYEVENTF_KEYUP, api),
    makeKeyEvent(VK_LCONTROL, KEYEVENTF_KEYUP, api)
  ])
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
  sendCtrlC()
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
  sendCtrlV()
}

export async function sendBackspaces(charCount: number): Promise<void> {
  const safeCount = Math.min(MAX_BACKSPACE_CHARS, Math.max(0, Math.floor(charCount)))
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
 * Isolated CLI sandboxes (such as "exebox-*") return a non-Default name, allowing main boot to refuse
 * hijacking the single-instance lock on an invisible desktop.
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
