import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { mergeConfig, OPENAI_PROVIDER_PRESETS } from '../src/shared/config'
import { MSG } from '../src/shared/messages'
import { DEFAULT_CONFIG } from '../src/shared/types'
import {
  buildLinuxBackspaceCommand,
  buildLinuxCopyCommand,
  buildLinuxPasteCommand,
  detectLinuxInputBackend
} from '../src/main/platform/linuxInput'
import {
  CG_EVENT_FLAG_MASK_COMMAND,
  MAC_VK_C,
  MAC_VK_DELETE,
  MAC_VK_V,
  sendMacBackspaces,
  sendMacCopyShortcut,
  sendMacPasteShortcut,
  setMacApiForTest
} from '../src/main/platform/macInput'
import { classifyWindowKind, setWin32ApiForTest } from '../src/main/platform/win32Input'
import {
  isIdeHostExeName,
  isIdeTerminalUiaNode,
  setWin32UiaForTest
} from '../src/main/platform/win32Uia'
import {
  configureSelectionService,
  runSelectionFlow,
  setSelectionRuntimeForTest
} from '../src/main/services/selectionService'
import type { TranslateService } from '../src/main/services/translateService'

interface AfterPackHelpers {
  resolveKeepKoffiTriplets: (platform: string, arch: number | string) => Set<string> | null
  pruneElectronLocales: (
    appOutDir: string,
    platform: string,
    productFilename?: string
  ) => { removedCount: number; reclaimedBytes: number }
  pruneForeignKoffiBinaries: (
    appOutDir: string,
    platform: string,
    arch: number | string,
    productFilename?: string
  ) => { removedCount: number; reclaimedBytes: number }
}

async function loadAfterPackHelpers(): Promise<AfterPackHelpers> {
  const url = pathToFileURL(path.resolve(process.cwd(), 'scripts', 'after-pack.mjs')).href
  return (await import(url)) as AfterPackHelpers
}

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  setMacApiForTest(null)
  setWin32ApiForTest(null)
  setWin32UiaForTest(null)
  setSelectionRuntimeForTest(null)
  configureSelectionService(null)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('Electron slimming helpers (scripts/after-pack.mjs)', () => {
  it('resolves exact koffi binary triplets for Windows, macOS, and Linux targets', async () => {
    const { resolveKeepKoffiTriplets } = await loadAfterPackHelpers()
    assert.deepEqual([...(resolveKeepKoffiTriplets('win32', 1) ?? [])], ['win32_x64'])
    assert.deepEqual([...(resolveKeepKoffiTriplets('win32', 'arm64') ?? [])], ['win32_arm64'])
    assert.deepEqual([...(resolveKeepKoffiTriplets('darwin', 3) ?? [])], ['darwin_arm64'])
    assert.deepEqual(
      [...(resolveKeepKoffiTriplets('darwin', 4) ?? [])].sort(),
      ['darwin_arm64', 'darwin_x64']
    )
    assert.deepEqual(
      [...(resolveKeepKoffiTriplets('linux', 'x64') ?? [])].sort(),
      ['linux_x64', 'musl_x64']
    )
  })

  it('prunes unused Chromium locale .pak files while retaining en-US and zh-CN', async () => {
    const { pruneElectronLocales } = await loadAfterPackHelpers()
    const outDir = makeTempDir('alt-t-locales-')
    const localesDir = path.join(outDir, 'locales')
    fs.mkdirSync(localesDir, { recursive: true })
    for (const name of ['en-US.pak', 'zh-CN.pak', 'fr.pak', 'de.pak', 'ja.pak']) {
      fs.writeFileSync(path.join(localesDir, name), Buffer.alloc(1024))
    }

    const res = pruneElectronLocales(outDir, 'win32', 'Alt-T')
    assert.equal(res.removedCount, 3)
    assert.equal(res.reclaimedBytes, 3072)
    assert.deepEqual(fs.readdirSync(localesDir).sort(), ['en-US.pak', 'zh-CN.pak'])
  })

  it('prunes foreign koffi binaries only when the target binary exists', async () => {
    const { pruneForeignKoffiBinaries } = await loadAfterPackHelpers()
    const outDir = makeTempDir('alt-t-koffi-')
    const koffiDir = path.join(
      outDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'koffi',
      'build',
      'koffi'
    )
    for (const triplet of ['win32_x64', 'linux_x64', 'darwin_arm64', 'freebsd_x64']) {
      const d = path.join(koffiDir, triplet)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'koffi.node'), Buffer.alloc(2048))
    }

    const res = pruneForeignKoffiBinaries(outDir, 'win32', 1, 'Alt-T')
    assert.equal(res.removedCount, 3)
    assert.equal(res.reclaimedBytes, 6144)
    assert.deepEqual(fs.readdirSync(koffiDir), ['win32_x64'])

    // Safety invariant: if required target is missing, do not delete remaining binaries
    const resMissing = pruneForeignKoffiBinaries(outDir, 'win32', 'arm64', 'Alt-T')
    assert.equal(resMissing.removedCount, 0)
    assert.deepEqual(fs.readdirSync(koffiDir), ['win32_x64'])
  })
})

describe('macOS native koffi CGEvent input backend', () => {
  it('posts native Cmd+C / Cmd+V and releases every CGEvent handle', () => {
    const events: Array<{ vk: number; down: boolean; flags: number }> = []
    let releases = 0
    let seq = 0

    setMacApiForTest({
      api: {
        axIsProcessTrusted: () => true,
        cgEventCreateKeyboardEvent: (_src, vk, down) => ({ id: ++seq, vk, down, flags: 0 }),
        cgEventSetFlags: (ev, flags) => {
          ;(ev as { flags: number }).flags = flags
        },
        cgEventPost: (_tap, ev) => {
          const item = ev as { vk: number; down: boolean; flags: number }
          events.push({ vk: item.vk, down: item.down, flags: item.flags })
        },
        cfRelease: () => {
          releases++
        }
      }
    })

    sendMacCopyShortcut()
    sendMacPasteShortcut()

    assert.deepEqual(events, [
      { vk: MAC_VK_C, down: true, flags: CG_EVENT_FLAG_MASK_COMMAND },
      { vk: MAC_VK_C, down: false, flags: CG_EVENT_FLAG_MASK_COMMAND },
      { vk: MAC_VK_V, down: true, flags: CG_EVENT_FLAG_MASK_COMMAND },
      { vk: MAC_VK_V, down: false, flags: CG_EVENT_FLAG_MASK_COMMAND }
    ])
    assert.equal(releases, 4)
  })

  it('throws MACOS_ACCESSIBILITY_DENIED and opens settings when untrusted', () => {
    let settingsOpened = 0
    setMacApiForTest({
      api: { axIsProcessTrusted: () => false },
      openAccessibilitySettings: () => {
        settingsOpened++
      }
    })

    assert.throws(() => sendMacCopyShortcut(), /MACOS_ACCESSIBILITY_DENIED/)
    assert.equal(settingsOpened, 1)
  })

  it('dispatches batched macOS Delete key events and supports osascript fallback when native unavailable', async () => {
    const deleteEvents: number[] = []
    setMacApiForTest({
      api: {
        axIsProcessTrusted: () => true,
        cgEventCreateKeyboardEvent: (_src, vk, down) => ({ vk, down }),
        cgEventPost: (_tap, ev) => {
          const item = ev as { vk: number; down: boolean }
          if (item.down) deleteEvents.push(item.vk)
        },
        cfRelease: () => {}
      }
    })

    await sendMacBackspaces(23)
    assert.equal(deleteEvents.length, 23)
    assert.ok(deleteEvents.every((vk) => vk === MAC_VK_DELETE))

    // Fallback path when koffi frameworks are unavailable
    const osaCalls: string[][] = []
    setMacApiForTest({
      api: null,
      runOsascriptSync: (args) => {
        osaCalls.push(args)
        return ''
      }
    })
    sendMacPasteShortcut()
    assert.equal(osaCalls.length, 1)
    assert.ok(osaCalls[0][1].includes('keystroke "v"'))
  })
})

describe('Linux X11 / Wayland multi-backend input selection & commands', () => {
  it('selects xdotool on X11 and prioritizes ydotool over wtype on Wayland', () => {
    assert.equal(
      detectLinuxInputBackend(false, (cmd) => cmd === 'xdotool'),
      'xdotool'
    )
    assert.equal(
      detectLinuxInputBackend(false, (cmd) => cmd === 'ydotool'),
      'none'
    )
    assert.equal(
      detectLinuxInputBackend(true, (cmd) => cmd === 'ydotool' || cmd === 'wtype'),
      'ydotool'
    )
    assert.equal(
      detectLinuxInputBackend(true, (cmd) => cmd === 'wtype'),
      'wtype'
    )
    assert.equal(
      detectLinuxInputBackend(true, () => false),
      'none'
    )
  })

  it('builds exact copy, paste, and backspace commands across xdotool, ydotool, and wtype', () => {
    assert.deepEqual(buildLinuxCopyCommand('xdotool', 'wt'), {
      cmd: 'xdotool',
      args: ['key', '--clearmodifiers', 'ctrl+shift+c']
    })
    assert.deepEqual(buildLinuxPasteCommand('ydotool', 'wt'), {
      cmd: 'ydotool',
      args: ['key', '29:1', '42:1', '47:1', '47:0', '42:0', '29:0']
    })
    assert.deepEqual(buildLinuxPasteCommand('wtype', 'conhost'), {
      cmd: 'wtype',
      args: ['-M', 'shift', '-k', 'Insert', '-m', 'shift']
    })
    assert.deepEqual(buildLinuxBackspaceCommand('xdotool', 5), {
      cmd: 'xdotool',
      args: ['key', '--clearmodifiers', '--repeat', '5', '--delay', '2', 'BackSpace']
    })
    assert.deepEqual(buildLinuxBackspaceCommand('ydotool', 2), {
      cmd: 'ydotool',
      args: ['key', '14:1', '14:0', '14:1', '14:0']
    })
    assert.deepEqual(buildLinuxBackspaceCommand('wtype', 2), {
      cmd: 'wtype',
      args: ['-k', 'BackSpace', '-k', 'BackSpace']
    })
  })
})

describe('IDE integrated terminal safety (Windows UIA probe + forcePopupOnReplaceExes)', () => {
  it('detects xterm / integrated terminal UIA nodes without false-positiving on code file tabs', () => {
    assert.equal(isIdeHostExeName('Code.exe'), true)
    assert.equal(isIdeHostExeName('Antigravity.exe'), true)
    assert.equal(isIdeHostExeName('notepad.exe'), false)

    assert.equal(
      isIdeTerminalUiaNode({
        pid: 100,
        controlType: 50004,
        name: 'Terminal 1, pwsh',
        automationId: '',
        className: 'xterm-helper-textarea'
      }),
      true
    )
    assert.equal(
      isIdeTerminalUiaNode({
        pid: 100,
        controlType: 50033,
        name: '',
        automationId: 'workbench.panel.terminal',
        className: ''
      }),
      true
    )
    assert.equal(
      isIdeTerminalUiaNode({
        pid: 100,
        controlType: 50004,
        name: 'terminal.ts - Alt-T - Visual Studio Code',
        automationId: 'workbench.parts.editor',
        className: 'inputarea'
      }),
      false
    )
  })

  it('dynamically upgrades Code.exe to wt only when focused UIA element belongs to its terminal', () => {
    const cls = Buffer.from('Chrome_WidgetWin_1', 'utf16le')
    const exe = Buffer.from('C:\\Program Files\\Microsoft VS Code\\Code.exe', 'utf16le')
    setWin32ApiForTest({
      getWindowThreadProcessId: (_hwnd, pidOut) => {
        pidOut[0] = 7777
        return 1
      },
      getClassNameW: (_hwnd, buf) => {
        new Uint8Array(buf.buffer).set(cls)
        return cls.length / 2
      },
      openProcess: () => 50,
      queryFullProcessImageNameW: (_hProc, _flags, buf, sizeOut) => {
        new Uint8Array(buf.buffer).set(exe)
        sizeOut[0] = exe.length / 2
        return 1
      }
    })

    // Regular editor pane -> remains normal
    setWin32UiaForTest(() => [
      { pid: 7777, controlType: 50004, name: 'app.ts', automationId: 'editor', className: 'inputarea' }
    ])
    assert.equal(classifyWindowKind(200), 'normal')

    // Integrated terminal pane (same PID) -> dynamically upgraded to wt
    setWin32UiaForTest(() => [
      {
        pid: 7777,
        controlType: 50004,
        name: 'Terminal 1, bash',
        automationId: '',
        className: 'xterm-helper-textarea'
      }
    ])
    assert.equal(classifyWindowKind(200), 'wt')

    // Mismatched PID -> ignored, stays normal
    setWin32UiaForTest(() => [
      {
        pid: 9999,
        controlType: 50004,
        name: 'Terminal 1, bash',
        automationId: '',
        className: 'xterm-helper-textarea'
      }
    ])
    assert.equal(classifyWindowKind(200), 'normal')
  })

  it('skips Ctrl+C and opens direct-input bar on Alt+R for processes in forcePopupOnReplaceExes', async () => {
    const merged = mergeConfig({ forcePopupOnReplaceExes: ['Code.exe', 'code.exe', ' Cursor.exe '] })
    assert.deepEqual(merged.forcePopupOnReplaceExes, ['code.exe', 'cursor.exe'])
    assert.ok(OPENAI_PROVIDER_PRESETS.some((p) => p.id === 'ollama' && p.keylessLoopback === true))

    let copyCalls = 0
    let openedHandle = 0
    const popupNotifies: string[] = []

    setSelectionRuntimeForTest({
      configStore: {
        get: () => ({ ...DEFAULT_CONFIG, forcePopupOnReplaceExes: ['code.exe'] }),
        addHistory: () => null
      },
      host: {
        canInjectKeystrokes: () => true,
        dispatchBackspaces: async () => {},
        dispatchCopyShortcut: () => {
          copyCalls++
        },
        dispatchPasteShortcut: () => {},
        focusTarget: () => true,
        getActiveTargetHandle: () => 888,
        getClipboardSequenceNumber: () => 1,
        getTargetCopyKind: () => 'normal',
        getTargetExeName: () => 'code.exe',
        getTargetPasteKind: () => 'normal',
        getWindowTitle: () => 'VS Code',
        isOwnProcessWindow: () => false,
        isTargetAlive: () => true,
        isTargetMinimized: () => false,
        isWindowElevatedOverSelf: () => false,
        releasePressedModifiers: async () => {}
      },
      notifySystem: () => {}
    })

    configureSelectionService({
      translateService: {} as TranslateService,
      showPopupAtCursor: () => {},
      openDirectInput: (h) => {
        openedHandle = h
      },
      pushToPopup: () => {},
      notifyPopup: (n) => popupNotifies.push(n.message)
    })

    const res = await runSelectionFlow('replace')
    assert.equal(res, 'done')
    assert.equal(copyCalls, 0)
    assert.equal(openedHandle, 888)
    assert.deepEqual(popupNotifies, [MSG.FORCE_POPUP_REPLACE_REDIRECT])
  })
})
