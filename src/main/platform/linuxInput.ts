import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { MAX_TRANSLATE_CHARS } from '../../shared/types'
import type { WindowInputKind } from './win32Classifier'

const execFileAsync = promisify(execFile)

export type LinuxInputBackend = 'xdotool' | 'ydotool' | 'wtype' | 'none'

export interface LinuxExecCommand {
  cmd: string
  args: string[]
}

/**
 * Sentinel target handle used on Linux Wayland when `ydotool` or `wtype` is available.
 * Wayland compositors intentionally disallow reading foreign window IDs, so hiding the
 * popup restores focus to the prior window directly and keystrokes inject into it.
 */
export const WAYLAND_SYNTHETIC_HANDLE = -1

const BACKEND_CACHE_TTL_MS = 5000
const BACKSPACE_BATCH_CHARS = 20
const BACKSPACE_BATCH_INTERVAL_MS = 8

// Linux evdev key codes (<linux/input-event-codes.h>) for ydotool
const EVDEV_BACKSPACE = 14
const EVDEV_LEFTCTRL = 29
const EVDEV_LEFTSHIFT = 42
const EVDEV_C = 46
const EVDEV_V = 47
const EVDEV_INSERT = 110

let cachedBackend: { key: string; value: LinuxInputBackend; expiresAt: number } | null = null

export function clearLinuxBackendCache(): void {
  cachedBackend = null
}

export function isLinuxWaylandEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    Boolean(env['WAYLAND_DISPLAY']) ||
    (env['XDG_SESSION_TYPE'] ?? '').trim().toLowerCase() === 'wayland'
  )
}

/**
 * Pure backend selector for Linux keystroke injection:
 * - X11: prefers `xdotool`
 * - Wayland: prefers `ydotool` (universal uinput), then `wtype` (wlroots compositors)
 */
export function detectLinuxInputBackend(
  isWayland: boolean,
  hasCommand: (cmd: string) => boolean
): LinuxInputBackend {
  if (!isWayland) {
    return hasCommand('xdotool') ? 'xdotool' : 'none'
  }
  if (hasCommand('ydotool')) return 'ydotool'
  if (hasCommand('wtype')) return 'wtype'
  return 'none'
}

export function buildLinuxCopyCommand(
  backend: Exclude<LinuxInputBackend, 'none'>,
  kind: WindowInputKind
): LinuxExecCommand {
  if (backend === 'xdotool') {
    const chord = kind === 'wt' ? 'ctrl+shift+c' : kind === 'conhost' ? 'ctrl+Insert' : 'ctrl+c'
    return { cmd: 'xdotool', args: ['key', '--clearmodifiers', chord] }
  }
  if (backend === 'ydotool') {
    if (kind === 'wt') {
      return {
        cmd: 'ydotool',
        args: [
          'key',
          `${EVDEV_LEFTCTRL}:1`,
          `${EVDEV_LEFTSHIFT}:1`,
          `${EVDEV_C}:1`,
          `${EVDEV_C}:0`,
          `${EVDEV_LEFTSHIFT}:0`,
          `${EVDEV_LEFTCTRL}:0`
        ]
      }
    }
    if (kind === 'conhost') {
      return {
        cmd: 'ydotool',
        args: [
          'key',
          `${EVDEV_LEFTCTRL}:1`,
          `${EVDEV_INSERT}:1`,
          `${EVDEV_INSERT}:0`,
          `${EVDEV_LEFTCTRL}:0`
        ]
      }
    }
    return {
      cmd: 'ydotool',
      args: ['key', `${EVDEV_LEFTCTRL}:1`, `${EVDEV_C}:1`, `${EVDEV_C}:0`, `${EVDEV_LEFTCTRL}:0`]
    }
  }
  // wtype
  if (kind === 'wt') {
    return {
      cmd: 'wtype',
      args: ['-M', 'ctrl', '-M', 'shift', '-k', 'c', '-m', 'shift', '-m', 'ctrl']
    }
  }
  if (kind === 'conhost') {
    return {
      cmd: 'wtype',
      args: ['-M', 'ctrl', '-k', 'Insert', '-m', 'ctrl']
    }
  }
  return {
    cmd: 'wtype',
    args: ['-M', 'ctrl', '-k', 'c', '-m', 'ctrl']
  }
}

export function buildLinuxPasteCommand(
  backend: Exclude<LinuxInputBackend, 'none'>,
  kind: WindowInputKind
): LinuxExecCommand {
  if (backend === 'xdotool') {
    const chord = kind === 'wt' ? 'ctrl+shift+v' : kind === 'conhost' ? 'shift+Insert' : 'ctrl+v'
    return { cmd: 'xdotool', args: ['key', '--clearmodifiers', chord] }
  }
  if (backend === 'ydotool') {
    if (kind === 'wt') {
      return {
        cmd: 'ydotool',
        args: [
          'key',
          `${EVDEV_LEFTCTRL}:1`,
          `${EVDEV_LEFTSHIFT}:1`,
          `${EVDEV_V}:1`,
          `${EVDEV_V}:0`,
          `${EVDEV_LEFTSHIFT}:0`,
          `${EVDEV_LEFTCTRL}:0`
        ]
      }
    }
    if (kind === 'conhost') {
      return {
        cmd: 'ydotool',
        args: [
          'key',
          `${EVDEV_LEFTSHIFT}:1`,
          `${EVDEV_INSERT}:1`,
          `${EVDEV_INSERT}:0`,
          `${EVDEV_LEFTSHIFT}:0`
        ]
      }
    }
    return {
      cmd: 'ydotool',
      args: ['key', `${EVDEV_LEFTCTRL}:1`, `${EVDEV_V}:1`, `${EVDEV_V}:0`, `${EVDEV_LEFTCTRL}:0`]
    }
  }
  // wtype
  if (kind === 'wt') {
    return {
      cmd: 'wtype',
      args: ['-M', 'ctrl', '-M', 'shift', '-k', 'v', '-m', 'shift', '-m', 'ctrl']
    }
  }
  if (kind === 'conhost') {
    return {
      cmd: 'wtype',
      args: ['-M', 'shift', '-k', 'Insert', '-m', 'shift']
    }
  }
  return {
    cmd: 'wtype',
    args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl']
  }
}

export function buildLinuxBackspaceCommand(
  backend: Exclude<LinuxInputBackend, 'none'>,
  batchCount: number
): LinuxExecCommand {
  const safeBatch = Math.max(1, Math.floor(batchCount))
  if (backend === 'xdotool') {
    return {
      cmd: 'xdotool',
      args: ['key', '--clearmodifiers', '--repeat', String(safeBatch), '--delay', '2', 'BackSpace']
    }
  }
  if (backend === 'ydotool') {
    const pairs: string[] = ['key']
    for (let i = 0; i < safeBatch; i++) {
      pairs.push(`${EVDEV_BACKSPACE}:1`, `${EVDEV_BACKSPACE}:0`)
    }
    return { cmd: 'ydotool', args: pairs }
  }
  const args: string[] = []
  for (let i = 0; i < safeBatch; i++) {
    args.push('-k', 'BackSpace')
  }
  return { cmd: 'wtype', args }
}

function hasSystemCommand(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], {
      encoding: 'utf8',
      timeout: 250,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

export function getLinuxInputBackend(env: NodeJS.ProcessEnv = process.env): LinuxInputBackend {
  const wayland = isLinuxWaylandEnv(env)
  const key = wayland ? 'wayland' : 'x11'
  const now = Date.now()
  if (cachedBackend !== null && cachedBackend.key === key && now < cachedBackend.expiresAt) {
    return cachedBackend.value
  }
  const detected = detectLinuxInputBackend(wayland, hasSystemCommand)
  cachedBackend = { key, value: detected, expiresAt: now + BACKEND_CACHE_TTL_MS }
  return detected
}

function runCommandSync(spec: LinuxExecCommand, timeout = 450): boolean {
  try {
    execFileSync(spec.cmd, spec.args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function sendLinuxCopyShortcut(kind: WindowInputKind): void {
  const backend = getLinuxInputBackend()
  if (backend === 'none') {
    throw new Error('KEYSTROKE_INJECTION_UNSUPPORTED')
  }
  const spec = buildLinuxCopyCommand(backend, kind)
  if (!runCommandSync(spec)) {
    throw new Error(`${backend.toUpperCase()}_COPY_FAILED`)
  }
}

export function sendLinuxPasteShortcut(kind: WindowInputKind): void {
  const backend = getLinuxInputBackend()
  if (backend === 'none') {
    throw new Error('KEYSTROKE_INJECTION_UNSUPPORTED')
  }
  const spec = buildLinuxPasteCommand(backend, kind)
  if (!runCommandSync(spec)) {
    throw new Error(`${backend.toUpperCase()}_PASTE_FAILED`)
  }
}

export async function sendLinuxBackspaces(charCount: number): Promise<void> {
  const safeCount = Math.min(MAX_TRANSLATE_CHARS, Math.max(0, Math.floor(charCount)))
  if (safeCount === 0) return

  const backend = getLinuxInputBackend()
  if (backend === 'none') return

  let remaining = safeCount
  while (remaining > 0) {
    const batch = Math.min(BACKSPACE_BATCH_CHARS, remaining)
    const spec = buildLinuxBackspaceCommand(backend, batch)
    try {
      await execFileAsync(spec.cmd, spec.args, { timeout: 1500 })
    } catch {
      return
    }
    remaining -= batch
    if (remaining > 0) {
      await sleep(BACKSPACE_BATCH_INTERVAL_MS)
    }
  }
}
