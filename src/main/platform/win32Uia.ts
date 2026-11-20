import type * as KoffiNS from 'koffi'
import { logWarn } from '../services/logger'

export interface UiaNodeInfo {
  pid: number
  controlType: number
  name: string
  automationId: string
  className: string
}

const IDE_HOST_EXE_NAMES = new Set<string>([
  'code.exe',
  'code - insiders.exe',
  'cursor.exe',
  'windsurf.exe',
  'antigravity.exe',
  'vscodium.exe',
  'trae.exe'
])

const CODE_FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|py|go|rs|java|c|cpp|h|hpp|cs|md|json|yml|yaml|toml|sh|ps1|bat|cmd|txt|html|css|scss|sql)\b/i
const TERMINAL_NAME_RE =
  /(?:^|[\s,:-])(?:terminal(?:\s+\d+|\s+input|\s+integrated|\s*$|,|\s*-)|interactive\s+terminal|xterm|\u7ec8\u7aef(?:\s*\d+|\s*\u8f93\u5165|\s*$|\uff0c|,|\s*-))/i

const MAX_ANCESTOR_HOPS = 6
const UIA_WALK_BUDGET_MS = 30
const COINIT_APARTMENTTHREADED = 2
const CLSCTX_INPROC_SERVER = 1

export function isIdeHostExeName(exeName: string): boolean {
  return IDE_HOST_EXE_NAMES.has(exeName.trim().toLowerCase())
}

/**
 * Pure heuristic deciding whether a Windows UI Automation node represents an IDE
 * integrated terminal panel (e.g. VS Code / Cursor / Antigravity xterm.js pane)
 * rather than a source code editor tab whose filename happens to include "terminal".
 */
export function isIdeTerminalUiaNode(node: UiaNodeInfo): boolean {
  const cls = node.className.trim().toLowerCase()
  if (cls.includes('xterm')) {
    return true
  }

  const autoId = node.automationId.trim().toLowerCase()
  if (autoId.includes('workbench.panel.terminal') || autoId.includes('xterm')) {
    return true
  }

  const name = node.name.trim()
  if (name === '' || CODE_FILE_EXT_RE.test(name)) {
    return false
  }
  return TERMINAL_NAME_RE.test(name)
}

interface UiaComBindings {
  koffi: typeof KoffiNS
  uia: unknown
  uiaSlots: unknown[]
  walker: unknown | null
  walkerSlots: unknown[] | null
  releaseProto: KoffiNS.IKoffiCType
  getFocusedProto: KoffiNS.IKoffiCType
  getParentProto: KoffiNS.IKoffiCType
  getInt32Proto: KoffiNS.IKoffiCType
  getBstrProto: KoffiNS.IKoffiCType
  sysStringLen: (bstr: unknown) => number
  sysFreeString: (bstr: unknown) => void
}

let cachedUia: UiaComBindings | null = null
let uiaInitAttempted = false
let testUiaWalkerOverride: ((targetPid: number) => UiaNodeInfo[]) | null = null

export function setWin32UiaForTest(fn: ((targetPid: number) => UiaNodeInfo[]) | null): void {
  testUiaWalkerOverride = fn
}

function guidToBytes(guid: string): Buffer {
  const hex = guid.replace(/[{}-]/g, '')
  const buf = Buffer.alloc(16)
  buf.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0)
  buf.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4)
  buf.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6)
  for (let i = 0; i < 8; i++) {
    buf[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16)
  }
  return buf
}

function ensureUia(): UiaComBindings | null {
  if (uiaInitAttempted) return cachedUia
  uiaInitAttempted = true
  if (process.platform !== 'win32') return null

  try {
    const koffi = require('koffi') as typeof KoffiNS
    const ole32 = koffi.load('ole32.dll')
    const oleaut32 = koffi.load('oleaut32.dll')

    const coInitializeEx = ole32.func(
      'long __stdcall CoInitializeEx(void *pvReserved, uint32 dwCoInit)'
    ) as (pvReserved: unknown, dwCoInit: number) => number
    const coCreateInstance = ole32.func(
      'long __stdcall CoCreateInstance(const uint8 *rclsid, void *pUnkOuter, uint32 dwClsContext, const uint8 *riid, _Out_ void **ppv)'
    ) as (
      rclsid: Buffer,
      pUnkOuter: unknown,
      dwClsContext: number,
      riid: Buffer,
      ppv: unknown[]
    ) => number
    const sysStringLen = oleaut32.func('uint32 __stdcall SysStringLen(void *bstr)') as (
      bstr: unknown
    ) => number
    const sysFreeString = oleaut32.func('void __stdcall SysFreeString(void *bstr)') as (
      bstr: unknown
    ) => void

    // Electron already initializes STA COM on the main thread; S_FALSE / RPC_E_CHANGED_MODE are harmless.
    coInitializeEx(null, COINIT_APARTMENTTHREADED)

    const clsidCUIAutomation = guidToBytes('{FF48DBA4-60EF-4201-AA87-54103EEF594E}')
    const iidIUIAutomation = guidToBytes('{30CBE57D-D9D0-452A-AB13-7AC5AC4825EE}')
    const outUia: unknown[] = [null]
    const hrCreate = coCreateInstance(
      clsidCUIAutomation,
      null,
      CLSCTX_INPROC_SERVER,
      iidIUIAutomation,
      outUia
    )
    if (hrCreate !== 0 || !outUia[0]) {
      return null
    }

    const uia = outUia[0]
    const uiaVtbl = koffi.decode(uia, 'void*') as unknown
    const uiaSlots = koffi.decode(uiaVtbl, koffi.array('void*', 20)) as unknown[]

    const releaseProto = koffi.proto('uint32 __stdcall UiaRelease(void *self)')
    const getFocusedProto = koffi.proto(
      'long __stdcall UiaGetFocusedElement(void *self, _Out_ void **elem)'
    )
    const getWalkerProto = koffi.proto(
      'long __stdcall UiaGetControlViewWalker(void *self, _Out_ void **walker)'
    )
    const getParentProto = koffi.proto(
      'long __stdcall UiaGetParentElement(void *self, void *elem, _Out_ void **parent)'
    )
    const getInt32Proto = koffi.proto(
      'long __stdcall UiaGetInt32(void *self, _Out_ int32 *retVal)'
    )
    const getBstrProto = koffi.proto(
      'long __stdcall UiaGetBstr(void *self, _Out_ void **retVal)'
    )

    const outWalker: unknown[] = [null]
    const getWalkerFn = koffi.decode(uiaSlots[14], getWalkerProto) as (
      self: unknown,
      out: unknown[]
    ) => number
    const hrWalker = getWalkerFn(uia, outWalker)
    const walker = hrWalker === 0 && outWalker[0] ? outWalker[0] : null
    const walkerSlots = walker
      ? (koffi.decode(koffi.decode(walker, 'void*'), koffi.array('void*', 8)) as unknown[])
      : null

    cachedUia = {
      koffi,
      uia,
      uiaSlots,
      walker,
      walkerSlots,
      releaseProto,
      getFocusedProto,
      getParentProto,
      getInt32Proto,
      getBstrProto,
      sysStringLen,
      sysFreeString
    }
    return cachedUia
  } catch (err) {
    logWarn(`Win32 UI Automation init failed: ${err instanceof Error ? err.message : String(err)}`)
    cachedUia = null
    return null
  }
}

function readBstrSafe(bindings: UiaComBindings, ptr: unknown): string {
  if (!ptr) return ''
  try {
    const len = bindings.sysStringLen(ptr)
    if (len === 0) return ''
    const chars = bindings.koffi.decode(ptr, 'uint16', len) as Uint16Array
    return Buffer.from(chars.buffer, chars.byteOffset, chars.byteLength).toString('utf16le')
  } finally {
    bindings.sysFreeString(ptr)
  }
}

function releaseComPtr(bindings: UiaComBindings, ptr: unknown): void {
  if (!ptr) return
  try {
    const slots = bindings.koffi.decode(
      bindings.koffi.decode(ptr, 'void*'),
      bindings.koffi.array('void*', 3)
    ) as unknown[]
    const releaseFn = bindings.koffi.decode(slots[2], bindings.releaseProto) as (
      self: unknown
    ) => number
    releaseFn(ptr)
  } catch {
    // Best effort COM release
  }
}

function walkFocusedElementChain(targetPid: number): UiaNodeInfo[] {
  if (testUiaWalkerOverride !== null) {
    return testUiaWalkerOverride(targetPid)
  }
  if (targetPid <= 0) return []
  const bindings = ensureUia()
  if (!bindings) return []

  const startedAt = Date.now()
  const outElem: unknown[] = [null]
  try {
    const getFocusedFn = bindings.koffi.decode(
      bindings.uiaSlots[8],
      bindings.getFocusedProto
    ) as (self: unknown, out: unknown[]) => number
    if (getFocusedFn(bindings.uia, outElem) !== 0 || !outElem[0]) {
      return []
    }
  } catch {
    return []
  }

  const nodes: UiaNodeInfo[] = []
  let current: unknown = outElem[0]

  try {
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS && current; hop++) {
      if (Date.now() - startedAt > UIA_WALK_BUDGET_MS) {
        break
      }
      const eSlots = bindings.koffi.decode(
        bindings.koffi.decode(current, 'void*'),
        bindings.koffi.array('void*', 36)
      ) as unknown[]

      const getInt32Pid = bindings.koffi.decode(eSlots[20], bindings.getInt32Proto) as (
        self: unknown,
        out: number[]
      ) => number
      const getInt32Ctrl = bindings.koffi.decode(eSlots[21], bindings.getInt32Proto) as (
        self: unknown,
        out: number[]
      ) => number
      const getName = bindings.koffi.decode(eSlots[23], bindings.getBstrProto) as (
        self: unknown,
        out: unknown[]
      ) => number
      const getAutoId = bindings.koffi.decode(eSlots[29], bindings.getBstrProto) as (
        self: unknown,
        out: unknown[]
      ) => number
      const getClassName = bindings.koffi.decode(eSlots[30], bindings.getBstrProto) as (
        self: unknown,
        out: unknown[]
      ) => number

      const pidOut = [0]
      const ctrlOut = [0]
      const nameOut: unknown[] = [null]
      const autoOut: unknown[] = [null]
      const clsOut: unknown[] = [null]

      getInt32Pid(current, pidOut)
      const pid = pidOut[0] ?? 0
      if (hop === 0 && pid > 0 && pid !== targetPid) {
        break
      }

      getInt32Ctrl(current, ctrlOut)
      getName(current, nameOut)
      getAutoId(current, autoOut)
      getClassName(current, clsOut)

      nodes.push({
        pid,
        controlType: ctrlOut[0] ?? 0,
        name: readBstrSafe(bindings, nameOut[0]),
        automationId: readBstrSafe(bindings, autoOut[0]),
        className: readBstrSafe(bindings, clsOut[0])
      })

      if (!bindings.walker || !bindings.walkerSlots) {
        break
      }

      const parentOut: unknown[] = [null]
      const getParentFn = bindings.koffi.decode(
        bindings.walkerSlots[3],
        bindings.getParentProto
      ) as (self: unknown, elem: unknown, out: unknown[]) => number
      const hrParent = getParentFn(bindings.walker, current, parentOut)
      releaseComPtr(bindings, current)
      current = hrParent === 0 && parentOut[0] ? parentOut[0] : null
    }
  } catch {
    // Never let UIA exceptions disrupt shortcut dispatch
  } finally {
    if (current) {
      releaseComPtr(bindings, current)
    }
  }

  return nodes
}

/**
 * Detect whether the currently focused accessibility element inside an Electron IDE window
 * (`code.exe`, `cursor.exe`, `antigravity.exe`, etc.) belongs to an integrated terminal pane.
 */
export function isFocusedIdeIntegratedTerminal(targetPid: number, exeName: string): boolean {
  if (!isIdeHostExeName(exeName)) return false
  const nodes = walkFocusedElementChain(targetPid)
  for (const node of nodes) {
    if (node.pid > 0 && targetPid > 0 && node.pid !== targetPid) continue
    if (isIdeTerminalUiaNode(node)) {
      return true
    }
  }
  return false
}
