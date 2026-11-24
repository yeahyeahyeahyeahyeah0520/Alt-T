import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig, type NotifyPush, type PopupShowPush } from '../src/shared/types'
import { MSG } from '../src/shared/messages'
import type { ClipboardSnapshot } from '../src/main/platform/clipboardBackup'
import {
  classifyUiaChain,
  probeFocusedIdeRegion,
  resolveUiaWorkerTarget,
  setUiaWorkerFactoryForTest,
  setWin32UiaForTest,
  shutdownWin32UiaWorker,
  toUnpackedAsarPath,
  type UiaWorkerLike,
  type UiaWorkerReply,
  type UiaWorkerRequest
} from '../src/main/platform/win32Uia'
import { resolveIdeWindowClassification } from '../src/main/platform/win32Classifier'
import {
  configureSelectionService,
  pasteTextToWindow,
  runSelectionFlow,
  setSelectionRuntimeForTest,
  type SelectionRuntimeDeps
} from '../src/main/services/selectionService'

function createStubConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides
  }
}

class FakeUiaWorker extends EventEmitter implements UiaWorkerLike {
  terminated = false
  requests: UiaWorkerRequest[] = []
  private readonly responder: (req: UiaWorkerRequest, worker: FakeUiaWorker) => void

  constructor(responder: (req: UiaWorkerRequest, worker: FakeUiaWorker) => void) {
    super()
    this.responder = responder
  }

  postMessage(value: UiaWorkerRequest): void {
    this.requests.push(value)
    this.responder(value, this)
  }

  async terminate(): Promise<number> {
    this.terminated = true
    return 0
  }

  unref(): void {}

  emitReply(reply: UiaWorkerReply): void {
    this.emit('message', reply)
  }
}

interface MockHarness {
  runtime: SelectionRuntimeDeps
  copyCalls: string[]
  pasteCalls: string[]
  backspaces: number[]
  plainWrites: string[]
  transientWrites: string[]
  restoreCount: () => number
  restoreIfUnchangedCount: () => number
  notifications: string[]
  popupNotifications: NotifyPush[]
  popupShows: PopupShowPush[]
  popupHiddenCount: () => number
  popupReshowCount: () => number
  directInputHandles: number[]
  setActiveHandle: (h: number) => void
  setPid: (pid: number) => void
  setExeName: (exe: string) => void
  setClassName: (cls: string) => void
  setTitle: (title: string) => void
  setAlive: (alive: boolean) => void
  setMinimized: (min: boolean) => void
  setElevated: (elevated: boolean) => void
  setClipboardText: (txt: string) => void
}

function createHarness(opts?: {
  cfg?: Partial<AppConfig>
  initialClipboard?: string
  pid?: number
  exeName?: string
  className?: string
  title?: string
  classification?: ReturnType<NonNullable<SelectionRuntimeDeps['host']['getTargetWindowClassification']>> extends Promise<infer T>
    ? T
    : never
  onBackspaceBatch?: (batchIndex: number, count: number, harness: MockHarness) => void
  onWriteTransient?: (text: string, harness: MockHarness) => void
}): MockHarness {
  let activeHandle = 500
  let pid = opts?.pid ?? 4200
  let exeName = opts?.exeName ?? 'notepad.exe'
  let className = opts?.className ?? 'Notepad'
  let title = opts?.title ?? 'Untitled'
  let alive = true
  let minimized = false
  let elevated = false
  let clipboardText = opts?.initialClipboard ?? 'old clipboard'
  let clipSeq = 1
  let restores = 0
  let restoresIfUnchanged = 0
  let hideCalls = 0
  let reshowCalls = 0
  let batchCounter = 0

  const copyCalls: string[] = []
  const pasteCalls: string[] = []
  const backspaces: number[] = []
  const plainWrites: string[] = []
  const transientWrites: string[] = []
  const notifications: string[] = []
  const popupNotifications: NotifyPush[] = []
  const popupShows: PopupShowPush[] = []
  const directInputHandles: number[] = []

  const cfg = createStubConfig(opts?.cfg)

  const runtime: SelectionRuntimeDeps = {
    clipboard: {
      readText: async () => clipboardText,
      writeText: async (txt) => {
        clipboardText = txt
        clipSeq += 1
        plainWrites.push(txt)
      }
    },
    clipboardBackup: {
      backupClipboard: async (): Promise<ClipboardSnapshot> => ({
        text: clipboardText,
        html: '',
        rtf: '',
        imageBlob: null,
        imageMime: null,
        formats: ['text/plain']
      }),
      writeSentinel: async () => '__ALT_T_SENTINEL__',
      writeTransientClipboardText: async (txt) => {
        clipboardText = txt
        clipSeq += 1
        transientWrites.push(txt)
        opts?.onWriteTransient?.(txt, harness)
      },
      restoreClipboard: async (snap) => {
        clipboardText = snap.text ?? ''
        restores += 1
      },
      restoreClipboardIfUnchanged: async (snap, injected, seqAtWrite) => {
        if ((seqAtWrite ?? 0) > 0 && clipSeq !== seqAtWrite) return
        if (clipboardText !== injected) return
        clipboardText = snap.text ?? ''
        restoresIfUnchanged += 1
      }
    },
    host: {
      canInjectKeystrokes: () => true,
      getActiveTargetHandle: () => activeHandle,
      isTargetAlive: () => alive,
      isTargetMinimized: () => minimized,
      isOwnProcessWindow: () => false,
      isWindowElevatedOverSelf: () => elevated,
      focusTarget: (h) => {
        activeHandle = h
        return true
      },
      getClipboardSequenceNumber: () => clipSeq,
      getTargetCopyKind: () => opts?.classification?.inputKind ?? 'normal',
      getTargetPasteKind: () => opts?.classification?.inputKind ?? 'normal',
      getTargetExeName: () => exeName,
      getTargetClassName: () => className,
      getTargetPid: () => pid,
      getTargetWindowClassification: opts?.classification
        ? async () => opts.classification!
        : undefined,
      getWindowTitle: () => title,
      dispatchCopyShortcut: (kind) => {
        copyCalls.push(kind)
      },
      dispatchBackspaces: async (count) => {
        batchCounter += 1
        backspaces.push(count)
        opts?.onBackspaceBatch?.(batchCounter, count, harness)
      },
      dispatchPasteShortcut: (kind) => {
        pasteCalls.push(kind)
      },
      releasePressedModifiers: async () => {}
    },
    configStore: {
      get: () => cfg,
      addHistory: () => cfg
    },
    notifySystem: (msg) => {
      notifications.push(msg)
    },
    sleep: async () => {},
    now: () => Date.now(),
    watchdogTimeoutMs: 5000
  }

  const harness: MockHarness = {
    runtime,
    copyCalls,
    pasteCalls,
    backspaces,
    plainWrites,
    transientWrites,
    restoreCount: () => restores,
    restoreIfUnchangedCount: () => restoresIfUnchanged,
    notifications,
    popupNotifications,
    popupShows,
    popupHiddenCount: () => hideCalls,
    popupReshowCount: () => reshowCalls,
    directInputHandles,
    setActiveHandle: (h) => {
      activeHandle = h
    },
    setPid: (p) => {
      pid = p
    },
    setExeName: (e) => {
      exeName = e
    },
    setClassName: (c) => {
      className = c
    },
    setTitle: (t) => {
      title = t
    },
    setAlive: (a) => {
      alive = a
    },
    setMinimized: (m) => {
      minimized = m
    },
    setElevated: (e) => {
      elevated = e
    },
    setClipboardText: (txt) => {
      clipboardText = txt
    }
  }

  setSelectionRuntimeForTest(runtime)
  configureSelectionService({
    translateService: {
      translateOnce: async () => ({
        text: 'Translated Result',
        provider: 'openai',
        usedFallback: false
      }),
      translateStream: async () => ({
        text: 'Translated Result',
        provider: 'openai',
        usedFallback: false
      }),
      cancel: () => {},
      disposeAll: () => {}
    },
    showPopupAtCursor: (payload) => {
      popupShows.push(payload)
    },
    showInactiveAtCursor: (payload) => {
      popupShows.push(payload)
    },
    reshowPopupInactive: () => {
      reshowCalls += 1
    },
    openDirectInput: (h) => {
      directInputHandles.push(h)
    },
    pushToPopup: () => {},
    notifyPopup: (payload) => {
      popupNotifications.push(payload)
    }
  })

  return harness
}

afterEach(() => {
  setSelectionRuntimeForTest(null)
  configureSelectionService(null)
  setWin32UiaForTest(null)
  setUiaWorkerFactoryForTest(null)
})

describe('Batch 1 hardening (ALT-01 / ALT-02 / ALT-06)', () => {
  it('T01: cancels paste right before dispatchPasteShortcut when PID/exe changes after async clipboard write and restores clipboard + popup', async () => {
    const h = createHarness({
      onWriteTransient: (_txt, mock) => {
        // Simulate process reuse / window swap during async clipboard write
        mock.setPid(9999)
      }
    })

    let hideCount = 0
    const reply = await pasteTextToWindow(500, 'Translated text', () => {
      hideCount += 1
    })

    assert.equal(hideCount, 1)
    assert.equal(h.pasteCalls.length, 0)
    assert.equal(h.restoreIfUnchangedCount(), 1)
    assert.equal(h.popupReshowCount(), 1)
    assert.equal(reply.ok, false)
    assert.equal(reply.status, 'cancelled')
    assert.equal(reply.reason, 'target-changed')
    assert.equal(reply.message, MSG.PASTE_CANCELLED_TARGET_CHANGED)
  })

  it('T02: stops batched Option B backspaces on mid-delete target switch and preserves translation on clipboard', async () => {
    // 45 ASCII chars => 3 batches: 20, 20, 5. Switch target after batch 1.
    const selected45 = '123456789012345678901234567890123456789012345'
    let h: MockHarness
    h = createHarness({
      cfg: { terminalAutoBackspace: true },
      classification: { inputKind: 'wt' },
      title: 'pwsh',
      onBackspaceBatch: (batchIdx, _count, mock) => {
        if (batchIdx === 1) {
          mock.setTitle('bash-other-tab')
        }
      }
    })

    // Simulate selection capture returning 45 chars by setting clipboard when Ctrl+Shift+C dispatches
    h.runtime.host.dispatchCopyShortcut = (kind) => {
      h.copyCalls.push(kind)
      h.setClipboardText(selected45)
    }

    const flowResult = await runSelectionFlow('replace')

    assert.equal(flowResult, 'error')
    assert.deepEqual(h.backspaces, [20])
    assert.equal(h.pasteCalls.length, 0)
    assert.ok(h.plainWrites.includes('Translated Result'))
    assert.equal(await h.runtime.clipboard.readText(), 'Translated Result')
    assert.ok(
      h.popupNotifications.some((n) => n.message === MSG.TARGET_CHANGED_AFTER_PARTIAL_DELETE)
    )
  })

  it('T03: UIA worker isolation enforces timeout, terminates poisoned worker, and trips circuit breaker after repeated failures', async () => {
    const spawnedWorkers: FakeUiaWorker[] = []
    setUiaWorkerFactoryForTest(() => {
      const w = new FakeUiaWorker(() => {
        // Never reply to simulate hung COM target
      })
      spawnedWorkers.push(w)
      return w
    })

    for (let i = 0; i < 3; i++) {
      const res = await probeFocusedIdeRegion(1234, 'Code.exe', { timeoutMs: 15 })
      assert.deepEqual(res, { region: 'unknown', reason: 'uia-timeout' })
      assert.equal(spawnedWorkers[i].terminated, true)
    }

    // 4th probe should hit open circuit breaker without spawning a new worker
    const fourth = await probeFocusedIdeRegion(1234, 'Code.exe', { timeoutMs: 15 })
    assert.deepEqual(fourth, { region: 'unknown', reason: 'uia-timeout' })
    assert.equal(spawnedWorkers.length, 3)

    // Reset factory and exercise real Node worker_threads path without crashing or timing out
    setUiaWorkerFactoryForTest(null)
    const realRes = await probeFocusedIdeRegion(999999, 'Code.exe', { timeoutMs: 3000 })
    assert.equal(realRes.region, 'unknown')
    assert.notEqual(realRes.reason, 'uia-error')
    await shutdownWin32UiaWorker()
  })

  it('T04: classifies IDE UIA chains cleanly across terminal, editor, non-editor chat/scm widgets, and mismatched PIDs', () => {
    assert.deepEqual(
      classifyUiaChain(
        [
          { pid: 100, controlType: 50004, name: '', automationId: '', className: 'xterm-helper-textarea' },
          { pid: 100, controlType: 50026, name: '', automationId: 'workbench.parts.editor', className: 'xterm' }
        ],
        100
      ),
      { region: 'terminal', reason: 'uia-terminal' }
    )

    assert.deepEqual(
      classifyUiaChain(
        [
          { pid: 100, controlType: 50004, name: 'terminal-guide.md', automationId: '', className: 'inputarea' },
          { pid: 100, controlType: 50026, name: '', automationId: 'workbench.parts.editor', className: 'monaco-editor editor-instance' }
        ],
        100
      ),
      { region: 'editor', reason: 'uia-editor' }
    )

    assert.deepEqual(
      classifyUiaChain(
        [
          { pid: 100, controlType: 50004, name: '', automationId: '', className: 'inputarea' },
          { pid: 100, controlType: 50026, name: '', automationId: 'workbench.panel.chat', className: 'monaco-editor chat-input' }
        ],
        100
      ),
      { region: 'unknown', reason: 'uia-empty' }
    )

    assert.deepEqual(
      classifyUiaChain(
        [{ pid: 999, controlType: 50004, name: '', automationId: 'terminal', className: 'xterm' }],
        100
      ),
      { region: 'unknown', reason: 'uia-pid-mismatch' }
    )

    assert.deepEqual(resolveIdeWindowClassification('normal', 'unknown', 'uia-timeout'), {
      inputKind: 'normal',
      ideRegion: 'unknown',
      uiaReason: 'uia-timeout'
    })
  })

  it('T05: refuses blind Ctrl+C / Ctrl+Shift+C when IDE focus region is unknown', async () => {
    const hShow = createHarness({
      exeName: 'Code.exe',
      classification: { inputKind: 'normal', ideRegion: 'unknown', uiaReason: 'uia-timeout' }
    })

    const resShow = await runSelectionFlow('show')
    assert.equal(resShow, 'no-selection')
    assert.equal(hShow.copyCalls.length, 0)
    assert.ok(hShow.notifications.includes(MSG.IDE_REGION_UNKNOWN_COPY))

    const hReplace = createHarness({
      exeName: 'Code.exe',
      classification: { inputKind: 'normal', ideRegion: 'unknown', uiaReason: 'uia-empty' }
    })

    const resReplace = await runSelectionFlow('replace')
    assert.equal(resReplace, 'done')
    assert.equal(hReplace.copyCalls.length, 0)
    assert.equal(hReplace.backspaces.length, 0)
    assert.deepEqual(hReplace.directInputHandles, [500])
    assert.ok(hReplace.popupNotifications.some((n) => n.message === MSG.IDE_REGION_UNKNOWN_POPUP))
  })

  it('T09: returns explicit 4-state PopupPasteReply outcomes across pasted, clipboard-only, cancelled, and error', async () => {
    const h = createHarness()

    const errReply = await pasteTextToWindow(500, '   ')
    assert.deepEqual(errReply, {
      ok: false,
      status: 'error',
      reason: 'empty-text',
      message: MSG.TRANSLATION_EMPTY
    })

    h.setMinimized(true)
    const minReply = await pasteTextToWindow(500, 'Hello')
    assert.deepEqual(minReply, {
      ok: false,
      status: 'error',
      reason: 'target-minimized',
      message: MSG.TARGET_MINIMIZED
    })
    h.setMinimized(false)

    h.runtime.host.dispatchPasteShortcut = () => {
      throw new Error('MACOS_ACCESSIBILITY_DENIED')
    }
    const clipReply = await pasteTextToWindow(500, 'Fallback text')
    assert.deepEqual(clipReply, {
      ok: false,
      status: 'clipboard-only',
      reason: 'macos-accessibility-denied',
      message: MSG.MACOS_ACCESSIBILITY_DENIED_PASTE
    })
    assert.equal(await h.runtime.clipboard.readText(), 'Fallback text')

    h.runtime.host.dispatchPasteShortcut = (kind) => {
      h.pasteCalls.push(kind)
    }
    const okReply = await pasteTextToWindow(500, 'Clean text')
    assert.deepEqual(okReply, { ok: true, status: 'pasted' })
    assert.equal(h.pasteCalls.length, 1)
  })

  it('T03b (P1): resolves win32UiaWorker.js across chunks/ parent, unpacked ASAR, dev .ts fallback, and throws descriptive error when absent', () => {
    const chunkBase = resolve('/app', 'out', 'main', 'chunks')
    const parentWorker = resolve('/app', 'out', 'main', 'win32UiaWorker.js')
    const resolvedFromChunk = resolveUiaWorkerTarget({
      baseDir: chunkBase,
      existsSync: (p) => p === parentWorker
    })
    assert.deepEqual(resolvedFromChunk.kind, 'js')
    assert.equal(resolvedFromChunk.path, parentWorker)

    const asarChunkBase = resolve('/opt', 'Alt-T', 'resources', 'app.asar', 'out', 'main', 'chunks')
    const asarParentJs = resolve('/opt', 'Alt-T', 'resources', 'app.asar', 'out', 'main', 'win32UiaWorker.js')
    const unpackedParentJs = resolve(
      '/opt',
      'Alt-T',
      'resources',
      'app.asar.unpacked',
      'out',
      'main',
      'win32UiaWorker.js'
    )
    assert.equal(toUnpackedAsarPath(asarParentJs), unpackedParentJs)
    const resolvedFromAsar = resolveUiaWorkerTarget({
      baseDir: asarChunkBase,
      existsSync: (p) => p === unpackedParentJs || p === asarParentJs
    })
    assert.equal(resolvedFromAsar.kind, 'js')
    assert.equal(resolvedFromAsar.path, unpackedParentJs)

    const explicitWorker = resolve('/custom', 'win32UiaWorker.js')
    const resolvedExplicit = resolveUiaWorkerTarget({
      baseDir: chunkBase,
      explicitPath: explicitWorker,
      existsSync: (p) => p === explicitWorker || p === parentWorker
    })
    assert.equal(resolvedExplicit.kind, 'js')
    assert.equal(resolvedExplicit.path, explicitWorker)

    const devBase = resolve('/repo', 'src', 'main', 'platform')
    const devWorkerTs = join(devBase, 'win32UiaWorker.ts')
    const resolvedDevTs = resolveUiaWorkerTarget({
      baseDir: devBase,
      existsSync: (p) => p === devWorkerTs
    })
    assert.equal(resolvedDevTs.kind, 'ts')
    assert.equal(resolvedDevTs.path, devWorkerTs)

    assert.throws(
      () =>
        resolveUiaWorkerTarget({
          baseDir: chunkBase,
          existsSync: () => false
        }),
      /Win32 UIA worker script not found.*searched:/
    )
  })
})
