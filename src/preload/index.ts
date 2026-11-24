import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isValidGlobalAccelerator, mergeConfig } from '../shared/config'
import { MSG } from '../shared/messages'
import {
  DEFAULT_CONFIG,
  IPC_CHANNELS,
  type AppConfig,
  type ConfigSetArgs,
  type ConfigSetReply,
  type HotkeyCheckReply,
  type NotifyPush,
  type PopupPasteArgs,
  type PopupPasteReply,
  type PopupShowPush,
  type ProviderTestArgs,
  type ProviderTestReply,
  type RendererApi,
  type TranslateChunkPush,
  type TranslateDonePush,
  type TranslateErrorPush,
  type TranslateStartArgs,
  type TranslateStartReply
} from '../shared/types'

const NO_HANDLER_RE = /No handler registered/i

async function invokeWithFallback<T>(
  channel: string,
  fallback: () => T,
  ...args: unknown[]
): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (NO_HANDLER_RE.test(message)) {
      return fallback()
    }
    throw err
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    cb(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: RendererApi = {
  translateStart: (args: TranslateStartArgs): Promise<TranslateStartReply> =>
    invokeWithFallback<TranslateStartReply>(
      IPC_CHANNELS.translateStart,
      () => ({ accepted: false }),
      args
    ),
  translateCancel: (requestId: string): Promise<void> =>
    invokeWithFallback<void>(IPC_CHANNELS.translateCancel, () => undefined, { requestId }),
  configGet: (): Promise<AppConfig> =>
    invokeWithFallback<AppConfig>(IPC_CHANNELS.configGet, () => mergeConfig(DEFAULT_CONFIG)),
  configSet: (args: ConfigSetArgs): Promise<ConfigSetReply> =>
    invokeWithFallback<ConfigSetReply>(
      IPC_CHANNELS.configSet,
      () => ({ ok: false, hotkeyConflicts: [] }),
      args
    ),
  historyClear: (): Promise<void> =>
    invokeWithFallback<void>(IPC_CHANNELS.historyClear, () => undefined),
  clipboardWrite: (text: string): Promise<void> =>
    invokeWithFallback<void>(IPC_CHANNELS.clipboardWrite, () => undefined, { text }),
  popupPin: (pinned: boolean): Promise<boolean> =>
    invokeWithFallback<boolean>(IPC_CHANNELS.popupPin, () => false, { pinned }),
  popupHide: (): Promise<void> =>
    invokeWithFallback<void>(IPC_CHANNELS.popupHide, () => undefined),
  popupResize: (height: number): Promise<void> =>
    invokeWithFallback<void>(IPC_CHANNELS.popupResize, () => undefined, { height }),
  popupPasteToTarget: (args: PopupPasteArgs): Promise<PopupPasteReply> =>
    invokeWithFallback<PopupPasteReply>(
      IPC_CHANNELS.popupPasteToTarget,
      () => ({
        ok: false,
        status: 'error',
        reason: 'main-outdated',
        message: MSG.MAIN_OUTDATED
      }),
      args
    ),
  settingsOpen: (): Promise<void> =>
    invokeWithFallback<void>(IPC_CHANNELS.settingsOpen, () => undefined),
  hotkeyCheck: (accelerator: string): Promise<HotkeyCheckReply> =>
    invokeWithFallback<HotkeyCheckReply>(
      IPC_CHANNELS.hotkeyCheck,
      () => ({ valid: isValidGlobalAccelerator(accelerator), occupied: false }),
      { accelerator }
    ),
  providerTest: (args: ProviderTestArgs): Promise<ProviderTestReply> =>
    invokeWithFallback<ProviderTestReply>(
      IPC_CHANNELS.providerTest,
      () => ({
        ok: false,
        provider: args.provider,
        latencyMs: 0,
        errorCode: 'UNSUPPORTED',
        errorMessage: MSG.MAIN_OUTDATED
      }),
      args
    ),
  appPing: (): Promise<{ ok: true; ts: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.appPing) as Promise<{ ok: true; ts: number }>,

  onTranslateChunk: (cb: (p: TranslateChunkPush) => void): (() => void) =>
    subscribe<TranslateChunkPush>(IPC_CHANNELS.translateChunk, cb),
  onTranslateDone: (cb: (p: TranslateDonePush) => void): (() => void) =>
    subscribe<TranslateDonePush>(IPC_CHANNELS.translateDone, cb),
  onTranslateError: (cb: (p: TranslateErrorPush) => void): (() => void) =>
    subscribe<TranslateErrorPush>(IPC_CHANNELS.translateError, cb),
  onPopupShow: (cb: (p: PopupShowPush) => void): (() => void) =>
    subscribe<PopupShowPush>(IPC_CHANNELS.popupShow, cb),
  onNotify: (cb: (p: NotifyPush) => void): (() => void) =>
    subscribe<NotifyPush>(IPC_CHANNELS.notify, cb),
  onConfigChanged: (cb: (p: AppConfig) => void): (() => void) =>
    subscribe<AppConfig>(IPC_CHANNELS.configChanged, cb)
}

contextBridge.exposeInMainWorld('api', api)
