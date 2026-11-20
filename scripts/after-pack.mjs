import path from 'node:path'
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'

/**
 * Electron-builder afterPack hook that locks down security-sensitive Electron fuses
 * prior to Windows NSIS / Portable installer packaging.
 */
export async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const ext =
    electronPlatformName === 'win32'
      ? '.exe'
      : electronPlatformName === 'darwin' || electronPlatformName === 'mas'
        ? '.app'
        : ''

  const executableBase =
    electronPlatformName === 'linux' ? packager.executableName : packager.appInfo.productFilename
  const binaryPath = path.join(appOutDir, `${executableBase}${ext}`)

  await flipFuses(binaryPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false
  })

  console.log(`[alt-t] Applied Electron fuses hardening to: ${path.basename(binaryPath)}`)
}

export default afterPack
