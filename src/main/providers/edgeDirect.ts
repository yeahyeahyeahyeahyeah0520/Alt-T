import { isRecord } from '../../shared/config'
import {
  ProviderError,
  type ProviderId,
  type ProviderRequest,
  type TranslateProvider
} from '../../shared/types'
import {
  createLinkedAbort,
  mapFetchError,
  sanitizeHttpErrorSnippet,
  TimeoutMarker,
  type HttpClient
} from './httpClient'

const DEFAULT_EDGE_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'
const DEFAULT_EDGE_AUTH_ENDPOINT = 'https://edge.microsoft.com/translate/auth'
const DEFAULT_EDGE_COGNITIVE_ENDPOINT =
  'https://api-edge.cognitive.microsofttranslator.com/translate'
const DEFAULT_EDGE_TIMEOUT_MS = 8000
const DEFAULT_TOKEN_TTL_MS = 8 * 60 * 1000
const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000

export interface EdgeProviderOptions {
  endpoint?: string
  authEndpoint?: string
  cognitiveEndpoint?: string
  timeoutMs?: number
  enableAuthFallback?: boolean
}

function extractEdgeText(json: unknown): string {
  if (!Array.isArray(json) || json.length === 0) {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'edge',
      message: 'Edge response is not a non-empty array',
      retryable: true
    })
  }

  const first = json[0]
  if (!isRecord(first) || !Array.isArray(first.translations) || first.translations.length === 0) {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'edge',
      message: 'Missing translations in Edge response',
      retryable: true
    })
  }

  const firstTranslation = first.translations[0]
  if (!isRecord(firstTranslation) || typeof firstTranslation.text !== 'string') {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'edge',
      message: 'Missing translation text in Edge response',
      retryable: true
    })
  }

  if (firstTranslation.text === '') {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'edge',
      message: 'Empty translation text in Edge response',
      retryable: true
    })
  }

  return firstTranslation.text
}

function parseJwtExpiresAt(token: string, nowMs: number): number {
  const parts = token.split('.')
  if (parts.length === 3) {
    try {
      const payloadRaw = Buffer.from(parts[1], 'base64url').toString('utf8')
      const payload: unknown = JSON.parse(payloadRaw)
      if (isRecord(payload) && typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
        const expMs = payload.exp * 1000 - TOKEN_EXPIRY_SAFETY_MS
        if (expMs > nowMs) {
          return expMs
        }
      }
    } catch {
      // Fall back to default TTL
    }
  }
  return nowMs + DEFAULT_TOKEN_TTL_MS
}

function shouldAttemptAuthFallback(err: ProviderError): boolean {
  if (err.info.code === 'ABORTED' || err.info.code === 'CONFIG') {
    return false
  }
  if (err.info.code === 'HTTP') {
    const status = err.info.status ?? 0
    return status === 401 || status === 403 || status === 429 || status >= 500
  }
  return err.info.code === 'PARSE'
}

export class EdgeDirectProvider implements TranslateProvider {
  readonly id: ProviderId = 'edge'
  private readonly endpoint: string
  private readonly authEndpoint: string | null
  private readonly cognitiveEndpoint: string | null
  private readonly timeoutMs: number
  private cachedToken: { token: string; expiresAt: number } | null = null

  constructor(
    private readonly http: HttpClient,
    opts?: EdgeProviderOptions
  ) {
    this.endpoint = opts?.endpoint ?? DEFAULT_EDGE_ENDPOINT
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_EDGE_TIMEOUT_MS

    const customPrimaryWithoutSecondary =
      opts?.endpoint !== undefined &&
      opts?.authEndpoint === undefined &&
      opts?.cognitiveEndpoint === undefined
    const allowFallback =
      opts?.enableAuthFallback ?? !customPrimaryWithoutSecondary

    this.authEndpoint = allowFallback ? (opts?.authEndpoint ?? DEFAULT_EDGE_AUTH_ENDPOINT) : null
    this.cognitiveEndpoint = allowFallback
      ? (opts?.cognitiveEndpoint ?? DEFAULT_EDGE_COGNITIVE_ENDPOINT)
      : null
  }

  private async translateDirectEndpoint(
    req: ProviderRequest,
    signal: AbortSignal
  ): Promise<string> {
    const sep = this.endpoint.includes('?') ? '&' : '?'
    const url = `${this.endpoint}${sep}to=${encodeURIComponent(req.to)}&isEnterpriseClient=false`

    const res = await this.http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([req.text]),
      signal,
      provider: this.id
    })

    if (!res.ok) {
      const errBody = await res.text()
      const snippet = sanitizeHttpErrorSnippet(errBody)
      throw new ProviderError({
        code: 'HTTP',
        provider: this.id,
        status: res.status,
        message: `HTTP ${res.status}: ${snippet}`,
        retryable: true
      })
    }

    const rawText = await res.text()
    let json: unknown
    try {
      json = JSON.parse(rawText)
    } catch {
      throw new ProviderError({
        code: 'PARSE',
        provider: this.id,
        message: 'Invalid JSON response from Edge translator',
        retryable: true
      })
    }

    return extractEdgeText(json)
  }

  private async getAuthToken(signal: AbortSignal, forceRefresh: boolean): Promise<string> {
    if (!this.authEndpoint) {
      throw new ProviderError({
        code: 'CONFIG',
        provider: this.id,
        message: 'Edge auth fallback endpoint not configured',
        retryable: false
      })
    }
    const now = Date.now()
    if (!forceRefresh && this.cachedToken !== null && now < this.cachedToken.expiresAt) {
      return this.cachedToken.token
    }

    const res = await this.http.request(this.authEndpoint, {
      method: 'GET',
      signal,
      provider: this.id
    })
    if (!res.ok) {
      const errBody = await res.text()
      const snippet = sanitizeHttpErrorSnippet(errBody)
      throw new ProviderError({
        code: 'HTTP',
        provider: this.id,
        status: res.status,
        message: `Edge auth HTTP ${res.status}: ${snippet}`,
        retryable: true
      })
    }
    const token = (await res.text()).trim()
    if (token === '') {
      throw new ProviderError({
        code: 'PARSE',
        provider: this.id,
        message: 'Empty token from Edge auth endpoint',
        retryable: true
      })
    }
    this.cachedToken = {
      token,
      expiresAt: parseJwtExpiresAt(token, now)
    }
    return token
  }

  private async translateCognitiveEndpoint(
    req: ProviderRequest,
    signal: AbortSignal,
    forceRefreshToken = false
  ): Promise<string> {
    if (!this.cognitiveEndpoint) {
      throw new ProviderError({
        code: 'CONFIG',
        provider: this.id,
        message: 'Edge cognitive fallback endpoint not configured',
        retryable: false
      })
    }
    const hadCachedToken = !forceRefreshToken && this.cachedToken !== null
    const token = await this.getAuthToken(signal, forceRefreshToken)
    const sep = this.cognitiveEndpoint.includes('?') ? '&' : '?'
    const url = `${this.cognitiveEndpoint}${sep}from=&to=${encodeURIComponent(req.to)}&api-version=3.0&includeSentenceLength=true`

    const res = await this.http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify([{ Text: req.text }]),
      signal,
      provider: this.id
    })

    if (res.status === 401 && hadCachedToken) {
      this.cachedToken = null
      return this.translateCognitiveEndpoint(req, signal, true)
    }

    if (!res.ok) {
      const errBody = await res.text()
      const snippet = sanitizeHttpErrorSnippet(errBody, token)
      throw new ProviderError({
        code: 'HTTP',
        provider: this.id,
        status: res.status,
        message: `HTTP ${res.status}: ${snippet}`,
        retryable: true
      })
    }

    const rawText = await res.text()
    let json: unknown
    try {
      json = JSON.parse(rawText)
    } catch {
      throw new ProviderError({
        code: 'PARSE',
        provider: this.id,
        message: 'Invalid JSON response from Edge cognitive translator',
        retryable: true
      })
    }

    return extractEdgeText(json)
  }

  async translate(req: ProviderRequest, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new ProviderError({
        code: 'ABORTED',
        provider: this.id,
        message: 'Request aborted',
        retryable: false
      })
    }

    if (req.text.trim() === '') {
      throw new ProviderError({
        code: 'PARSE',
        provider: this.id,
        message: 'empty input',
        retryable: true
      })
    }

    const { controller, cleanup } = createLinkedAbort(signal)
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new TimeoutMarker())
      }
    }, this.timeoutMs)

    try {
      try {
        return await this.translateDirectEndpoint(req, controller.signal)
      } catch (primaryErr) {
        const mappedPrimary = mapFetchError(primaryErr, this.id, controller.signal)
        if (
          !this.authEndpoint ||
          !this.cognitiveEndpoint ||
          controller.signal.aborted ||
          !shouldAttemptAuthFallback(mappedPrimary)
        ) {
          throw mappedPrimary
        }
        return await this.translateCognitiveEndpoint(req, controller.signal)
      }
    } catch (err) {
      throw mapFetchError(err, this.id, controller.signal)
    } finally {
      clearTimeout(timer)
      cleanup()
    }
  }

  async translateStream(
    req: ProviderRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const text = await this.translate(req, signal)
    onDelta(text)
    return text
  }
}
