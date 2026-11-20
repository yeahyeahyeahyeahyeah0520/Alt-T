export type WindowInputKind = 'normal' | 'wt' | 'conhost'

const WT_CLASS_NAMES = new Set<string>([
  'cascadia_hosting_window_class',
  'org.wezfurlong.wezterm'
])

const CONHOST_CLASS_NAMES = new Set<string>([
  'consolewindowclass',
  'virtualconsoleclass',
  'mintty',
  'putty',
  'putty-nd'
])

const WT_EXE_NAMES = new Set<string>([
  'windowsterminal.exe',
  'wt.exe',
  'wezterm-gui.exe',
  'alacritty.exe',
  'ghostty.exe',
  'tabby.exe',
  'hyper.exe',
  'rio.exe',
  'warp.exe',
  'wave.exe',
  'waveterm.exe',
  'terminus.exe'
])

const CONHOST_EXE_NAMES = new Set<string>([
  'conhost.exe',
  'openconsole.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'mintty.exe',
  'wsl.exe',
  'bash.exe',
  'putty.exe',
  'kitty.exe',
  'xshell.exe',
  'mobaxterm.exe'
])

const NON_TARGET_WINDOW_CLASSES = new Set<string>([
  'shell_traywnd',
  'shell_secondarytraywnd',
  'notifyiconoverflowwindow',
  'toplevelwindowforoverflowxamlisland',
  'xamlexplorerhostislandwindow',
  'progman',
  'workerw',
  'dv2controlhost',
  'tasklistthumbnailwnd',
  'multitaskingviewframe',
  'windows.ui.core.corewindow'
])

/**
 * Pure classifier by executable basename (fallback when window class is generic).
 * User-configured `extraWtExes` / `extraConhostExes` take precedence over built-in sets.
 */
export function classifyExeName(
  exeName: string,
  extraWtExes: ReadonlySet<string> = new Set(),
  extraConhostExes: ReadonlySet<string> = new Set()
): WindowInputKind {
  const lower = exeName.trim().toLowerCase()
  if (extraWtExes.has(lower)) return 'wt'
  if (extraConhostExes.has(lower)) return 'conhost'
  if (WT_EXE_NAMES.has(lower)) return 'wt'
  if (CONHOST_EXE_NAMES.has(lower)) return 'conhost'
  return 'normal'
}

/**
 * Pure classifier combining Win32 window class name and executable name.
 * Checking window class first ensures console client processes (e.g. claude.exe, agy.exe,
 * python.exe, ssh.exe) running inside ConsoleWindowClass are never misclassified as 'normal'.
 */
export function classifyTerminalWindow(
  className: string,
  exeName: string,
  extraWtExes: ReadonlySet<string> = new Set(),
  extraConhostExes: ReadonlySet<string> = new Set()
): WindowInputKind {
  const lowerClass = className.trim().toLowerCase()
  if (WT_CLASS_NAMES.has(lowerClass)) return 'wt'
  if (CONHOST_CLASS_NAMES.has(lowerClass) || lowerClass.startsWith('cygwin/x')) return 'conhost'
  return classifyExeName(exeName, extraWtExes, extraConhostExes)
}

/**
 * Pure check for taskbar, desktop wallpaper, or OS shell overlay window classes
 * that should never be recorded as a paste target.
 */
export function isNonTargetWindowClass(className: string): boolean {
  const lower = className.trim().toLowerCase()
  return lower === '' || NON_TARGET_WINDOW_CLASSES.has(lower)
}
