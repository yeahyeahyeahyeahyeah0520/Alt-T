import { fetch, ProxyAgent, type Dispatcher, type Response } from 'undici'
import { ProviderError, type ProviderId, type ProxyConfig } from '../../shared/types'
import { redactSecretsInText } from '../core/redact'

export class TimeoutMarker extends Error {
  constructor(message = 'Request timed out') {
    super(message)
    this.name = 'TimeoutMarker'
  }
}

export class AbortMarker extends Error {
  constructor(message = 'Request aborted') {
    super(message)
    this.name = 'AbortMarker'
  }
}

export interface HttpDeps {
  getProxy: () => ProxyConfig
}

export interface HttpRequestInit {
  method: 'POST' | 'GET'
  headers?: Record<string, string>
  body?: string
  signal: AbortSignal
  provider?: ProviderId
}

export interface HttpClient {
  request(url: string, init: HttpRequestInit): Promise<Response>
  dispose(): void
}

export function createLinkedAbort(externalSignal?: AbortSignal): {
  controller: AbortController
  cleanup: () => void
} {
  const controller = new AbortController()
  if (!externalSignal) {
    return { controller, cleanup: () => {} }
  }

  const onAbort = (): void => {
    const reason =
      externalSignal.reason instanceof TimeoutMarker
        ? externalSignal.reason
        : new AbortMarker()
    if (!controller.signal.aborted) {
      controller.abort(reason)
    }
  }

  if (externalSignal.aborted) {
    onAbort()
    return { controller, cleanup: () => {} }
  }

  externalSignal.addEventListener('abort', onAbort, { once: true })
  return {
    controller,
    cleanup: () => {
      externalSignal.removeEventListener('abort', onAbort)
    }
  }
}

export function mapFetchError(
  err: unknown,
  provider: ProviderId,
  signal?: AbortSignal,
  secret?: string
): ProviderError {
  if (err instanceof ProviderError) {
    const scrubbed = redactSecretsInText(err.info.message, secret)
    if (err.info.provider === provider && scrubbed === err.info.message) {
      return err
    }
    return new ProviderError({
      ...err.info,
      provider,
      message: scrubbed
    })
  }

  if (err instanceof TimeoutMarker || signal?.reason instanceof TimeoutMarker) {
    return new ProviderError({
      code: 'TIMEOUT',
      provider,
      message: 'Request timed out',
      retryable: true
    })
  }

  if (err instanceof AbortMarker || signal?.reason instanceof AbortMarker || signal?.aborted) {
    return new ProviderError({
      code: 'ABORTED',
      provider,
      message: 'Request aborted',
      retryable: false
    })
  }

  const rawMsg = err instanceof Error ? err.message : String(err)
  return new ProviderError({
    code: 'NETWORK',
    provider,
    message: redactSecretsInText(rawMsg, secret),
    retryable: true
  })
}

export function sanitizeHttpErrorSnippet(bodyText: string, secret?: string): string {
  const singleLine = bodyText.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
  return redactSecretsInText(singleLine, secret)
}

export function createHttp(deps: HttpDeps): HttpClient {
  let cachedProxyUrl = ''
  let cachedAgent: ProxyAgent | null = null

  function closeCachedAgent(): void {
    if (cachedAgent) {
      const prev = cachedAgent
      cachedAgent = null
      cachedProxyUrl = ''
      void prev.close().catch(() => {})
    }
  }

  function resolveDispatcher(provider: ProviderId = 'openai'): Dispatcher | undefined {
    const proxy = deps.getProxy()
    const rawUrl = proxy.url.trim()
    if (!proxy.enabled || rawUrl === '') {
      closeCachedAgent()
      return undefined
    }

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new ProviderError({
        code: 'CONFIG',
        provider,
        message: 'Invalid proxy URL',
        retryable: true
      })
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ProviderError({
        code: 'CONFIG',
        provider,
        message: `Unsupported proxy protocol: ${parsed.protocol}`,
        retryable: true
      })
    }

    if (cachedAgent && cachedProxyUrl === rawUrl) {
      return cachedAgent
    }

    closeCachedAgent()
    cachedAgent = new ProxyAgent(rawUrl)
    cachedProxyUrl = rawUrl
    return cachedAgent
  }

  async function request(url: string, init: HttpRequestInit): Promise<Response> {
    const dispatcher = resolveDispatcher(init.provider)
    return fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      dispatcher,
      signal: init.signal
    })
  }

  function dispose(): void {
    closeCachedAgent()
  }

  return { request, dispose }
}
