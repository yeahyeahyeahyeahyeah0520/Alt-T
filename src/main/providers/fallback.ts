import { MSG } from '../../shared/messages'
import {
  ProviderError,
  type ProviderId,
  type ProviderRequest,
  type TranslateErrorInfo,
  type TranslateProvider,
  type TranslateResult
} from '../../shared/types'

export interface FallbackDeps {
  providers: Record<ProviderId, TranslateProvider>
  primary: ProviderId
  enableFallback: boolean
}

function toErrorInfo(err: unknown, provider: ProviderId): TranslateErrorInfo {
  if (err instanceof ProviderError) {
    return err.info
  }
  return {
    code: 'NETWORK',
    provider,
    message: err instanceof Error ? err.message : String(err),
    retryable: true
  }
}

export async function translateWithFallback(
  deps: FallbackDeps,
  req: ProviderRequest,
  mode: { stream: false } | { stream: true; onDelta: (d: string) => void },
  signal?: AbortSignal
): Promise<TranslateResult> {
  const secondary: ProviderId = deps.primary === 'openai' ? 'edge' : 'openai'
  let emittedDelta = false

  try {
    const text = mode.stream
      ? await deps.providers[deps.primary].translateStream(
          req,
          (delta: string) => {
            emittedDelta = true
            mode.onDelta(delta)
          },
          signal
        )
      : await deps.providers[deps.primary].translate(req, signal)

    return {
      text,
      provider: deps.primary,
      usedFallback: false
    }
  } catch (primaryErr) {
    const primaryInfo = toErrorInfo(primaryErr, deps.primary)

    if (
      !primaryInfo.retryable ||
      primaryInfo.code === 'ABORTED' ||
      !deps.enableFallback ||
      signal?.aborted ||
      emittedDelta
    ) {
      throw new ProviderError(primaryInfo)
    }

    try {
      const text = mode.stream
        ? await deps.providers[secondary].translateStream(req, mode.onDelta, signal)
        : await deps.providers[secondary].translate(req, signal)

      return {
        text,
        provider: secondary,
        usedFallback: true,
        primaryError: primaryInfo
      }
    } catch (secondaryErr) {
      const secondaryInfo = toErrorInfo(secondaryErr, secondary)
      if (secondaryInfo.code === 'ABORTED') {
        throw new ProviderError(secondaryInfo)
      }
      throw new ProviderError({
        ...secondaryInfo,
        message: MSG.formatFallbackFailure(
          deps.primary,
          primaryInfo.message,
          secondary,
          secondaryInfo.message
        )
      })
    }
  }
}
