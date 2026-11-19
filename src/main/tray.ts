import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { AppConfig } from '../shared/types'
import { logError, logWarn } from './services/logger'

export interface TrayDeps {
  getConfig: () => AppConfig
  onTogglePopup: () => void
  onDirectInput?: () => void
  onToggleAutoLaunch?: (enabled: boolean) => void
  onOpenSettings: () => void
  onQuit?: () => void
}

export interface TrayController {
  rebuildMenu(): void
  destroy(): void
}

/**
 * Render a crisp BGRA rounded badge with a bold white 'F' glyph at `size x size` pixels.
 */
function renderBrandBitmap(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const radius = Math.max(2, Math.round(size * 0.22))

  const xStem0 = Math.round(size * 0.22)
  const stemW = Math.max(2, Math.round(size * 0.16))
  const xStem1 = xStem0 + stemW

  const yTop0 = Math.round(size * 0.22)
  const barH = Math.max(2, Math.round(size * 0.14))
  const yTop1 = yTop0 + barH
  const yBottom = size - Math.round(size * 0.22)

  const xTopBar1 = size - Math.round(size * 0.22)

  const yMid0 = Math.round(size * 0.46)
  const midH = Math.max(1, Math.round(size * 0.12))
  const yMid1 = yMid0 + midH
  const xMidBar1 = size - Math.round(size * 0.35)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x - 0.5, 0, x + 0.5 - (size - radius))
      const dy = Math.max(radius - y - 0.5, 0, y + 0.5 - (size - radius))
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > radius + 0.5) {
        continue
      }

      const edgeAlpha = dist <= radius - 0.5 ? 1 : Math.max(0, Math.min(1, radius + 0.5 - dist))
      const inStem = x >= xStem0 && x < xStem1 && y >= yTop0 && y < yBottom
      const inTopBar = x >= xStem0 && x < xTopBar1 && y >= yTop0 && y < yTop1
      const inMidBar = x >= xStem0 && x < xMidBar1 && y >= yMid0 && y < yMid1
      const isGlyph = inStem || inTopBar || inMidBar

      const idx = (y * size + x) * 4
      if (isGlyph) {
        buf[idx] = 0xff
        buf[idx + 1] = 0xff
        buf[idx + 2] = 0xff
        buf[idx + 3] = Math.round(255 * edgeAlpha)
      } else {
        // Electric Indigo / Blue (#4F46E5 -> BGRA: E5, 46, 4F, alpha)
        buf[idx] = 0xe5
        buf[idx + 1] = 0x46
        buf[idx + 2] = 0x4f
        buf[idx + 3] = Math.round(255 * edgeAlpha)
      }
    }
  }
  return buf
}

export function createAppIcon(): Electron.NativeImage {
  try {
    const multi = nativeImage.createEmpty()
    multi.addRepresentation({
      scaleFactor: 1.0,
      width: 16,
      height: 16,
      buffer: renderBrandBitmap(16)
    })
    multi.addRepresentation({
      scaleFactor: 2.0,
      width: 32,
      height: 32,
      buffer: renderBrandBitmap(32)
    })
    if (!multi.isEmpty()) {
      return multi
    }
  } catch {
    // Fallback to single-scale bitmap below
  }

  const fallback = nativeImage.createFromBitmap(renderBrandBitmap(16), { width: 16, height: 16 })
  if (fallback.isEmpty()) {
    logWarn('tray bitmap icon is empty, falling back to createEmpty')
    return nativeImage.createEmpty()
  }
  return fallback
}

export function createTray(deps: TrayDeps): TrayController {
  const icon = createAppIcon()
  const tray = new Tray(icon)
  tray.setToolTip('Alt-T')

  function buildContextMenu(): Menu {
    const cfg = deps.getConfig()
    const template: MenuItemConstructorOptions[] = []

    if (deps.onDirectInput) {
      const onDirectInput = deps.onDirectInput
      template.push({
        label: `极速译入终端/窗口 (${cfg.hotkeys.directInputTranslate})`,
        click: () => {
          try {
            onDirectInput()
          } catch (err) {
            logError('tray directInput error', err)
          }
        }
      })
    }

    template.push({
      label: `显示主浮窗 (${cfg.hotkeys.togglePopup})`,
      click: () => {
        try {
          deps.onTogglePopup()
        } catch (err) {
          logError('tray togglePopup error', err)
        }
      }
    })

    if (deps.onToggleAutoLaunch) {
      const onToggleAutoLaunch = deps.onToggleAutoLaunch
      template.push({
        label: '开机自启',
        type: 'checkbox',
        checked: cfg.autoLaunch,
        click: (menuItem) => {
          try {
            onToggleAutoLaunch(Boolean(menuItem.checked))
          } catch (err) {
            logError('tray toggleAutoLaunch error', err)
          }
        }
      })
    }

    template.push(
      {
        label: '设置…',
        click: () => {
          try {
            deps.onOpenSettings()
          } catch (err) {
            logError('tray openSettings error', err)
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          if (deps.onQuit) {
            deps.onQuit()
          } else {
            app.quit()
          }
        }
      }
    )

    return Menu.buildFromTemplate(template)
  }

  function rebuildMenu(): void {
    if (tray.isDestroyed()) return
    tray.setContextMenu(buildContextMenu())
  }

  tray.on('click', () => {
    try {
      deps.onTogglePopup()
    } catch (err) {
      logError('tray click error', err)
    }
  })

  rebuildMenu()

  return {
    rebuildMenu,
    destroy(): void {
      if (!tray.isDestroyed()) {
        tray.destroy()
      }
    }
  }
}
