import fs from 'node:fs'
import path from 'node:path'
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'

const ARCH_ENUM_TO_NAME = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal'
}

const KEEP_WIN_LINUX_LOCALES = new Set(['en-us.pak', 'zh-cn.pak'])
const KEEP_MAC_LPROJ = new Set(['en.lproj', 'en_us.lproj', 'zh_cn.lproj', 'base.lproj'])

/**
 * Normalize electron-builder Arch enum or string to canonical arch name.
 */
export function normalizeArchName(arch) {
  if (typeof arch === 'number' && arch in ARCH_ENUM_TO_NAME) {
    return ARCH_ENUM_TO_NAME[arch]
  }
  if (typeof arch === 'string') {
    return arch.trim().toLowerCase()
  }
  return ''
}

/**
 * Resolve which prebuilt `koffi/build/koffi/<triplet>` directories must be retained
 * for a specific target platform + architecture.
 */
export function resolveKeepKoffiTriplets(electronPlatformName, arch) {
  const archName = normalizeArchName(arch)
  if (electronPlatformName === 'win32') {
    if (archName === 'ia32') return new Set(['win32_ia32'])
    if (archName === 'arm64') return new Set(['win32_arm64'])
    if (archName === 'x64') return new Set(['win32_x64'])
    return null
  }
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    if (archName === 'arm64') return new Set(['darwin_arm64'])
    if (archName === 'x64') return new Set(['darwin_x64'])
    if (archName === 'universal') return new Set(['darwin_arm64', 'darwin_x64'])
    return null
  }
  if (electronPlatformName === 'linux') {
    if (archName === 'x64') return new Set(['linux_x64', 'musl_x64'])
    if (archName === 'arm64') return new Set(['linux_arm64', 'musl_arm64'])
    if (archName === 'ia32') return new Set(['linux_ia32'])
    if (archName === 'armv7l') return new Set(['linux_armhf'])
    return null
  }
  return null
}

function getDirByteSize(dirPath, fsImpl) {
  let total = 0
  if (!fsImpl.existsSync(dirPath)) return 0
  for (const entry of fsImpl.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += getDirByteSize(full, fsImpl)
    } else if (entry.isFile()) {
      total += fsImpl.statSync(full).size
    }
  }
  return total
}

/**
 * Prune unused Chromium locale `.pak` files (Win/Linux) or `.lproj` dirs (macOS),
 * keeping only English and Simplified Chinese.
 */
export function pruneElectronLocales(appOutDir, electronPlatformName, productFilename = 'Alt-T', fsImpl = fs) {
  let removedCount = 0
  let reclaimedBytes = 0

  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    const resDir = path.join(
      appOutDir,
      `${productFilename}.app`,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources'
    )
    if (!fsImpl.existsSync(resDir)) return { removedCount, reclaimedBytes }
    for (const entry of fsImpl.readdirSync(resDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue
      if (KEEP_MAC_LPROJ.has(entry.name.toLowerCase())) continue
      const full = path.join(resDir, entry.name)
      reclaimedBytes += getDirByteSize(full, fsImpl)
      fsImpl.rmSync(full, { recursive: true, force: true })
      removedCount++
    }
    return { removedCount, reclaimedBytes }
  }

  const localesDir = path.join(appOutDir, 'locales')
  if (!fsImpl.existsSync(localesDir)) return { removedCount, reclaimedBytes }

  for (const entry of fsImpl.readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pak')) continue
    if (KEEP_WIN_LINUX_LOCALES.has(entry.name.toLowerCase())) continue
    const full = path.join(localesDir, entry.name)
    reclaimedBytes += fsImpl.statSync(full).size
    fsImpl.rmSync(full, { force: true })
    removedCount++
  }

  return { removedCount, reclaimedBytes }
}

/**
 * Remove foreign-OS/foreign-arch prebuilt `koffi.node` binaries from `app.asar.unpacked`.
 * Safety invariant: only prunes when at least one required target triplet directory exists.
 */
export function pruneForeignKoffiBinaries(
  appOutDir,
  electronPlatformName,
  arch,
  productFilename = 'Alt-T',
  fsImpl = fs
) {
  let removedCount = 0
  let reclaimedBytes = 0

  const keepSet = resolveKeepKoffiTriplets(electronPlatformName, arch)
  if (!keepSet || keepSet.size === 0) return { removedCount, reclaimedBytes }

  const resourcesRoot =
    electronPlatformName === 'darwin' || electronPlatformName === 'mas'
      ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources')

  const koffiBuildDir = path.join(
    resourcesRoot,
    'app.asar.unpacked',
    'node_modules',
    'koffi',
    'build',
    'koffi'
  )
  if (!fsImpl.existsSync(koffiBuildDir)) return { removedCount, reclaimedBytes }

  const entries = fsImpl.readdirSync(koffiBuildDir, { withFileTypes: true })
  const hasRequiredTarget = entries.some((entry) => entry.isDirectory() && keepSet.has(entry.name))
  if (!hasRequiredTarget) return { removedCount, reclaimedBytes }

  for (const entry of entries) {
    if (!entry.isDirectory() || keepSet.has(entry.name)) continue
    const full = path.join(koffiBuildDir, entry.name)
    reclaimedBytes += getDirByteSize(full, fsImpl)
    fsImpl.rmSync(full, { recursive: true, force: true })
    removedCount++
  }

  return { removedCount, reclaimedBytes }
}

/**
 * Electron-builder afterPack hook:
 * 1. Prunes unused Chromium locales (keeping en-US & zh-CN).
 * 2. Prunes foreign-OS/arch koffi native binaries (keeping only target triplet).
 * 3. Applies @electron/fuses security hardening to the packaged executable.
 */
export async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch, packager } = context
  const productFilename = packager.appInfo.productFilename

  const localeResult = pruneElectronLocales(appOutDir, electronPlatformName, productFilename)
  const koffiResult = pruneForeignKoffiBinaries(
    appOutDir,
    electronPlatformName,
    arch,
    productFilename
  )

  const localeMb = (localeResult.reclaimedBytes / (1024 * 1024)).toFixed(2)
  const koffiMb = (koffiResult.reclaimedBytes / (1024 * 1024)).toFixed(2)
  console.log(
    `[alt-t] Bundle slimming: pruned ${localeResult.removedCount} locales (${localeMb} MB) and ${koffiResult.removedCount} foreign koffi binaries (${koffiMb} MB)`
  )

  const ext =
    electronPlatformName === 'win32'
      ? '.exe'
      : electronPlatformName === 'darwin' || electronPlatformName === 'mas'
        ? '.app'
        : ''

  const executableBase =
    electronPlatformName === 'linux' ? packager.executableName : productFilename
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
