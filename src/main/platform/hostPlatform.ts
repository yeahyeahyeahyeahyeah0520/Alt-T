import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import {
  classifyWindowKind as win32ClassifyWindowKind,
  focusWindow as win32FocusWindow,
  getClipboardSequenceNumber as win32GetClipboardSequenceNumber,
  getCurrentDesktopName as win32GetCurrentDesktopName,
  getForegroundWindow as win32GetForegroundWindow,
  getWindowTitle as win32GetWindowTitle,
  injectMaskKey as win32InjectMaskKey,
  isOwnProcessWindow as win32IsOwnProcessWindow,
  isValidExternalTargetWindow as win32IsValidExternalTargetWindow,
  isWindow as win32IsWindow,
  isWindowElevatedOverSelf as win32IsWindowElevatedOverSelf,
  isWindowMinimized as win32IsWindowMinimized,
  releaseModifiers as win32ReleaseModifiers,
  sendBackspaces as win32SendBackspaces,
  sendCopyForWindow as win32SendCopyForWindow,
  sendPasteForWindow as win32SendPasteForWindow,
  writePrivateClipboardText as win32WritePrivateClipboardText,
  type WindowInputKind
} from './win32Input'

export type { WindowInputKind }

export interface CustomTerminalExeSets {
  extraWt?: ReadonlySet<string>
  extraConhost?: ReadonlySet<string>
}

const MAC_TERMINAL_NAMES = new Set<string>([
  'terminal',
  'iterm2',
  'iterm',
  'wezterm',
  'wezterm-gui',
  'alacritty',
  'ghostty',
  'kitty',
  'warp',
  'hyper',
  'tabby',
  'rio'
])

const LINUX_WT_CLASSES = [
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'mate-terminal',
  'lxterminal',
  'tilix',
  'terminator',
  'alacritty',
  'kitty',
  'wezterm',
  'ghostty',
  'warp',
  'tabby',
  'hyper'
]

export function isLinuxWayland(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    Boolean(env['WAYLAND_DISPLAY']) ||
    (env['XDG_SESSION_TYPE'] ?? '').trim().toLowerCase() === 'wayland'
  )
}

export function classifyMacAppName(appName: string): WindowInputKind {
  const lower = appName.trim().toLowerCase()
  return MAC_TERMINAL_NAMES.has(lower) ? 'wt' : 'normal'
}

export function classifyLinuxWmClass(wmClassOutput: string): WindowInputKind {
  const lower = wmClassOutput.toLowerCase()
  if (LINUX_WT_CLASSES.some((cls) => lower.includes(cls))) {
    return 'wt'
  }
  if (lower.includes('xterm') || lower.includes('urxvt')) {
    return 'conhost'
  }
  return 'normal'
}

const macKindCache = new Map<number, WindowInputKind>()

function runExecSync(cmd: string, args: string[], timeout = 400): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

export function hideDockOnMacOS(): void {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide()
  }
}

export function canInjectKeystrokes(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return true
  }
  if (process.platform === 'linux') {
    if (isLinuxWayland()) return false
    return runExecSync('which', ['xdotool'], 250) !== null
  }
  return false
}

export function getActiveTargetHandle(): number {
  if (process.platform === 'win32') {
    return win32GetForegroundWindow()
  }
  if (process.platform === 'darwin') {
    const out = runExecSync('osascript', [
      '-e',
      'tell application "System Events" to set fpProc to first process whose frontmost is true',
      '-e',
      'tell application "System Events" to return (unix id of fpProc as text) & "|" & (name of fpProc)'
    ])
    if (!out) return 0
    const sep = out.indexOf('|')
    const pid = Number(sep >= 0 ? out.slice(0, sep) : out)
    const name = sep >= 0 ? out.slice(sep + 1) : ''
    if (!Number.isFinite(pid) || pid <= 0) return 0
    macKindCache.set(pid, classifyMacAppName(name))
    if (macKindCache.size > 64) {
      const oldest = macKindCache.keys().next().value
      if (oldest !== undefined) macKindCache.delete(oldest)
    }
    return pid
  }
  if (process.platform === 'linux' && !isLinuxWayland()) {
    const out = runExecSync('xdotool', ['getactivewindow'])
    const wid = out ? Number(out) : 0
    return Number.isFinite(wid) && wid > 0 ? wid : 0
  }
  return 0
}

export function isValidExternalTarget(handle: number): boolean {
  if (!handle) return false
  if (process.platform === 'win32') {
    return win32IsValidExternalTargetWindow(handle)
  }
  if (process.platform === 'darwin') {
    if (handle === process.pid) return false
    try {
      process.kill(handle, 0)
      return true
    } catch {
      return false
    }
  }
  if (process.platform === 'linux' && !isLinuxWayland()) {
    const pidOut = runExecSync('xdotool', ['getwindowpid', String(handle)])
    const pid = pidOut ? Number(pidOut) : 0
    return pid > 0 && pid !== process.pid && handle > 0
  }
  return false
}

export function isTargetAlive(handle: number): boolean {
  if (!handle) return false
  if (process.platform === 'win32') {
    return win32IsWindow(handle)
  }
  if (process.platform === 'darwin') {
    try {
      process.kill(handle, 0)
      return true
    } catch {
      return false
    }
  }
  if (process.platform === 'linux') {
    if (isLinuxWayland()) return true
    return runExecSync('xprop', ['-id', String(handle), 'WM_CLASS'], 250) !== null
  }
  return false
}

export function isTargetMinimized(handle: number): boolean {
  if (process.platform === 'win32') {
    return win32IsWindowMinimized(handle)
  }
  return false
}

export function isWindowElevatedOverSelf(handle: number): boolean {
  if (process.platform === 'win32') {
    return win32IsWindowElevatedOverSelf(handle)
  }
  return false
}

export function isOwnProcessWindow(handle: number): boolean {
  if (!handle) return false
  if (process.platform === 'win32') {
    return win32IsOwnProcessWindow(handle)
  }
  if (process.platform === 'darwin') {
    return handle === process.pid
  }
  if (process.platform === 'linux' && !isLinuxWayland()) {
    const pidOut = runExecSync('xdotool', ['getwindowpid', String(handle)])
    const pid = pidOut ? Number(pidOut) : 0
    return pid > 0 && pid === process.pid
  }
  return false
}

export function getWindowTitle(handle: number): string {
  if (process.platform === 'win32') {
    return win32GetWindowTitle(handle)
  }
  return ''
}

export function getClipboardSequenceNumber(): number {
  if (process.platform === 'win32') {
    return win32GetClipboardSequenceNumber()
  }
  return 0
}

export function injectMaskKey(): boolean {
  if (process.platform === 'win32') {
    return win32InjectMaskKey()
  }
  return false
}

function getTargetInputKind(handle: number, customSets?: CustomTerminalExeSets): WindowInputKind {
  if (process.platform === 'win32') {
    return win32ClassifyWindowKind(handle, customSets?.extraWt, customSets?.extraConhost)
  }
  if (process.platform === 'darwin') {
    return macKindCache.get(handle) ?? 'normal'
  }
  if (process.platform === 'linux' && !isLinuxWayland()) {
    const wmClass = runExecSync('xprop', ['-id', String(handle), 'WM_CLASS'], 250) ?? ''
    return classifyLinuxWmClass(wmClass)
  }
  return 'normal'
}

export function getTargetCopyKind(handle: number, customSets?: CustomTerminalExeSets): WindowInputKind {
  return getTargetInputKind(handle, customSets)
}

export function getTargetPasteKind(handle: number, customSets?: CustomTerminalExeSets): WindowInputKind {
  return getTargetInputKind(handle, customSets)
}

export async function dispatchBackspaces(charCount: number): Promise<void> {
  if (process.platform === 'win32') {
    await win32SendBackspaces(charCount)
  }
}

export function focusTarget(handle: number): boolean {
  if (!handle) return false
  if (process.platform === 'win32') {
    return win32FocusWindow(handle)
  }
  if (process.platform === 'darwin') {
    const res = runExecSync('osascript', [
      '-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${handle}) to true`
    ])
    return res !== null
  }
  if (process.platform === 'linux' && !isLinuxWayland()) {
    return runExecSync('xdotool', ['windowactivate', '--sync', String(handle)], 500) !== null
  }
  return false
}

export async function releasePressedModifiers(): Promise<void> {
  if (process.platform === 'win32') {
    await win32ReleaseModifiers()
  }
}

export function dispatchCopyShortcut(kind: WindowInputKind): void {
  if (process.platform === 'win32') {
    win32SendCopyForWindow(kind)
    return
  }
  if (process.platform === 'darwin') {
    const res = runExecSync('osascript', [
      '-e',
      'tell application "System Events" to keystroke "c" using command down'
    ])
    if (res === null) {
      throw new Error('MACOS_ACCESSIBILITY_DENIED')
    }
    return
  }
  if (process.platform === 'linux' && !isLinuxWayland()) {
    const chord = kind === 'wt' ? 'ctrl+shift+c' : kind === 'conhost' ? 'ctrl+Insert' : 'ctrl+c'
    const res = runExecSync('xdotool', ['key', '--clearmodifiers', chord])
    if (res === null) {
      throw new Error('XDOTOOL_COPY_FAILED')
    }
    return
  }
  throw new Error('KEYSTROKE_INJECTION_UNSUPPORTED')
}

export function dispatchPasteShortcut(kind: WindowInputKind): void {
  if (process.platform === 'win32') {
    win32SendPasteForWindow(kind)
    return
  }
  if (process.platform === 'darwin') {
    const res = runExecSync('osascript', [
      '-e',
      'tell application "System Events" to keystroke "v" using command down'
    ])
    if (res === null) {
      throw new Error('MACOS_ACCESSIBILITY_DENIED')
    }
    return
  }
  if (process.platform === 'linux' && !isLinuxWayland()) {
    const chord = kind === 'wt' ? 'ctrl+shift+v' : kind === 'conhost' ? 'shift+Insert' : 'ctrl+v'
    const res = runExecSync('xdotool', ['key', '--clearmodifiers', chord])
    if (res === null) {
      throw new Error('XDOTOOL_PASTE_FAILED')
    }
    return
  }
  throw new Error('KEYSTROKE_INJECTION_UNSUPPORTED')
}

export async function writeHistoryExcludedClipboardText(text: string): Promise<boolean> {
  if (process.platform === 'win32') {
    return win32WritePrivateClipboardText(text)
  }
  return false
}

/**
 * Detect whether the current process is attached to an isolated/non-interactive desktop
 * (such as an IDE agent sandbox `exebox-*`) where tray icons and global hotkeys would be invisible.
 */
export function isRunningOnHiddenDesktop(): boolean {
  if (process.platform !== 'win32') return false
  const name = win32GetCurrentDesktopName().trim().toLowerCase()
  return name !== '' && name !== 'default'
}
