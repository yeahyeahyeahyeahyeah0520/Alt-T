import { isProviderId, isRecord, mergeOpenAI, mergeProxy } from '../../shared/config'
import {
  IPC_CHANNELS,
  ProviderError,
  type ProviderTestReply
} from '../../shared/types'
import { validateLocalOnlyTarget } from '../core/baseUrl'
import { redactSecretsInText } from '../core/redact'
import { EdgeDirectProvider, type EdgeProviderOptions } from './edgeDirect'
import { createHttp } from './httpClient'
import { OpenAICompatibleProvider } from './openaiCompatible'

const PROVIDER_TEST_TIMEOUT_MS = 6000

export interface ProviderTestOptions {
  timeoutMs?: number
  edgeOptions?: EdgeProviderOptions
  defaultLocalOnlyMode?: boolean
}

/**
 * Isolated, side-effect-free connectivity test for unsaved Settings drafts.
 * Does not persist config or append history; always disposes its temporary HTTP client.
 */
export async function testProviderDraft(
  raw: unknown,
  opts?: ProviderTestOptions
): Promise<ProviderTestReply> {
  if (!isRecord(raw) || !isProviderId(raw.provider)) {
    throw new Error(`IPC_BAD_ARGS:${IPC_CHANNELS.providerTest}`)
  }

  const providerId = raw.provider
  const openaiCfg = mergeOpenAI(raw.openai)
  const proxyCfg = mergeProxy(raw.proxy)
  const effectiveLocalOnly =
    typeof raw.localOnlyMode === 'boolean'
      ? raw.localOnlyMode
      : Boolean(opts?.defaultLocalOnlyMode)

  const localCheck = validateLocalOnlyTarget({
    localOnlyMode: effectiveLocalOnly,
    provider: providerId,
    baseUrl: openaiCfg.baseUrl
  })
  if (!localCheck.ok) {
    return {
      ok: false,
      provider: providerId,
      latencyMs: 0,
      errorCode: localCheck.code,
      errorMessage: localCheck.message
    }
  }

  const timeoutMs = opts?.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS
  const http = createHttp({
    getProxy: () => proxyCfg,
    isLocalOnly: () => effectiveLocalOnly
  })
  const startedAt = Date.now()

  try {
    const provider =
      providerId === 'edge'
        ? new EdgeDirectProvider(http, { ...opts?.edgeOptions, timeoutMs })
        : new OpenAICompatibleProvider(() => openaiCfg, http, {
            nonStreamTimeoutMs: timeoutMs
          })

    const translated = await provider.translate({ text: 'hello', to: 'zh-Hans' })
    return {
      ok: true,
      provider: providerId,
      latencyMs: Math.max(1, Date.now() - startedAt),
      sampleText: translated.trim().slice(0, 120)
    }
  } catch (err) {
    const latencyMs = Math.max(1, Date.now() - startedAt)
    const secrets = openaiCfg.apiKey ? [openaiCfg.apiKey] : []
    if (err instanceof ProviderError) {
      return {
        ok: false,
        provider: providerId,
        latencyMs,
        errorCode: err.info.code,
        errorMessage: redactSecretsInText(err.info.message, secrets)
      }
    }
    const rawMsg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      provider: providerId,
      latencyMs,
      errorCode: 'NETWORK',
      errorMessage: redactSecretsInText(rawMsg, secrets)
    }
  } finally {
    http.dispose()
  }
}
