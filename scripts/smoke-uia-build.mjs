import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = process.cwd()
const mainDir = path.join(root, 'out', 'main')
const chunksDir = path.join(mainDir, 'chunks')

const workerEntry = path.join(mainDir, 'win32UiaWorker.js')
assert.equal(fs.existsSync(workerEntry), true, `Missing built UIA worker: ${workerEntry}`)

function findBuiltUiaChunk() {
  assert.equal(fs.existsSync(chunksDir), true, `Missing main chunks directory: ${chunksDir}`)
  for (const file of fs.readdirSync(chunksDir)) {
    if (!file.endsWith('.js')) continue
    const candidate = path.join(chunksDir, file)
    const mod = require(candidate)
    if (
      typeof mod?.probeFocusedIdeRegion === 'function' &&
      typeof mod?.shutdownWin32UiaWorker === 'function'
    ) {
      return { path: candidate, mod }
    }
  }
  throw new Error(`Could not locate built win32Uia chunk in ${chunksDir}`)
}

const { path: loadedPath, mod: builtUia } = findBuiltUiaChunk()
const logs = []
builtUia.setUiaWarnLogger((msg) => logs.push(msg))

try {
  const res = await builtUia.probeFocusedIdeRegion(0, 'Code.exe', { timeoutMs: 3000 })
  assert.equal(
    logs.some((m) => m.includes('Cannot find module')),
    false,
    `Unexpected worker module error: ${logs.join('; ')}`
  )
  assert.notEqual(
    res.reason,
    'uia-error',
    `Built UIA worker failed with uia-error (${loadedPath}): ${logs.join('; ')}`
  )
  if (process.platform === 'win32') {
    assert.equal(res.reason, 'uia-empty')
  }
  console.log(`[smoke-uia-build] PASS (${path.relative(root, loadedPath)} -> ${res.reason})`)
} finally {
  await builtUia.shutdownWin32UiaWorker()
  builtUia.setUiaWarnLogger(null)
}
