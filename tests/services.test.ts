import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { MSG } from '../src/shared/messages'
import { DEFAULT_CONFIG, ProviderError, type AppConfig, type HistoryItem } from '../src/shared/types'
import { getWindowsStartupDir, resolveUnpackagedRootDir, syncAutoLaunch } from '../src/main/platform/autoLaunch'
import { createClipboardManager, type ClipboardSnapshot } from '../src/main/platform/clipboardBackup'
import { createConfigStore } from '../src/main/services/configStore'
import { createHotkeyService } from '../src/main/services/hotkeyService'
import { createLogger } from '../src/main/services/logger'
import {
  configureSelectionService,
  pasteTextToWindow,
  runSelectionFlow,
  setSelectionRuntimeForTest
} from '../src/main/services/selectionService'
import type { TranslateService } from '../src/main/services/translateService'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  setSelectionRuntimeForTest(null)
  configureSelectionService(null)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('configStore', () => {
  it('retries atomic rename on EPERM, encrypts API keys via DPAPI, and recovers corrupt JSON', () => {
    const dir = makeTempDir('alt-t-cfg-')
    let renameAttempts = 0
    const wrappedFs = {
      ...fs,
      renameSync: (oldP: fs.PathLike, newP: fs.PathLike) => {
        renameAttempts++
        if (renameAttempts === 1) {
          const err = new Error('transient share lock') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
        fs.renameSync(oldP, newP)
      }
    }

    const store = createConfigStore({
      getUserDataDir: () => dir,
      fs: wrappedFs,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, '')
      },
      sleepSync: () => {}
    })

    const saved = store.set({
      ...DEFAULT_CONFIG,
      openai: { ...DEFAULT_CONFIG.openai, apiKey: 'fp-api-key-test' }
    })
    assert.equal(saved.openai.apiKey, 'fp-api-key-test')
    assert.ok(renameAttempts >= 2)

    const diskJson = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      openai: { apiKey: string; encryptedKey: string }
    }
    assert.equal(diskJson.openai.apiKey, '')
    assert.ok(diskJson.openai.encryptedKey.length > 0)

    // Reload hydrates encrypted key back into memory
    const reloaded = store.load()
    assert.equal(reloaded.openai.apiKey, 'fp-api-key-test')

    // Corrupt config triggers backup file + default fallback
    fs.writeFileSync(path.join(dir, 'config.json'), '{broken json', 'utf8')
    const recovered = store.load()
    assert.equal(recovered.primaryProvider, DEFAULT_CONFIG.primaryProvider)
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('config.json.bak-')))
  })

  it('skips addHistory when disabled and tracks clean-exit flag', () => {
    const dir = makeTempDir('alt-t-hist-')
    const store = createConfigStore({
      getUserDataDir: () => dir,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => ''
      }
    })

    store.set({ ...DEFAULT_CONFIG, historyEnabled: false })
    const item: HistoryItem = {
      id: 'h1',
      at: Date.now(),
      from: 'a',
      to: 'b',
      provider: 'edge',
      target: 'zh-Hans'
    }
    assert.equal(store.addHistory(item), null)

    store.set({ ...DEFAULT_CONFIG, historyEnabled: true, historyLimit: 10 })
    const updated = store.addHistory(item)
    assert.ok(updated)
    assert.equal(updated.history.length, 1)

    store.markCleanExit()
    assert.equal(fs.existsSync(store.getCleanExitFlagPath()), true)
    store.clearCleanExit()
    assert.equal(fs.existsSync(store.getCleanExitFlagPath()), false)
  })
})

describe('clipboardBackup', () => {
  it('checks sequence number before restoring and falls back to private clipboard write', async () => {
    let seq = 10
    let wrotePrivate = ''
    let restoredText = ''
    let clipboardText = ''

    const mgr = createClipboardManager({
      clipboard: {
        read: async () => [],
        readText: async () => clipboardText,
        write: async (items) => {
          const plain = await items[0]?.getType('text/plain')
          if (plain instanceof Blob) {
            restoredText = await plain.text()
          }
        },
        writeText: async (t) => {
          clipboardText = t
        },
        clear: () => {
          clipboardText = ''
        }
      },
      createClipboardItem: () => {
        throw new Error('ClipboardItem disabled')
      },
      writePrivateClipboardText: async (text) => {
        wrotePrivate = text
        return true
      },
      getClipboardSequenceNumber: () => seq,
      sleep: async () => {}
    })

    await mgr.writeTransientClipboardText('translated')
    assert.equal(wrotePrivate, 'translated')

    const snap: ClipboardSnapshot = {
      text: 'prior',
      html: '',
      rtf: '',
      imageBlob: null,
      imageMime: null,
      formats: ['text/plain']
    }

    // Sequence changed -> user copied elsewhere -> do NOT overwrite clipboard
    seq = 11
    await mgr.restoreClipboardIfUnchanged(snap, 'translated', 10)
    assert.equal(restoredText, '')
  })
})

describe('logger', () => {
  it('recovers if getLogDir initially returns null and later succeeds, and scrubs secrets', () => {
    const dir = makeTempDir('alt-t-log-')
    let ready = false
    const logger = createLogger({
      getLogDir: () => (ready ? dir : null),
      console: { log: () => {}, warn: () => {}, error: () => {} },
      maxLogSize: 200,
      getSecrets: () => ['fp-my-secret-value']
    })

    logger.logInfo('before ready fp-my-secret-value')
    assert.equal(logger.getLogFilePath(), null)

    ready = true
    logger.logInfo('after ready fp-my-secret-value')
    const logPath = logger.getLogFilePath()
    assert.ok(logPath && fs.existsSync(logPath))
    const content = fs.readFileSync(logPath, 'utf8')
    assert.equal(content.includes('fp-my-secret-value'), false)
    assert.ok(content.includes('[REDACTED]'))
  })
})

describe('autoLaunch helpers', () => {
  it('resolves unpackaged root directory and syncs Windows portable & Linux desktop entries', () => {
    const dir = makeTempDir('alt-t-al-')
    fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8')
    assert.equal(resolveUnpackagedRootDir(path.join(dir, 'out', 'main'), fs), dir)

    const startupDir = getWindowsStartupDir({
      app: {
        isPackaged: true,
        getPath: () => dir,
        getAppPath: () => dir,
        setLoginItemSettings: () => {}
      }
    })
    assert.ok(startupDir.endsWith(path.join('Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')))

    let writtenTarget = ''
    const okWin = syncAutoLaunch(true, {
      platform: 'win32',
      env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Apps\\Alt-T.exe' },
      execPath: 'C:\\Apps\\Alt-T.exe',
      app: {
        isPackaged: true,
        getPath: () => dir,
        getAppPath: () => dir,
        setLoginItemSettings: () => {}
      },
      shell: {
        writeShortcutLink: (_p, details) => {
          writtenTarget = details.target
          return true
        },
        readShortcutLink: () => ({ target: '' })
      },
      fs
    })
    assert.equal(okWin, true)
    assert.equal(writtenTarget, 'C:\\Apps\\Alt-T.exe')

    const okLinux = syncAutoLaunch(true, {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: dir },
      execPath: '/usr/bin/alt-t',
      homedir: () => dir,
      app: {
        isPackaged: true,
        getPath: () => dir,
        getAppPath: () => dir,
        setLoginItemSettings: () => {}
      }
    })
    assert.equal(okLinux, true)
    assert.equal(fs.existsSync(path.join(dir, 'autostart', 'alt-t.desktop')), true)
  })
})

describe('hotkeyService', () => {
  it('reports missing/duplicate keys, retries external conflicts, and detaches listeners on dispose', () => {
    const registered = new Set<string>()
    const listeners = new Map<string, () => void>()
    const timers: Array<() => void> = []
    let failFirstAltR = true

    const svc = createHotkeyService({
      globalShortcut: {
        register: (accel) => {
          if (accel === 'Alt+R' && failFirstAltR) {
            failFirstAltR = false
            return false
          }
          registered.add(accel)
          return true
        },
        unregister: (accel) => {
          registered.delete(accel)
        },
        unregisterAll: () => {
          registered.clear()
        },
        isRegistered: (accel) => registered.has(accel)
      },
      powerMonitor: {
        on: (ev, fn) => {
          listeners.set(ev, fn)
        },
        removeListener: (ev) => {
          listeners.delete(ev)
        }
      },
      injectMaskKey: () => true,
      cancelActiveReplaceFlow: () => {},
      runSelectionFlow: async () => 'done',
      setTimeout: (fn) => {
        timers.push(fn)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {}
    })

    const conflicts = svc.registerAll(DEFAULT_CONFIG.hotkeys)
    assert.deepEqual(conflicts, [{ key: 'replaceTranslate', accelerator: 'Alt+R' }])
    assert.equal(svc.verifyHotkeys().ok, false)

    // Retry succeeds cleanly
    timers.shift()?.()
    assert.equal(svc.verifyHotkeys().ok, true)

    // Simulate OS dropping Alt+T -> healMissingHotkeys restores it
    registered.delete('Alt+T')
    assert.deepEqual(svc.healMissingHotkeys(), ['directInputTranslate(Alt+T)'])
    assert.equal(svc.verifyHotkeys().ok, true)

    svc.dispose()
    assert.equal(listeners.size, 0)
    assert.equal(registered.size, 0)
  })
})

describe('selectionService hardening', () => {
  function createMockRuntime(overrides?: {
    cfg?: Partial<AppConfig>
    clipboardReadAfterCopy?: string
    throwOnCopy?: Error
    throwOnPaste?: Error
    pasteKind?: 'normal' | 'wt' | 'conhost'
  }) {
    const notifications: string[] = []
    const plainClipboardWrites: string[] = []
    const transientWrites: string[] = []
    const backspaces: number[] = []
    let restoreCalls = 0
    let clipboardValue = 'prior clipboard'
    let copiedSent = false
    const cfg: AppConfig = { ...DEFAULT_CONFIG, ...overrides?.cfg }

    setSelectionRuntimeForTest({
      configStore: {
        get: () => cfg,
        addHistory: (item) => ({ ...cfg, history: [item, ...cfg.history] })
      },
      clipboard: {
        readText: () => clipboardValue,
        writeText: (t) => {
          clipboardValue = t
          plainClipboardWrites.push(t)
        }
      },
      clipboardBackup: {
        backupClipboard: async () => ({
          text: 'prior clipboard',
          html: '',
          rtf: '',
          imageBlob: null,
          imageMime: null,
          formats: []
        }),
        restoreClipboard: async () => {
          restoreCalls++
        },
        restoreClipboardIfUnchanged: async () => {
          restoreCalls++
        },
        writeSentinel: async () => {
          clipboardValue = '__SENTINEL__'
          return '__SENTINEL__'
        },
        writeTransientClipboardText: async (text) => {
          clipboardValue = text
          transientWrites.push(text)
        }
      },
      host: {
        canInjectKeystrokes: () => true,
        dispatchBackspaces: async (count) => {
          backspaces.push(count)
        },
        dispatchCopyShortcut: () => {
          if (overrides?.throwOnCopy) throw overrides.throwOnCopy
          copiedSent = true
          if (overrides?.clipboardReadAfterCopy !== undefined) {
            clipboardValue = overrides.clipboardReadAfterCopy
          }
        },
        dispatchPasteShortcut: () => {
          if (overrides?.throwOnPaste) throw overrides.throwOnPaste
        },
        focusTarget: () => true,
        getActiveTargetHandle: () => 555,
        getClipboardSequenceNumber: () => (copiedSent ? 42 : 41),
        getTargetCopyKind: () => overrides?.pasteKind ?? 'normal',
        getTargetPasteKind: () => overrides?.pasteKind ?? 'normal',
        getWindowTitle: () => 'Terminal',
        isOwnProcessWindow: () => false,
        isTargetAlive: () => true,
        isTargetMinimized: () => false,
        isWindowElevatedOverSelf: () => false,
        releasePressedModifiers: async () => {}
      },
      notifySystem: (msg) => notifications.push(msg),
      sleep: async () => {},
      now: (() => {
        let t = 0
        return () => (t += 100)
      })(),
      watchdogTimeoutMs: 30_000
    })

    return { notifications, plainClipboardWrites, transientWrites, backspaces, getRestoreCalls: () => restoreCalls }
  }

  it('does not emit double notifications on macOS accessibility denial or whitespace selection', async () => {
    const rt1 = createMockRuntime({ throwOnCopy: new Error('MACOS_ACCESSIBILITY_DENIED') })
    const res1 = await runSelectionFlow('replace')
    assert.equal(res1, 'error')
    assert.deepEqual(rt1.notifications, [MSG.MACOS_ACCESSIBILITY_DENIED_COPY])

    let openedDirect = 0
    configureSelectionService({
      translateService: {} as TranslateService,
      showPopupAtCursor: () => {},
      openDirectInput: () => {
        openedDirect++
      },
      pushToPopup: () => {}
    })
    const rt2 = createMockRuntime({ clipboardReadAfterCopy: '   \t  ' })
    const res2 = await runSelectionFlow('replace')
    assert.equal(res2, 'no-selection')
    assert.equal(openedDirect, 0)
    assert.deepEqual(rt2.notifications, [MSG.NO_TEXT_SELECTED])
  })

  it('keeps watchdog active across show mode and emits TIMEOUT error when stream stalls', async () => {
    const pushed: Array<{ ch: string; payload: unknown }> = []
    let cancelledId = ''

    createMockRuntime({
      cfg: { openai: { ...DEFAULT_CONFIG.openai, stream: true } },
      clipboardReadAfterCopy: 'hello'
    })
    // Override watchdogTimeoutMs shorter for fast unit test
    setSelectionRuntimeForTest({
      configStore: {
        get: () => ({ ...DEFAULT_CONFIG, openai: { ...DEFAULT_CONFIG.openai, stream: true } }),
        addHistory: () => null
      },
      clipboard: {
        readText: () => 'hello',
        writeText: () => {}
      },
      clipboardBackup: {
        backupClipboard: async () => ({
          text: '',
          html: '',
          rtf: '',
          imageBlob: null,
          imageMime: null,
          formats: []
        }),
        restoreClipboard: async () => {},
        restoreClipboardIfUnchanged: async () => {},
        writeSentinel: async () => '__SENTINEL__',
        writeTransientClipboardText: async () => {}
      },
      host: {
        canInjectKeystrokes: () => true,
        dispatchBackspaces: async () => {},
        dispatchCopyShortcut: () => {},
        dispatchPasteShortcut: () => {},
        focusTarget: () => true,
        getActiveTargetHandle: () => 555,
        getClipboardSequenceNumber: () => 1,
        getTargetCopyKind: () => 'normal',
        getTargetPasteKind: () => 'normal',
        getWindowTitle: () => '',
        isOwnProcessWindow: () => false,
        isTargetAlive: () => true,
        isTargetMinimized: () => false,
        isWindowElevatedOverSelf: () => false,
        releasePressedModifiers: async () => {}
      },
      notifySystem: () => {},
      sleep: async () => {},
      now: () => Date.now(),
      watchdogTimeoutMs: 40
    })

    configureSelectionService({
      translateService: {
        translateOnce: async () => ({ text: 'x', provider: 'edge', usedFallback: false }),
        translateStream: () => {
          // Simulate hung stream (never emits done/error)
        },
        cancel: (id) => {
          cancelledId = id
        },
        disposeAll: () => {}
      },
      showPopupAtCursor: () => {},
      pushToPopup: (ch, payload) => pushed.push({ ch, payload })
    })

    const res = await runSelectionFlow('show')
    assert.equal(res, 'done')

    // Wait past watchdogTimeoutMs (40ms) AFTER runSelectionFlow returned
    await new Promise((r) => setTimeout(r, 90))
    assert.notEqual(cancelledId, '')
    assert.ok(
      pushed.some(
        (m) =>
          m.ch === 'translate:error' &&
          (m.payload as { error: { code: string } }).error.code === 'TIMEOUT'
      )
    )
  })

  it('preserves translated text on plain clipboard if replace paste fails', async () => {
    const rt = createMockRuntime({
      clipboardReadAfterCopy: '你好',
      throwOnPaste: new Error('SendInput injected 0 of 4')
    })

    configureSelectionService({
      translateService: {
        translateOnce: async () => ({ text: 'Hello', provider: 'edge', usedFallback: false }),
        translateStream: () => '',
        cancel: () => {},
        disposeAll: () => {}
      },
      showPopupAtCursor: () => {},
      pushToPopup: () => {}
    })

    const res = await runSelectionFlow('replace')
    assert.equal(res, 'error')
    assert.deepEqual(rt.plainClipboardWrites, ['Hello'])
    assert.deepEqual(rt.notifications, [MSG.PASTE_BLOCKED])
    // Only capture's initial restore happened (1); replace paste failure must NOT restore prior clipboard
    assert.equal(rt.getRestoreCalls(), 1)
  })

  it('dispatches grapheme backspaces in Option B terminal replace mode and notifies onHistoryChanged', async () => {
    let historyNotified = 0
    const rt = createMockRuntime({
      cfg: { terminalAutoBackspace: true },
      clipboardReadAfterCopy: '你好世界',
      pasteKind: 'wt'
    })

    configureSelectionService({
      translateService: {
        translateOnce: async () => ({ text: 'Hello world', provider: 'edge', usedFallback: false }),
        translateStream: () => '',
        cancel: () => {},
        disposeAll: () => {}
      },
      showPopupAtCursor: () => {},
      pushToPopup: () => {},
      onHistoryChanged: () => {
        historyNotified++
      }
    })

    const res = await runSelectionFlow('replace')
    assert.equal(res, 'done')
    assert.deepEqual(rt.backspaces, [4])
    assert.deepEqual(rt.transientWrites, ['Hello world'])
    assert.equal(historyNotified, 1)
  })

  it('rejects aborted translateOnce in non-stream replace mode cleanly without UI error', async () => {
    const rt = createMockRuntime({ clipboardReadAfterCopy: 'hello' })
    configureSelectionService({
      translateService: {
        translateOnce: async () => {
          throw new ProviderError({ code: 'ABORTED', provider: 'edge', message: 'aborted', retryable: false })
        },
        translateStream: () => '',
        cancel: () => {},
        disposeAll: () => {}
      },
      showPopupAtCursor: () => {},
      pushToPopup: () => {}
    })

    const res = await runSelectionFlow('replace')
    assert.equal(res, 'done')
    assert.equal(rt.notifications.length, 0)
  })

  it('writes translation directly to clipboard on pasteTextToWindow when UIPI elevated', async () => {
    setSelectionRuntimeForTest({
      clipboard: {
        readText: () => '',
        writeText: (t) => {
          assert.equal(t, 'Translated prompt')
        }
      },
      host: {
        canInjectKeystrokes: () => true,
        dispatchBackspaces: async () => {},
        dispatchCopyShortcut: () => {},
        dispatchPasteShortcut: () => {
          throw new Error('should not call sendInput under UIPI')
        },
        focusTarget: () => true,
        getActiveTargetHandle: () => 888,
        getClipboardSequenceNumber: () => 1,
        getTargetCopyKind: () => 'normal',
        getTargetPasteKind: () => 'normal',
        getWindowTitle: () => '',
        isOwnProcessWindow: () => false,
        isTargetAlive: () => true,
        isTargetMinimized: () => false,
        isWindowElevatedOverSelf: () => true,
        releasePressedModifiers: async () => {}
      },
      configStore: { get: () => DEFAULT_CONFIG, addHistory: () => null },
      notifySystem: (msg) => assert.equal(msg, MSG.UIPI_PASTE_FALLBACK)
    })

    const reply = await pasteTextToWindow(888, 'Translated prompt')
    assert.deepEqual(reply, {
      ok: false,
      status: 'clipboard-only',
      reason: 'uipi-elevated',
      message: MSG.UIPI_PASTE_FALLBACK
    })
  })
})
