import type * as KoffiNS from 'koffi'

const TOKEN_INTEGRITY_LEVEL_CLASS = 25

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

export function hasTestWin32ApiOverride(): boolean {
  return testApiOverride
}

export function getCachedSelfRid(): number | null {
  return cachedSelfIntegrityRid
}

export function setCachedSelfRid(rid: number | null): void {
  cachedSelfIntegrityRid = rid
}

export function ensureWin32(): Win32Api {
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
