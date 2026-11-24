import { computed, onUnmounted, ref } from 'vue'
import type {
  ProtectedVerifySummary,
  ProviderId,
  TargetLang,
  TranslateChunkPush,
  TranslateDonePush,
  TranslateErrorInfo,
  TranslateErrorPush
} from '../../../shared/types'

export type TranslateStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error'

export interface StartTranslateParams {
  text: string
  to: TargetLang
  stream: boolean
  targetExeName?: string
  protectTechnicalText?: boolean
  promptId?: string
}

export function useTranslate() {
  const status = ref<TranslateStatus>('idle')
  const translatedText = ref('')
  const protectedVerify = ref<ProtectedVerifySummary | null>(null)
  const error = ref<TranslateErrorInfo | null>(null)
  const resultProvider = ref<ProviderId | null>(null)
  const usedFallback = ref(false)
  const copied = ref(false)

  let currentRequestId: string | null = null
  let copyTimer: ReturnType<typeof setTimeout> | null = null

  const isBusy = computed(() => status.value === 'loading' || status.value === 'streaming')

  function clearCopyTimer(): void {
    if (copyTimer !== null) {
      clearTimeout(copyTimer)
      copyTimer = null
    }
  }

  function cancelPreviousIfBusy(): void {
    if (currentRequestId !== null && (status.value === 'loading' || status.value === 'streaming')) {
      const prevId = currentRequestId
      currentRequestId = null
      void window.api.translateCancel(prevId)
    }
  }

  async function start(params: StartTranslateParams): Promise<void> {
    cancelPreviousIfBusy()

    const requestId = crypto.randomUUID()
    currentRequestId = requestId
    status.value = 'loading'
    translatedText.value = ''
    protectedVerify.value = null
    error.value = null
    resultProvider.value = null
    usedFallback.value = false
    copied.value = false
    clearCopyTimer()

    try {
      const reply = await window.api.translateStart({
        requestId,
        text: params.text,
        to: params.to,
        stream: params.stream,
        ...(params.targetExeName ? { targetExeName: params.targetExeName } : {}),
        ...(typeof params.protectTechnicalText === 'boolean'
          ? { protectTechnicalText: params.protectTechnicalText }
          : {}),
        ...(params.promptId ? { promptId: params.promptId } : {})
      })
      if (currentRequestId !== requestId) return
      if (!reply.accepted) {
        currentRequestId = null
        status.value = 'idle'
      }
    } catch (err) {
      if (currentRequestId !== requestId) return
      currentRequestId = null
      status.value = 'error'
      error.value = {
        code: 'NETWORK',
        provider: 'edge',
        message: err instanceof Error ? err.message : String(err),
        retryable: false
      }
    }
  }

  function attachExternal(externalRequestId: string): void {
    if (currentRequestId !== null && currentRequestId !== externalRequestId) {
      cancelPreviousIfBusy()
    }
    currentRequestId = externalRequestId
    protectedVerify.value = null
    status.value = 'loading'
    translatedText.value = ''
    error.value = null
    resultProvider.value = null
    usedFallback.value = false
    copied.value = false
    clearCopyTimer()
  }

  function cancel(): void {
    if (currentRequestId === null) return
    const id = currentRequestId
    currentRequestId = null
    if (status.value === 'loading' || status.value === 'streaming') {
      status.value = 'idle'
    }
    void window.api.translateCancel(id)
  }

  function reset(): void {
    cancelPreviousIfBusy()
    currentRequestId = null
    status.value = 'idle'
    translatedText.value = ''
    protectedVerify.value = null
    error.value = null
    resultProvider.value = null
    usedFallback.value = false
    copied.value = false
    clearCopyTimer()
  }

  async function copy(overrideText?: string): Promise<void> {
    const content = overrideText ?? translatedText.value
    if (!content) return
    await window.api.clipboardWrite(content)
    copied.value = true
    clearCopyTimer()
    copyTimer = setTimeout(() => {
      copied.value = false
      copyTimer = null
    }, 1500)
  }

  const unsubChunk = window.api.onTranslateChunk((payload: TranslateChunkPush) => {
    if (payload.requestId !== currentRequestId) return
    status.value = 'streaming'
    translatedText.value += payload.delta
  })

  const unsubDone = window.api.onTranslateDone((payload: TranslateDonePush) => {
    if (payload.requestId !== currentRequestId) return
    currentRequestId = null
    status.value = 'done'
    translatedText.value = payload.result.text
    protectedVerify.value = payload.result.protectedVerify ?? null
    resultProvider.value = payload.result.provider
    usedFallback.value = payload.result.usedFallback
    error.value = null
  })

  const unsubError = window.api.onTranslateError((payload: TranslateErrorPush) => {
    if (payload.requestId !== currentRequestId) return
    currentRequestId = null
    status.value = 'error'
    error.value = payload.error
  })

  onUnmounted(() => {
    unsubChunk()
    unsubDone()
    unsubError()
    clearCopyTimer()
    cancelPreviousIfBusy()
  })

  return {
    status,
    translatedText,
    protectedVerify,
    clearResult: () => {
      cancelPreviousIfBusy()
      currentRequestId = null
      status.value = 'idle'
      translatedText.value = ''
      protectedVerify.value = null
      error.value = null
    },
    error,
    resultProvider,
    usedFallback,
    copied,
    isBusy,
    start,
    attachExternal,
    cancel,
    reset,
    copy
  }
}
