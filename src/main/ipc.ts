import crypto from 'node:crypto'
import {
  BrowserWindow,
  clipboard,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { createHistoryEntry, HOTKEY_KEYS, isRecord, isTargetLang } from '../shared/config'
import { MSG } from '../shared/messages'
import {
  IPC_CHANNELS,
  MAX_TRANSLATE_CHARS,
  ProviderError,
  type AppConfig,
  type ConfigSetReply,
  type HistoryItem,
  type HotkeyCheckReply,
  type HotkeyConfig,
  type PopupPasteReply,
  type ProviderId,
  type ProviderTestReply,
  type TargetLang,
  type TranslateChunkPush,
  type TranslateDonePush,
  type TranslateErrorInfo,
  type TranslateErrorPush,
  type TranslateStartArgs,
  type TranslateStartReply
} from '../shared/types'
import { testProviderDraft } from './providers/providerTest'
import type { TranslateService } from './services/translateService'
import type { PopupWindowController } from './windows/popupWindow'

const MAX_IPC_TEXT_LENGTH = 50000

export interface IpcDeps {
  configStore: {
    get: () => AppConfig
    set: (next: unknown) => AppConfig
    addHistory: (item: HistoryItem) => AppConfig | null | void
    clearHistory: () => AppConfig | void
  }
  translateService: TranslateService
  hotkeyService: {
    registerAll: (cfg: HotkeyConfig) => Array<{ key: keyof HotkeyConfig; accelerator: string }>
    verifyHotkeys: () => { ok: boolean; missing: string[] }
    checkHotkey: (accelerator: string) => HotkeyCheckReply
  }
  popupWindow: PopupWindowController
  tray: {
    rebuildMenu: () => void
  }
  openSettingsWindow: () => void
  pasteToTargetWindow: (
    targetHandle: number,
    text: string,
    hidePopup?: () => void
  ) => Promise<PopupPasteReply>
  syncAutoLaunch?: (enabled: boolean) => void
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

export function broadcastConfigChanged(cfg: AppConfig): void {
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

  function recordHistoryAndBroadcast(
    fromText: string,
    toText: string,
    provider: ProviderId,
    target: TargetLang
  ): void {
    const updated = deps.configStore.addHistory(
      createHistoryEntry({
        id: crypto.randomUUID(),
        at: Date.now(),
        from: fromText,
        to: toText,
        provider,
        target
      })
    )
    if (updated) {
      broadcastConfigChanged(updated)
    }
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
    IPC_CHANNELS.providerTest,
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
    const prev = deps.configStore.get()
    const saved = deps.configStore.set(raw.config)

    const hotkeysChanged = HOTKEY_KEYS.some((k) => prev.hotkeys[k] !== saved.hotkeys[k])
    const needsHotkeyRegister = hotkeysChanged || !deps.hotkeyService.verifyHotkeys().ok
    const hotkeyConflicts = needsHotkeyRegister
      ? deps.hotkeyService.registerAll(saved.hotkeys)
      : []

    const autoLaunchChanged = prev.autoLaunch !== saved.autoLaunch
    if (autoLaunchChanged) {
      deps.syncAutoLaunch?.(saved.autoLaunch)
    }
    if (autoLaunchChanged || hotkeysChanged) {
      deps.tray.rebuildMenu()
    }
    broadcastConfigChanged(saved)
    return { ok: true, hotkeyConflicts }
  })

  ipcMain.handle(IPC_CHANNELS.historyClear, (event) => {
    assertTrustedSender(event, IPC_CHANNELS.historyClear)
    const updated = deps.configStore.clearHistory()
    broadcastConfigChanged(updated ?? deps.configStore.get())
  })

  ipcMain.handle(IPC_CHANNELS.clipboardWrite, (event, raw: unknown) => {
    assertTrustedSender(event, IPC_CHANNELS.clipboardWrite)
    if (!isRecord(raw) || typeof raw.text !== 'string' || raw.text.length > MAX_IPC_TEXT_LENGTH) {
      throw badArgsError(IPC_CHANNELS.clipboardWrite)
    }
    clipboard.writeText(raw.text)
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
      deps.popupWindow.setPasting(true)
      try {
        return await deps.pasteToTargetWindow(targetHandle, raw.text, () => {
          deps.popupWindow.hide()
        })
      } finally {
        deps.popupWindow.setPasting(false)
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.hotkeyCheck, (event, raw: unknown): HotkeyCheckReply => {
    assertTrustedSender(event, IPC_CHANNELS.hotkeyCheck)
    if (!isRecord(raw) || typeof raw.accelerator !== 'string') {
      throw badArgsError(IPC_CHANNELS.hotkeyCheck)
    }
    return deps.hotkeyService.checkHotkey(raw.accelerator)
  })

  ipcMain.handle(
    IPC_CHANNELS.providerTest,
    async (event, raw: unknown): Promise<ProviderTestReply> => {
      assertTrustedSender(event, IPC_CHANNELS.providerTest)
      return await testProviderDraft(raw)
    }
  )

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

    if (text.length > MAX_TRANSLATE_CHARS) {
      const payload: TranslateErrorPush = {
        requestId,
        error: {
          code: 'PARSE',
          provider: deps.configStore.get().primaryProvider,
          message: MSG.TEXT_TOO_LONG,
          retryable: false
        }
      }
      queueMicrotask(() => {
        pushToWebContents(sender, IPC_CHANNELS.translateError, payload)
      })
      return { accepted: true }
    }

    cancelledIds.delete(requestId)
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
            recordHistoryAndBroadcast(text, result.text, result.provider, to)
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

    void deps.translateService
      .translateOnce({ text, to }, undefined, requestId)
      .then((result) => {
        deps.popupWindow.endTranslation(requestId)
        if (cancelledIds.has(requestId)) return
        const payload: TranslateDonePush = { requestId, result }
        pushToWebContents(sender, IPC_CHANNELS.translateDone, payload)
        recordHistoryAndBroadcast(text, result.text, result.provider, to)
      })
      .catch((err: unknown) => {
        deps.popupWindow.endTranslation(requestId)
        if (cancelledIds.has(requestId) || (err instanceof ProviderError && err.info.code === 'ABORTED')) {
          return
        }

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
    deps.translateService.cancel(requestId)
    deps.popupWindow.endTranslation(requestId)
  })
}
