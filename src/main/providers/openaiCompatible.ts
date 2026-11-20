import {
  ProviderError,
  type OpenAIProviderConfig,
  type ProviderId,
  type ProviderRequest,
  type TranslateProvider
} from '../../shared/types'
import { buildChatCompletionsUrl, isLoopbackBaseUrl } from '../core/baseUrl'
import {
  buildRequestBody,
  extractNonStreamText,
  extractStreamDelta
} from '../core/openaiPayload'
import { SseLineParser } from '../core/sseParser'
import {
  createLinkedAbort,
  mapFetchError,
  sanitizeHttpErrorSnippet,
  TimeoutMarker,
  type HttpClient
} from './httpClient'

const DEFAULT_NON_STREAM_TIMEOUT_MS = 6000
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 10000
const DEFAULT_IDLE_TIMEOUT_MS = 30000

export interface OpenAIProviderOptions {
  nonStreamTimeoutMs?: number
  firstTokenTimeoutMs?: number
  idleTimeoutMs?: number
}

export class OpenAICompatibleProvider implements TranslateProvider {
  readonly id: ProviderId = 'openai'
  private readonly nonStreamTimeoutMs: number
  private readonly firstTokenTimeoutMs: number
  private readonly idleTimeoutMs: number

  constructor(
    private readonly getCfg: () => OpenAIProviderConfig,
    private readonly http: HttpClient,
    opts?: OpenAIProviderOptions
  ) {
    this.nonStreamTimeoutMs = opts?.nonStreamTimeoutMs ?? DEFAULT_NON_STREAM_TIMEOUT_MS
    this.firstTokenTimeoutMs = opts?.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  private validateAndPrepare(
    req: ProviderRequest,
    signal?: AbortSignal
  ): { cfg: OpenAIProviderConfig; url: string } {
    if (signal?.aborted) {
      throw new ProviderError({
        code: 'ABORTED',
        provider: this.id,
        message: 'Request aborted',
        retryable: false
      })
    }

    const cfg = this.getCfg()
    if (cfg.model.trim() === '') {
      throw new ProviderError({
        code: 'CONFIG',
        provider: this.id,
        message: 'OpenAI model is empty',
        retryable: true
      })
    }

    let url: string
    try {
      url = buildChatCompletionsUrl(cfg.baseUrl)
    } catch (err) {
      throw new ProviderError({
        code: 'CONFIG',
        provider: this.id,
        message: err instanceof Error ? err.message : 'Invalid base URL',
        retryable: true
      })
    }

    if (!isLoopbackBaseUrl(cfg.baseUrl) && cfg.apiKey.trim() === '') {
      throw new ProviderError({
        code: 'CONFIG',
        provider: this.id,
        message: 'OpenAI API key is empty',
        retryable: true
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

    return { cfg, url }
  }

  private buildHeaders(cfg: OpenAIProviderConfig, stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    const secret = cfg.apiKey.trim()
    if (secret !== '') {
      headers['Authorization'] = `Bearer ${secret}`
    }
    if (stream) {
      headers['Accept'] = 'text/event-stream'
    }
    return headers
  }

  async translate(req: ProviderRequest, signal?: AbortSignal): Promise<string> {
    const { cfg, url } = this.validateAndPrepare(req, signal)
    const headers = this.buildHeaders(cfg, false)
    const body = buildRequestBody(cfg, req, false)

    const { controller, cleanup } = createLinkedAbort(signal)
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new TimeoutMarker())
      }
    }, this.nonStreamTimeoutMs)

    try {
      const res = await this.http.request(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        provider: this.id
      })

      if (!res.ok) {
        const errBody = await res.text()
        const snippet = sanitizeHttpErrorSnippet(errBody, cfg.apiKey)
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
          message: 'Invalid JSON response from OpenAI',
          retryable: true
        })
      }

      return extractNonStreamText(json)
    } catch (err) {
      throw mapFetchError(err, this.id, controller.signal, cfg.apiKey)
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
    const { cfg, url } = this.validateAndPrepare(req, signal)
    const headers = this.buildHeaders(cfg, true)
    const body = buildRequestBody(cfg, req, true)

    const { controller, cleanup } = createLinkedAbort(signal)
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new TimeoutMarker())
      }
    }, this.firstTokenTimeoutMs)

    const resetIdleTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(new TimeoutMarker())
        }
      }, this.idleTimeoutMs)
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let completedNormally = false

    try {
      const res = await this.http.request(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        provider: this.id
      })

      if (!res.ok) {
        const errBody = await res.text()
        const snippet = sanitizeHttpErrorSnippet(errBody, cfg.apiKey)
        throw new ProviderError({
          code: 'HTTP',
          provider: this.id,
          status: res.status,
          message: `HTTP ${res.status}: ${snippet}`,
          retryable: true
        })
      }

      if (!res.body) {
        throw new ProviderError({
          code: 'PARSE',
          provider: this.id,
          message: 'Empty response body in OpenAI stream',
          retryable: true
        })
      }

      reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      const parser = new SseLineParser()
      let accumulated = ''
      let doneReceived = false

      const processEvents = (events: Array<{ data: string }>): void => {
        for (const ev of events) {
          const parsed = extractStreamDelta(ev.data)
          if (parsed.done) {
            doneReceived = true
            break
          }
          if (parsed.delta !== '') {
            resetIdleTimer()
            accumulated += parsed.delta
            onDelta(parsed.delta)
          }
        }
      }

      while (!doneReceived) {
        const { done, value } = await reader.read()
        if (done) break
        const decoded = decoder.decode(value, { stream: true })
        processEvents(parser.push(decoded))
      }

      if (doneReceived) {
        await reader.cancel().catch(() => {})
      } else {
        const tail = decoder.decode()
        if (tail !== '') {
          processEvents(parser.push(tail))
        }
        if (!doneReceived) {
          processEvents(parser.flush())
        }
      }

      if (accumulated === '') {
        throw new ProviderError({
          code: 'PARSE',
          provider: this.id,
          message: 'empty response',
          retryable: true
        })
      }

      completedNormally = true
      return accumulated
    } catch (err) {
      throw mapFetchError(err, this.id, controller.signal, cfg.apiKey)
    } finally {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (reader && !completedNormally) {
        void reader.cancel().catch(() => {})
      }
      cleanup()
    }
  }
}
