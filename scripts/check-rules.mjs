import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'dist-electron', 'release', '.git'])

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function walkFiles(dir, exts) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...walkFiles(path.join(dir, entry.name), exts))
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

function isCommentLine(trimmed) {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

const cjkStart = String.fromCharCode(0x4e00)
const cjkEnd = String.fromCharCode(0x9fff)
const literalCjkRangeRe = new RegExp(
  '[' + cjkStart + '-' + cjkEnd + ']-[' + cjkStart + '-' + cjkEnd + ']'
)
const zwspChar = String.fromCharCode(0x200b)
const bomChar = String.fromCharCode(0xfeff)

const coreNoElectronRe =
  /from\s+['"](electron|koffi|undici)['"]|require\(['"](electron|koffi|undici)['"]\)/
const rendererNoMainRe = /from\s+['"][^'"]*\/main\//
const rendererNoHttpRe = /\bfetch\s*\(|XMLHttpRequest|axios/
const noAnyRe = /:\s*any\b|<any>|\bas\s+any\b/
const noTsIgnoreRe = /@ts-ignore|@ts-expect-error/
const noTodoRe = /TODO|FIXME|XXX/
const platformGuardRe = /process\.platform/

const winUsersPathRe = new RegExp(
  '[A-Za-z]:\\\\+Users\\\\+(?!\\\\*(?:Public(?:\\\\|$)|Default(?:\\\\|$)|<user>|your-user))',
  'i'
)
const macUsersPathRe = new RegExp('/User' + 's/(?!<user>|your-user)')
const migratedRootRe = new RegExp('C' + '_Migrated', 'i')
const expandedAppDataRe = new RegExp('App' + 'Data[/\\\\]+Roaming[/\\\\]+TTime', 'i')
const secretLiteralRe =
  /\b(sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|xoxb-[0-9A-Za-z-]{20,})\b/

function hasPersonalPathLeak(line) {
  return (
    winUsersPathRe.test(line) ||
    macUsersPathRe.test(line) ||
    migratedRootRe.test(line) ||
    expandedAppDataRe.test(line)
  )
}

export function checkProjectRules(rootDir = process.cwd()) {
  const errors = []

  function report(relPath, lineNum, ruleName) {
    errors.push(`${relPath}:${lineNum}: ${ruleName}`)
  }

  // 1. package.json: no-forbidden-deps (electron-builder & @electron/fuses permitted)
  const pkgPath = path.join(rootDir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkgRaw = fs.readFileSync(pkgPath, 'utf8')
    const pkgLines = pkgRaw.split(/\r?\n/)
    const pkg = JSON.parse(pkgRaw)
    const forbiddenRe =
      /robotjs|uiohook|sqlite3|onnxruntime|node-screenshots|pinia|vuex|tailwind|element-plus|electron-updater|axios/
    for (const section of ['dependencies', 'devDependencies']) {
      const deps = pkg[section]
      if (!deps || typeof deps !== 'object') continue
      for (const depName of Object.keys(deps)) {
        if (forbiddenRe.test(depName)) {
          const idx = pkgLines.findIndex((l) => l.includes(`"${depName}"`))
          report('package.json', idx >= 0 ? idx + 1 : 1, 'no-forbidden-deps')
        }
      }
    }
  }

  // 2. Scan src/**/*.{ts,vue}
  const srcFiles = walkFiles(path.join(rootDir, 'src'), ['.ts', '.vue'])
  for (const absPath of srcFiles) {
    const rel = toPosix(path.relative(rootDir, absPath))
    const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/)
    const isTs = rel.endsWith('.ts')
    const inCoreOrShared = rel.startsWith('src/main/core/') || rel.startsWith('src/shared/')
    const inRendererOrPreload = rel.startsWith('src/renderer/') || rel.startsWith('src/preload/')
    const inRenderer = rel.startsWith('src/renderer/')
    const inPlatformLayer = rel.startsWith('src/main/platform/')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      const lineNum = i + 1

      if (hasPersonalPathLeak(line)) {
        report(rel, lineNum, 'no-personal-path')
      }
      if (secretLiteralRe.test(line)) {
        report(rel, lineNum, 'no-secret-literal')
      }
      if (noTodoRe.test(line)) {
        report(rel, lineNum, 'no-todo')
      }

      if (isCommentLine(trimmed)) continue

      if (inCoreOrShared && coreNoElectronRe.test(line)) {
        report(rel, lineNum, 'core-no-electron')
      }
      if (inRendererOrPreload && rendererNoMainRe.test(line)) {
        report(rel, lineNum, 'renderer-no-main')
      }
      if (inRenderer && rendererNoHttpRe.test(line)) {
        report(rel, lineNum, 'renderer-no-http')
      }
      if (isTs && noAnyRe.test(line)) {
        report(rel, lineNum, 'no-any')
      }
      if (noTsIgnoreRe.test(line)) {
        report(rel, lineNum, 'no-ts-ignore')
      }
      if (line.includes('console.') && line.includes('apiKey')) {
        report(rel, lineNum, 'no-key-log')
      }
      if (literalCjkRangeRe.test(line) || line.includes(zwspChar) || line.includes(bomChar)) {
        report(rel, lineNum, 'no-literal-cjk-range')
      }
      if (!inPlatformLayer && platformGuardRe.test(line)) {
        report(rel, lineNum, 'platform-guard')
      }
    }
  }

  // 3. Scan tests/**/*.ts
  const testFiles = walkFiles(path.join(rootDir, 'tests'), ['.ts'])
  for (const absPath of testFiles) {
    const rel = toPosix(path.relative(rootDir, absPath))
    const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      const lineNum = i + 1

      if (hasPersonalPathLeak(line)) {
        report(rel, lineNum, 'no-personal-path')
      }
      if (secretLiteralRe.test(line)) {
        report(rel, lineNum, 'no-secret-literal')
      }
      if (noTodoRe.test(line)) {
        report(rel, lineNum, 'no-todo')
      }

      if (isCommentLine(trimmed)) continue

      if (noTsIgnoreRe.test(line)) {
        report(rel, lineNum, 'no-ts-ignore')
      }
      if (literalCjkRangeRe.test(line) || line.includes(zwspChar) || line.includes(bomChar)) {
        report(rel, lineNum, 'no-literal-cjk-range')
      }
    }
  }

  // 4. vbs-ascii-no-bom check on *.vbs
  const vbsFiles = walkFiles(rootDir, ['.vbs'])
  for (const absPath of vbsFiles) {
    const rel = toPosix(path.relative(rootDir, absPath))
    const buf = fs.readFileSync(absPath)
    const hasUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    const hasUtf16Bom =
      buf.length >= 2 &&
      ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))

    if (hasUtf8Bom || hasUtf16Bom) {
      report(rel, 1, 'vbs-ascii-no-bom')
    } else {
      let lineNum = 1
      let badLine = -1
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i]
        if (b >= 0x80) {
          badLine = lineNum
          break
        }
        if (b === 0x0a) {
          lineNum++
        }
      }
      if (badLine !== -1) {
        report(rel, badLine, 'vbs-ascii-no-bom')
      }
    }
  }

  // 5. Zero-leakage static gate on scripts, .github, *.md, *.json, *.vbs
  const extraLeakageFiles = [
    ...walkFiles(path.join(rootDir, 'scripts'), ['.mjs', '.js', '.ts']),
    ...walkFiles(path.join(rootDir, '.github'), ['.yml', '.yaml']),
    ...walkFiles(rootDir, ['.md', '.json', '.vbs']).filter(
      (absPath) => path.basename(absPath) !== 'package-lock.json'
    )
  ]
  const seenExtra = new Set()
  for (const absPath of extraLeakageFiles) {
    const rel = toPosix(path.relative(rootDir, absPath))
    if (seenExtra.has(rel)) continue
    seenExtra.add(rel)

    const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1
      if (hasPersonalPathLeak(line)) {
        report(rel, lineNum, 'no-personal-path')
      }
      if (secretLiteralRe.test(line)) {
        report(rel, lineNum, 'no-secret-literal')
      }
    }
  }

  // 6. popup-close-guard
  const popupWinPath = path.join(rootDir, 'src/main/windows/popupWindow.ts')
  if (fs.existsSync(popupWinPath)) {
    const lines = fs.readFileSync(popupWinPath, 'utf8').split(/\r?\n/)
    const nonCommentLines = lines.filter((l) => !isCommentLine(l.trim()))
    const codeText = nonCommentLines.join('\n')
    if (/['"]close['"]/.test(codeText) && !codeText.includes('isQuitting')) {
      const closeLineIdx = lines.findIndex(
        (l) => !isCommentLine(l.trim()) && /['"]close['"]/.test(l)
      )
      report(
        'src/main/windows/popupWindow.ts',
        closeLineIdx >= 0 ? closeLineIdx + 1 : 1,
        'popup-close-guard'
      )
    }
  }

  return {
    ok: errors.length === 0,
    errors
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isEntrypoint) {
  const result = checkProjectRules(process.cwd())
  if (!result.ok) {
    for (const err of result.errors) {
      console.error(err)
    }
    process.exit(1)
  }
  console.log('[check] OK')
}
