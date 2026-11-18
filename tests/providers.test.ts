import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import { createHttp } from '../src/main/providers/httpClient'
import { OpenAICompatibleProvider } from '../src/main/providers/openaiCompatible'
import { EdgeDirectProvider } from '../src/main/providers/edgeDirect'
import { translateWithFallback } from '../src/main/providers/fallback'
import { createTranslateService } from '../src/main/services/translateService'
import {
  DEFAULT_CONFIG,
  ProviderError,
  type AppConfig,
  type OpenAIProviderConfig,
  type ProxyConfig,
  type TranslateProvider
} from '../src/shared/types'

interface MockServerHandle {
  url: string
  port: number
  close: () => Promise<void>
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<MockServerHandle> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind local mock server')
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    if (fn) await fn()
  }
})

function makeOpenAICfg(baseUrl: string, overrides?: Partial<OpenAIProviderConfig>): OpenAIProviderConfig {
  return {
    ...DEFAULT_CONFIG.openai,
    baseUrl,
    apiKey: 'fp-mock-token-12345',
    model: 'gpt-4o-mini',
    ...overrides
  }
}

describe('OpenAICompatibleProvider (local node:http mock)', () => {
  it('translates non-stream and normalizes base URL lacking /v1', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let seenBody = ''

    const srv = await startServer(async (req, res) => {
      seenUrl = req.url ?? ''
      seenAuth = req.headers.authorization ?? ''
      seenBody = await readBody(req)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '你好，世界' } }] }))
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const provider = new OpenAICompatibleProvider(() => makeOpenAICfg(srv.url), httpClient)
    const result = await provider.translate({ text: 'hello world', to: 'zh-Hans' })

    assert.equal(result, '你好，世界')
    assert.equal(seenUrl, '/v1/chat/completions')
    assert.equal(seenAuth, 'Bearer fp-mock-token-12345')
    const parsedBody = JSON.parse(seenBody) as { stream: boolean; model: string }
    assert.equal(parsedBody.stream, false)
    assert.equal(parsedBody.model, 'gpt-4o-mini')
  })

  it('streams SSE with multi-byte UTF-8 Chinese characters split across byte boundaries', async () => {
    const srv = await startServer(async (_req, res) => {
      await readBody(_req)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache'
      })

      const fullSse =
        `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: '世界！' } }] })}\n\n` +
        'data: [DONE]\n\n' +
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'IGNORED_AFTER_DONE' } }] })}\n\n`

      const bytes = Buffer.from(fullSse, 'utf8')
      // Split into tiny 3-byte slices to force multi-byte UTF-8 characters across chunk boundaries
      let offset = 0
      const step = 3
      const timer = setInterval(() => {
        if (offset >= bytes.length) {
          clearInterval(timer)
          res.end()
          return
        }
        res.write(bytes.subarray(offset, offset + step))
        offset += step
      }, 2)
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const provider = new OpenAICompatibleProvider(() => makeOpenAICfg(srv.url), httpClient)
    const deltas: string[] = []
    const text = await provider.translateStream(
      { text: 'hello world!', to: 'zh-Hans' },
      (d) => deltas.push(d)
    )

    assert.deepEqual(deltas, ['你好', '世界！'])
    assert.equal(text, '你好世界！')
  })

  it('times out non-stream request when server delays beyond nonStreamTimeoutMs', async () => {
    const srv = await startServer((_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }))
        }
      }, 600)
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const provider = new OpenAICompatibleProvider(() => makeOpenAICfg(srv.url), httpClient, {
      nonStreamTimeoutMs: 150
    })

    await assert.rejects(
      () => provider.translate({ text: 'hello', to: 'zh-Hans' }),
      (err: unknown) =>
        err instanceof ProviderError &&
        err.info.code === 'TIMEOUT' &&
        err.info.retryable === true &&
        err.info.provider === 'openai'
    )
  })

  it('times out stream when headers arrive but first token stalls beyond firstTokenTimeoutMs', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': keep-alive\n\n')
      // Never send any content delta
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const provider = new OpenAICompatibleProvider(() => makeOpenAICfg(srv.url), httpClient, {
      firstTokenTimeoutMs: 150,
      idleTimeoutMs: 150
    })

    await assert.rejects(
      () => provider.translateStream({ text: 'hello', to: 'zh-Hans' }, () => {}),
      (err: unknown) =>
        err instanceof ProviderError && err.info.code === 'TIMEOUT' && err.info.retryable === true
    )
  })

  it('maps HTTP 500 and 401 to retryable HTTP error and never leaks apiKey in message', async () => {
    const secret = 'fp-super-secret-xyz-999'
    let statusToSend = 500

    const srv = await startServer((_req, res) => {
      res.writeHead(statusToSend, { 'Content-Type': 'text/plain' })
      res.end(`server error echoing ${secret}`)
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const provider = new OpenAICompatibleProvider(
      () => makeOpenAICfg(srv.url, { apiKey: secret }),
      httpClient
    )

    for (const expectedStatus of [500, 401]) {
      statusToSend = expectedStatus
      await assert.rejects(
        () => provider.translate({ text: 'hello', to: 'zh-Hans' }),
        (err: unknown) =>
          err instanceof ProviderError &&
          err.info.code === 'HTTP' &&
          err.info.status === expectedStatus &&
          err.info.retryable === true &&
          !err.info.message.includes(secret)
      )
    }
  })
})

describe('EdgeDirectProvider (local node:http mock)', () => {
  it('translates text using Edge POST format and supports translateStream fallback', async () => {
    let seenPath = ''
    let seenBody = ''

    const srv = await startServer(async (req, res) => {
      seenPath = req.url ?? ''
      seenBody = await readBody(req)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            detectedLanguage: { language: 'en', score: 1.0 },
            translations: [{ text: '你好，世界', to: 'zh-Hans' }]
          }
        ])
      )
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const edge = new EdgeDirectProvider(httpClient, { endpoint: `${srv.url}/translate/translatetext` })
    const deltas: string[] = []
    const out = await edge.translateStream({ text: 'hello world', to: 'zh-Hans' }, (d) => deltas.push(d))

    assert.equal(seenPath, '/translate/translatetext?to=zh-Hans&isEnterpriseClient=false')
    assert.equal(seenBody, JSON.stringify(['hello world']))
    assert.equal(out, '你好，世界')
    assert.deepEqual(deltas, ['你好，世界'])
  })

  it('throws PARSE on malformed JSON from Edge', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{not valid json')
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const edge = new EdgeDirectProvider(httpClient, { endpoint: `${srv.url}/translate/translatetext` })
    await assert.rejects(
      () => edge.translate({ text: 'hello', to: 'zh-Hans' }),
      (err: unknown) => err instanceof ProviderError && err.info.code === 'PARSE'
    )
  })

  it('throws PARSE on empty input from Edge without making HTTP request', async () => {
    let requestCount = 0
    const srv = await startServer((_req, res) => {
      requestCount++
      res.writeHead(200)
      res.end('[]')
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const edge = new EdgeDirectProvider(httpClient, { endpoint: `${srv.url}/translate/translatetext` })
    await assert.rejects(
      () =>
        edge.translate({
          text: '   ',
          to: 'zh-Hans'
        }),
      (err: unknown) =>
        err instanceof ProviderError &&
        err.info.code === 'PARSE' &&
        err.info.retryable === true
    )
    assert.equal(requestCount, 0)
  })
})

describe('translateWithFallback', () => {
  it('falls back from failing primary openai (500) to edge', async () => {
    const srv = await startServer(async (req, res) => {
      await readBody(req)
      if ((req.url ?? '').includes('/chat/completions')) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('boom')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{ translations: [{ text: '备源译文', to: 'zh-Hans' }] }]))
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const openai = new OpenAICompatibleProvider(() => makeOpenAICfg(srv.url), httpClient)
    const edge = new EdgeDirectProvider(httpClient, { endpoint: `${srv.url}/translatetext` })

    const res = await translateWithFallback(
      { providers: { openai, edge }, primary: 'openai', enableFallback: true },
      { text: 'hello', to: 'zh-Hans' },
      { stream: false }
    )

    assert.equal(res.text, '备源译文')
    assert.equal(res.provider, 'edge')
    assert.equal(res.usedFallback, true)
    assert.equal(res.primaryError?.code, 'HTTP')
    assert.equal(res.primaryError?.status, 500)
  })

  it('does not fallback when enableFallback is false', async () => {
    let edgeCalls = 0
    const openai: TranslateProvider = {
      id: 'openai',
      async translate() {
        throw new ProviderError({
          code: 'HTTP',
          provider: 'openai',
          status: 500,
          message: 'fail',
          retryable: true
        })
      },
      async translateStream() {
        throw new Error('unused')
      }
    }
    const edge: TranslateProvider = {
      id: 'edge',
      async translate() {
        edgeCalls++
        return 'ok'
      },
      async translateStream() {
        edgeCalls++
        return 'ok'
      }
    }

    await assert.rejects(
      () =>
        translateWithFallback(
          { providers: { openai, edge }, primary: 'openai', enableFallback: false },
          { text: 'hello', to: 'zh-Hans' },
          { stream: false }
        ),
      (err: unknown) => err instanceof ProviderError && err.info.provider === 'openai'
    )
    assert.equal(edgeCalls, 0)
  })

  it('does not fallback in stream mode if primary already emitted at least one delta', async () => {
    let edgeCalls = 0
    const openai: TranslateProvider = {
      id: 'openai',
      async translate() {
        return ''
      },
      async translateStream(_req, onDelta) {
        onDelta('partial')
        throw new ProviderError({
          code: 'NETWORK',
          provider: 'openai',
          message: 'connection reset',
          retryable: true
        })
      }
    }
    const edge: TranslateProvider = {
      id: 'edge',
      async translate() {
        edgeCalls++
        return 'fallback'
      },
      async translateStream() {
        edgeCalls++
        return 'fallback'
      }
    }

    const received: string[] = []
    await assert.rejects(
      () =>
        translateWithFallback(
          { providers: { openai, edge }, primary: 'openai', enableFallback: true },
          { text: 'hello', to: 'zh-Hans' },
          { stream: true, onDelta: (d) => received.push(d) }
        ),
      (err: unknown) => err instanceof ProviderError && err.info.message === 'connection reset'
    )
    assert.deepEqual(received, ['partial'])
    assert.equal(edgeCalls, 0)
  })

  it('returns ABORTED and never falls back when signal is aborted', async () => {
    const ac = new AbortController()
    let edgeCalls = 0

    const srv = await startServer((_req, _res) => {
      ac.abort()
    })
    cleanups.push(srv.close)

    const httpClient = createHttp({ getProxy: () => ({ enabled: false, url: '' }) })
    cleanups.push(() => httpClient.dispose())

    const openai = new OpenAICompatibleProvider(() => makeOpenAICfg(srv.url), httpClient)
    const edge: TranslateProvider = {
      id: 'edge',
      async translate() {
        edgeCalls++
        return 'should-not-run'
      },
      async translateStream() {
        edgeCalls++
        return 'should-not-run'
      }
    }

    await assert.rejects(
      () =>
        translateWithFallback(
          { providers: { openai, edge }, primary: 'openai', enableFallback: true },
          { text: 'hello', to: 'zh-Hans' },
          { stream: false },
          ac.signal
        ),
      (err: unknown) =>
        err instanceof ProviderError &&
        err.info.code === 'ABORTED' &&
        err.info.retryable === false
    )
    assert.equal(edgeCalls, 0)
  })

  it('combines primary and secondary errors when both fail', async () => {
    const openai: TranslateProvider = {
      id: 'openai',
      async translate() {
        throw new ProviderError({
          code: 'HTTP',
          provider: 'openai',
          status: 502,
          message: 'bad gateway',
          retryable: true
        })
      },
      async translateStream() {
        return ''
      }
    }
    const edge: TranslateProvider = {
      id: 'edge',
      async translate() {
        throw new ProviderError({
          code: 'TIMEOUT',
          provider: 'edge',
          message: 'Request timed out',
          retryable: true
        })
      },
      async translateStream() {
        return ''
      }
    }

    await assert.rejects(
      () =>
        translateWithFallback(
          { providers: { openai, edge }, primary: 'openai', enableFallback: true },
          { text: 'hello', to: 'zh-Hans' },
          { stream: false }
        ),
      (err: unknown) =>
        err instanceof ProviderError &&
        err.info.provider === 'edge' &&
        err.info.code === 'TIMEOUT' &&
        err.info.message.includes('主源(openai): bad gateway') &&
        err.info.message.includes('备用源(edge): Request timed out')
    )
  })
})

describe('ProxyAgent routing & TranslateService', () => {
  it('routes requests through local HTTP proxy (CONNECT or absolute URI) when proxy is enabled', async () => {
    const targetSrv = await startServer(async (_req, res) => {
      await readBody(_req)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{ translations: [{ text: '经代理成功', to: 'zh-Hans' }] }]))
    })
    cleanups.push(targetSrv.close)

    let sawConnect = false
    let sawAbsoluteUri = false

    const proxyServer = http.createServer(async (req, res) => {
      const reqUrl = req.url ?? ''
      if (reqUrl.startsWith('http://') || reqUrl.startsWith('https://')) {
        sawAbsoluteUri = true
      }
      const body = await readBody(req)
      const forwardReq = http.request(
        reqUrl,
        {
          method: req.method,
          headers: req.headers
        },
        (forwardRes) => {
          res.writeHead(forwardRes.statusCode ?? 502, forwardRes.headers)
          forwardRes.pipe(res)
        }
      )
      forwardReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      forwardReq.end(body)
    })

    proxyServer.on('connect', (req, clientSocket, head) => {
      sawConnect = true
      const [host, portStr] = (req.url ?? '').split(':')
      const port = Number(portStr) || 80
      const serverSocket = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) serverSocket.write(head)
        serverSocket.pipe(clientSocket)
        clientSocket.pipe(serverSocket)
      })
      serverSocket.on('error', () => clientSocket.destroy())
    })

    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(async () => {
      proxyServer.closeAllConnections?.()
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()))
    })
    const proxyAddr = proxyServer.address()
    if (!proxyAddr || typeof proxyAddr === 'string') {
      throw new Error('Failed to bind local proxy server')
    }

    const proxyCfg: ProxyConfig = {
      enabled: true,
      url: `http://127.0.0.1:${proxyAddr.port}`
    }
    const httpClient = createHttp({ getProxy: () => proxyCfg })
    cleanups.push(() => httpClient.dispose())

    const edge = new EdgeDirectProvider(httpClient, {
      endpoint: `${targetSrv.url}/translate/translatetext`
    })
    const out = await edge.translate({ text: 'proxy test', to: 'zh-Hans' })

    assert.equal(out, '经代理成功')
    assert.equal(sawConnect || sawAbsoluteUri, true)
  })

  it('rejects invalid proxy URL with CONFIG error', async () => {
    const httpClient = createHttp({
      getProxy: () => ({ enabled: true, url: 'not-a-valid-proxy-url' })
    })
    cleanups.push(() => httpClient.dispose())

    const edge = new EdgeDirectProvider(httpClient, {
      endpoint: 'http://127.0.0.1:1/unused'
    })
    await assert.rejects(
      () => edge.translate({ text: 'hello', to: 'zh-Hans' }),
      (err: unknown) => err instanceof ProviderError && err.info.code === 'CONFIG'
    )
  })

  it('translateService supports translateStream and cancels active request silently', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\n\n`)
      setTimeout(() => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'B' } }] })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }, 250)
    })
    cleanups.push(srv.close)

    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      primaryProvider: 'openai',
      enableFallback: false,
      openai: makeOpenAICfg(srv.url)
    }

    const svc = createTranslateService({ getConfig: () => cfg })
    cleanups.push(() => svc.disposeAll())

    const chunks: string[] = []
    let doneCount = 0
    let errorCount = 0

    await new Promise<void>((resolve) => {
      svc.translateStream(
        'req-1',
        { text: 'hello', to: 'zh-Hans' },
        {
          onChunk: (d) => {
            chunks.push(d)
            svc.cancel('req-1')
            setTimeout(resolve, 350)
          },
          onDone: () => {
            doneCount++
          },
          onError: () => {
            errorCount++
          }
        }
      )
    })

    assert.deepEqual(chunks, ['A'])
    assert.equal(doneCount, 0)
    assert.equal(errorCount, 0)
  })
})
