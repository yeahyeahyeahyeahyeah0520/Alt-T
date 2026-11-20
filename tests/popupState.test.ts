import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyLoadedConfigState,
  applyPopupShowState,
  clampManualInput,
  createInitialPopupUiState,
  handlePopupBlurState,
  isStreamEnabledForConfig,
  MAX_MANUAL_INPUT_CHARS,
  shouldSuppressMidStreamResize,
  toggleDirectPasteState,
  validateManualInputLength
} from '../src/shared/popupState'
import { DEFAULT_CONFIG } from '../src/shared/types'

describe('popupState state machine', () => {
  it('initializes with default target language and unlocked manual mode', () => {
    const state = createInitialPopupUiState('en')
    assert.equal(state.targetLang, 'en')
    assert.equal(state.manualLangLocked, false)
    assert.equal(state.directPasteMode, false)
    assert.equal(state.hasReceivedPopupShow, false)
  })

  it('locks targetLang to en on input + directPaste and preserves show lang on selection', () => {
    const init = createInitialPopupUiState('zh-Hans')

    const directInput = applyPopupShowState(init, {
      mode: 'input',
      text: '你好',
      to: 'zh-Hans',
      directPaste: true
    })
    assert.equal(directInput.targetLang, 'en')
    assert.equal(directInput.directPasteMode, true)
    assert.equal(directInput.manualLangLocked, true)
    assert.equal(directInput.hasReceivedPopupShow, true)

    const selectionShow = applyPopupShowState(init, {
      mode: 'selection',
      text: 'hello',
      to: 'zh-Hans',
      requestId: 'req-1'
    })
    assert.equal(selectionShow.targetLang, 'zh-Hans')
    assert.equal(selectionShow.directPasteMode, false)
    assert.equal(selectionShow.manualLangLocked, true)
  })

  it('ignores late configGet reply once popupShow has arrived', () => {
    const init = createInitialPopupUiState('zh-Hans')
    const afterLoad = applyLoadedConfigState(init, {
      ...DEFAULT_CONFIG,
      defaultTargetLang: 'en'
    })
    assert.equal(afterLoad.targetLang, 'en')

    const afterShow = applyPopupShowState(init, {
      mode: 'selection',
      text: 'hi',
      to: 'zh-Hans'
    })
    const lateLoad = applyLoadedConfigState(afterShow, {
      ...DEFAULT_CONFIG,
      defaultTargetLang: 'en'
    })
    assert.equal(lateLoad.targetLang, 'zh-Hans')
  })

  it('toggles directPaste mode cleanly and clears pendingPasteAfterDone on blur unless pasting', () => {
    let state = createInitialPopupUiState('zh-Hans')
    state = toggleDirectPasteState(state)
    assert.equal(state.directPasteMode, true)
    assert.equal(state.manualLangLocked, true)
    assert.equal(state.targetLang, 'en')

    state = { ...state, pendingPasteAfterDone: true, pasting: false }
    const blurred = handlePopupBlurState(state, false, false)
    assert.equal(blurred.clearedPendingPaste, true)
    assert.equal(blurred.shouldHide, true)
    assert.equal(blurred.nextState.pendingPasteAfterDone, false)

    // While actively pasting or pinned, blur must not clear pending or hide
    const whilePasting = handlePopupBlurState(
      { ...state, pendingPasteAfterDone: true, pasting: true },
      false,
      true
    )
    assert.equal(whilePasting.clearedPendingPaste, false)
    assert.equal(whilePasting.shouldHide, false)
  })

  it('validates input length, clamps max chars, and suppresses mid-stream resize', () => {
    assert.equal(shouldSuppressMidStreamResize('streaming', true), true)
    assert.equal(shouldSuppressMidStreamResize('streaming', false), false)
    assert.equal(shouldSuppressMidStreamResize('done', true), false)
    assert.equal(isStreamEnabledForConfig(DEFAULT_CONFIG), true)

    assert.equal(clampManualInput('a'.repeat(MAX_MANUAL_INPUT_CHARS + 10)).length, MAX_MANUAL_INPUT_CHARS)
    assert.deepEqual(validateManualInputLength('hello'), { ok: true })
    const tooLong = validateManualInputLength('x'.repeat(MAX_MANUAL_INPUT_CHARS + 1))
    assert.equal(tooLong.ok, false)
  })
})
