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
const DEFAULT_EDGE_TIMEOUT_MS = 8000

export interface EdgeProviderOptions {
  endpoint?: string
  timeoutMs?: number
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

export class EdgeDirectProvider implements TranslateProvider {
  readonly id: ProviderId = 'edge'
  private readonly endpoint: string
  private readonly timeoutMs: number

  constructor(
    private readonly http: HttpClient,
    opts?: EdgeProviderOptions
  ) {
    this.endpoint = opts?.endpoint ?? DEFAULT_EDGE_ENDPOINT
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_EDGE_TIMEOUT_MS
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

    const sep = this.endpoint.includes('?') ? '&' : '?'
    const url = `${this.endpoint}${sep}to=${encodeURIComponent(req.to)}&isEnterpriseClient=false`

    const { controller, cleanup } = createLinkedAbort(signal)
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new TimeoutMarker())
      }
    }, this.timeoutMs)

    try {
      const res = await this.http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([req.text]),
        signal: controller.signal,
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
