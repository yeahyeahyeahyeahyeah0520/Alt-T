import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import {
  buildLinuxBackspaceCommand,
  buildLinuxCopyCommand,
  buildLinuxPasteCommand,
  detectLinuxInputBackend,
  getLinuxInputBackend,
  isLinuxWaylandEnv,
  sendLinuxBackspaces,
  sendLinuxCopyShortcut,
  sendLinuxPasteShortcut,
  WAYLAND_SYNTHETIC_HANDLE,
  type LinuxInputBackend
} from './linuxInput'
import {
  isMacAccessibilityTrusted,
  sendMacBackspaces,
  sendMacCopyShortcut,
  sendMacPasteShortcut
} from './macInput'
import {
  setWin32UiaWorkerScriptPath as setWin32UiaWorkerScriptPathImpl,
  shutdownWin32UiaWorker
} from './win32Uia'
import {
  classifyWindowContext as win32ClassifyWindowContext,
  classifyWindowKind as win32ClassifyWindowKind,
  focusWindow as win32FocusWindow,
  getClipboardSequenceNumber as win32GetClipboardSequenceNumber,
  getCurrentDesktopName as win32GetCurrentDesktopName,
  getForegroundWindow as win32GetForegroundWindow,
  getWindowClassName as win32GetWindowClassName,
  getWindowExeName as win32GetWindowExeName,
  getWindowPid as win32GetWindowPid,
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
  type WindowClassification,
  type WindowInputKind
} from './win32Input'

export {
  buildLinuxBackspaceCommand,
  buildLinuxCopyCommand,
  buildLinuxPasteCommand,
  detectLinuxInputBackend,
  getLinuxInputBackend,
  isLinuxWaylandEnv as isLinuxWayland,
  WAYLAND_SYNTHETIC_HANDLE,
  type LinuxInputBackend
}
export type { WindowClassification, WindowInputKind } from './win32Classifier'

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

function parseLinuxWmClassName(wmClassOutput: string): string {
  const matches = [...wmClassOutput.matchAll(/"([^"]+)"/g)]
  const first = matches[0]?.[1] ?? ''
  return first.trim().toLowerCase()
}

const macAppInfoCache = new Map<number, { kind: WindowInputKind; appName: string }>()

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
    return getLinuxInputBackend() !== 'none'
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
    macAppInfoCache.set(pid, {
      kind: classifyMacAppName(name),
      appName: name.trim().toLowerCase()
    })
    if (macAppInfoCache.size > 64) {
      const oldest = macAppInfoCache.keys().next().value
      if (oldest !== undefined) macAppInfoCache.delete(oldest)
    }
    return pid
  }
  if (process.platform === 'linux') {
    if (isLinuxWaylandEnv()) {
      return getLinuxInputBackend() !== 'none' ? WAYLAND_SYNTHETIC_HANDLE : 0
    }
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
  if (process.platform === 'linux') {
    if (isLinuxWaylandEnv()) {
      return handle === WAYLAND_SYNTHETIC_HANDLE && getLinuxInputBackend() !== 'none'
    }
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
    if (isLinuxWaylandEnv()) {
      return handle === WAYLAND_SYNTHETIC_HANDLE
    }
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
  if (process.platform === 'linux' && !isLinuxWaylandEnv()) {
    const pidOut = runExecSync('xdotool', ['getwindowpid', String(handle)])
    const pid = pidOut ? Number(pidOut) : 0
    return pid > 0 && pid === process.pid
  }
  return false
}

export function getTargetExeName(handle: number): string {
  if (!handle) return ''
  if (process.platform === 'win32') {
    return win32GetWindowExeName(handle)
  }
  if (process.platform === 'darwin') {
    return macAppInfoCache.get(handle)?.appName ?? ''
  }
  if (process.platform === 'linux' && !isLinuxWaylandEnv()) {
    const wmClass = runExecSync('xprop', ['-id', String(handle), 'WM_CLASS'], 250) ?? ''
    return parseLinuxWmClassName(wmClass)
  }
  return ''
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
    return macAppInfoCache.get(handle)?.kind ?? 'normal'
  }
  if (process.platform === 'linux' && !isLinuxWaylandEnv()) {
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

export function getTargetPid(handle: number): number {
  if (process.platform === 'win32') {
    return win32GetWindowPid(handle)
  }
  return 0
}

export function getTargetClassName(handle: number): string {
  if (process.platform === 'win32') {
    return win32GetWindowClassName(handle)
  }
  return ''
}

export async function getTargetWindowClassification(
  handle: number,
  customSets?: CustomTerminalExeSets
): Promise<WindowClassification> {
  if (process.platform === 'win32') {
    return win32ClassifyWindowContext(handle, customSets?.extraWt, customSets?.extraConhost)
  }
  return { inputKind: getTargetInputKind(handle, customSets) }
}

export function setWin32UiaWorkerScriptPath(workerPath: string | null): void {
  if (process.platform === 'win32') {
    setWin32UiaWorkerScriptPathImpl(workerPath)
  }
}

export async function shutdownPlatformWorkers(): Promise<void> {
  if (process.platform === 'win32') {
    await shutdownWin32UiaWorker()
  }
}

export async function dispatchBackspaces(charCount: number): Promise<void> {
  if (process.platform === 'win32') {
    await win32SendBackspaces(charCount)
    return
  }
  if (process.platform === 'darwin') {
    await sendMacBackspaces(charCount)
    return
  }
  if (process.platform === 'linux') {
    await sendLinuxBackspaces(charCount)
  }
}

export function focusTarget(handle: number): boolean {
  if (!handle) return false
  if (process.platform === 'win32') {
    return win32FocusWindow(handle)
  }
  if (process.platform === 'darwin') {
    if (!isMacAccessibilityTrusted()) {
      return false
    }
    const res = runExecSync('osascript', [
      '-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${handle}) to true`
    ])
    return res !== null
  }
  if (process.platform === 'linux') {
    if (isLinuxWaylandEnv()) {
      return handle === WAYLAND_SYNTHETIC_HANDLE
    }
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
    sendMacCopyShortcut()
    return
  }
  if (process.platform === 'linux') {
    sendLinuxCopyShortcut(kind)
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
    sendMacPasteShortcut()
    return
  }
  if (process.platform === 'linux') {
    sendLinuxPasteShortcut(kind)
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
