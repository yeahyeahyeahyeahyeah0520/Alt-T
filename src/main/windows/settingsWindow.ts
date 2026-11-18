import { join } from 'node:path'
import { BrowserWindow, nativeTheme } from 'electron'
import { createAppIcon } from '../tray'

let settingsWin: BrowserWindow | null = null

export function openSettingsWindow(): BrowserWindow {
  if (settingsWin !== null && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) {
      settingsWin.restore()
    }
    settingsWin.show()
    settingsWin.focus()
    return settingsWin
  }

  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff'

  const win = new BrowserWindow({
    width: 560,
    height: 660,
    resizable: true,
    minimizable: false,
    maximizable: false,
    frame: true,
    title: 'FlashPrompt 设置',
    icon: createAppIcon(),
    backgroundColor,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  win.setMenu(null)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => {
    e.preventDefault()
  })

  const onThemeUpdated = (): void => {
    if (!win.isDestroyed()) {
      win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff')
    }
  }
  nativeTheme.on('updated', onThemeUpdated)

  win.on('closed', () => {
    nativeTheme.removeListener('updated', onThemeUpdated)
    if (settingsWin === win) {
      settingsWin = null
    }
  })

  settingsWin = win

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/settings.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/settings.html'))
  }

  return win
}

export function getSettingsWindow(): BrowserWindow | null {
  if (settingsWin !== null && !settingsWin.isDestroyed()) {
    return settingsWin
  }
  return null
}

export function closeSettingsWindow(): void {
  if (settingsWin !== null && !settingsWin.isDestroyed()) {
    settingsWin.close()
  }
}
