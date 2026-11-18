import crypto from 'node:crypto'
import { clipboard, Notification } from 'electron'
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
    new Notification({ title: 'FlashPrompt', body }).show()
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
    return { ok: false, message: '取词或粘贴任务正忙，请稍后重试' }
  }
  if (textToPaste.trim() === '') {
    return { ok: false, message: '译文为空，无法填入' }
  }
  if (!rt.host.canInjectKeystrokes()) {
    // Graceful clipboard-only mode (e.g. Linux Wayland)
    return null
  }
  if (!targetHandle || !rt.host.isTargetAlive(targetHandle)) {
    return { ok: false, message: '原目标窗口已关闭或未记录，请重新从目标窗口呼出浮窗' }
  }
  if (rt.host.isTargetMinimized(targetHandle)) {
    return { ok: false, message: '原目标窗口已最小化，请先恢复窗口或点击“复制”手动粘贴' }
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
      rt.notifySystem('译文已复制到剪贴板，请直接粘贴')
      return { ok: true }
    }

    if (rt.host.isWindowElevatedOverSelf(targetHandle)) {
      await rt.clipboard.writeText(textToPaste)
      rt.host.focusTarget(targetHandle)
      hideFn?.()
      const msg =
        '目标窗口为管理员权限(UIPI拦截)，译文已复制到剪贴板，请手动按 Ctrl+V / Shift+Insert 粘贴'
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
      const msg = '无法切换到原目标窗口，译文已复制到剪贴板，请手动按 Ctrl+V / Shift+Insert 粘贴'
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
          ? '未授予系统辅助功能权限，译文已复制到剪贴板，请按 Cmd+V 粘贴'
          : '自动粘贴受阻，译文已保留在剪贴板，请手动按 Ctrl+V / Shift+Insert 粘贴'
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
      rt.notifySystem('当前桌面环境不支持跨窗按键取词，请使用 Alt+T 输入翻译')
      return 'no-selection'
    }

    const handle0 = rt.host.getActiveTargetHandle()
    if (handle0 === 0) {
      rt.notifySystem('没有前台窗口')
      return 'error'
    }

    if (rt.host.isOwnProcessWindow(handle0)) {
      logInfo(`selection flow ignored on own process window handle=${handle0}`)
      return 'no-selection'
    }

    if (rt.host.isWindowElevatedOverSelf(handle0)) {
      logWarn(`selection flow blocked by privilege boundary on handle=${handle0}`)
      rt.notifySystem('未选中文本或目标窗口为高权限(UIPI)')
      return 'no-selection'
    }

    const copyKind = rt.host.getTargetCopyKind(handle0)
    const pasteKind = rt.host.getTargetPasteKind(handle0)
    const titleAtStart = pasteKind === 'wt' ? rt.host.getWindowTitle(handle0) : ''

    await rt.host.releasePressedModifiers()

    const snap1 = await rt.clipboardBackup.backupClipboard()
    const sentinel = await rt.clipboardBackup.writeSentinel()

    try {
      rt.host.dispatchCopyShortcut(copyKind)
    } catch (err) {
      await rt.clipboardBackup.restoreClipboard(snap1)
      const errMsg = err instanceof Error ? err.message : String(err)
      rt.notifySystem(
        errMsg === 'MACOS_ACCESSIBILITY_DENIED'
          ? '请在系统设置 → 辅助功能 中授权 FlashPrompt'
          : '发送复制快捷键失败'
      )
      logError('dispatchCopyShortcut failed', err)
      return 'error'
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
      await rt.clipboardBackup.restoreClipboard(snap1)
      if (pasteKind !== 'normal' && mode === 'replace' && deps?.openDirectInput) {
        deps.openDirectInput(handle0)
        return 'done'
      }
      rt.notifySystem('未选中文本或目标窗口为高权限(UIPI)')
      return 'no-selection'
    }

    const text = pasteKind !== 'normal' ? normalizeTerminalCapturedText(rawCaptured) : rawCaptured

    if (text.trim() === '') {
      await rt.clipboardBackup.restoreClipboard(snap1)
      rt.notifySystem('选中内容不是文本')
      return 'no-selection'
    }

    await rt.clipboardBackup.restoreClipboard(snap1)
    const seqAfterS7 = rt.host.getClipboardSequenceNumber()

    if (text.length > 5000) {
      rt.notifySystem('文本超过 5000 字符')
      return 'error'
    }

    const to = detectTargetLang(text)
    logInfo(`selection captured: "${truncatePreview(text, 40)}" -> to=${to} kind=${pasteKind}`)

    if (!deps) {
      rt.notifySystem('翻译服务未初始化')
      return 'error'
    }

    const activeDeps = deps

    if (mode === 'show') {
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

      return 'done'
    }

    let translatedText: string
    let usedProvider: ProviderId
    let usedFallback: boolean
    try {
      const res = await activeDeps.translateService.translateOnce({ text, to }, watchdog.signal)
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

    if (pasteKind !== 'normal') {
      const cfg = rt.configStore.get()
      const eraseCount = countTerminalEraseChars(rawCaptured)
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
          message: '终端选区已译好：按 Enter 直接填入命令行，按 Esc 关闭'
        })
        recordHistoryIfEnabled(rt, text, translatedText, usedProvider, to)
        return 'done'
      }

      const handleNow = rt.host.getActiveTargetHandle()
      const titleNow = pasteKind === 'wt' ? rt.host.getWindowTitle(handle0) : ''
      const titleChanged =
        pasteKind === 'wt' && titleAtStart !== '' && titleNow !== '' && titleNow !== titleAtStart

      if (handleNow !== handle0 || titleChanged) {
        showS11PopupFallback(
          activeDeps,
          rt,
          text,
          to,
          translatedText,
          usedProvider,
          usedFallback,
          '目标窗口或标签页已变化，未替换'
        )
        return 'done'
      }

      await rt.host.releasePressedModifiers()
      await rt.host.dispatchBackspaces(eraseCount)
      await rt.sleep(20)

      const curSeq = rt.host.getClipboardSequenceNumber()
      const snap2 =
        seqAfterS7 > 0 && curSeq === seqAfterS7
          ? snap1
          : await rt.clipboardBackup.backupClipboard()

      await rt.clipboardBackup.writeTransientClipboardText(translatedText)
      const seqAfterWrite = rt.host.getClipboardSequenceNumber()

      try {
        rt.host.dispatchPasteShortcut(pasteKind)
      } catch (err) {
        await rt.clipboardBackup.restoreClipboard(snap2)
        rt.notifySystem('发送粘贴快捷键失败')
        logError('dispatchPasteShortcut failed (terminal auto-backspace)', err)
        return 'error'
      }

      await rt.sleep(POST_PASTE_RESTORE_DELAY_MS)
      await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)
      recordHistoryIfEnabled(rt, text, translatedText, usedProvider, to)
      return 'done'
    }

    const handleNow = rt.host.getActiveTargetHandle()
    if (handleNow !== handle0) {
      showS11PopupFallback(
        activeDeps,
        rt,
        text,
        to,
        translatedText,
        usedProvider,
        usedFallback,
        '目标窗口已变化，未替换'
      )
      return 'done'
    }

    await rt.host.releasePressedModifiers()

    const curSeq = rt.host.getClipboardSequenceNumber()
    const snap2 =
      seqAfterS7 > 0 && curSeq === seqAfterS7
        ? snap1
        : await rt.clipboardBackup.backupClipboard()

    await rt.clipboardBackup.writeTransientClipboardText(translatedText)
    const seqAfterWrite = rt.host.getClipboardSequenceNumber()

    try {
      rt.host.dispatchPasteShortcut(pasteKind)
    } catch (err) {
      await rt.clipboardBackup.restoreClipboard(snap2)
      rt.notifySystem('发送粘贴快捷键失败')
      logError('dispatchPasteShortcut failed', err)
      return 'error'
    }

    await rt.sleep(POST_PASTE_RESTORE_DELAY_MS)
    await rt.clipboardBackup.restoreClipboardIfUnchanged(snap2, translatedText, seqAfterWrite)

    recordHistoryIfEnabled(rt, text, translatedText, usedProvider, to)

    return 'done'
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
