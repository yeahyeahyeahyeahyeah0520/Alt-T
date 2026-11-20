import { MSG } from './messages'
import {
  DEFAULT_CONFIG,
  MAX_TRANSLATE_CHARS,
  type AppConfig,
  type PopupShowPush,
  type TargetLang
} from './types'

export const MAX_MANUAL_INPUT_CHARS = MAX_TRANSLATE_CHARS

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
    pasting: false
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
  status: 'idle' | 'loading' | 'streaming' | 'done' | 'error',
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
      message: MSG.inputTooLong(maxChars)
    }
  }
  return { ok: true }
}
