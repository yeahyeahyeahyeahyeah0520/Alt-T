import crypto from 'node:crypto'
import {
  BrowserWindow,
  clipboard,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { isTargetLang } from '../shared/config'
import {
  IPC_CHANNELS,
  ProviderError,
  type AppConfig,
  type ConfigSetReply,
  type HistoryItem,
  type HotkeyCheckReply,
  type HotkeyConfig,
  type PopupPasteReply,
  type TranslateChunkPush,
  type TranslateDonePush,
  type TranslateErrorInfo,
  type TranslateErrorPush,
  type TranslateStartArgs,
  type TranslateStartReply
} from '../shared/types'
import type { TranslateService } from './services/translateService'
import type { PopupWindowController } from './windows/popupWindow'

const MAX_TRANSLATE_TEXT_LENGTH = 5000
const MAX_IPC_TEXT_LENGTH = 50000

export interface IpcDeps {
  configStore: {
    get: () => AppConfig
    set: (next: unknown) => AppConfig
    addHistory: (item: HistoryItem) => void
    clearHistory: () => void
  }
  translateService: TranslateService
  hotkeyService: {
    registerAll: (cfg: HotkeyConfig) => Array<{ key: keyof HotkeyConfig; accelerator: string }>
    checkHotkey: (accelerator: string) => HotkeyCheckReply
  }
  popupWindow: PopupWindowController
  tray: {
    rebuildMenu: () => void
  }
  openSettingsWindow: () => void
  validatePastePreconditions: (targetHandle: number, text: string) => PopupPasteReply | null
  pasteToTargetWindow: (
    targetHandle: number,
    text: string,
    hidePopup?: (() => void) | boolean
  ) => Promise<PopupPasteReply>
  syncAutoLaunch?: (enabled: boolean) => void
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function badArgsError(channel: string): Error {
  return new Error(`IPC_BAD_ARGS:${channel}`)
}

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  const frameUrl = event.senderFrame?.url ?? event.sender.getURL() ?? ''
  if (frameUrl.startsWith('file://')) {
    return
  }
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    try {
      const allowedOrigin = new URL(devUrl).origin
      if (new URL(frameUrl).origin === allowedOrigin) {
        return
      }
    } catch {
      // Fall through to untrusted error
    }
  }
  throw new Error(`IPC_UNTRUSTED_SENDER:${channel}`)
}

function validateTranslateStartArgs(raw: unknown): TranslateStartArgs {
  if (!isRecord(raw)) throw badArgsError(IPC_CHANNELS.translateStart)
  if (typeof raw.requestId !== 'string' || raw.requestId.trim() === '') {
    throw badArgsError(IPC_CHANNELS.translateStart)
  }
  if (typeof raw.text !== 'string' || raw.text.length > MAX_IPC_TEXT_LENGTH) {
    throw badArgsError(IPC_CHANNELS.translateStart)
  }
  if (!isTargetLang(raw.to)) {
    throw badArgsError(IPC_CHANNELS.translateStart)
  }
  if (typeof raw.stream !== 'boolean') {
    throw badArgsError(IPC_CHANNELS.translateStart)
  }
  return {
    requestId: raw.requestId,
    text: raw.text,
    to: raw.to,
    stream: raw.stream
  }
}

function validateRequestIdArg(raw: unknown, channel: string): string {
  if (!isRecord(raw) || typeof raw.requestId !== 'string' || raw.requestId.trim() === '') {
    throw badArgsError(channel)
  }
  return raw.requestId
}

function broadcastConfigChanged(cfg: AppConfig): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.configChanged, cfg)
    }
  }
}

function pushToWebContents(sender: WebContents, channel: string, payload: unknown): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload)
  }
}

export function registerIpc(deps: IpcDeps): void {
  const nonStreamControllers = new Map<string, AbortController>()
  const cancelledIds = new Set<string>()

  function markCancelled(requestId: string): void {
    cancelledIds.add(requestId)
    if (cancelledIds.size > 500) {
      const oldest = cancelledIds.values().next().value
      if (oldest !== undefined) {
        cancelledIds.delete(oldest)
      }
    }
  }

  function recordHistoryIfEnabled(
    fromText: string,
    toText: string,
    provider: 'openai' | 'edge',
    target: 'en' | 'zh-Hans'
  ): void {
    const cfg = deps.configStore.get()
    if (!cfg.historyEnabled) return
    deps.configStore.addHistory({
      id: crypto.randomUUID(),
      at: Date.now(),
      from: fromText.slice(0, 2000),
      to: toText.slice(0, 4000),
      provider,
      target
    })
  }

  const allInvokeChannels = [
    IPC_CHANNELS.appPing,
    IPC_CHANNELS.configGet,
    IPC_CHANNELS.configSet,
    IPC_CHANNELS.translateStart,
    IPC_CHANNELS.translateCancel,
    IPC_CHANNELS.popupPin,
    IPC_CHANNELS.popupHide,
    IPC_CHANNELS.popupResize,
    IPC_CHANNELS.popupPasteToTarget,
    IPC_CHANNELS.clipboardWrite,
    IPC_CHANNELS.historyClear,
    IPC_CHANNELS.hotkeyCheck,
    IPC_CHANNELS.settingsOpen
  ]
  for (const ch of allInvokeChannels) {
    ipcMain.removeHandler(ch)
  }

  ipcMain.handle(IPC_CHANNELS.appPing, (event) => {
    assertTrustedSender(event, IPC_CHANNELS.appPing)
    return { ok: true as const, ts: Date.now() }
  })

  ipcMain.handle(IPC_CHANNELS.configGet, (event) => {
    assertTrustedSender(event, IPC_CHANNELS.configGet)
    return deps.configStore.get()
  })

  ipcMain.handle(IPC_CHANNELS.configSet, (event, raw: unknown): ConfigSetReply => {
    assertTrustedSender(event, IPC_CHANNELS.configSet)
    if (!isRecord(raw) || !isRecord(raw.config)) {
      throw badArgsError(IPC_CHANNELS.configSet)
    }
    const saved = deps.configStore.set(raw.config)
    const hotkeyConflicts = deps.hotkeyService.registerAll(saved.hotkeys)
    deps.syncAutoLaunch?.(saved.autoLaunch)
    deps.tray.rebuildMenu()
    broadcastConfigChanged(saved)
    return { ok: true, hotkeyConflicts }
  })

  ipcMain.handle(IPC_CHANNELS.historyClear, (event) => {
    assertTrustedSender(event, IPC_CHANNELS.historyClear)
    deps.configStore.clearHistory()
    broadcastConfigChanged(deps.configStore.get())
  })

  ipcMain.handle(IPC_CHANNELS.clipboardWrite, async (event, raw: unknown) => {
    assertTrustedSender(event, IPC_CHANNELS.clipboardWrite)
    if (!isRecord(raw) || typeof raw.text !== 'string' || raw.text.length > MAX_IPC_TEXT_LENGTH) {
      throw badArgsError(IPC_CHANNELS.clipboardWrite)
    }
    await clipboard.writeText(raw.text)
  })

  ipcMain.handle(IPC_CHANNELS.popupPin, (event, raw: unknown): boolean => {
    assertTrustedSender(event, IPC_CHANNELS.popupPin)
    if (!isRecord(raw) || typeof raw.pinned !== 'boolean') {
      throw badArgsError(IPC_CHANNELS.popupPin)
    }
    return deps.popupWindow.pin(raw.pinned)
  })

  ipcMain.handle(IPC_CHANNELS.popupHide, (event) => {
    assertTrustedSender(event, IPC_CHANNELS.popupHide)
    deps.popupWindow.hide()
  })

  ipcMain.handle(IPC_CHANNELS.popupResize, (event, raw: unknown) => {
    assertTrustedSender(event, IPC_CHANNELS.popupResize)
    if (!isRecord(raw) || typeof raw.height !== 'number' || !Number.isFinite(raw.height)) {
      throw badArgsError(IPC_CHANNELS.popupResize)
    }
    deps.popupWindow.resize(raw.height)
  })

  ipcMain.handle(
    IPC_CHANNELS.popupPasteToTarget,
    async (event, raw: unknown): Promise<PopupPasteReply> => {
      assertTrustedSender(event, IPC_CHANNELS.popupPasteToTarget)
      if (!isRecord(raw) || typeof raw.text !== 'string' || raw.text.length > MAX_IPC_TEXT_LENGTH) {
        throw badArgsError(IPC_CHANNELS.popupPasteToTarget)
      }
      const targetHandle = deps.popupWindow.getLastTargetHandle()
      const preError = deps.validatePastePreconditions(targetHandle, raw.text)
      if (preError !== null) {
        return preError
      }
      return deps.pasteToTargetWindow(targetHandle, raw.text, () => {
        deps.popupWindow.hide()
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.hotkeyCheck, (event, raw: unknown): HotkeyCheckReply => {
    assertTrustedSender(event, IPC_CHANNELS.hotkeyCheck)
    if (!isRecord(raw) || typeof raw.accelerator !== 'string') {
      throw badArgsError(IPC_CHANNELS.hotkeyCheck)
    }
    return deps.hotkeyService.checkHotkey(raw.accelerator)
  })

  ipcMain.handle(IPC_CHANNELS.settingsOpen, (event) => {
    assertTrustedSender(event, IPC_CHANNELS.settingsOpen)
    deps.openSettingsWindow()
  })

  ipcMain.handle(IPC_CHANNELS.translateStart, (event, raw: unknown): TranslateStartReply => {
    assertTrustedSender(event, IPC_CHANNELS.translateStart)
    const args = validateTranslateStartArgs(raw)
    if (args.text.trim() === '') {
      return { accepted: false }
    }

    const { requestId, text, to, stream } = args
    const sender = event.sender

    if (text.length > MAX_TRANSLATE_TEXT_LENGTH) {
      const payload: TranslateErrorPush = {
        requestId,
        error: {
          code: 'PARSE',
          provider: deps.configStore.get().primaryProvider,
          message: `文本超过 ${MAX_TRANSLATE_TEXT_LENGTH} 字符上限`,
          retryable: false
        }
      }
      queueMicrotask(() => {
        pushToWebContents(sender, IPC_CHANNELS.translateError, payload)
      })
      return { accepted: true }
    }

    cancelledIds.delete(requestId)
    const prevAc = nonStreamControllers.get(requestId)
    if (prevAc) {
      nonStreamControllers.delete(requestId)
      prevAc.abort()
    }
    deps.translateService.cancel(requestId)
    deps.popupWindow.beginTranslation(requestId)

    if (stream) {
      deps.translateService.translateStream(
        requestId,
        { text, to },
        {
          onChunk: (delta) => {
            if (cancelledIds.has(requestId)) return
            const payload: TranslateChunkPush = { requestId, delta }
            pushToWebContents(sender, IPC_CHANNELS.translateChunk, payload)
          },
          onDone: (result) => {
            deps.popupWindow.endTranslation(requestId)
            if (cancelledIds.has(requestId)) return
            const payload: TranslateDonePush = { requestId, result }
            pushToWebContents(sender, IPC_CHANNELS.translateDone, payload)
            recordHistoryIfEnabled(text, result.text, result.provider, to)
          },
          onError: (error) => {
            deps.popupWindow.endTranslation(requestId)
            if (cancelledIds.has(requestId)) return
            const payload: TranslateErrorPush = { requestId, error }
            pushToWebContents(sender, IPC_CHANNELS.translateError, payload)
          }
        }
      )
      return { accepted: true }
    }

    const ac = new AbortController()
    nonStreamControllers.set(requestId, ac)

    void deps.translateService
      .translateOnce({ text, to }, ac.signal)
      .then((result) => {
        const wasActive = nonStreamControllers.delete(requestId)
        deps.popupWindow.endTranslation(requestId)
        if (!wasActive || ac.signal.aborted || cancelledIds.has(requestId)) return
        const payload: TranslateDonePush = { requestId, result }
        pushToWebContents(sender, IPC_CHANNELS.translateDone, payload)
        recordHistoryIfEnabled(text, result.text, result.provider, to)
      })
      .catch((err: unknown) => {
        const wasActive = nonStreamControllers.delete(requestId)
        deps.popupWindow.endTranslation(requestId)
        if (!wasActive || ac.signal.aborted || cancelledIds.has(requestId)) return

        const provider = deps.configStore.get().primaryProvider
        const info: TranslateErrorInfo =
          err instanceof ProviderError
            ? err.info
            : {
                code: 'NETWORK',
                provider,
                message: err instanceof Error ? err.message : String(err),
                retryable: true
              }

        const payload: TranslateErrorPush = { requestId, error: info }
        pushToWebContents(sender, IPC_CHANNELS.translateError, payload)
      })

    return { accepted: true }
  })

  ipcMain.handle(IPC_CHANNELS.translateCancel, (event, raw: unknown) => {
    assertTrustedSender(event, IPC_CHANNELS.translateCancel)
    const requestId = validateRequestIdArg(raw, IPC_CHANNELS.translateCancel)
    markCancelled(requestId)
    const ac = nonStreamControllers.get(requestId)
    if (ac) {
      nonStreamControllers.delete(requestId)
      ac.abort()
    }
    deps.translateService.cancel(requestId)
    deps.popupWindow.endTranslation(requestId)
  })
}
