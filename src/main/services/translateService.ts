import { truncatePreview } from '../../shared/text'
import {
  ProviderError,
  type AppConfig,
  type ProviderId,
  type ProviderRequest,
  type TranslateErrorInfo,
  type TranslateProvider,
  type TranslateRequest,
  type TranslateResult
} from '../../shared/types'
import { EdgeDirectProvider } from '../providers/edgeDirect'
import { translateWithFallback } from '../providers/fallback'
import { createHttp, createLinkedAbort } from '../providers/httpClient'
import { OpenAICompatibleProvider } from '../providers/openaiCompatible'
import { logInfo, logWarn } from './logger'

export interface TranslateService {
  translateOnce(
    req: TranslateRequest,
    signal?: AbortSignal,
    requestId?: string
  ): Promise<TranslateResult>
  translateStream(
    requestId: string,
    req: TranslateRequest,
    sinks: {
      onChunk(d: string): void
      onDone(r: TranslateResult): void
      onError(e: TranslateErrorInfo): void
    }
  ): void
  cancel(requestId: string): void
  disposeAll(): void
}

export function createTranslateService(deps: { getConfig: () => AppConfig }): TranslateService {
  const http = createHttp({ getProxy: () => deps.getConfig().proxy })
  const providers: Record<ProviderId, TranslateProvider> = {
    openai: new OpenAICompatibleProvider(() => deps.getConfig().openai, http),
    edge: new EdgeDirectProvider(http)
  }
  const active = new Map<string, AbortController>()

  function toProviderRequest(req: TranslateRequest): ProviderRequest {
    return {
      text: req.text,
      to: req.to
    }
  }

  async function translateOnce(
    req: TranslateRequest,
    signal?: AbortSignal,
    requestId?: string
  ): Promise<TranslateResult> {
    const cfg = deps.getConfig()
    const primary = req.provider ?? cfg.primaryProvider
    const preview = truncatePreview(req.text, 40)
    logInfo(`translateOnce start provider=${primary} to=${req.to} text="${preview}"`)

    const linked = createLinkedAbort(signal)
    if (requestId) {
      cancel(requestId)
      active.set(requestId, linked.controller)
    }

    try {
      const result = await translateWithFallback(
        {
          providers,
          primary,
          enableFallback: cfg.enableFallback
        },
        toProviderRequest(req),
        { stream: false },
        linked.controller.signal
      )
      logInfo(`translateOnce done provider=${result.provider} fallback=${result.usedFallback}`)
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logWarn(`translateOnce failed provider=${primary}: ${msg}`)
      throw err
    } finally {
      linked.cleanup()
      if (requestId && active.get(requestId) === linked.controller) {
        active.delete(requestId)
      }
    }
  }

  function translateStream(
    requestId: string,
    req: TranslateRequest,
    sinks: {
      onChunk(d: string): void
      onDone(r: TranslateResult): void
      onError(e: TranslateErrorInfo): void
    }
  ): void {
    cancel(requestId)
    const ac = new AbortController()
    active.set(requestId, ac)

    const cfg = deps.getConfig()
    const primary = req.provider ?? cfg.primaryProvider
    const preview = truncatePreview(req.text, 40)
    logInfo(
      `translateStream start id=${requestId} provider=${primary} to=${req.to} text="${preview}"`
    )

    void translateWithFallback(
      {
        providers,
        primary,
        enableFallback: cfg.enableFallback
      },
      toProviderRequest(req),
      {
        stream: true,
        onDelta: (delta: string) => {
          if (ac.signal.aborted || active.get(requestId) !== ac) return
          sinks.onChunk(delta)
        }
      },
      ac.signal
    )
      .then((res) => {
        if (ac.signal.aborted || active.get(requestId) !== ac) return
        active.delete(requestId)
        logInfo(
          `translateStream done id=${requestId} provider=${res.provider} fallback=${res.usedFallback}`
        )
        sinks.onDone(res)
      })
      .catch((err: unknown) => {
        const isCurrent = active.get(requestId) === ac
        if (isCurrent) {
          active.delete(requestId)
        }
        if (ac.signal.aborted || !isCurrent) {
          return
        }
        const info: TranslateErrorInfo =
          err instanceof ProviderError
            ? err.info
            : {
                code: 'NETWORK',
                provider: primary,
                message: err instanceof Error ? err.message : String(err),
                retryable: true
              }
        logWarn(
          `translateStream error id=${requestId} code=${info.code} provider=${info.provider}: ${info.message}`
        )
        sinks.onError(info)
      })
  }

  function cancel(requestId: string): void {
    const prev = active.get(requestId)
    if (prev) {
      active.delete(requestId)
      prev.abort()
    }
  }

  function disposeAll(): void {
    for (const ac of active.values()) {
      ac.abort()
    }
    active.clear()
    http.dispose()
  }

  return {
    translateOnce,
    translateStream,
    cancel,
    disposeAll
  }
}
