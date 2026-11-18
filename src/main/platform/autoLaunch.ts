import fs from 'node:fs'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { app, shell, type ShortcutDetails } from 'electron'

const WIN_STARTUP_SHORTCUT = 'FlashPrompt.lnk'
const LEGACY_WATCHDOG_SHORTCUT = 'TTime Lite Watchdog.lnk'
const LINUX_AUTOSTART_DESKTOP = 'flashprompt.desktop'

export interface AutoLaunchDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  execPath: string
  homedir: () => string
  app: {
    isPackaged: boolean
    getPath: (name: 'appData') => string
    getAppPath: () => string
    setLoginItemSettings: (settings: { openAtLogin: boolean; path?: string }) => void
  }
  shell: {
    writeShortcutLink: (shortcutPath: string, details: ShortcutDetails) => boolean
    readShortcutLink: (shortcutPath: string) => ShortcutDetails
  }
  fs: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'unlinkSync' | 'writeFileSync'>
}

function resolveDeps(overrides?: Partial<AutoLaunchDeps>): AutoLaunchDeps {
  return {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    homedir: () => os.homedir(),
    app,
    shell,
    fs,
    ...overrides
  }
}

export function getWindowsStartupDir(overrides?: Partial<AutoLaunchDeps>): string {
  const deps = resolveDeps(overrides)
  return join(
    deps.app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
  )
}

export function resolveUnpackagedRootDir(
  rawAppPath: string,
  fsImpl: Pick<typeof fs, 'existsSync'> = fs
): string {
  const normalized = resolve(rawAppPath)
  const parent = dirname(normalized)
  if (
    basename(normalized).toLowerCase() === 'main' &&
    basename(parent).toLowerCase() === 'out'
  ) {
    const candidateRoot = dirname(parent)
    if (fsImpl.existsSync(join(candidateRoot, 'package.json'))) {
      return candidateRoot
    }
  }
  return normalized
}

function removeFileIfExists(
  filePath: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'unlinkSync'>
): void {
  try {
    if (fsImpl.existsSync(filePath)) {
      fsImpl.unlinkSync(filePath)
    }
  } catch {
    // Ignore cleanup error
  }
}

function sameWinPath(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
}

function shortcutAlreadyMatches(
  lnkPath: string,
  desired: ShortcutDetails,
  deps: AutoLaunchDeps
): boolean {
  if (!deps.fs.existsSync(lnkPath)) return false
  try {
    const existing = deps.shell.readShortcutLink(lnkPath)
    return (
      sameWinPath(existing.target, desired.target) &&
      (existing.args ?? '').trim() === (desired.args ?? '').trim() &&
      sameWinPath(existing.cwd, desired.cwd)
    )
  } catch {
    return false
  }
}

function syncLinuxAutoLaunch(enabled: boolean, deps: AutoLaunchDeps): boolean {
  const configBase = deps.env['XDG_CONFIG_HOME'] || join(deps.homedir(), '.config')
  const autostartDir = join(configBase, 'autostart')
  const desktopFile = join(autostartDir, LINUX_AUTOSTART_DESKTOP)

  if (!enabled) {
    removeFileIfExists(desktopFile, deps.fs)
    return true
  }

  deps.fs.mkdirSync(autostartDir, { recursive: true })
  const execCmd = deps.app.isPackaged
    ? `"${deps.execPath}"`
    : `"${deps.execPath}" "${resolveUnpackagedRootDir(deps.app.getAppPath(), deps.fs)}"`

  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=FlashPrompt',
    'Comment=Instant native prompt translator and terminal injector',
    `Exec=${execCmd}`,
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')

  deps.fs.writeFileSync(desktopFile, content, 'utf8')
  return true
}

export function syncAutoLaunch(
  enabled: boolean,
  overrides?: Partial<AutoLaunchDeps>
): boolean {
  const deps = resolveDeps(overrides)
  if (deps.env['ELECTRON_RENDERER_URL']) {
    return true
  }

  const isSmoke = deps.env['TTL_SMOKE'] === '1' || deps.env['FP_SMOKE'] === '1'

  try {
    if (deps.platform === 'darwin') {
      deps.app.setLoginItemSettings({ openAtLogin: enabled })
      return true
    }

    if (deps.platform === 'linux') {
      return syncLinuxAutoLaunch(enabled, deps)
    }

    if (deps.platform !== 'win32') {
      return false
    }

    const startupDir = getWindowsStartupDir(deps)
    const lnkPath = join(startupDir, WIN_STARTUP_SHORTCUT)
    if (!isSmoke) {
      removeFileIfExists(join(startupDir, LEGACY_WATCHDOG_SHORTCUT), deps.fs)
    }

    const portableExe = (deps.env['PORTABLE_EXECUTABLE_FILE'] ?? '').trim()

    if (!enabled) {
      removeFileIfExists(lnkPath, deps.fs)
      if (deps.app.isPackaged && portableExe === '') {
        deps.app.setLoginItemSettings({ openAtLogin: false, path: deps.execPath })
      }
      return true
    }

    if (deps.app.isPackaged) {
      if (portableExe !== '') {
        deps.fs.mkdirSync(startupDir, { recursive: true })
        const desired: ShortcutDetails = {
          target: portableExe,
          args: '',
          cwd: dirname(portableExe),
          description: 'FlashPrompt',
          icon: portableExe,
          iconIndex: 0,
          appUserModelId: 'com.flashprompt.app'
        }
        if (shortcutAlreadyMatches(lnkPath, desired, deps)) {
          return true
        }
        return deps.shell.writeShortcutLink(lnkPath, desired)
      }

      removeFileIfExists(lnkPath, deps.fs)
      deps.app.setLoginItemSettings({ openAtLogin: true, path: deps.execPath })
      return true
    }

    deps.fs.mkdirSync(startupDir, { recursive: true })
    const appDir = resolveUnpackagedRootDir(deps.app.getAppPath(), deps.fs)
    const electronExe = deps.execPath
    const vbsPath = join(appDir, 'start-silent.vbs')

    const desired: ShortcutDetails = deps.fs.existsSync(vbsPath)
      ? {
          target: join(deps.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'wscript.exe'),
          args: `//B //NoLogo "${vbsPath}"`,
          cwd: appDir,
          description: 'FlashPrompt',
          icon: electronExe,
          iconIndex: 0,
          appUserModelId: 'com.flashprompt.app'
        }
      : {
          target: electronExe,
          args: `"${appDir}"`,
          cwd: appDir,
          description: 'FlashPrompt',
          icon: electronExe,
          iconIndex: 0,
          appUserModelId: 'com.flashprompt.app'
        }

    if (shortcutAlreadyMatches(lnkPath, desired, deps)) {
      return true
    }
    return deps.shell.writeShortcutLink(lnkPath, desired)
  } catch (err) {
    console.warn('[fp] syncAutoLaunch failed:', err)
    return false
  }
}
