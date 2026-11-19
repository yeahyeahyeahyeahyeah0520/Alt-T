import crypto from 'node:crypto'
import { clipboard, Notification } from 'electron'
import { MSG } from '../../shared/messages'
import {
  countTerminalEraseChars,
  detectTargetLang,
  normalizeTerminalCapturedText,
  truncatePreview
} from '../../shared/text'
import {
  IPC_CHANNELS,
  ProviderError,
  type AppConfig,
  type HistoryItem,
  type NotifyPush,
  type PopupPasteReply,
  type PopupShowPush,
  type ProviderId,
  type TargetLang,
  type TranslateChunkPush,
  type TranslateDonePush,
  type TranslateErrorInfo,
  type TranslateErrorPush
} from '../../shared/types'
import { waitForClipboardChange } from '../core/clipboardPolicy'
import {
  backupClipboard,
  restoreClipboard,
  restoreClipboardIfUnchanged,
  writeSentinel,
  writeTransientClipboardText,
  type ClipboardSnapshot
} from '../platform/clipboardBackup'
import {
  canInjectKeystrokes,
  dispatchBackspaces,
  dispatchCopyShortcut,
  dispatchPasteShortcut,
  focusTarget,
  getActiveTargetHandle,
  getClipboardSequenceNumber,
  getTargetCopyKind,
  getTargetPasteKind,
  getWindowTitle,
  isOwnProcessWindow,
  isTargetAlive,
  isTargetMinimized,
  isWindowElevatedOverSelf,
  releasePressedModifiers,
  type WindowInputKind
} from '../platform/hostPlatform'
import { configStore } from './configStore'
import { logError, logInfo, logWarn } from './logger'
import type { TranslateService } from './translateService'

export interface SelectionRuntimeDeps {
  clipboard: {
    readText: () => string | Promise<string>
    writeText: (text: string) => void | Promise<void>
  }
  clipboardBackup: {
    backupClipboard: () => Promise<ClipboardSnapshot>
    restoreClipboard: (snapshot: ClipboardSnapshot) => Promise<void>
    restoreClipboardIfUnchanged: (
      snapshot: ClipboardSnapshot,
      expectedCurrentText: string,
      expectedSequence?: number
    ) => Promise<void>
    writeSentinel: () => Promise<string>
    writeTransientClipboardText: (text: string) => Promise<void>
  }
  host: {
    canInjectKeystrokes: () => boolean
    dispatchBackspaces: (count: number) => Promise<void>
    dispatchCopyShortcut: (kind: WindowInputKind) => void
    dispatchPasteShortcut: (kind: WindowInputKind) => void
    focusTarget: (handle: number) => boolean
    getActiveTargetHandle: () => number
    getClipboardSequenceNumber: () => number
    getTargetCopyKind: (handle: number) => WindowInputKind
    getTargetPasteKind: (handle: number) => WindowInputKind
    getWindowTitle: (handle: number) => string
    isOwnProcessWindow: (handle: number) => boolean
    isTargetAlive: (handle: number) => boolean
    isTargetMinimized: (handle: number) => boolean
    isWindowElevatedOverSelf: (handle: number) => boolean
    releasePressedModifiers: () => Promise<void>
  }
  configStore: {
    get: () => AppConfig
    addHistory: (item: HistoryItem) => void
  }
  notifySystem: (body: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  watchdogTimeoutMs: number
}

export interface SelectionServiceDeps {
  translateService: TranslateService
  showPopupAtCursor: (payload: PopupShowPush) => void
  showInactiveAtCursor?: (payload: PopupShowPush) => void
  openDirectInput?: (targetHandle: number) => void
  pushToPopup: (channel: string, payload: unknown) => void
  onTranslationStart?: (requestId: string) => void
  onTranslationEnd?: (requestId: string) => void
  notifyPopup?: (payload: NotifyPush) => void
  runtime?: Partial<SelectionRuntimeDeps>
}

const POST_PASTE_RESTORE_DELAY_MS = 320
const TERMINAL_REPLACE_POLL_MS = 220
const STANDARD_POLL_MS = 400
const FOREGROUND_POLL_ATTEMPTS = 8
const FOREGROUND_POLL_INTERVAL_MS = 15

let deps: SelectionServiceDeps | null = null
let runtimeOverride: Partial<SelectionRuntimeDeps> | null = null
let busy = false
let activeReplaceController: AbortController | null = null

function defaultShowSystemNotification(body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title: 'Alt-T', body }).show()
  } else {
    logInfo(`notification (unsupported): ${body}`)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRuntime(): SelectionRuntimeDeps {
  const override = runtimeOverride ?? deps?.runtime
  return {
    clipboard: override?.clipboard ?? clipboard,
    clipboardBackup: override?.clipboardBackup ?? {
      backupClipboard,
      restoreClipboard,
      restoreClipboardIfUnchanged,
      writeSentinel,
      writeTransientClipboardText
    },
    host: override?.host ?? {
      canInjectKeystrokes,
      dispatchBackspaces,
      dispatchCopyShortcut,
      dispatchPasteShortcut,
      focusTarget,
      getActiveTargetHandle,
      getClipboardSequenceNumber,
      getTargetCopyKind,
      getTargetPasteKind,
      getWindowTitle,
      isOwnProcessWindow,
      isTargetAlive,
      isTargetMinimized,
      isWindowElevatedOverSelf,
      releasePressedModifiers
    },
    configStore: override?.configStore ?? configStore,
    notifySystem: override?.notifySystem ?? defaultShowSystemNotification,
    sleep: override?.sleep ?? defaultSleep,
    now: override?.now ?? (() => Date.now()),
    watchdogTimeoutMs: override?.watchdogTimeoutMs ?? 30_000
  }
}

export function configureSelectionService(nextDeps: SelectionServiceDeps | null): void {
  deps = nextDeps
}

export function setSelectionRuntimeForTest(override: Partial<SelectionRuntimeDeps> | null): void {
  runtimeOverride = override
  if (override === null) {
    busy = false
    activeReplaceController = null
  }
}

export function isSelectionBusy(): boolean {
  return busy
}

export function cancelActiveReplaceFlow(): void {
  if (activeReplaceController !== null && !activeReplaceController.signal.aborted) {
    activeReplaceController.abort()
  }
}

function recordHistoryIfEnabled(
  rt: SelectionRuntimeDeps,
  fromText: string,
  toText: string,
  provider: ProviderId,
  target: TargetLang
): void {
  const cfg = rt.configStore.get()
  if (!cfg.historyEnabled) return
  rt.configStore.addHistory({
    id: crypto.randomUUID(),
    at: rt.now(),
    from: fromText.slice(0, 2000),
    to: toText.slice(0, 4000),
    provider,
    target
  })
}

export function validatePastePreconditions(
  targetHandle: number,
  textToPaste: string
): PopupPasteReply | null {
  const rt = getRuntime()
  if (busy) {
    return { ok: false, message: MSG.BUSY_LOCKED }
  }
  if (textToPaste.trim() === '') {
    return { ok: false, message: MSG.TRANSLATION_EMPTY }
  }
  if (!rt.host.canInjectKeystrokes()) {
    // Graceful clipboard-only mode (e.g. Linux Wayland)
    return null
  }
  if (!targetHandle || !rt.host.isTargetAlive(targetHandle)) {
    return { ok: false, message: MSG.TARGET_CLOSED }
  }
  if (rt.host.isTargetMinimized(targetHandle)) {
    return { ok: false, message: MSG.TARGET_MINIMIZED }
  }
  return null
}

export async function pasteTextToWindow(
  targetHandle: number,
  textToPaste: string,
  hidePopup?: (() => void) | boolean
): Promise<PopupPasteReply> {
  const rt = getRuntime()
  const preError = validatePastePreconditions(targetHandle, textToPaste)
  if (preError !== null) {
    return preError
  }

  const hideFn = typeof hidePopup === 'function' ? hidePopup : undefined
  const focusAlreadyVerified = typeof hidePopup === 'boolean' ? hidePopup : false

  busy = true
  try {
    if (!rt.host.canInjectKeystrokes()) {
      await rt.clipboard.writeText(textToPaste)
      hideFn?.()
      rt.notifySystem(MSG.CLIPBOARD_ONLY_MODE)
      return { ok: true }
    }

    if (rt.host.isWindowElevatedOverSelf(targetHandle)) {
      await rt.clipboard.writeText(textToPaste)
      rt.host.focusTarget(targetHandle)
      hideFn?.()
      const msg = MSG.UIPI_PASTE_FALLBACK
      logWarn(`pasteTextToWindow UIPI fallback for handle=${targetHandle}`)
      rt.notifySystem(msg)
      return { ok: true }
    }

    await rt.host.releasePressedModifiers()

    if (!focusAlreadyVerified || rt.host.getActiveTargetHandle() !== targetHandle) {
      rt.host.focusTarget(targetHandle)
    }

    hideFn?.()

    let confirmed = rt.host.getActiveTargetHandle() === targetHandle
    for (let attempt = 0; !confirmed && attempt < FOREGROUND_POLL_ATTEMPTS; attempt++) {
      await rt.sleep(FOREGROUND_POLL_INTERVAL_MS)
      confirmed = rt.host.getActiveTargetHandle() === targetHandle
    }

    if (!confirmed) {
      await rt.clipboard.writeText(textToPaste)
      const currentActive = rt.host.getActiveTargetHandle()
      const msg = MSG.TARGET_FOREGROUND_LOST
      logWarn(`pasteTextToWindow foreground mismatch: expected=${targetHandle}, actual=${currentActive}`)
      rt.notifySystem(msg)
      return { ok: false, message: msg }
    }

    await rt.sleep(30)

    const pasteKind = rt.host.getTargetPasteKind(targetHandle)
    const snap = await rt.clipboardBackup.backupClipboard()
    await rt.clipboardBackup.writeTransientClipboardText(textToPaste)
    const seqAfterWrite = rt.host.getClipboardSequenceNumber()

    try {
      rt.host.dispatchPasteShortcut(pasteKind)
    } catch (err) {
      await rt.clipboard.writeText(textToPaste)
      const errMsg = err instanceof Error ? err.message : String(err)
      const msg =
        errMsg === 'MACOS_ACCESSIBILITY_DENIED'
          ? MSG.MACOS_ACCESSIBILITY_DENIED_PASTE
          : MSG.PASTE_BLOCKED
      logError('pasteTextToWindow dispatchPaste failed', err)
      rt.notifySystem(msg)
      return { ok: true }
    }

    await rt.sleep(POST_PASTE_RESTORE_DELAY_MS)
    await rt.clipboardBackup.restoreClipboardIfUnchanged(snap, textToPaste, seqAfterWrite)
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('pasteTextToWindow unexpected error', err)
    return { ok: false, message: msg }
  } finally {
    busy = false
  }
}

function showS11PopupFallback(
  activeDeps: SelectionServiceDeps,
  rt: SelectionRuntimeDeps,
  text: string,
  to: TargetLang,
  translatedText: string,
  usedProvider: ProviderId,
  usedFallback: boolean,
  warnMessage: string
): void {
  const requestId = crypto.randomUUID()
  const showFn = activeDeps.showInactiveAtCursor ?? activeDeps.showPopupAtCursor
  showFn({
    mode: 'selection',
    text,
    requestId,
    to
  })
  const donePayload: TranslateDonePush = {
    requestId,
    result: {
      text: translatedText,
      provider: usedProvider,
      usedFallback
    }
  }
  activeDeps.pushToPopup(IPC_CHANNELS.translateDone, donePayload)
  if (activeDeps.notifyPopup) {
    activeDeps.notifyPopup({ level: 'warn', message: warnMessage })
  } else {
    rt.notifySystem(warnMessage)
  }
  recordHistoryIfEnabled(rt, text, translatedText, usedProvider, to)
}

type CaptureResult =
  | {
      ok: true
      rawText: string
      normalizedText: string
      pasteKind: WindowInputKind
      copyKind: WindowInputKind
      titleAtStart: string
      snap: ClipboardSnapshot
      seqAfterRestore: number
    }
  | { ok: false; reason: 'uipi' | 'no-selection' | 'own-window' | 'copy-failed' | 'too-long' }

async function captureSelectionText(
  handle: number,
  rt: SelectionRuntimeDeps,
  mode: 'replace' | 'show' = 'replace'
): Promise<CaptureResult> {
  if (rt.host.isOwnProcessWindow(handle)) {
    return { ok: false, reason: 'own-window' }
  }
  if (rt.host.isWindowElevatedOverSelf(handle)) {
    return { ok: false, reason: 'uipi' }
  }

  const copyKind = rt.host.getTargetCopyKind(handle)
  const pasteKind = rt.host.getTargetPasteKind(handle)
  const titleAtStart = pasteKind === 'wt' ? rt.host.getWindowTitle(handle) : ''

  await rt.host.releasePressedModifiers()

  const snap = await rt.clipboardBackup.backupClipboard()
  const sentinel = await rt.clipboardBackup.writeSentinel()

  try {
    rt.host.dispatchCopyShortcut(copyKind)
  } catch (err) {
    await rt.clipboardBackup.restoreClipboard(snap)
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errMsg === 'MACOS_ACCESSIBILITY_DENIED') {
      rt.notifySystem(MSG.MACOS_ACCESSIBILITY_DENIED_COPY)
    }
    logError('dispatchCopyShortcut failed', err)
    return { ok: false, reason: 'copy-failed' }
  }

  const pollTimeoutMs =
    pasteKind !== 'normal' && mode === 'replace' ? TERMINAL_REPLACE_POLL_MS : STANDARD_POLL_MS
  const rawCaptured = await waitForClipboardChange(
    sentinel,
    {
      readText: () => rt.clipboard.readText(),
      sleep: rt.sleep,
      now: rt.now
    },
    25,
    pollTimeoutMs
  )

  if (rawCaptured === null) {
    await rt.clipboardBackup.restoreClipboard(snap)
    return { ok: false, reason: 'no-selection' }
  }

  const normalizedText =
    pasteKind !== 'normal' ? normalizeTerminalCapturedText(rawCaptured) : rawCaptured

  await rt.clipboardBackup.restoreClipboard(snap)
  const seqAfterRestore = rt.host.getClipboardSequenceNumber()

  if (normalizedText.trim() === '') {
    rt.notifySystem(MSG.NO_TEXT_SELECTED)
    return { ok: false, reason: 'no-selection' }
  }

  if (normalizedText.length > 5000) {
    return { ok: false, reason: 'too-long' }
  }

  return {
    ok: true,
    rawText: rawCaptured,
    normalizedText,
    pasteKind,
    copyKind,
    titleAtStart,
    snap,
    seqAfterRestore
  }
}

function runShowMode(params: {
  text: string
  to: TargetLang
  rt: SelectionRuntimeDeps
  activeDeps: SelectionServiceDeps
  watchdog: AbortController
}): void {
  const { text, to, rt, activeDeps, watchdog } = params
  const cfg = rt.configStore.get()
  const requestId = crypto.randomUUID()

  activeDeps.showPopupAtCursor({
    mode: 'selection',
    text,
    requestId,
    to
  })
  activeDeps.onTranslationStart?.(requestId)

  if (cfg.openai.stream) {
    const onWatchdogAbort = (): void => {
      activeDeps.translateService.cancel(requestId)
      activeDeps.onTranslationEnd?.(requestId)
    }
    watchdog.signal.addEventListener('abort', onWatchdogAbort, { once: true })

    activeDeps.translateService.translateStream(
      requestId,
      { text, to },
      {
        onChunk: (delta) => {
          const payload: TranslateChunkPush = { requestId, delta }
          activeDeps.pushToPopup(IPC_CHANNELS.translateChunk, payload)
        },
        onDone: (result) => {
          watchdog.signal.removeEventListener('abort', onWatchdogAbort)
          activeDeps.onTranslationEnd?.(requestId)
          const payload: TranslateDonePush = { requestId, result }
          activeDeps.pushToPopup(IPC_CHANNELS.translateDone, payload)
          recordHistoryIfEnabled(rt, text, result.text, result.provider, to)
        },
        onError: (error) => {
          watchdog.signal.removeEventListener('abort', onWatchdogAbort)
          activeDeps.onTranslationEnd?.(requestId)
          const payload: TranslateErrorPush = { requestId, error }
          activeDeps.pushToPopup(IPC_CHANNELS.translateError, payload)
        }
      }
    )
  } else {
    void activeDeps.translateService
      .translateOnce({ text, to }, watchdog.signal, requestId)
      .then((result) => {
        activeDeps.onTranslationEnd?.(requestId)
        const payload: TranslateDonePush = { requestId, result }
        activeDeps.pushToPopup(IPC_CHANNELS.translateDone, payload)
        recordHistoryIfEnabled(rt, text, result.text, result.provider, to)
      })
      .catch((err: unknown) => {
        activeDeps.onTranslationEnd?.(requestId)
        if (err instanceof ProviderError && err.info.code === 'ABORTED') {
          return
        }
        const latestCfg = rt.configStore.get()
        const error: TranslateErrorInfo =
          err instanceof ProviderError
            ? err.info
            : {
                code: 'NETWORK',
                provider: latestCfg.primaryProvider,
                message: err instanceof Error ? err.message : String(err),
                retryable: true
              }
        const payload: TranslateErrorPush = { requestId, error }
        activeDeps.pushToPopup(IPC_CHANNELS.translateError, payload)
      })
  }
}

async function runReplaceModeTerminal(params: {
  translatedText: string
  rawText: string
  pasteKind: WindowInputKind
  handle: number
  titleAtStart: string
  snap: ClipboardSnapshot
  seqAfterRestore: number
  rt: SelectionRuntimeDeps
  activeDeps: SelectionServiceDeps
  to: TargetLang
  usedProvider: ProviderId
  usedFallback: boolean
  watchdog: AbortController
}): Promise<'done' | 'error'> {
  const {
    translatedText,
    rawText,
    pasteKind,
    handle,
    titleAtStart,
    snap,
    seqAfterRestore,
    rt,
    activeDeps,
    to,
    usedProvider,
    usedFallback
  } = params

  const cfg = rt.configStore.get()
  const eraseCount = countTerminalEraseChars(rawText)
  const text = pasteKind !== 'normal' ? normalizeTerminalCapturedText(rawText) : rawText

  if (!cfg.terminalAutoBackspace || eraseCount === 0) {
    const requestId = crypto.randomUUID()
    activeDeps.showPopupAtCursor({
      mode: 'selection',
      text,
      requestId,
      to,
      directPaste: true
    })
    const donePayload: TranslateDonePush = {
      requestId,
      result: {
        text: translatedText,
        provider: usedProvider,
        usedFallback
      }
    }
    activeDeps.pushToPopup(IPC_CHANNELS.translateDone, donePayload)
    activeDeps.notifyPopup?.({
      level: 'info',
      message: MSG.TERMINAL_SELECTION_TRANSLATED
    })
    recordHistoryIfEnabled(rt, text, translatedText, usedProvider, to)
    return 'done'
  }

  const handleNow = rt.host.getActiveTargetHandle()
  const titleNow = pasteKind === 'wt' ? rt.host.getWindowTitle(handle) : ''
  const titleChanged =
    pasteKind === 'wt' && titleAtStart !== '' && titleNow !== '' && titleNow !== titleAtStart

  if (handleNow !== handle || titleChanged) {
    showS11PopupFallback(
      activeDeps,
      rt,
      text,
      to,
      translatedText,
      usedProvider,
      usedFallback,
      MSG.TARGET_CHANGED_TAB
    )
    return 'done'
  }

  await rt.host.releasePressedModifiers()
  await rt.host.dispatchBackspaces(eraseCount)
  await rt.sleep(20)

  const curSeq = rt.host.getClipboardSequenceNumber()
  const snap2 =
    seqAfterRestore > 0 && curSeq === seqAfterRestore
      ? snap
      : await rt.clipboardBackup.backupClipboard()

  await rt.clipboardBackup.writeTransientClipboardText(translatedText)
  const seqAfterWrite = rt.host.getClipboardSequenceNumber()

  try {
    rt.host.dispatchPasteShortcut(pasteKind)
  } catch (err) {
    await rt.clipboardBackup.restoreClipboard(snap2)
    rt.notifySystem(MSG.PASTE_SHORTCUT_FAILED)
    logError('dispatchPasteShortcut failed (terminal auto-backspace)', err)
    return 'error'
  }

  await rt.sleep(POST_PASTE_RESTORE_DELAY_MS)
  await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)
  recordHistoryIfEnabled(rt, text, translatedText, usedProvider, to)
  return 'done'
}

async function runReplaceModeNormal(params: {
  translatedText: string
  handle: number
  snap: ClipboardSnapshot
  seqAfterRestore: number
  pasteKind: WindowInputKind
  rt: SelectionRuntimeDeps
  activeDeps: SelectionServiceDeps
  to: TargetLang
  text: string
  usedProvider: ProviderId
  usedFallback: boolean
}): Promise<'done' | 'error'> {
  const {
    translatedText,
    handle,
    snap,
    seqAfterRestore,
    pasteKind,
    rt,
    activeDeps,
    to,
    text,
    usedProvider,
    usedFallback
  } = params

  const handleNow = rt.host.getActiveTargetHandle()
  if (handleNow !== handle) {
    showS11PopupFallback(
      activeDeps,
      rt,
      text,
      to,
      translatedText,
      usedProvider,
      usedFallback,
      MSG.TARGET_CHANGED
    )
    return 'done'
  }

  await rt.host.releasePressedModifiers()

  const curSeq = rt.host.getClipboardSequenceNumber()
  const snap2 =
    seqAfterRestore > 0 && curSeq === seqAfterRestore
      ? snap
      : await rt.clipboardBackup.backupClipboard()

  await rt.clipboardBackup.writeTransientClipboardText(translatedText)
  const seqAfterWrite = rt.host.getClipboardSequenceNumber()

  try {
    rt.host.dispatchPasteShortcut(pasteKind)
  } catch (err) {
    await rt.clipboardBackup.restoreClipboard(snap2)
    rt.notifySystem(MSG.PASTE_SHORTCUT_FAILED)
    logError('dispatchPasteShortcut failed', err)
    return 'error'
  }

  await rt.sleep(POST_PASTE_RESTORE_DELAY_MS)
  await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)

  recordHistoryIfEnabled(rt, text, translatedText, usedProvider, to)

  return 'done'
}

export async function runSelectionFlow(
  mode: 'replace' | 'show'
): Promise<'done' | 'busy' | 'no-selection' | 'error'> {
  if (busy) {
    logInfo('selection flow busy, ignored')
    return 'busy'
  }
  busy = true

  const rt = getRuntime()
  const watchdog = new AbortController()
  const watchdogTimer = setTimeout(() => {
    logWarn(`selection flow watchdog timeout (${rt.watchdogTimeoutMs}ms)`)
    watchdog.abort()
  }, rt.watchdogTimeoutMs)

  if (mode === 'replace') {
    activeReplaceController = watchdog
  }

  try {
    if (!rt.host.canInjectKeystrokes()) {
      if (mode === 'replace' && deps?.openDirectInput) {
        deps.openDirectInput(0)
        return 'done'
      }
      rt.notifySystem(MSG.PLATFORM_NO_INJECT)
      return 'no-selection'
    }

    const handle0 = rt.host.getActiveTargetHandle()
    if (handle0 === 0) {
      rt.notifySystem(MSG.NO_FOREGROUND)
      return 'error'
    }

    const capture = await captureSelectionText(handle0, rt, mode)
    if (!capture.ok) {
      switch (capture.reason) {
        case 'own-window':
          logInfo(`selection flow ignored on own process window handle=${handle0}`)
          return 'no-selection'
        case 'uipi':
          logWarn(`selection flow blocked by privilege boundary on handle=${handle0}`)
          rt.notifySystem(MSG.UIPI_BLOCKED)
          return 'no-selection'
        case 'copy-failed':
          rt.notifySystem(MSG.COPY_SHORTCUT_FAILED)
          return 'error'
        case 'no-selection':
          if (mode === 'replace' && deps?.openDirectInput) {
            deps.openDirectInput(handle0)
            return 'done'
          }
          rt.notifySystem(MSG.NO_SELECTION_OR_UIPI)
          return 'no-selection'
        case 'too-long':
          rt.notifySystem(MSG.TEXT_TOO_LONG)
          return 'error'
      }
    }

    if (!deps) {
      rt.notifySystem(MSG.SERVICE_NOT_INIT)
      return 'error'
    }

    const text = capture.normalizedText
    const to = detectTargetLang(text)
    logInfo(`selection captured: "${truncatePreview(text, 40)}" -> to=${to} kind=${capture.pasteKind}`)

    if (mode === 'show') {
      runShowMode({ text, to, rt, activeDeps: deps, watchdog })
      return 'done'
    }

    let translatedText: string
    let usedProvider: ProviderId
    let usedFallback: boolean
    try {
      const res = await deps.translateService.translateOnce({ text, to }, watchdog.signal)
      translatedText = res.text
      usedProvider = res.provider
      usedFallback = res.usedFallback
    } catch (err) {
      if (watchdog.signal.aborted || (err instanceof ProviderError && err.info.code === 'ABORTED')) {
        logInfo('selection replace flow aborted before completion')
        return 'done'
      }
      const message =
        err instanceof ProviderError
          ? err.info.message
          : err instanceof Error
            ? err.message
            : String(err)
      rt.notifySystem(message)
      logWarn(`translateOnce failed in replace mode: ${message}`)
      return 'error'
    }

    if (watchdog.signal.aborted) {
      logInfo('selection replace flow aborted after translation')
      return 'done'
    }

    if (capture.pasteKind !== 'normal') {
      return await runReplaceModeTerminal({
        translatedText,
        rawText: capture.rawText,
        pasteKind: capture.pasteKind,
        handle: handle0,
        titleAtStart: capture.titleAtStart,
        snap: capture.snap,
        seqAfterRestore: capture.seqAfterRestore,
        rt,
        activeDeps: deps,
        to,
        usedProvider,
        usedFallback,
        watchdog
      })
    }

    return await runReplaceModeNormal({
      translatedText,
      handle: handle0,
      snap: capture.snap,
      seqAfterRestore: capture.seqAfterRestore,
      pasteKind: capture.pasteKind,
      rt,
      activeDeps: deps,
      to,
      text,
      usedProvider,
      usedFallback
    })
  } catch (err) {
    logError('selection flow unexpected error', err)
    rt.notifySystem(err instanceof Error ? err.message : String(err))
    return 'error'
  } finally {
    clearTimeout(watchdogTimer)
    if (activeReplaceController === watchdog) {
      activeReplaceController = null
    }
    busy = false
  }
}
