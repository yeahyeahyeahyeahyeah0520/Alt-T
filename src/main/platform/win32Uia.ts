import fs from 'node:fs'
import { join } from 'node:path'
import { Worker, isMainThread } from 'node:worker_threads'
import type * as KoffiNS from 'koffi'
import type { IdeProbeResult, UiaProbeReason } from '../../shared/types'

let uiaWarnLogger: ((msg: string) => void) | null = null
let lastUiaInitError = ''

function logWarn(msg: string): void {
  lastUiaInitError = msg
  uiaWarnLogger?.(msg)
}

export function setUiaWarnLogger(fn: ((msg: string) => void) | null): void {
  uiaWarnLogger = fn
}

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
  if (isMainThread) {
    return []
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
const UIA_EDIT_CONTROL_TYPE = 50004
const UIA_DOCUMENT_CONTROL_TYPE = 50030
const UIA_PROBE_TIMEOUT_MS = 120
const UIA_CIRCUIT_BREAKER_THRESHOLD = 3
const UIA_CIRCUIT_OPEN_MS = 15_000

const EXPLICIT_TERMINAL_CLASS_TOKENS = new Set<string>([
  'xterm',
  'xterm-screen',
  'xterm-helper-textarea',
  'xterm-accessibility-tree',
  'terminal-wrapper',
  'integrated-terminal',
  'terminal-outer-container'
])

const NON_EDITOR_CLASS_TOKENS = new Set<string>([
  'chat-input',
  'interactive-input-part',
  'interactive-editor',
  'scm-editor',
  'find-widget',
  'simple-find-part',
  'suggest-widget',
  'quick-input-widget',
  'repl-input-wrapper',
  'debug-repl',
  'notebook-cell-output'
])

function splitClassTokens(className: string): Set<string> {
  return new Set(
    className
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  )
}

function isExplicitTerminalUiaNode(node: UiaNodeInfo): boolean {
  const tokens = splitClassTokens(node.className)
  for (const token of EXPLICIT_TERMINAL_CLASS_TOKENS) {
    if (tokens.has(token)) return true
  }
  const classLower = node.className.trim().toLowerCase()
  const aidLower = node.automationId.trim().toLowerCase()
  if (
    classLower.includes('jediterm') ||
    classLower.includes('terminalpanel') ||
    classLower.includes('terminalwidget')
  ) {
    return true
  }
  if (
    aidLower === 'terminal' ||
    aidLower === 'workbench.panel.terminal' ||
    aidLower.startsWith('workbench.parts.terminal')
  ) {
    return true
  }
  return false
}

function isExcludedNonEditorNode(node: UiaNodeInfo): boolean {
  const tokens = splitClassTokens(node.className)
  for (const token of NON_EDITOR_CLASS_TOKENS) {
    if (tokens.has(token)) return true
  }
  const aidLower = node.automationId.trim().toLowerCase()
  return (
    aidLower.includes('workbench.view.scm') ||
    aidLower.includes('workbench.panel.chat') ||
    aidLower.includes('workbench.view.search') ||
    aidLower.includes('workbench.panel.repl') ||
    aidLower.includes('chat-input') ||
    aidLower.includes('scm-input')
  )
}

export function classifyUiaChain(nodes: UiaNodeInfo[], targetPid: number): IdeProbeResult {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { region: 'unknown', reason: 'uia-empty' }
  }
  const matchingNodes = nodes.filter(
    (node) => targetPid <= 0 || node.pid <= 0 || node.pid === targetPid
  )
  if (matchingNodes.length === 0) {
    return { region: 'unknown', reason: 'uia-pid-mismatch' }
  }
  for (const node of matchingNodes) {
    if (isExplicitTerminalUiaNode(node)) {
      return { region: 'terminal', reason: 'uia-terminal' }
    }
  }
  for (const node of matchingNodes) {
    if (isExcludedNonEditorNode(node)) {
      return { region: 'unknown', reason: 'uia-empty' }
    }
  }
  const hasEditOrDoc = matchingNodes.some(
    (node) => node.controlType === UIA_EDIT_CONTROL_TYPE || node.controlType === UIA_DOCUMENT_CONTROL_TYPE
  )
  const hasEditorLeafToken = matchingNodes.some((node) => {
    const tokens = splitClassTokens(node.className)
    return tokens.has('inputarea') || tokens.has('native-edit-context')
  })
  const hasEditorHost = matchingNodes.some((node) => {
    const tokens = splitClassTokens(node.className)
    const aidLower = node.automationId.trim().toLowerCase()
    return tokens.has('editor-instance') || aidLower.startsWith('workbench.parts.editor')
  })
  const hasMonacoToken = matchingNodes.some((node) => splitClassTokens(node.className).has('monaco-editor'))
  const hasExplicitSingleEditorNode =
    !hasMonacoToken &&
    matchingNodes.some((node) => {
      const tokens = splitClassTokens(node.className)
      return (
        (node.controlType === UIA_EDIT_CONTROL_TYPE || node.controlType === UIA_DOCUMENT_CONTROL_TYPE) &&
        node.automationId.trim().toLowerCase() === 'editor' &&
        (tokens.has('inputarea') || tokens.has('native-edit-context'))
      )
    })
  const hasJetBrainsEditor = matchingNodes.some((node) => {
    const cl = node.className.toLowerCase()
    return (
      (cl.includes('editorcomponentimpl') || cl.includes('editorimpl')) &&
      (node.controlType === UIA_EDIT_CONTROL_TYPE || node.controlType === UIA_DOCUMENT_CONTROL_TYPE)
    )
  })
  if ((hasEditOrDoc && hasEditorLeafToken && hasEditorHost) || hasExplicitSingleEditorNode || hasJetBrainsEditor) {
    return { region: 'editor', reason: 'uia-editor' }
  }
  if (!hasEditorLeafToken) {
    for (const node of matchingNodes) {
      if (isIdeTerminalUiaNode(node)) {
        return { region: 'terminal', reason: 'uia-terminal' }
      }
    }
  }
  return { region: 'unknown', reason: 'uia-empty' }
}

export interface UiaWorkerRequest {
  id: number
  targetPid: number
}

export interface UiaWorkerReply {
  id: number
  ok: boolean
  nodes: UiaNodeInfo[]
  error?: string
}

export interface UiaWorkerLike {
  postMessage(value: UiaWorkerRequest): void
  on(event: 'message', listener: (value: UiaWorkerReply) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  off?(event: 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
  removeListener?(event: 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
  terminate(): Promise<number>
  unref?(): void
}

let activeUiaWorker: UiaWorkerLike | null = null
let workerFactoryOverride: (() => UiaWorkerLike) | null = null
let nextProbeRequestId = 1
let consecutiveUiaFailures = 0
let uiaCircuitOpenUntil = 0
let lastUiaFailureReason: UiaProbeReason = 'uia-error'
let probeQueue: Promise<void> = Promise.resolve()

export function setUiaWorkerFactoryForTest(factory: (() => UiaWorkerLike) | null): void {
  workerFactoryOverride = factory
  consecutiveUiaFailures = 0
  uiaCircuitOpenUntil = 0
  lastUiaFailureReason = 'uia-error'
  if (activeUiaWorker) {
    const old = activeUiaWorker
    activeUiaWorker = null
    void old.terminate().catch(() => {})
  }
}

export async function shutdownWin32UiaWorker(): Promise<void> {
  if (!activeUiaWorker) return
  const worker = activeUiaWorker
  activeUiaWorker = null
  await worker.terminate().catch(() => {})
}

function createDefaultUiaWorker(): UiaWorkerLike {
  const jsPath = join(__dirname, 'win32UiaWorker.js')
  if (fs.existsSync(jsPath)) {
    const w = new Worker(jsPath)
    w.unref()
    return w
  }
  const tsPath = join(__dirname, 'win32UiaWorker.ts')
  const bootstrap = `require(${JSON.stringify(require.resolve('tsx/cjs'))}); require(${JSON.stringify(tsPath)});`
  const w = new Worker(bootstrap, { eval: true })
  w.unref()
  return w
}

function getOrCreateUiaWorker(): UiaWorkerLike {
  if (activeUiaWorker) return activeUiaWorker
  activeUiaWorker = workerFactoryOverride ? workerFactoryOverride() : createDefaultUiaWorker()
  return activeUiaWorker
}

function detachListener(
  worker: UiaWorkerLike,
  event: 'message' | 'error' | 'exit',
  listener: (...args: unknown[]) => void
): void {
  if (typeof worker.off === 'function') {
    worker.off(event, listener)
  } else if (typeof worker.removeListener === 'function') {
    worker.removeListener(event, listener)
  }
}

function recordUiaFailure(reason: UiaProbeReason): void {
  consecutiveUiaFailures += 1
  lastUiaFailureReason = reason
  if (consecutiveUiaFailures >= UIA_CIRCUIT_BREAKER_THRESHOLD) {
    uiaCircuitOpenUntil = Date.now() + UIA_CIRCUIT_OPEN_MS
  }
}

function resetUiaFailures(): void {
  consecutiveUiaFailures = 0
  uiaCircuitOpenUntil = 0
}

function runWorkerProbeOnce(targetPid: number, timeoutMs: number): Promise<IdeProbeResult> {
  if (uiaCircuitOpenUntil > Date.now()) {
    return Promise.resolve({ region: 'unknown', reason: lastUiaFailureReason })
  }
  let worker: UiaWorkerLike
  try {
    worker = getOrCreateUiaWorker()
  } catch (err) {
    uiaWarnLogger?.(`UIA worker spawn failed: ${err instanceof Error ? err.message : String(err)}`)
    recordUiaFailure('uia-error')
    return Promise.resolve({ region: 'unknown', reason: 'uia-error' })
  }

  const reqId = nextProbeRequestId++
  return new Promise<IdeProbeResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      detachListener(worker, 'message', onMessage as (...args: unknown[]) => void)
      detachListener(worker, 'error', onError as (...args: unknown[]) => void)
      detachListener(worker, 'exit', onExit as (...args: unknown[]) => void)
    }

    const finish = (result: IdeProbeResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const onMessage = (reply: UiaWorkerReply): void => {
      if (!reply || reply.id !== reqId) return
      if (!reply.ok) {
        const reason: UiaProbeReason =
          reply.error === 'uia-unavailable' ? 'uia-unavailable' : 'uia-error'
        if (reply.error && reply.error !== 'uia-unavailable') {
          uiaWarnLogger?.(`Win32 UIA worker error: ${reply.error}`)
        }
        recordUiaFailure(reason)
        finish({ region: 'unknown', reason })
        return
      }
      resetUiaFailures()
      finish(classifyUiaChain(reply.nodes, targetPid))
    }

    const onError = (err: Error): void => {
      uiaWarnLogger?.(`Win32 UIA worker exception: ${err.message}`)
      if (activeUiaWorker === worker) activeUiaWorker = null
      void worker.terminate().catch(() => {})
      recordUiaFailure('uia-error')
      finish({ region: 'unknown', reason: 'uia-error' })
    }

    const onExit = (): void => {
      if (activeUiaWorker === worker) activeUiaWorker = null
      recordUiaFailure('uia-error')
      finish({ region: 'unknown', reason: 'uia-error' })
    }

    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)

    timer = setTimeout(() => {
      if (activeUiaWorker === worker) activeUiaWorker = null
      void worker.terminate().catch(() => {})
      recordUiaFailure('uia-timeout')
      finish({ region: 'unknown', reason: 'uia-timeout' })
    }, timeoutMs)

    try {
      worker.postMessage({ id: reqId, targetPid })
    } catch (err) {
      if (activeUiaWorker === worker) activeUiaWorker = null
      void worker.terminate().catch(() => {})
      uiaWarnLogger?.(
        `Win32 UIA worker postMessage failed: ${err instanceof Error ? err.message : String(err)}`
      )
      recordUiaFailure('uia-error')
      finish({ region: 'unknown', reason: 'uia-error' })
    }
  })
}

export function walkFocusedElementChainNative(targetPid: number): {
  ok: boolean
  nodes: UiaNodeInfo[]
  error?: string
} {
  if (targetPid <= 0) return { ok: true, nodes: [] }
  const bindings = ensureUia()
  if (!bindings) {
    return {
      ok: false,
      nodes: [],
      error: lastUiaInitError || 'uia-unavailable'
    }
  }
  const nodes = walkFocusedElementChain(targetPid)
  return { ok: true, nodes }
}

export async function probeFocusedIdeRegion(
  targetPid: number,
  exeName: string,
  options?: { timeoutMs?: number }
): Promise<IdeProbeResult> {
  if (!isIdeHostExeName(exeName)) {
    return { region: 'unknown', reason: 'uia-empty' }
  }
  if (testUiaWalkerOverride !== null) {
    try {
      return classifyUiaChain(testUiaWalkerOverride(targetPid), targetPid)
    } catch {
      return { region: 'unknown', reason: 'uia-error' }
    }
  }
  if (process.platform !== 'win32' && workerFactoryOverride === null) {
    return { region: 'unknown', reason: 'uia-unavailable' }
  }
  const timeoutMs = Math.max(10, options?.timeoutMs ?? UIA_PROBE_TIMEOUT_MS)
  const task = probeQueue.then(() => runWorkerProbeOnce(targetPid, timeoutMs))
  probeQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

export function isFocusedIdeIntegratedTerminal(targetPid: number, exeName: string): boolean {
  if (!isIdeHostExeName(exeName)) return false
  if (testUiaWalkerOverride === null) return false
  return classifyUiaChain(testUiaWalkerOverride(targetPid), targetPid).region === 'terminal'
}
