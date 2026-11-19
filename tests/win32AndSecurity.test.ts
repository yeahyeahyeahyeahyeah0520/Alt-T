import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  classifyExeName,
  classifyTerminalWindow,
  isNonTargetWindowClass,
  isWindowElevatedOverSelf,
  setWin32ApiForTest
} from '../src/main/platform/win32Input'
import {
  classifyLinuxWmClass,
  classifyMacAppName,
  isLinuxWayland
} from '../src/main/platform/hostPlatform'
import { shouldRestoreClipboard } from '../src/main/core/clipboardPolicy'
import { redactSecret, redactUrlCredentials } from '../src/main/providers/httpClient'
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

  it('classifies standalone GPU terminals by executable basename when class is generic', () => {
    assert.equal(classifyExeName('Ghostty.exe'), 'wt')
    assert.equal(classifyExeName('alacritty.exe'), 'wt')
    assert.equal(classifyExeName('kitty.exe'), 'wt')
    assert.equal(classifyExeName('warp.exe'), 'wt')
    assert.equal(classifyExeName('pwsh.exe'), 'conhost')
    assert.equal(classifyExeName('wsl.exe'), 'conhost')
    assert.equal(classifyExeName('Code.exe'), 'normal')
    assert.equal(classifyExeName('notepad.exe'), 'normal')
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

  it('supports custom extra terminal exe sets in classifyExeName and classifyTerminalWindow', () => {
    assert.equal(classifyExeName('mycustom.exe'), 'normal')
    assert.equal(classifyExeName('mycustom.exe', new Set(['mycustom.exe'])), 'wt')
    assert.equal(classifyExeName('mycustom.exe', new Set(), new Set(['mycustom.exe'])), 'conhost')

    assert.equal(classifyTerminalWindow('CustomClass', 'mycustom.exe', new Set(['mycustom.exe'])), 'wt')
  })

  it('returns false when self integrity rid is null (conservative fallback)', () => {
    setWin32ApiForTest({
      getTokenIntegrityRid: () => null,
      openProcess: () => 1,
      openProcessToken: () => 1
    })
    try {
      assert.equal(isWindowElevatedOverSelf(123), false)
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

  it('redacts embedded HTTP/HTTPS proxy credentials and bearer secrets from error messages', () => {
    const raw =
      'Proxy connection failed to http://alice:s3cr3tP@ss@127.0.0.1:7890 while using token fp-token-999'
    const cleaned = redactSecret(raw, 'fp-token-999')
    assert.equal(cleaned.includes('s3cr3tP@ss'), false)
    assert.equal(cleaned.includes('alice:'), false)
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
    assert.ok(path.isAbsolute(process.cwd()))
  })
})
