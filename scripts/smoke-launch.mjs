import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')

const ROOT = process.cwd()
const mainEntry = path.join(ROOT, 'out', 'main', 'index.js')

if (!fs.existsSync(mainEntry)) {
  console.error('[smoke] FAIL: out/main/index.js not found. Run npm run build first.')
  process.exit(1)
}

const TIMEOUT_MS = 25000
const childEnv = { ...process.env, ALT_T_SMOKE: '1' }
delete childEnv.FP_SMOKE
delete childEnv.ELECTRON_RUN_AS_NODE

const child = spawn(electronExecutable, ['.'], {
  cwd: ROOT,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
let timedOut = false
let finished = false

child.stdout.on('data', (chunk) => {
  output += chunk.toString('utf8')
})

child.stderr.on('data', (chunk) => {
  output += chunk.toString('utf8')
})

function killChild() {
  if (child.killed) return
  try {
    child.kill('SIGKILL')
  } catch {
    try {
      child.kill()
    } catch {
      // Ignore already exited
    }
  }
}

const timer = setTimeout(() => {
  timedOut = true
  killChild()
}, TIMEOUT_MS)

function handleSignal() {
  killChild()
  process.exit(1)
}

process.once('SIGINT', handleSignal)
process.once('SIGTERM', handleSignal)

child.on('error', (err) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  process.removeListener('SIGINT', handleSignal)
  process.removeListener('SIGTERM', handleSignal)
  console.error('[smoke] FAIL: spawn error:', err)
  if (output.trim() !== '') console.error(output)
  process.exit(1)
})

child.on('close', (code) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  process.removeListener('SIGINT', handleSignal)
  process.removeListener('SIGTERM', handleSignal)

  if (timedOut) {
    console.error(`[smoke] FAIL: timed out after ${TIMEOUT_MS}ms`)
    if (output.trim() !== '') console.error(output)
    process.exit(1)
  }

  if (code === 0 && output.includes('[alt-t] SMOKE_OK')) {
    console.log(output.trim())
    console.log('[smoke] PASS')
    process.exit(0)
  }

  console.error(`[smoke] FAIL: exit code=${String(code)}`)
  if (output.trim() !== '') console.error(output)
  process.exit(1)
})
