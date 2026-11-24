import {
  protectTechnicalText,
  restoreAndVerifyProtectedText,
  type ProtectedTextResult
} from '../core/protectedText'
import { shouldLogOriginalTextPreview } from '../../shared/config'
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
  const http = createHttp({
    getProxy: () => deps.getConfig().proxy,
    isLocalOnly: () => deps.getConfig().localOnlyMode
  })
  const providers: Record<ProviderId, TranslateProvider> = {
    openai: new OpenAICompatibleProvider(() => deps.getConfig().openai, http),
    edge: new EdgeDirectProvider(http)
  }
  const active = new Map<string, AbortController>()

  function buildVerifySummary(
    protectedState: ProtectedTextResult,
    verify: ReturnType<typeof restoreAndVerifyProtectedText>
  ): NonNullable<TranslateResult['protectedVerify']> | undefined {
    if (!protectedState.hasProtected) return undefined
    return {
      ok: verify.ok,
      ...(verify.reason ? { reason: verify.reason } : {}),
      reordered: verify.reordered,
      spanCount: protectedState.spans.length,
      ...(verify.missingTokens.length > 0 ? { missingTokens: [...verify.missingTokens] } : {})
    }
  }

  function toProviderRequest(req: TranslateRequest, overrideText?: string): ProviderRequest {
    return {
      text: overrideText ?? req.text,
      to: req.to,
      ...(req.promptId ? { promptId: req.promptId } : {})
    }
  }

  async function translateOnce(
    req: TranslateRequest,
    signal?: AbortSignal,
    requestId?: string
  ): Promise<TranslateResult> {
    const cfg = deps.getConfig()
    const primary = req.provider ?? cfg.primaryProvider
    const preview = shouldLogOriginalTextPreview(cfg) ? truncatePreview(req.text, 40) : ''
    logInfo(
      preview
        ? `translateOnce start provider=${primary} to=${req.to} text="${preview}"`
        : `translateOnce start provider=${primary} to=${req.to} chars=${req.text.length}`
    )

    const linked = createLinkedAbort(signal)
    if (requestId) {
      cancel(requestId)
      active.set(requestId, linked.controller)
    }

    const shouldProtect = req.protectTechnicalText ?? cfg.protectTechnicalText
    const protectedState = shouldProtect
      ? protectTechnicalText(req.text)
      : { hasProtected: false, maskedText: req.text, prefix: 'ALTT', spans: [] }

    try {
      const result = await translateWithFallback(
        {
          providers,
          primary,
          enableFallback: cfg.enableFallback,
          localOnlyMode: cfg.localOnlyMode,
          openaiBaseUrl: cfg.openai.baseUrl
        },
        toProviderRequest(req, protectedState.maskedText),
        { stream: false },
        linked.controller.signal
      )
      const verify = restoreAndVerifyProtectedText(result.text, protectedState, {
        allowReorder: true
      })
      const protectedVerify = buildVerifySummary(protectedState, verify)
      if (protectedVerify && !protectedVerify.ok) {
        logWarn(
          `translateOnce protected text verify failed: reason=${protectedVerify.reason ?? 'unknown'} spans=${protectedVerify.spanCount}`
        )
      }
      logInfo(`translateOnce done provider=${result.provider} fallback=${result.usedFallback}`)
      return {
        ...result,
        text: verify.text,
        ...(protectedVerify ? { protectedVerify } : {})
      }
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
    const preview = shouldLogOriginalTextPreview(cfg) ? truncatePreview(req.text, 40) : ''
    logInfo(
      preview
        ? `translateStream start id=${requestId} provider=${primary} to=${req.to} text="${preview}"`
        : `translateStream start id=${requestId} provider=${primary} to=${req.to} chars=${req.text.length}`
    )

    const shouldProtect = req.protectTechnicalText ?? cfg.protectTechnicalText
    const protectedState = shouldProtect
      ? protectTechnicalText(req.text)
      : { hasProtected: false, maskedText: req.text, prefix: 'ALTT', spans: [] }

    void translateWithFallback(
      {
        providers,
        primary,
        enableFallback: cfg.enableFallback,
        localOnlyMode: cfg.localOnlyMode,
        openaiBaseUrl: cfg.openai.baseUrl
      },
      toProviderRequest(req, protectedState.maskedText),
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
        const verify = restoreAndVerifyProtectedText(res.text, protectedState, {
          allowReorder: true
        })
        const protectedVerify = buildVerifySummary(protectedState, verify)
        if (protectedVerify && !protectedVerify.ok) {
          logWarn(
            `translateStream protected text verify failed: reason=${protectedVerify.reason ?? 'unknown'} spans=${protectedVerify.spanCount}`
          )
        }
        logInfo(
          `translateStream done id=${requestId} provider=${res.provider} fallback=${res.usedFallback}`
        )
        sinks.onDone({
          ...res,
          text: verify.text,
          ...(protectedVerify ? { protectedVerify } : {})
        })
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
