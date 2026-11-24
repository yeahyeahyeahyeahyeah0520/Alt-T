import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CONFIG } from '../src/shared/types'
import { createMetricsTracker, type MetricRunInput } from '../src/main/core/metrics'
import {
  configureSelectionService,
  getSelectionMetricsSummary,
  pasteTextToWindow,
  resetSelectionMetricsForTest,
  runSelectionFlow,
  setSelectionRuntimeForTest,
  type SelectionRuntimeDeps
} from '../src/main/services/selectionService'
import type { ClipboardSnapshot } from '../src/main/platform/clipboardBackup'

afterEach(() => {
  setSelectionRuntimeForTest(null)
  configureSelectionService(null)
  resetSelectionMetricsForTest()
})

describe('Batch 4 metrics baseline (ALT-14)', () => {
  it('computes p50/p95 timings without skewing unexecuted stages, bounds sample window, and strips non-allowlisted strings', () => {
    const tracker = createMetricsTracker(5)

    for (let i = 1; i <= 10; i++) {
      const injected = {
        flow: 'replace',
        outcome: 'pasted',
        totalMs: i * 10,
        captureMs: i * 2,
        // Skip uiaProbeMs on half of runs to verify skipped stages don't skew p50 with 0
        ...(i % 2 === 0 ? { uiaProbeMs: i * 3 } : {}),
        translateMs: i * 5,
        pasteVerifyMs: 1.5,
        ideRegion: i % 2 === 0 ? 'editor' : undefined,
        secretTitle: 'MY_SUPER_SECRET_WINDOW_TITLE',
        rawPromptText: 'PRIVATE_SOURCE_CODE'
      } as unknown as MetricRunInput
      tracker.record(injected)
    }

    // Invalid outcomes or negative timings must be ignored safely
    tracker.record({
      flow: 'replace',
      outcome: 'invalid-outcome' as unknown as MetricRunInput['outcome'],
      totalMs: 10
    })
    tracker.record({
      flow: 'replace',
      outcome: 'error',
      totalMs: -5
    })

    tracker.record({
      flow: 'show',
      outcome: 'cancelled',
      totalMs: 42,
      ideRegion: 'unknown',
      ideUnknown: true,
      protectedHold: true,
      targetChanged: true
    })

    const summary = tracker.getSummary()
    assert.equal(summary.totalRuns, 11)
    assert.equal(summary.sampleWindowSize, 5) // Bounded window kept 5 most recent valid samples
    assert.equal(summary.outcomes.pasted, 10) // Lifetime counter survives window eviction
    assert.equal(summary.outcomes.cancelled, 1)
    assert.equal(summary.flags.ideUnknown, 1)
    assert.equal(summary.flags.protectedHold, 1)
    assert.equal(summary.flags.targetChanged, 1)
    assert.equal(summary.ideRegions.unknown, 1)

    // Unexecuted uiaProbeMs in sample window (last 5 valid runs: i=7,8,9,10 and cancelled run => only i=8,10 had uiaProbeMs)
    assert.equal(summary.stages.uiaProbeMs.count, 2)
    assert.equal(summary.stages.uiaProbeMs.p50Ms, 24)
    assert.equal(summary.stages.uiaProbeMs.p95Ms, 30)
    assert.equal(summary.stages.uiaProbeMs.p95Reliable, false)

    // Serialize whole summary and assert zero user strings or unknown keys exist
    const serialized = JSON.stringify(summary)
    assert.equal(serialized.includes('MY_SUPER_SECRET_WINDOW_TITLE'), false)
    assert.equal(serialized.includes('PRIVATE_SOURCE_CODE'), false)
  })

  it('records monotonic paste outcomes cleanly through selectionService without leaking clipboard content', async () => {
    resetSelectionMetricsForTest()
    let active = 700
    let clip = 'old'
    const runtime: SelectionRuntimeDeps = {
      clipboard: {
        readText: async () => clip,
        writeText: async (t) => {
          clip = t
        }
      },
      clipboardBackup: {
        backupClipboard: async (): Promise<ClipboardSnapshot> => ({
          text: clip,
          html: '',
          rtf: '',
          imageBlob: null,
          imageMime: null,
          formats: ['text/plain']
        }),
        writeSentinel: async () => '__SENTINEL__',
        writeTransientClipboardText: async (t) => {
          clip = t
        },
        restoreClipboard: async (s) => {
          clip = s.text
        },
        restoreClipboardIfUnchanged: async () => {}
      },
      host: {
        canInjectKeystrokes: () => true,
        getActiveTargetHandle: () => active,
        isTargetAlive: () => true,
        isTargetMinimized: () => false,
        isOwnProcessWindow: () => false,
        isWindowElevatedOverSelf: () => false,
        focusTarget: (h) => {
          active = h
          return true
        },
        getClipboardSequenceNumber: () => 1,
        getTargetCopyKind: () => 'normal',
        getTargetPasteKind: () => 'normal',
        getTargetExeName: () => 'notepad.exe',
        getTargetClassName: () => 'Notepad',
        getTargetPid: () => 123,
        getWindowTitle: () => 'SECRET_NOTEPAD_FILE.txt',
        dispatchCopyShortcut: () => {},
        dispatchBackspaces: async () => {},
        dispatchPasteShortcut: () => {},
        releasePressedModifiers: async () => {}
      },
      configStore: {
        get: () => DEFAULT_CONFIG,
        addHistory: () => DEFAULT_CONFIG
      },
      notifySystem: () => {},
      sleep: async () => {},
      now: () => Date.now(),
      watchdogTimeoutMs: 5000
    }
    setSelectionRuntimeForTest(runtime)

    const res = await pasteTextToWindow(700, 'TOP_SECRET_TRANSLATION_BODY')
    assert.equal(res.status, 'pasted')

    const summary = getSelectionMetricsSummary()
    assert.equal(summary.totalRuns, 1)
    assert.equal(summary.outcomes.pasted, 1)
    assert.equal(summary.stages.pasteVerifyMs.count, 1)
    assert.equal(summary.stages.totalMs.count, 1)

    const serialized = JSON.stringify(summary)
    assert.equal(serialized.includes('TOP_SECRET_TRANSLATION_BODY'), false)
    assert.equal(serialized.includes('SECRET_NOTEPAD_FILE'), false)
  })

  it('tracks runSelectionFlow metrics across IDE unknown, protectedHold, normal paste, and targetChanged without miscounting or leaking PII', async () => {
    resetSelectionMetricsForTest()
    let clip = 'old'
    let activeHandle = 900
    let classifyIde: 'editor' | 'terminal' | 'unknown' | undefined = 'unknown'
    let protectedOk = true
    let dropForegroundBeforePaste = false

    const runtime: SelectionRuntimeDeps = {
      clipboard: {
        readText: async () => clip,
        writeText: async (t) => {
          clip = t
        }
      },
      clipboardBackup: {
        backupClipboard: async (): Promise<ClipboardSnapshot> => ({
          text: clip,
          html: '',
          rtf: '',
          imageBlob: null,
          imageMime: null,
          formats: ['text/plain']
        }),
        writeSentinel: async () => '__SENTINEL__',
        writeTransientClipboardText: async (t) => {
          clip = t
        },
        restoreClipboard: async (s) => {
          clip = s.text
        },
        restoreClipboardIfUnchanged: async () => {}
      },
      host: {
        canInjectKeystrokes: () => true,
        getActiveTargetHandle: () => activeHandle,
        isTargetAlive: () => true,
        isTargetMinimized: () => false,
        isOwnProcessWindow: () => false,
        isWindowElevatedOverSelf: () => false,
        focusTarget: () => true,
        getClipboardSequenceNumber: () => 5,
        getTargetCopyKind: () => 'normal',
        getTargetPasteKind: () => 'normal',
        getTargetWindowClassification: async () =>
          classifyIde === undefined
            ? { inputKind: 'normal' }
            : {
                inputKind: classifyIde === 'terminal' ? 'wt' : 'normal',
                ideRegion: classifyIde,
                uiaReason:
                  classifyIde === 'terminal'
                    ? 'uia-terminal'
                    : classifyIde === 'editor'
                      ? 'uia-editor'
                      : 'uia-empty'
              },
        getTargetExeName: () => 'Code.exe',
        getTargetClassName: () => 'Chrome_WidgetWin_1',
        getTargetPid: () => 456,
        getWindowTitle: () => 'TOP_SECRET_PROJECT_WINDOW',
        dispatchCopyShortcut: () => {
          clip = 'SECRET_SELECTED_SNIPPET'
        },
        dispatchBackspaces: async () => {},
        dispatchPasteShortcut: () => {},
        releasePressedModifiers: async () => {}
      },
      configStore: {
        get: () => DEFAULT_CONFIG,
        addHistory: () => DEFAULT_CONFIG
      },
      notifySystem: () => {},
      sleep: async () => {},
      now: () => Date.now(),
      watchdogTimeoutMs: 5000
    }
    setSelectionRuntimeForTest(runtime)
    configureSelectionService({
      translateService: {
        translateOnce: async () => {
          if (dropForegroundBeforePaste) {
            activeHandle = 999
          }
          return {
            text: 'SECRET_TRANSLATED_OUTPUT',
            provider: 'edge',
            usedFallback: false,
            protectedVerify: protectedOk
              ? { ok: true, spanCount: 0, reordered: false }
              : {
                  ok: false,
                  spanCount: 1,
                  reason: 'placeholder-missing',
                  missingTokens: ['[[ALTT_0]]'],
                  reordered: false
                }
          }
        },
        translateStream: async () => ({
          text: 'SECRET_TRANSLATED_OUTPUT',
          provider: 'edge',
          usedFallback: false
        }),
        cancel: () => {},
        disposeAll: () => {}
      },
      showPopupAtCursor: () => {},
      showInactiveAtCursor: () => {},
      openDirectInput: () => {},
      pushToPopup: () => {},
      notifyPopup: () => {}
    })

    // 1) IDE unknown -> direct-input + ideUnknown=1 + uiaProbeMs recorded
    const resUnknown = await runSelectionFlow('replace')
    assert.equal(resUnknown, 'done')

    // 2) Protected verify failed -> shown + protectedHold=1 (non-IDE omits uiaProbeMs)
    classifyIde = undefined
    protectedOk = false
    const resHold = await runSelectionFlow('replace')
    assert.equal(resHold, 'done')

    // 3) Normal IDE editor replace -> pasted (uiaProbeMs recorded twice across 3 runs)
    classifyIde = 'editor'
    protectedOk = true
    const resOk = await runSelectionFlow('replace')
    assert.equal(resOk, 'done')

    // 4) Foreground drifted during translate -> shown + targetChanged=1 (NOT counted as pasted!)
    classifyIde = undefined
    dropForegroundBeforePaste = true
    const resDrift = await runSelectionFlow('replace')
    assert.equal(resDrift, 'done')

    const summary = getSelectionMetricsSummary()
    assert.equal(summary.totalRuns, 4)
    assert.equal(summary.outcomes['direct-input'], 1)
    assert.equal(summary.outcomes.shown, 2)
    assert.equal(summary.outcomes.pasted, 1)
    assert.equal(summary.flags.ideUnknown, 1)
    assert.equal(summary.flags.protectedHold, 1)
    assert.equal(summary.flags.targetChanged, 1)
    assert.equal(summary.stages.uiaProbeMs.count, 2)
    assert.equal(summary.stages.translateMs.count, 3)

    const serialized = JSON.stringify(summary)
    assert.equal(serialized.includes('TOP_SECRET_PROJECT_WINDOW'), false)
    assert.equal(serialized.includes('SECRET_SELECTED_SNIPPET'), false)
    assert.equal(serialized.includes('SECRET_TRANSLATED_OUTPUT'), false)
  })
})

describe('Batch 4 CI workflow matrix (ALT-13)', () => {
  it('defines verify-windows with ALT_T_SMOKE and verify-cross-platform across macos-latest and ubuntu-latest', () => {
    const ciPath = path.resolve(process.cwd(), '.github', 'workflows', 'ci.yml')
    const raw = fs.readFileSync(ciPath, 'utf8')
    assert.match(raw, /verify-windows:/)
    assert.match(raw, /ALT_T_SMOKE:\s*'1'/)
    assert.match(raw, /npm run smoke/)
    assert.match(raw, /electron-builder --win --dir/)
    assert.match(raw, /verify-cross-platform:/)
    assert.match(raw, /macos-latest/)
    assert.match(raw, /ubuntu-latest/)
    assert.match(raw, /npm run typecheck/)
    assert.match(raw, /npm run check/)
    assert.match(raw, /npm test/)
    assert.match(raw, /npm run build/)
  })
})
