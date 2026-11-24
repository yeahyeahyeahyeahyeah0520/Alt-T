import crypto from 'node:crypto'
import { clipboard, Notification } from 'electron'
import { createHistoryEntry } from '../../shared/config'
import { MSG } from '../../shared/messages'
import {
  countTerminalEraseChars,
  detectTargetLang,
  normalizeTerminalCapturedText,
  truncatePreview
} from '../../shared/text'
import {
  IPC_CHANNELS,
  MAX_TRANSLATE_CHARS,
  ProviderError,
  type AppConfig,
  type HistoryItem,
  type IdeRegionKind,
  type NotifyPush,
  type PopupPasteStatus,
  type UiaProbeReason,
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
  getTargetClassName,
  getTargetCopyKind,
  getTargetExeName,
  getTargetPasteKind,
  getTargetPid,
  getTargetWindowClassification,
  getWindowTitle,
  type WindowClassification,
  isOwnProcessWindow,
  isTargetAlive,
  isTargetMinimized,
  isWindowElevatedOverSelf,
  releasePressedModifiers,
  type CustomTerminalExeSets,
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
    getTargetCopyKind: (handle: number, customSets?: CustomTerminalExeSets) => WindowInputKind
    getTargetExeName?: (handle: number) => string
    getTargetClassName?: (handle: number) => string
    getTargetPid?: (handle: number) => number
    getTargetPasteKind: (handle: number, customSets?: CustomTerminalExeSets) => WindowInputKind
    getTargetWindowClassification?: (
      handle: number,
      customSets?: CustomTerminalExeSets
    ) => Promise<WindowClassification>
    getWindowTitle: (handle: number) => string
    isOwnProcessWindow: (handle: number) => boolean
    isTargetAlive: (handle: number) => boolean
    isTargetMinimized: (handle: number) => boolean
    isWindowElevatedOverSelf: (handle: number) => boolean
    releasePressedModifiers: () => Promise<void>
  }
  configStore: {
    get: () => AppConfig
    addHistory: (item: HistoryItem) => AppConfig | null | void
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
  reshowPopupInactive?: () => void
  openDirectInput?: (targetHandle: number) => void
  pushToPopup: (channel: string, payload: unknown) => void
  onTranslationStart?: (requestId: string) => void
  onTranslationEnd?: (requestId: string) => void
  notifyPopup?: (payload: NotifyPush) => void
  onHistoryChanged?: (cfg: AppConfig) => void
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
      getTargetClassName,
      getTargetCopyKind,
      getTargetExeName,
      getTargetPasteKind,
      getTargetPid,
      getTargetWindowClassification,
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

export function cancelActiveReplaceFlow(): void {
  if (activeReplaceController !== null && !activeReplaceController.signal.aborted) {
    activeReplaceController.abort()
  }
}

function buildCustomExeSets(cfg: AppConfig): CustomTerminalExeSets {
  return {
    extraWt: new Set((cfg.customWtExeNames ?? []).map((s) => s.toLowerCase())),
    extraConhost: new Set((cfg.customConhostExeNames ?? []).map((s) => s.toLowerCase()))
  }
}

function shouldForcePopupOnReplace(
  handle: number,
  rt: SelectionRuntimeDeps,
  cfg: AppConfig
): boolean {
  const list = cfg.forcePopupOnReplaceExes
  if (!list || list.length === 0) return false
  const exeName = (rt.host.getTargetExeName?.(handle) ?? '').trim().toLowerCase()
  if (exeName === '') return false
  return list.some((item) => item.trim().toLowerCase() === exeName)
}

function recordHistory(
  rt: SelectionRuntimeDeps,
  activeDeps: SelectionServiceDeps | null,
  fromText: string,
  toText: string,
  provider: ProviderId,
  target: TargetLang
): void {
  const updated = rt.configStore.addHistory(
    createHistoryEntry({
      id: crypto.randomUUID(),
      at: rt.now(),
      from: fromText,
      to: toText,
      provider,
      target
    })
  )
  if (updated) {
    activeDeps?.onHistoryChanged?.(updated)
  }
}

export interface TargetContext {
  handle: number
  pid: number
  exeName: string
  className: string
  title: string
  inputKind: WindowInputKind
  ideRegion?: IdeRegionKind
  uiaReason?: UiaProbeReason
}

export type TargetVerifyFailureReason =
  | 'target-closed'
  | 'target-minimized'
  | 'uipi-elevated'
  | 'target-foreground-lost'
  | 'target-changed'
  | 'target-tab-changed'

export type TargetVerifyResult =
  | { ok: true }
  | { ok: false; reason: TargetVerifyFailureReason }

let lastPopupTargetContext: TargetContext | null = null

export function captureTargetSnapshot(
  rt: SelectionRuntimeDeps,
  handle: number,
  classification?: WindowClassification
): TargetContext {
  const pid = rt.host.getTargetPid?.(handle) ?? 0
  const exeName = (rt.host.getTargetExeName?.(handle) ?? '').trim().toLowerCase()
  const className = (rt.host.getTargetClassName?.(handle) ?? '').trim().toLowerCase()
  const customSets = buildCustomExeSets(rt.configStore.get())
  const inputKind = classification?.inputKind ?? rt.host.getTargetPasteKind(handle, customSets)
  const title = inputKind === 'wt' || inputKind === 'conhost' ? rt.host.getWindowTitle(handle) : ''
  return {
    handle,
    pid,
    exeName,
    className,
    title,
    inputKind,
    ...(classification?.ideRegion !== undefined ? { ideRegion: classification.ideRegion } : {}),
    ...(classification?.uiaReason !== undefined ? { uiaReason: classification.uiaReason } : {})
  }
}

export function verifyTargetContext(
  rt: SelectionRuntimeDeps,
  ctx: TargetContext
): TargetVerifyResult {
  if (!ctx.handle || !rt.host.isTargetAlive(ctx.handle)) {
    return { ok: false, reason: 'target-closed' }
  }
  if (rt.host.isTargetMinimized(ctx.handle)) {
    return { ok: false, reason: 'target-minimized' }
  }
  if (rt.host.isWindowElevatedOverSelf(ctx.handle)) {
    return { ok: false, reason: 'uipi-elevated' }
  }
  if (rt.host.getActiveTargetHandle() !== ctx.handle) {
    return { ok: false, reason: 'target-foreground-lost' }
  }
  const pidNow = rt.host.getTargetPid?.(ctx.handle) ?? 0
  if (ctx.pid > 0 && pidNow > 0 && pidNow !== ctx.pid) {
    return { ok: false, reason: 'target-changed' }
  }
  const exeNow = (rt.host.getTargetExeName?.(ctx.handle) ?? '').trim().toLowerCase()
  if (ctx.exeName && exeNow && exeNow !== ctx.exeName) {
    return { ok: false, reason: 'target-changed' }
  }
  const classNow = (rt.host.getTargetClassName?.(ctx.handle) ?? '').trim().toLowerCase()
  if (ctx.className && classNow && classNow !== ctx.className) {
    return { ok: false, reason: 'target-changed' }
  }
  if ((ctx.inputKind === 'wt' || ctx.inputKind === 'conhost') && ctx.title) {
    const titleNow = rt.host.getWindowTitle(ctx.handle)
    if (titleNow !== ctx.title) {
      return { ok: false, reason: 'target-tab-changed' }
    }
  }
  return { ok: true }
}

function mapVerifyFailureMessage(reason: TargetVerifyFailureReason): string {
  switch (reason) {
    case 'target-closed':
      return MSG.TARGET_CLOSED
    case 'target-minimized':
      return MSG.TARGET_MINIMIZED
    case 'uipi-elevated':
      return MSG.UIPI_PASTE_FALLBACK
    case 'target-tab-changed':
      return MSG.TARGET_CHANGED_TAB
    case 'target-foreground-lost':
      return MSG.TARGET_FOREGROUND_LOST
    case 'target-changed':
      return MSG.PASTE_CANCELLED_TARGET_CHANGED
  }
}

function validatePastePreconditions(
  rt: SelectionRuntimeDeps,
  targetHandle: number,
  textToPaste: string
): PopupPasteReply | null {
  if (busy) {
    return { ok: false, status: 'error', reason: 'busy', message: MSG.BUSY_LOCKED }
  }
  if (textToPaste.trim() === '') {
    return { ok: false, status: 'error', reason: 'empty-text', message: MSG.TRANSLATION_EMPTY }
  }
  if (!rt.host.canInjectKeystrokes()) {
    // Graceful clipboard-only mode (e.g. Linux Wayland)
    return null
  }
  if (!targetHandle || !rt.host.isTargetAlive(targetHandle)) {
    return { ok: false, status: 'error', reason: 'target-closed', message: MSG.TARGET_CLOSED }
  }
  if (rt.host.isTargetMinimized(targetHandle)) {
    return { ok: false, status: 'error', reason: 'target-minimized', message: MSG.TARGET_MINIMIZED }
  }
  return null
}

function getPasteErrorMessage(err: unknown): string {
  const errMsg = err instanceof Error ? err.message : String(err)
  return errMsg === 'MACOS_ACCESSIBILITY_DENIED'
    ? MSG.MACOS_ACCESSIBILITY_DENIED_PASTE
    : MSG.PASTE_BLOCKED
}

export async function pasteTextToWindow(
  targetHandle: number,
  textToPaste: string,
  hidePopup?: () => void
): Promise<PopupPasteReply> {
  const rt = getRuntime()
  const preError = validatePastePreconditions(rt, targetHandle, textToPaste)
  if (preError !== null) {
    return preError
  }

  busy = true
  try {
    if (!rt.host.canInjectKeystrokes()) {
      await rt.clipboard.writeText(textToPaste)
      hidePopup?.()
      rt.notifySystem(MSG.CLIPBOARD_ONLY_MODE)
      return {
        ok: false,
        status: 'clipboard-only',
        reason: 'platform-no-inject',
        message: MSG.CLIPBOARD_ONLY_MODE
      }
    }

    if (rt.host.isWindowElevatedOverSelf(targetHandle)) {
      await rt.clipboard.writeText(textToPaste)
      rt.host.focusTarget(targetHandle)
      hidePopup?.()
      logWarn(`pasteTextToWindow UIPI fallback for handle=${targetHandle}`)
      rt.notifySystem(MSG.UIPI_PASTE_FALLBACK)
      return {
        ok: false,
        status: 'clipboard-only',
        reason: 'uipi-elevated',
        message: MSG.UIPI_PASTE_FALLBACK
      }
    }

    const trackedCtx =
      lastPopupTargetContext && lastPopupTargetContext.handle === targetHandle
        ? lastPopupTargetContext
        : captureTargetSnapshot(rt, targetHandle)

    // Pre-check identity mismatch before hiding popup if snapshot already drifted
    if (
      lastPopupTargetContext &&
      lastPopupTargetContext.handle === targetHandle &&
      trackedCtx === lastPopupTargetContext
    ) {
      const currentPid = rt.host.getTargetPid?.(targetHandle) ?? 0
      const currentExe = (rt.host.getTargetExeName?.(targetHandle) ?? '').trim().toLowerCase()
      const currentClass = (rt.host.getTargetClassName?.(targetHandle) ?? '').trim().toLowerCase()
      if (
        (trackedCtx.pid > 0 && currentPid > 0 && currentPid !== trackedCtx.pid) ||
        (trackedCtx.exeName && currentExe && currentExe !== trackedCtx.exeName) ||
        (trackedCtx.className && currentClass && currentClass !== trackedCtx.className)
      ) {
        return {
          ok: false,
          status: 'cancelled',
          reason: 'target-changed',
          message: MSG.PASTE_CANCELLED_TARGET_CHANGED
        }
      }
    }

    // Hide popup before focus transfer so Windows grants foreground cleanly
    hidePopup?.()

    await rt.host.releasePressedModifiers()

    if (rt.host.getActiveTargetHandle() !== targetHandle) {
      rt.host.focusTarget(targetHandle)
    }

    let confirmed = rt.host.getActiveTargetHandle() === targetHandle
    for (let attempt = 0; !confirmed && attempt < FOREGROUND_POLL_ATTEMPTS; attempt++) {
      await rt.sleep(FOREGROUND_POLL_INTERVAL_MS)
      confirmed = rt.host.getActiveTargetHandle() === targetHandle
    }

    if (!confirmed) {
      const currentActive = rt.host.getActiveTargetHandle()
      logWarn(`pasteTextToWindow foreground mismatch: expected=${targetHandle}, actual=${currentActive}`)
      deps?.reshowPopupInactive?.()
      rt.notifySystem(MSG.TARGET_FOREGROUND_LOST)
      return {
        ok: false,
        status: 'cancelled',
        reason: 'target-foreground-lost',
        message: MSG.TARGET_FOREGROUND_LOST
      }
    }

    await rt.sleep(30)

    const customSets = buildCustomExeSets(rt.configStore.get())
    const pasteKind =
      trackedCtx.ideRegion === 'terminal'
        ? 'wt'
        : rt.host.getTargetPasteKind(targetHandle, customSets)
    const snap = await rt.clipboardBackup.backupClipboard()
    await rt.clipboardBackup.writeTransientClipboardText(textToPaste)
    const seqAfterWrite = rt.host.getClipboardSequenceNumber()

    const preSendCheck = verifyTargetContext(rt, trackedCtx)
    if (!preSendCheck.ok) {
      await rt.clipboardBackup.restoreClipboardIfUnchanged(snap, textToPaste, seqAfterWrite)
      deps?.reshowPopupInactive?.()
      const cancelMessage = mapVerifyFailureMessage(preSendCheck.reason)
      logWarn(`pasteTextToWindow cancelled before paste: ${preSendCheck.reason}`)
      rt.notifySystem(cancelMessage)
      return {
        ok: false,
        status: 'cancelled',
        reason: preSendCheck.reason,
        message: cancelMessage
      }
    }

    try {
      rt.host.dispatchPasteShortcut(pasteKind)
    } catch (err) {
      await rt.clipboard.writeText(textToPaste)
      const errMsg = err instanceof Error ? err.message : String(err)
      const msg = getPasteErrorMessage(err)
      logError('pasteTextToWindow dispatchPaste failed', err)
      rt.notifySystem(msg)
      return {
        ok: false,
        status: 'clipboard-only',
        reason:
          errMsg === 'MACOS_ACCESSIBILITY_DENIED'
            ? 'macos-accessibility-denied'
            : 'paste-shortcut-failed',
        message: msg
      }
    }

    await rt.sleep(POST_PASTE_RESTORE_DELAY_MS)
    await rt.clipboardBackup.restoreClipboardIfUnchanged(snap, textToPaste, seqAfterWrite)
    return { ok: true, status: 'pasted' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('pasteTextToWindow unexpected error', err)
    return { ok: false, status: 'error', reason: 'unexpected-error', message: msg }
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
  recordHistory(rt, activeDeps, text, translatedText, usedProvider, to)
}

type CaptureResult =
  | {
      ok: true
      rawText: string
      normalizedText: string
      pasteKind: WindowInputKind
      titleAtStart: string
      snap: ClipboardSnapshot
      seqAfterRestore: number
      targetContext: TargetContext
    }
  | {
      ok: false
      reason:
        | 'own-window'
        | 'uipi'
        | 'ide-region-unknown'
        | 'copy-failed'
        | 'macos-accessibility-denied'
        | 'no-selection'
        | 'non-text'
        | 'too-long'
      targetContext?: TargetContext
    }

async function captureSelectionText(
  handle: number,
  rt: SelectionRuntimeDeps,
  cfg: AppConfig,
  mode: 'replace' | 'show'
): Promise<CaptureResult> {
  if (rt.host.isOwnProcessWindow(handle)) {
    return { ok: false, reason: 'own-window' }
  }
  if (rt.host.isWindowElevatedOverSelf(handle)) {
    return { ok: false, reason: 'uipi' }
  }

  const customSets = buildCustomExeSets(cfg)
  const classification = rt.host.getTargetWindowClassification
    ? await rt.host.getTargetWindowClassification(handle, customSets)
    : undefined
  if (classification?.ideRegion === 'unknown') {
    return {
      ok: false,
      reason: 'ide-region-unknown',
      targetContext: captureTargetSnapshot(rt, handle, classification)
    }
  }
  const copyKind = classification?.inputKind ?? rt.host.getTargetCopyKind(handle, customSets)
  const pasteKind = classification?.inputKind ?? rt.host.getTargetPasteKind(handle, customSets)
  const titleAtStart = pasteKind === 'wt' ? rt.host.getWindowTitle(handle) : ''

  await rt.host.releasePressedModifiers()

  const snap = await rt.clipboardBackup.backupClipboard()
  const sentinel = await rt.clipboardBackup.writeSentinel()

  try {
    rt.host.dispatchCopyShortcut(copyKind)
  } catch (err) {
    await rt.clipboardBackup.restoreClipboard(snap)
    logError('dispatchCopyShortcut failed', err)
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errMsg === 'MACOS_ACCESSIBILITY_DENIED') {
      return { ok: false, reason: 'macos-accessibility-denied' }
    }
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
    return { ok: false, reason: 'non-text' }
  }

  if (normalizedText.length > MAX_TRANSLATE_CHARS) {
    return { ok: false, reason: 'too-long' }
  }

  return {
    ok: true,
    rawText: rawCaptured,
    normalizedText,
    pasteKind,
    titleAtStart,
    snap,
    seqAfterRestore,
    targetContext: captureTargetSnapshot(
      rt,
      handle,
      classification ?? { inputKind: pasteKind }
    )
  }
}

function runShowMode(params: {
  text: string
  to: TargetLang
  targetContext?: TargetContext
  cfg: AppConfig
  rt: SelectionRuntimeDeps
  activeDeps: SelectionServiceDeps
  watchdog: AbortController
  clearWatchdog: () => void
}): void {
  const { text, to, targetContext, cfg, rt, activeDeps, watchdog, clearWatchdog } = params
  const requestId = crypto.randomUUID()
  lastPopupTargetContext = targetContext ?? null

  activeDeps.showPopupAtCursor({
    mode: 'selection',
    text,
    requestId,
    to,
    ...(targetContext?.exeName ? { targetApp: targetContext.exeName } : {}),
    ...(targetContext?.ideRegion ? { ideRegion: targetContext.ideRegion } : {})
  })
  activeDeps.onTranslationStart?.(requestId)

  const pushTimeoutError = (): void => {
    const error: TranslateErrorInfo = {
      code: 'TIMEOUT',
      provider: cfg.primaryProvider,
      message: MSG.TRANSLATE_TIMEOUT,
      retryable: true
    }
    const payload: TranslateErrorPush = { requestId, error }
    activeDeps.pushToPopup(IPC_CHANNELS.translateError, payload)
  }

  if (cfg.openai.stream) {
    let settled = false
    const finishStream = (): void => {
      settled = true
      clearWatchdog()
      watchdog.signal.removeEventListener('abort', onWatchdogAbort)
      activeDeps.onTranslationEnd?.(requestId)
    }

    const onWatchdogAbort = (): void => {
      if (settled) return
      finishStream()
      activeDeps.translateService.cancel(requestId)
      pushTimeoutError()
    }
    watchdog.signal.addEventListener('abort', onWatchdogAbort, { once: true })

    activeDeps.translateService.translateStream(
      requestId,
      { text, to },
      {
        onChunk: (delta) => {
          if (settled || watchdog.signal.aborted) return
          const payload: TranslateChunkPush = { requestId, delta }
          activeDeps.pushToPopup(IPC_CHANNELS.translateChunk, payload)
        },
        onDone: (result) => {
          if (settled) return
          finishStream()
          const payload: TranslateDonePush = { requestId, result }
          activeDeps.pushToPopup(IPC_CHANNELS.translateDone, payload)
          recordHistory(rt, activeDeps, text, result.text, result.provider, to)
        },
        onError: (error) => {
          if (settled) return
          finishStream()
          const payload: TranslateErrorPush = { requestId, error }
          activeDeps.pushToPopup(IPC_CHANNELS.translateError, payload)
        }
      }
    )
    return
  }

  void activeDeps.translateService
    .translateOnce({ text, to }, watchdog.signal, requestId)
    .then((result) => {
      clearWatchdog()
      activeDeps.onTranslationEnd?.(requestId)
      const payload: TranslateDonePush = { requestId, result }
      activeDeps.pushToPopup(IPC_CHANNELS.translateDone, payload)
      recordHistory(rt, activeDeps, text, result.text, result.provider, to)
    })
    .catch((err: unknown) => {
      clearWatchdog()
      activeDeps.onTranslationEnd?.(requestId)
      if (watchdog.signal.aborted) {
        pushTimeoutError()
        return
      }
      if (err instanceof ProviderError && err.info.code === 'ABORTED') {
        return
      }
      const error: TranslateErrorInfo =
        err instanceof ProviderError
          ? err.info
          : {
              code: 'NETWORK',
              provider: rt.configStore.get().primaryProvider,
              message: err instanceof Error ? err.message : String(err),
              retryable: true
            }
      const payload: TranslateErrorPush = { requestId, error }
      activeDeps.pushToPopup(IPC_CHANNELS.translateError, payload)
    })
}

async function pasteReplacementAndRecord(params: {
  translatedText: string
  sourceText: string
  pasteKind: WindowInputKind
  targetContext?: TargetContext
  snap: ClipboardSnapshot
  seqAfterRestore: number
  rt: SelectionRuntimeDeps
  activeDeps: SelectionServiceDeps
  to: TargetLang
  usedProvider: ProviderId
  usedFallback: boolean
  logContext: string
}): Promise<'done' | 'error'> {
  const {
    translatedText,
    sourceText,
    pasteKind,
    targetContext,
    snap,
    seqAfterRestore,
    rt,
    activeDeps,
    to,
    usedProvider,
    usedFallback,
    logContext
  } = params

  const curSeq = rt.host.getClipboardSequenceNumber()
  const snap2 =
    seqAfterRestore > 0 && curSeq === seqAfterRestore
      ? snap
      : await rt.clipboardBackup.backupClipboard()

  await rt.clipboardBackup.writeTransientClipboardText(translatedText)
  const seqAfterWrite = rt.host.getClipboardSequenceNumber()

  if (targetContext) {
    const preSendCheck = verifyTargetContext(rt, targetContext)
    if (!preSendCheck.ok) {
      await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)
      const cancelMsg = mapVerifyFailureMessage(preSendCheck.reason)
      logWarn(`pasteReplacementAndRecord cancelled before paste: ${preSendCheck.reason}`)
      showS11PopupFallback(
        activeDeps,
        rt,
        sourceText,
        to,
        translatedText,
        usedProvider,
        usedFallback,
        cancelMsg
      )
      return 'error'
    }
  }

  try {
    rt.host.dispatchPasteShortcut(pasteKind)
  } catch (err) {
    // Keep the translation on the user's clipboard so they can paste manually
    await rt.clipboard.writeText(translatedText)
    rt.notifySystem(getPasteErrorMessage(err))
    logError(logContext, err)
    return 'error'
  }

  await rt.sleep(POST_PASTE_RESTORE_DELAY_MS)
  await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)
  recordHistory(rt, activeDeps, sourceText, translatedText, usedProvider, to)
  return 'done'
}

const TERMINAL_BACKSPACE_BATCH_CHARS = 20
const TERMINAL_BACKSPACE_BATCH_INTERVAL_MS = 8

async function runReplaceModeTerminal(params: {
  translatedText: string
  rawText: string
  normalizedText: string
  pasteKind: WindowInputKind
  handle: number
  titleAtStart: string
  targetContext: TargetContext
  snap: ClipboardSnapshot
  seqAfterRestore: number
  rt: SelectionRuntimeDeps
  activeDeps: SelectionServiceDeps
  cfg: AppConfig
  to: TargetLang
  usedProvider: ProviderId
  usedFallback: boolean
}): Promise<'done' | 'error'> {
  const {
    translatedText,
    rawText,
    normalizedText,
    pasteKind,
    handle,
    titleAtStart,
    targetContext,
    snap,
    seqAfterRestore,
    rt,
    activeDeps,
    cfg,
    to,
    usedProvider,
    usedFallback
  } = params

  const eraseCount = countTerminalEraseChars(rawText)

  if (!cfg.terminalAutoBackspace || eraseCount === 0) {
    const requestId = crypto.randomUUID()
    lastPopupTargetContext = targetContext
    activeDeps.showPopupAtCursor({
      mode: 'selection',
      text: normalizedText,
      requestId,
      to,
      directPaste: true,
      ...(targetContext.exeName ? { targetApp: targetContext.exeName } : {}),
      ...(targetContext.ideRegion ? { ideRegion: targetContext.ideRegion } : {})
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
    recordHistory(rt, activeDeps, normalizedText, translatedText, usedProvider, to)
    return 'done'
  }

  const effectiveCtx: TargetContext =
    titleAtStart && !targetContext.title ? { ...targetContext, title: titleAtStart } : targetContext

  const titleNow = pasteKind === 'wt' ? rt.host.getWindowTitle(handle) : ''
  const titleChanged =
    pasteKind === 'wt' && titleAtStart !== '' && titleNow !== '' && titleNow !== titleAtStart

  const preCheck = verifyTargetContext(rt, effectiveCtx)
  if (!preCheck.ok || titleChanged) {
    showS11PopupFallback(
      activeDeps,
      rt,
      normalizedText,
      to,
      translatedText,
      usedProvider,
      usedFallback,
      titleChanged || (!preCheck.ok && preCheck.reason === 'target-tab-changed')
        ? MSG.TARGET_CHANGED_TAB
        : mapVerifyFailureMessage(preCheck.ok ? 'target-changed' : preCheck.reason)
    )
    return 'done'
  }

  await rt.host.releasePressedModifiers()

  // Prepare clipboard before destructive backspaces so partial-delete aborts never lose the translation
  const curSeq = rt.host.getClipboardSequenceNumber()
  const snap2 =
    seqAfterRestore > 0 && curSeq === seqAfterRestore
      ? snap
      : await rt.clipboardBackup.backupClipboard()
  await rt.clipboardBackup.writeTransientClipboardText(translatedText)
  const seqAfterWrite = rt.host.getClipboardSequenceNumber()

  let remaining = eraseCount
  let batchesSent = 0
  while (remaining > 0) {
    const batchVerify = verifyTargetContext(rt, effectiveCtx)
    if (!batchVerify.ok) {
      if (batchesSent > 0) {
        await rt.clipboard.writeText(translatedText)
        showS11PopupFallback(
          activeDeps,
          rt,
          normalizedText,
          to,
          translatedText,
          usedProvider,
          usedFallback,
          MSG.TARGET_CHANGED_AFTER_PARTIAL_DELETE
        )
      } else {
        await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)
        showS11PopupFallback(
          activeDeps,
          rt,
          normalizedText,
          to,
          translatedText,
          usedProvider,
          usedFallback,
          mapVerifyFailureMessage(batchVerify.reason)
        )
      }
      return 'error'
    }
    const chunk = Math.min(TERMINAL_BACKSPACE_BATCH_CHARS, remaining)
    await rt.host.dispatchBackspaces(chunk)
    batchesSent += 1
    remaining -= chunk
    if (remaining > 0) {
      await rt.sleep(TERMINAL_BACKSPACE_BATCH_INTERVAL_MS)
    }
  }

  await rt.sleep(20)

  const preSendCheck = verifyTargetContext(rt, effectiveCtx)
  if (!preSendCheck.ok) {
    if (batchesSent > 0) {
      await rt.clipboard.writeText(translatedText)
      showS11PopupFallback(
        activeDeps,
        rt,
        normalizedText,
        to,
        translatedText,
        usedProvider,
        usedFallback,
        MSG.TARGET_CHANGED_AFTER_PARTIAL_DELETE
      )
    } else {
      await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)
      showS11PopupFallback(
        activeDeps,
        rt,
        normalizedText,
        to,
        translatedText,
        usedProvider,
        usedFallback,
        mapVerifyFailureMessage(preSendCheck.reason)
      )
    }
    return 'error'
  }

  try {
    rt.host.dispatchPasteShortcut(pasteKind)
  } catch (err) {
    await rt.clipboard.writeText(translatedText)
    rt.notifySystem(getPasteErrorMessage(err))
    logError('dispatchPasteShortcut failed (terminal auto-backspace)', err)
    return 'error'
  }

  await rt.sleep(POST_PASTE_RESTORE_DELAY_MS)
  await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)
  recordHistory(rt, activeDeps, normalizedText, translatedText, usedProvider, to)
  return 'done'
}

async function runReplaceModeNormal(params: {
  translatedText: string
  handle: number
  targetContext: TargetContext
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
    targetContext,
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

  const preCheck = verifyTargetContext(rt, targetContext)
  if (!preCheck.ok) {
    showS11PopupFallback(
      activeDeps,
      rt,
      text,
      to,
      translatedText,
      usedProvider,
      usedFallback,
      preCheck.reason === 'target-foreground-lost'
        ? MSG.TARGET_CHANGED
        : mapVerifyFailureMessage(preCheck.reason)
    )
    return 'done'
  }

  await rt.host.releasePressedModifiers()

  return pasteReplacementAndRecord({
    translatedText,
    sourceText: text,
    pasteKind,
    targetContext,
    snap,
    seqAfterRestore,
    rt,
    activeDeps,
    to,
    usedProvider,
    usedFallback,
    logContext: 'dispatchPasteShortcut failed'
  })
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
  let watchdogTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    watchdogTimer = null
    logWarn(`selection flow watchdog timeout (${rt.watchdogTimeoutMs}ms)`)
    watchdog.abort()
  }, rt.watchdogTimeoutMs)
  watchdogTimer.unref?.()

  const clearWatchdog = (): void => {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }
  let watchdogOwnedByShow = false

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

    const cfg = rt.configStore.get()

    if (mode === 'replace' && shouldForcePopupOnReplace(handle0, rt, cfg)) {
      if (deps?.openDirectInput) {
        deps.openDirectInput(handle0)
        if (deps.notifyPopup) {
          deps.notifyPopup({ level: 'info', message: MSG.FORCE_POPUP_REPLACE_REDIRECT })
        } else {
          rt.notifySystem(MSG.FORCE_POPUP_REPLACE_REDIRECT)
        }
        return 'done'
      }
      rt.notifySystem(MSG.FORCE_POPUP_REPLACE_REDIRECT)
      return 'no-selection'
    }

    const capture = await captureSelectionText(handle0, rt, cfg, mode)
    if (!capture.ok) {
      switch (capture.reason) {
        case 'own-window':
          logInfo(`selection flow ignored on own process window handle=${handle0}`)
          return 'no-selection'
        case 'ide-region-unknown':
          if (mode === 'replace' && deps?.openDirectInput) {
            deps.openDirectInput(handle0)
            if (deps.notifyPopup) {
              deps.notifyPopup({ level: 'warn', message: MSG.IDE_REGION_UNKNOWN_POPUP })
            } else {
              rt.notifySystem(MSG.IDE_REGION_UNKNOWN_POPUP)
            }
            return 'done'
          }
          rt.notifySystem(MSG.IDE_REGION_UNKNOWN_COPY)
          return 'no-selection'
        case 'uipi':
          logWarn(`selection flow blocked by privilege boundary on handle=${handle0}`)
          rt.notifySystem(MSG.UIPI_BLOCKED)
          return 'no-selection'
        case 'macos-accessibility-denied':
          rt.notifySystem(MSG.MACOS_ACCESSIBILITY_DENIED_COPY)
          return 'error'
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
        case 'non-text':
          rt.notifySystem(MSG.NO_TEXT_SELECTED)
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
      watchdogOwnedByShow = true
      runShowMode({
        text,
        to,
        targetContext: capture.targetContext,
        cfg,
        rt,
        activeDeps: deps,
        watchdog,
        clearWatchdog
      })
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
        normalizedText: text,
        pasteKind: capture.pasteKind,
        handle: handle0,
        titleAtStart: capture.titleAtStart,
        targetContext: capture.targetContext,
        snap: capture.snap,
        seqAfterRestore: capture.seqAfterRestore,
        rt,
        activeDeps: deps,
        cfg,
        to,
        usedProvider,
        usedFallback
      })
    }

    return await runReplaceModeNormal({
      translatedText,
      handle: handle0,
      targetContext: capture.targetContext,
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
    if (!watchdogOwnedByShow) {
      clearWatchdog()
    }
    if (activeReplaceController === watchdog) {
      activeReplaceController = null
    }
    busy = false
  }
}
