import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, type AppConfig } from '../src/shared/types'
import { mergeConfig, shouldLogOriginalTextPreview } from '../src/shared/config'
import { isLoopbackBaseUrl, isLoopbackIp, validateLocalOnlyTarget } from '../src/main/core/baseUrl'
import { createHttp } from '../src/main/providers/httpClient'
import { OpenAICompatibleProvider } from '../src/main/providers/openaiCompatible'
import { translateWithFallback } from '../src/main/providers/fallback'
import { testProviderDraft } from '../src/main/providers/providerTest'
import { createConfigStore } from '../src/main/services/configStore'
import { createTranslateService } from '../src/main/services/translateService'
import { setLoggerDepsForTest } from '../src/main/services/logger'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-t-b2-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  setLoggerDepsForTest(null)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Batch 2 security & privacy (ALT-03 / ALT-04 / ALT-05)', () => {
  it('T06a: validates loopback URLs and blocks external/non-loopback/fallback paths in localOnlyMode', async () => {
    assert.equal(isLoopbackIp('127.0.0.1'), true)
    assert.equal(isLoopbackIp('127.0.0.2'), true)
    assert.equal(isLoopbackIp('::1'), true)
    assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackIp('::ffff:7f00:2'), true)
    assert.equal(isLoopbackIp('192.168.1.1'), false)

    assert.equal(isLoopbackBaseUrl('http://localhost:11434/v1'), true)
    assert.equal(isLoopbackBaseUrl('http://127.0.0.1:11434/v1'), true)
    assert.equal(isLoopbackBaseUrl('http://[::1]:11434/v1'), true)
    assert.equal(isLoopbackBaseUrl('https://api.openai.com/v1'), false)
    assert.equal(isLoopbackBaseUrl('http://localtest.me:11434/v1'), false)
    assert.equal(isLoopbackBaseUrl('http://localhost.:11434/v1'), false)
    assert.equal(isLoopbackBaseUrl('http://user:pass@localhost:11434/v1'), false)

    assert.equal(validateLocalOnlyTarget({ localOnlyMode: true, provider: 'edge' }).ok, false)

    let edgeCalled = 0
    let openaiCalled = 0
    await assert.rejects(
      () =>
        translateWithFallback(
          {
            primary: 'edge',
            enableFallback: true,
            localOnlyMode: true,
            openaiBaseUrl: 'http://127.0.0.1:11434/v1',
            providers: {
              edge: {
                id: 'edge',
                translate: async () => {
                  edgeCalled += 1
                  return 'nope'
                },
                translateStream: async () => 'nope'
              },
              openai: {
                id: 'openai',
                translate: async () => {
                  openaiCalled += 1
                  return 'ok'
                },
                translateStream: async () => 'ok'
              }
            }
          },
          { text: 'hello', to: 'zh-Hans' },
          { stream: false }
        ),
      (err: { info?: { code?: string } }) => err?.info?.code === 'LOCAL_ONLY_BLOCKED'
    )
    assert.equal(edgeCalled, 0)
    assert.equal(openaiCalled, 0)

    // Primary local OpenAI fails -> MUST NOT fall back to Edge when localOnlyMode=true
    await assert.rejects(
      () =>
        translateWithFallback(
          {
            primary: 'openai',
            enableFallback: true,
            localOnlyMode: true,
            openaiBaseUrl: 'http://127.0.0.1:11434/v1',
            providers: {
              edge: {
                id: 'edge',
                translate: async () => {
                  edgeCalled += 1
                  return 'edge fallback'
                },
                translateStream: async () => 'edge fallback'
              },
              openai: {
                id: 'openai',
                translate: async () => {
                  openaiCalled += 1
                  throw new Error('local ollama down')
                },
                translateStream: async () => ''
              }
            }
          },
          { text: 'hello', to: 'zh-Hans' },
          { stream: false }
        ),
      /local ollama down/
    )
    assert.equal(openaiCalled, 1)
    assert.equal(edgeCalled, 0)

    const edgeDraft = await testProviderDraft({
      provider: 'edge',
      localOnlyMode: true,
      openai: DEFAULT_CONFIG.openai,
      proxy: DEFAULT_CONFIG.proxy
    })
    assert.equal(edgeDraft.ok, false)
    assert.equal(edgeDraft.errorCode, 'LOCAL_ONLY_BLOCKED')

    const remoteDraft = await testProviderDraft({
      provider: 'openai',
      localOnlyMode: true,
      openai: { ...DEFAULT_CONFIG.openai, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      proxy: DEFAULT_CONFIG.proxy
    })
    assert.equal(remoteDraft.ok, false)
    assert.equal(remoteDraft.errorCode, 'LOCAL_ONLY_BLOCKED')
  })

  it('T06b: blocks HTTP 3xx redirects and bypasses proxy in localOnlyMode via live loopback server', async () => {
    let mode: 'redirect' | 'ok' = 'redirect'
    const server = http.createServer((_req, res) => {
      if (mode === 'redirect') {
        res.statusCode = 302
        res.setHeader('Location', 'https://example.com/v1/chat/completions')
        res.end()
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: 'local ok' } }] }))
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`

    // Configure an unreachable proxy to verify localOnlyMode bypasses proxy cleanly
    const httpClient = createHttp({
      getProxy: () => ({ enabled: true, url: 'http://127.0.0.1:1' }),
      isLocalOnly: () => true
    })

    const provider = new OpenAICompatibleProvider(
      () => ({
        ...DEFAULT_CONFIG.openai,
        baseUrl,
        apiKey: '',
        stream: false
      }),
      httpClient
    )

    try {
      await assert.rejects(
        () => provider.translate({ text: 'ping', to: 'zh-Hans' }),
        (err: { info?: { code?: string } }) => err?.info?.code === 'LOCAL_ONLY_BLOCKED'
      )

      mode = 'ok'
      const out = await provider.translate({ text: 'ping', to: 'zh-Hans' })
      assert.equal(out, 'local ok')
    } finally {
      httpClient.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('T07: suppresses original text preview logs by default/localOnlyMode and enforces history retention & session-only isolation', async () => {
    assert.equal(DEFAULT_CONFIG.logOriginalTextPreview, false)
    assert.equal(
      shouldLogOriginalTextPreview({ localOnlyMode: true, logOriginalTextPreview: true }),
      false
    )
    assert.equal(
      mergeConfig({ localOnlyMode: true, logOriginalTextPreview: true }).logOriginalTextPreview,
      false
    )

    const logs: string[] = []
    setLoggerDepsForTest({
      getLogDir: () => makeTempDir(),
      console: {
        log: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg)
      }
    })

    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: 'translated' } }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const svc = createTranslateService({
      getConfig: (): AppConfig => ({
        ...DEFAULT_CONFIG,
        primaryProvider: 'openai',
        localOnlyMode: true,
        logOriginalTextPreview: false,
        openai: {
          ...DEFAULT_CONFIG.openai,
          baseUrl: `http://127.0.0.1:${addr.port}/v1`,
          stream: false
        }
      })
    })

    try {
      await svc.translateOnce({ text: 'SUPER_SECRET_PROMPT_123', to: 'zh-Hans' })
      assert.ok(logs.some((line) => line.includes('translateOnce start')))
      assert.equal(logs.some((line) => line.includes('SUPER_SECRET_PROMPT_123')), false)
    } finally {
      svc.disposeAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    // History retention & session-only isolation in configStore
    const dir = makeTempDir()
    let now = 1_700_000_000_000
    const DAY = 86_400_000
    const store = createConfigStore({
      getUserDataDir: () => dir,
      now: () => now,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (b) => b.toString('utf8')
      }
    })

    store.set({
      ...DEFAULT_CONFIG,
      historyEnabled: true,
      historyRetentionDays: 7,
      history: [
        { id: 'fresh', at: now - 2 * DAY, from: 'hi', to: '嗨', provider: 'edge', target: 'zh-Hans' },
        { id: 'expired', at: now - 10 * DAY, from: 'old', to: '旧', provider: 'edge', target: 'zh-Hans' }
      ]
    })
    assert.deepEqual(
      store.get().history.map((h) => h.id),
      ['fresh']
    )

    // Switch to session-only (retention=0): kept in RAM during session, never written to disk even if raised later
    store.set({ ...store.get(), historyRetentionDays: 0, history: [] })
    store.addHistory({
      id: 'ephemeral-1',
      at: now,
      from: 'secret session input',
      to: '会话译文',
      provider: 'edge',
      target: 'zh-Hans'
    })
    assert.equal(store.get().history.length, 1)
    const rawDisk0 = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      history: unknown[]
    }
    assert.equal(rawDisk0.history.length, 0)

    store.set({ ...store.get(), historyRetentionDays: 30 })
    const rawDisk30 = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      history: Array<{ id: string }>
    }
    assert.equal(rawDisk30.history.some((h) => h.id === 'ephemeral-1'), false)
  })

  it('T08: prevents plaintext apiKey writes and preserves ciphertext safely across safeStorage failures', () => {
    const dir = makeTempDir()
    let encryptionAvailable = false
    let decryptThrows = false
    let encryptThrows = false

    const store = createConfigStore({
      getUserDataDir: () => dir,
      safeStorage: {
        isEncryptionAvailable: () => encryptionAvailable,
        encryptString: (s) => {
          if (encryptThrows) throw new Error('DPAPI busy')
          return Buffer.from(`enc:${s}`, 'utf8')
        },
        decryptString: (b) => {
          if (decryptThrows) throw new Error('DPAPI locked')
          const raw = b.toString('utf8')
          return raw.startsWith('enc:') ? raw.slice(4) : raw
        }
      }
    })

    // Case A: Fresh save while encryption unavailable -> memory-only, NO plaintext written
    store.set({
      ...DEFAULT_CONFIG,
      openai: { ...DEFAULT_CONFIG.openai, apiKey: 'sk-fresh-mem-only' }
    })
    assert.equal(store.get().openai.apiKey, 'sk-fresh-mem-only')
    assert.equal(store.getApiKeyPersistence(), 'memory-only')
    const rawA = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(rawA.openai.apiKey, '')
    assert.equal(rawA.openai.encryptedKey, undefined)

    // Case B1: Encrypt cleanly, then fail on unrelated save -> preserve valid encryptedKey
    encryptionAvailable = true
    store.set({
      ...DEFAULT_CONFIG,
      openai: { ...DEFAULT_CONFIG.openai, apiKey: 'sk-real-cipher' }
    })
    assert.equal(store.getApiKeyPersistence(), 'encrypted')
    const rawEnc = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(rawEnc.openai.apiKey, '')
    assert.ok(rawEnc.openai.encryptedKey)

    encryptThrows = true
    store.set({ ...store.get(), defaultTargetLang: 'en' })
    const rawAfterB1 = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(rawAfterB1.openai.apiKey, '')
    assert.equal(rawAfterB1.openai.encryptedKey, rawEnc.openai.encryptedKey)

    // Case B2: Cold load when decrypt fails -> preserve encryptedKey on unrelated save
    encryptThrows = false
    decryptThrows = true
    const reloaded = store.load()
    assert.equal(reloaded.openai.apiKey, '')
    assert.equal(store.hasUnreadableEncryptedKey(), true)
    store.set({ ...reloaded, defaultTargetLang: 'zh-Hans' })
    const rawAfterB2 = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(rawAfterB2.openai.encryptedKey, rawEnc.openai.encryptedKey)

    // Case B3: Enter brand-new key while encryption still unavailable -> do NOT revive stale encryptedKey
    encryptionAvailable = false
    store.set({
      ...store.get(),
      openai: { ...store.get().openai, apiKey: 'sk-new-key-unpersisted' }
    })
    const rawAfterB3 = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(rawAfterB3.openai.apiKey, '')
    assert.equal(rawAfterB3.openai.encryptedKey, undefined)

    // Case C: Explicit clear wipes both memory and disk ciphertext
    encryptionAvailable = true
    decryptThrows = false
    store.set({
      ...DEFAULT_CONFIG,
      openai: { ...DEFAULT_CONFIG.openai, apiKey: 'sk-to-clear' }
    })
    store.set({
      ...store.get(),
      openai: { ...store.get().openai, apiKey: '' }
    })
    const rawAfterC = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(store.getApiKeyPersistence(), 'empty')
    assert.equal(rawAfterC.openai.apiKey, '')
    assert.equal(rawAfterC.openai.encryptedKey, undefined)

    // Case D: Linux basic_text backend treated as unavailable (memory-only, no plaintext)
    const dirBasic = makeTempDir()
    const basicStore = createConfigStore({
      getUserDataDir: () => dirBasic,
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'basic_text',
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (b) => b.toString('utf8')
      }
    })
    basicStore.set({
      ...DEFAULT_CONFIG,
      openai: { ...DEFAULT_CONFIG.openai, apiKey: 'sk-linux-basic' }
    })
    assert.equal(basicStore.getApiKeyPersistence(), 'memory-only')
    const rawBasic = JSON.parse(fs.readFileSync(path.join(dirBasic, 'config.json'), 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(rawBasic.openai.apiKey, '')
    assert.equal(rawBasic.openai.encryptedKey, undefined)
  })

  it('T08b (P2): immediately scrubs legacy plaintext apiKey on load across safeStorage unavailable, encrypt error, ciphertext preservation, and read-only failures', () => {
    // 1) Legacy plaintext + safeStorage unavailable -> keeps key in RAM only and scrubs disk immediately
    const dirUnavail = makeTempDir()
    const fileUnavail = path.join(dirUnavail, 'config.json')
    fs.writeFileSync(fileUnavail, JSON.stringify({ openai: { apiKey: 'sk-legacy-unavail' } }), 'utf8')
    const storeUnavail = createConfigStore({
      getUserDataDir: () => dirUnavail,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
        decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
      }
    })
    const loadedUnavail = storeUnavail.load()
    assert.equal(loadedUnavail.openai.apiKey, 'sk-legacy-unavail')
    assert.equal(storeUnavail.getApiKeyPersistence(), 'memory-only')
    assert.equal(storeUnavail.hasPlaintextOnDiskRisk?.(), false)
    const diskUnavail = JSON.parse(fs.readFileSync(fileUnavail, 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(diskUnavail.openai.apiKey, '')
    assert.equal(diskUnavail.openai.encryptedKey, undefined)

    // 2) Legacy plaintext + pre-existing encryptedKey + safeStorage unavailable -> scrubs plaintext while preserving ciphertext
    const dirBoth = makeTempDir()
    const fileBoth = path.join(dirBoth, 'config.json')
    const oldCipher = Buffer.from('enc:sk-legacy-both', 'utf8').toString('base64')
    fs.writeFileSync(
      fileBoth,
      JSON.stringify({ openai: { apiKey: 'sk-legacy-both', encryptedKey: oldCipher } }),
      'utf8'
    )
    const storeBoth = createConfigStore({
      getUserDataDir: () => dirBoth,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
        decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
      }
    })
    const loadedBoth = storeBoth.load()
    assert.equal(loadedBoth.openai.apiKey, 'sk-legacy-both')
    const diskBoth = JSON.parse(fs.readFileSync(fileBoth, 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(diskBoth.openai.apiKey, '')
    assert.equal(diskBoth.openai.encryptedKey, oldCipher)

    // 3) Legacy plaintext + encryptString throws -> still scrubs plaintext on load (memory-only)
    const dirThrow = makeTempDir()
    const fileThrow = path.join(dirThrow, 'config.json')
    fs.writeFileSync(fileThrow, JSON.stringify({ openai: { apiKey: 'sk-legacy-throw' } }), 'utf8')
    const storeThrow = createConfigStore({
      getUserDataDir: () => dirThrow,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: () => {
          throw new Error('DPAPI encrypt failed')
        },
        decryptString: (b) => b.toString('utf8')
      }
    })
    const loadedThrow = storeThrow.load()
    assert.equal(loadedThrow.openai.apiKey, 'sk-legacy-throw')
    assert.equal(storeThrow.getApiKeyPersistence(), 'memory-only')
    const diskThrow = JSON.parse(fs.readFileSync(fileThrow, 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(diskThrow.openai.apiKey, '')
    assert.equal(diskThrow.openai.encryptedKey, undefined)

    // 4) Legacy plaintext + safeStorage available -> encrypts cleanly on load and removes plaintext
    const dirAvail = makeTempDir()
    const fileAvail = path.join(dirAvail, 'config.json')
    fs.writeFileSync(fileAvail, JSON.stringify({ openai: { apiKey: 'sk-legacy-ok' } }), 'utf8')
    const storeAvail = createConfigStore({
      getUserDataDir: () => dirAvail,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
        decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
      }
    })
    const loadedAvail = storeAvail.load()
    assert.equal(loadedAvail.openai.apiKey, 'sk-legacy-ok')
    assert.equal(storeAvail.getApiKeyPersistence(), 'encrypted')
    const diskAvail = JSON.parse(fs.readFileSync(fileAvail, 'utf8')) as {
      openai: { apiKey: string; encryptedKey?: string }
    }
    assert.equal(diskAvail.openai.apiKey, '')
    assert.ok(diskAvail.openai.encryptedKey)

    // 5) Read-only write failure during load migration flags plaintext-on-disk risk cleanly
    const dirRo = makeTempDir()
    const fileRo = path.join(dirRo, 'config.json')
    fs.writeFileSync(fileRo, JSON.stringify({ openai: { apiKey: 'sk-legacy-ro' } }), 'utf8')
    const storeRo = createConfigStore({
      getUserDataDir: () => dirRo,
      fs: {
        ...fs,
        writeFileSync: () => {
          const err = new Error('EACCES read-only') as NodeJS.ErrnoException
          err.code = 'EACCES'
          throw err
        }
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => ''
      }
    })
    const loadedRo = storeRo.load()
    assert.equal(loadedRo.openai.apiKey, 'sk-legacy-ro')
    assert.equal(storeRo.hasPlaintextOnDiskRisk?.(), true)
  })
})
