import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyExeName,
  classifyTerminalWindow,
  classifyWindowKind,
  isNonTargetWindowClass,
  isWindowElevatedOverSelf,
  releaseModifiers,
  setWin32ApiForTest
} from '../src/main/platform/win32Input'
import type { InputEvent } from '../src/main/platform/win32Ffi'
import {
  classifyLinuxWmClass,
  classifyMacAppName,
  isLinuxWayland
} from '../src/main/platform/hostPlatform'
import { shouldRestoreClipboard } from '../src/main/core/clipboardPolicy'
import { redactSecretsInText, redactUrlCredentials } from '../src/main/core/redact'
import { DEFAULT_PROMPTS } from '../src/shared/types'

describe('Cross-OS terminal & shell window classification', () => {
  it('classifies Windows Terminal and WezTerm window classes as wt regardless of child process', () => {
    assert.equal(classifyTerminalWindow('CASCADIA_HOSTING_WINDOW_CLASS', 'pwsh.exe'), 'wt')
    assert.equal(classifyTerminalWindow('CASCADIA_HOSTING_WINDOW_CLASS', 'claude.exe'), 'wt')
    assert.equal(classifyTerminalWindow('org.wezfurlong.wezterm', 'wezterm-gui.exe'), 'wt')
  })

  it('classifies ConsoleWindowClass as conhost even when owned by claude.exe / agy.exe / python.exe', () => {
    assert.equal(classifyTerminalWindow('ConsoleWindowClass', 'claude.exe'), 'conhost')
    assert.equal(classifyTerminalWindow('ConsoleWindowClass', 'agy.exe'), 'conhost')
    assert.equal(classifyTerminalWindow('ConsoleWindowClass', 'python.exe'), 'conhost')
    assert.equal(classifyTerminalWindow('ConsoleWindowClass', 'ssh.exe'), 'conhost')
    assert.equal(classifyTerminalWindow('VirtualConsoleClass', 'ConEmu64.exe'), 'conhost')
    assert.equal(classifyTerminalWindow('mintty', 'usr\\bin\\mintty.exe'), 'conhost')
  })

  it('classifies GPU terminals and PuTTY-family terminals consistently without contradictions', () => {
    assert.equal(classifyExeName('Ghostty.exe'), 'wt')
    assert.equal(classifyExeName('alacritty.exe'), 'wt')
    assert.equal(classifyExeName('wezterm-gui.exe'), 'wt')
    assert.equal(classifyExeName('warp.exe'), 'wt')
    assert.equal(classifyExeName('kitty.exe'), 'conhost')
    assert.equal(classifyTerminalWindow('GenericClass', 'kitty.exe'), 'conhost')
    assert.equal(classifyExeName('pwsh.exe'), 'conhost')
    assert.equal(classifyExeName('wsl.exe'), 'conhost')
    assert.equal(classifyExeName('Code.exe'), 'normal')
    assert.equal(classifyExeName('notepad.exe'), 'normal')
  })

  it('allows custom extra terminal exe sets to extend and override defaults', () => {
    assert.equal(classifyExeName('mycustom.exe'), 'normal')
    assert.equal(classifyExeName('mycustom.exe', new Set(['mycustom.exe'])), 'wt')
    assert.equal(classifyExeName('mycustom.exe', new Set(), new Set(['mycustom.exe'])), 'conhost')
    // User override takes precedence over built-in defaults (e.g. modern kitty routed to wt)
    assert.equal(classifyExeName('kitty.exe', new Set(['kitty.exe'])), 'wt')
    assert.equal(classifyTerminalWindow('CustomClass', 'mycustom.exe', new Set(['mycustom.exe'])), 'wt')
  })

  it('classifies macOS and Linux X11/Wayland environments accurately', () => {
    assert.equal(classifyMacAppName('iTerm2'), 'wt')
    assert.equal(classifyMacAppName('Ghostty'), 'wt')
    assert.equal(classifyMacAppName('Safari'), 'normal')

    assert.equal(classifyLinuxWmClass('WM_CLASS(STRING) = "gnome-terminal-server", "Gnome-terminal"'), 'wt')
    assert.equal(classifyLinuxWmClass('WM_CLASS(STRING) = "xterm", "XTerm"'), 'conhost')
    assert.equal(classifyLinuxWmClass('WM_CLASS(STRING) = "code", "Code"'), 'normal')

    assert.equal(isLinuxWayland({ WAYLAND_DISPLAY: 'wayland-0' }), true)
    assert.equal(isLinuxWayland({ XDG_SESSION_TYPE: 'wayland' }), true)
    assert.equal(isLinuxWayland({ XDG_SESSION_TYPE: 'x11' }), false)
  })

  it('filters out taskbar, desktop wallpaper, and shell overlay classes from paste targets', () => {
    assert.equal(isNonTargetWindowClass('Shell_TrayWnd'), true)
    assert.equal(isNonTargetWindowClass('Shell_SecondaryTrayWnd'), true)
    assert.equal(isNonTargetWindowClass('NotifyIconOverflowWindow'), true)
    assert.equal(isNonTargetWindowClass('TopLevelWindowForOverflowXamlIsland'), true)
    assert.equal(isNonTargetWindowClass('Progman'), true)
    assert.equal(isNonTargetWindowClass('WorkerW'), true)
    assert.equal(isNonTargetWindowClass(''), true)

    assert.equal(isNonTargetWindowClass('CASCADIA_HOSTING_WINDOW_CLASS'), false)
    assert.equal(isNonTargetWindowClass('Chrome_WidgetWin_1'), false)
    assert.equal(isNonTargetWindowClass('Notepad'), false)
  })

  it('reads HWND class and exe name via Win32 mock in classifyWindowKind', () => {
    const cls = Buffer.from('CustomClass', 'utf16le')
    const exe = Buffer.from('C:\\Program Files\\Custom\\myterm.exe', 'utf16le')
    setWin32ApiForTest({
      getWindowThreadProcessId: (_hwnd, pidOut) => {
        pidOut[0] = 4321
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
    try {
      assert.equal(classifyWindowKind(100), 'normal')
      assert.equal(classifyWindowKind(100, new Set(['myterm.exe'])), 'wt')
    } finally {
      setWin32ApiForTest(null)
    }
  })
})

describe('Win32 UIPI integrity & extended-key modifier release', () => {
  it('checks integrity levels accurately without false-positive bypasses', () => {
    let selfRid: number | null = null
    let targetRid: number | null = 0x3000
    let targetOpenOk = 1

    setWin32ApiForTest({
      getCurrentProcess: () => 10,
      getWindowThreadProcessId: (_hwnd, pidOut) => {
        pidOut[0] = 9999
        return 1
      },
      openProcess: () => (targetOpenOk ? 200 : 0),
      openProcessToken: (hProc, _access, out) => {
        out[0] = hProc === 10 ? 101 : 201
        return 1
      },
      getTokenIntegrityRid: (hTok) => (hTok === 101 ? selfRid : targetRid)
    })

    try {
      // Conservative fallback when selfRid is null even if target is High (0x3000) or inaccessible
      selfRid = null
      targetRid = 0x3000
      assert.equal(isWindowElevatedOverSelf(123), false)

      targetOpenOk = 0
      assert.equal(isWindowElevatedOverSelf(123), false)

      // Medium (0x2000) -> High (0x3000) must report UIPI blocked
      targetOpenOk = 1
      selfRid = 0x2000
      targetRid = 0x3000
      assert.equal(isWindowElevatedOverSelf(123), true)

      // High (0x3000) -> High (0x3000) is equal privilege -> allowed
      selfRid = 0x3000
      targetRid = 0x3000
      assert.equal(isWindowElevatedOverSelf(123), false)

      // High (0x3000) -> System (0x4000) must still report UIPI blocked
      selfRid = 0x3000
      targetRid = 0x4000
      assert.equal(isWindowElevatedOverSelf(123), true)

      // Medium (0x2000) when OpenProcess is denied on protected target -> blocked
      selfRid = 0x2000
      targetOpenOk = 0
      assert.equal(isWindowElevatedOverSelf(123), true)
    } finally {
      setWin32ApiForTest(null)
    }
  })

  it('applies KEYEVENTF_EXTENDEDKEY when releasing extended modifiers via releaseModifiers', async () => {
    const sent: InputEvent[] = []
    let checks = 0
    setWin32ApiForTest({
      // Only RCONTROL (0xa3) held initially, released on second poll
      getAsyncKeyState: (vk) => {
        if (vk !== 0xa3) return 0
        return checks++ < 15 ? 0x8000 : 0
      },
      sendInput: (_count, events) => {
        sent.push(...events)
        return events.length
      }
    })
    try {
      await releaseModifiers()
      const rctrlRelease = sent.find((ev) => ev.u.ki.wVk === 0xa3)
      assert.ok(rctrlRelease)
      // KEYEVENTF_EXTENDEDKEY (0x0001) | KEYEVENTF_KEYUP (0x0002) = 0x0003
      assert.equal(rctrlRelease.u.ki.dwFlags, 0x0003)
    } finally {
      setWin32ApiForTest(null)
    }
  })
})

describe('Clipboard & credential safety policies', () => {
  it('only restores clipboard snapshot when clipboard still holds our injected translation', () => {
    assert.equal(shouldRestoreClipboard('Hello world', 'Hello world'), true)
    assert.equal(shouldRestoreClipboard('User copied new text meanwhile', 'Hello world'), false)
  })

  it('redacts embedded HTTP/HTTPS proxy credentials, sk-proj keys, and bearer secrets', () => {
    const projKey = 'sk-proj-' + 'ABCDEFGHIJKL123456'
    const raw =
      `Proxy connection failed to http://alice:s3cr3tP@ss@127.0.0.1:7890 with ${projKey} and fp-token-999`
    const cleaned = redactSecretsInText(raw, 'fp-token-999')
    assert.equal(cleaned.includes('s3cr3tP@ss'), false)
    assert.equal(cleaned.includes('alice:'), false)
    assert.equal(cleaned.includes(projKey), false)
    assert.equal(cleaned.includes('fp-token-999'), false)
    assert.match(cleaned, /http:\/\/\[REDACTED\]@127\.0\.0\.1:7890/)

    assert.equal(
      redactUrlCredentials('https://bob:hunter2@proxy.example.com:8443/path'),
      'https://[REDACTED]@proxy.example.com:8443/path'
    )
  })

  it('includes pure developer-aware translation and CLI prompt templates in DEFAULT_PROMPTS', () => {
    const ids = DEFAULT_PROMPTS.map((p) => p.id)
    assert.deepEqual(ids, ['translate', 'cli-prompt'])
    assert.ok(DEFAULT_PROMPTS[0].systemPrompt.includes('CLI flags'))
    assert.ok(DEFAULT_PROMPTS[1].systemPrompt.includes('slash commands'))
  })
})
