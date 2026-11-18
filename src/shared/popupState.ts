import { DEFAULT_CONFIG, type AppConfig, type PopupShowPush, type TargetLang } from './types'

export const MAX_MANUAL_INPUT_CHARS = 5000

export interface PopupUiState {
  sourceText: string
  targetLang: TargetLang
  manualLangLocked: boolean
  directPasteMode: boolean
  hasReceivedPopupShow: boolean
  lastSubmittedText: string
  lastSubmittedLang: TargetLang
  pendingPasteAfterDone: boolean
  pasting: boolean
  status: 'idle' | 'loading' | 'streaming' | 'done' | 'error'
}

export function createInitialPopupUiState(
  defaultTargetLang: TargetLang = DEFAULT_CONFIG.defaultTargetLang
): PopupUiState {
  return {
    sourceText: '',
    targetLang: defaultTargetLang,
    manualLangLocked: false,
    directPasteMode: false,
    hasReceivedPopupShow: false,
    lastSubmittedText: '',
    lastSubmittedLang: defaultTargetLang,
    pendingPasteAfterDone: false,
    pasting: false,
    status: 'idle'
  }
}

export function applyPopupShowState(state: PopupUiState, payload: PopupShowPush): PopupUiState {
  const directPaste = Boolean(payload.directPaste)
  const nextTargetLang: TargetLang =
    payload.mode === 'input' && directPaste ? 'en' : payload.to

  return {
    ...state,
    sourceText: payload.text,
    targetLang: nextTargetLang,
    manualLangLocked: payload.mode === 'selection' || directPaste,
    directPasteMode: directPaste,
    hasReceivedPopupShow: true,
    lastSubmittedText: payload.text,
    lastSubmittedLang: nextTargetLang,
    pendingPasteAfterDone: false
  }
}

export function toggleDirectPasteState(state: PopupUiState): PopupUiState {
  const nextDirect = !state.directPasteMode
  if (nextDirect) {
    return {
      ...state,
      directPasteMode: true,
      manualLangLocked: true,
      targetLang: 'en'
    }
  }
  return {
    ...state,
    directPasteMode: false,
    manualLangLocked: false
  }
}

export function applyLoadedConfigState(state: PopupUiState, loaded: AppConfig): PopupUiState {
  if (state.hasReceivedPopupShow) {
    return state
  }
  return {
    ...state,
    targetLang: loaded.defaultTargetLang
  }
}

export function handlePopupBlurState(
  state: PopupUiState,
  pinned: boolean,
  isBusy: boolean
): {
  nextState: PopupUiState
  shouldHide: boolean
  clearedPendingPaste: boolean
} {
  let clearedPendingPaste = false
  let nextPending = state.pendingPasteAfterDone
  if (state.pendingPasteAfterDone && !state.pasting) {
    nextPending = false
    clearedPendingPaste = true
  }
  const shouldHide = !pinned && !isBusy && !state.pasting
  return {
    nextState:
      nextPending === state.pendingPasteAfterDone
        ? state
        : { ...state, pendingPasteAfterDone: nextPending },
    shouldHide,
    clearedPendingPaste
  }
}

export function shouldSuppressMidStreamResize(
  status: PopupUiState['status'],
  pendingPasteAfterDone: boolean
): boolean {
  return status === 'streaming' && pendingPasteAfterDone
}

export function isStreamEnabledForConfig(config: Pick<AppConfig, 'openai'>): boolean {
  return Boolean(config.openai.stream)
}

export function clampManualInput(text: string, maxChars = MAX_MANUAL_INPUT_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

export function validateManualInputLength(
  text: string,
  maxChars = MAX_MANUAL_INPUT_CHARS
): { ok: true } | { ok: false; message: string } {
  if (text.length > maxChars) {
    return {
      ok: false,
      message: `\u8f93\u5165\u6587\u672c\u8d85\u8fc7 ${maxChars} \u5b57\u7b26\u4e0a\u9650`
    }
  }
  return { ok: true }
}
