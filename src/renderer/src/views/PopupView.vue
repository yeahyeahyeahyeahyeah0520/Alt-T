<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { mergeConfig } from '../../../shared/config'
import { MSG } from '../../../shared/messages'
import {
  applyLoadedConfigState,
  applyPopupShowState,
  clampManualInput,
  createInitialPopupUiState,
  handlePopupBlurState,
  isStreamEnabledForConfig,
  markSourceEditedState,
  MAX_MANUAL_INPUT_CHARS,
  shouldAutoPasteOnDone,
  shouldSuppressMidStreamResize,
  toggleDirectPasteState,
  validateManualInputLength,
  type PopupUiState
} from '../../../shared/popupState'
import { detectTargetLang } from '../../../shared/text'
import {
  DEFAULT_CONFIG,
  TARGET_LANG_NAME,
  type AppConfig,
  type NotifyPush,
  type PopupShowPush,
  type TargetLang
} from '../../../shared/types'
import { useTranslate } from '../composables/useTranslate'

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const resultPanelRef = ref<HTMLElement | null>(null)
const config = ref<AppConfig>(mergeConfig(DEFAULT_CONFIG))
const uiState = ref<PopupUiState>(createInitialPopupUiState())
const pinned = ref(false)
const toast = ref<NotifyPush | null>(null)

let toastTimer: ReturnType<typeof setTimeout> | null = null

const {
  status,
  translatedText,
  protectedVerify,
  clearResult,
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
} = useTranslate()

const canTranslate = computed(() => uiState.value.sourceText.trim() !== '')
const directHotkey = computed(() => config.value.hotkeys.directInputTranslate || 'Alt+T')

const providerLabel = computed(() => {
  if (!resultProvider.value) return ''
  const base = resultProvider.value === 'edge' ? 'Edge' : 'OpenAI'
  return usedFallback.value ? `${base}（备用源）` : base
})

function showLocalToast(level: NotifyPush['level'], message: string): void {
  toast.value = { level, message }
  if (toastTimer !== null) {
    clearTimeout(toastTimer)
  }
  toastTimer = setTimeout(() => {
    toast.value = null
    toastTimer = null
  }, 3000)
}

function safePopupHide(): void {
  void window.api.popupHide().catch((err: unknown) => {
    console.error('[alt-t] popupHide failed:', err)
  })
}

function safePopupResize(height: number): void {
  void window.api.popupResize(height).catch((err: unknown) => {
    console.error('[alt-t] popupResize failed:', err)
  })
}

watch(
  () => uiState.value.sourceText,
  (nextVal) => {
    if (!uiState.value.manualLangLocked && nextVal.trim() !== '') {
      uiState.value.targetLang = detectTargetLang(nextVal)
    }
  }
)

function handleSourceInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement | null
  if (!target) return
  if (target.value.length > MAX_MANUAL_INPUT_CHARS) {
    const clamped = clampManualInput(target.value)
    uiState.value.sourceText = clamped
    target.value = clamped
    showLocalToast('warn', MSG.inputTruncated(MAX_MANUAL_INPUT_CHARS))
  }
  uiState.value = markSourceEditedState(uiState.value)
  editableResult.value = ''
  clearResult()
}

function startTranslation(): void {
  if (!canTranslate.value) return
  const lenCheck = validateManualInputLength(uiState.value.sourceText)
  if (!lenCheck.ok) {
    showLocalToast('warn', lenCheck.message)
    return
  }
  uiState.value.sourceEditedSinceTranslate = false
  uiState.value.protectedVerificationFailed = false
  uiState.value.protectedWarningMessage = ''
  if (!uiState.value.manualLangLocked) {
    uiState.value.targetLang = detectTargetLang(uiState.value.sourceText)
  }
  const stream = isStreamEnabledForConfig(config.value)
  uiState.value.lastSubmittedText = uiState.value.sourceText
  uiState.value.lastSubmittedLang = uiState.value.targetLang
  void start({
    text: uiState.value.sourceText,
    to: uiState.value.targetLang,
    stream,
    ...(uiState.value.targetApp ? { targetExeName: uiState.value.targetApp } : {})
  })
}

async function doPasteToTarget(text: string): Promise<void> {
  if (!text || uiState.value.pasting) return
  uiState.value.pasting = true
  try {
    const res = await window.api.popupPasteToTarget({ text })
    if (!res.ok) {
      const level: NotifyPush['level'] =
        res.status === 'clipboard-only' || res.status === 'cancelled' ? 'warn' : 'error'
      if (res.message) {
        showLocalToast(level, res.message)
      }
    }
  } catch (err) {
    showLocalToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    uiState.value.pasting = false
  }
}

function handleTranslateAndPaste(): void {
  const activeResult = editableResult.value || translatedText.value
  const upToDate =
    status.value === 'done' &&
    activeResult !== '' &&
    uiState.value.lastSubmittedText === uiState.value.sourceText &&
    uiState.value.lastSubmittedLang === uiState.value.targetLang

  if (upToDate) {
    void doPasteToTarget(activeResult)
    return
  }

  if (
    isBusy.value &&
    uiState.value.lastSubmittedText === uiState.value.sourceText &&
    uiState.value.lastSubmittedLang === uiState.value.targetLang
  ) {
    uiState.value.pendingPasteAfterDone = !uiState.value.confirmBeforePaste
    return
  }

  if (canTranslate.value) {
    const lenCheck = validateManualInputLength(uiState.value.sourceText)
    if (!lenCheck.ok) {
      showLocalToast('warn', lenCheck.message)
      return
    }
    uiState.value.sourceEditedSinceTranslate = false
    uiState.value.protectedVerificationFailed = false
    uiState.value.protectedWarningMessage = ''
    uiState.value.pendingPasteAfterDone = !uiState.value.confirmBeforePaste
    startTranslation()
  }
}

async function handlePasteOriginal(): Promise<void> {
  const original = uiState.value.sourceText
  if (!original.trim() || uiState.value.pasting) return
  uiState.value.pendingPasteAfterDone = false
  cancel()
  await doPasteToTarget(original)
}

function handleToggleDirectPaste(): void {
  uiState.value = toggleDirectPasteState(uiState.value)
}

function handleTextareaKeydown(e: KeyboardEvent): void {
  if (e.isComposing || sourceComposingJustEnded.value || e.keyCode === 229) return
  if (e.key === 'Enter') {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      handleTranslateAndPaste()
      return
    }
    if (!e.shiftKey) {
      e.preventDefault()
      if (uiState.value.directPasteMode && !uiState.value.confirmBeforePaste) {
        e.stopPropagation()
        handleTranslateAndPaste()
        return
      }
      uiState.value.pendingPasteAfterDone = false
      startTranslation()
    }
  }
}

function handleResultKeydown(e: KeyboardEvent): void {
  if (e.isComposing || resultComposingJustEnded.value || e.keyCode === 229) return
  if (e.key === 'Enter' && !e.shiftKey) {
    if (status.value !== 'done') return
    const textToPaste = editableResult.value || translatedText.value
    if (!textToPaste.trim()) return
    e.preventDefault()
    e.stopPropagation()
    void doPasteToTarget(textToPaste)
  }
}

function selectTargetLang(lang: TargetLang): void {
  uiState.value.manualLangLocked = true
  uiState.value.targetLang = lang
  uiState.value.pendingPasteAfterDone = false
  if (canTranslate.value) {
    startTranslation()
  }
}

async function handleTogglePin(): Promise<void> {
  try {
    const nextPinned = await window.api.popupPin(!pinned.value)
    pinned.value = nextPinned
  } catch (err) {
    showLocalToast('error', err instanceof Error ? err.message : String(err))
  }
}

function handleOpenSettings(): void {
  void window.api.settingsOpen().catch((err: unknown) => {
    showLocalToast('error', err instanceof Error ? err.message : String(err))
  })
}

function handleCancelActive(): void {
  uiState.value.pendingPasteAfterDone = false
  cancel()
}

function handleClose(): void {
  uiState.value.pendingPasteAfterDone = false
  if (isBusy.value) {
    cancel()
  }
  safePopupHide()
}

async function handleCopy(): Promise<void> {
  try {
    await copy(editableResult.value || translatedText.value)
  } catch (err) {
    showLocalToast('error', err instanceof Error ? err.message : String(err))
  }
}

function handleWindowKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    uiState.value.pendingPasteAfterDone = false
    if (isBusy.value) {
      cancel()
    } else {
      safePopupHide()
    }
    return
  }
  if (e.key === 'Enter' && !e.isComposing) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      handleTranslateAndPaste()
      return
    }
    const tag = (e.target as HTMLElement | null)?.tagName
    if (uiState.value.directPasteMode && !e.shiftKey && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
      e.preventDefault()
      handleTranslateAndPaste()
    }
  }
}

function handleWindowBlur(): void {
  const { nextState, shouldHide, clearedPendingPaste } = handlePopupBlurState(
    uiState.value,
    pinned.value,
    isBusy.value
  )
  uiState.value = nextState
  if (clearedPendingPaste) {
    showLocalToast('warn', MSG.POPUP_BLUR_PASTE_CANCELLED)
  }
  if (shouldHide) {
    safePopupHide()
  }
}

function measureNaturalHeight(): number {
  const rootOverflow = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  const contentEl = contentRef.value
  const resultEl = resultPanelRef.value
  const contentOverflow = contentEl
    ? Math.max(0, contentEl.scrollHeight - contentEl.clientHeight)
    : 0
  const resultOverflow = resultEl
    ? Math.max(0, resultEl.scrollHeight - resultEl.clientHeight)
    : 0
  return Math.ceil(window.innerHeight + Math.max(rootOverflow, contentOverflow + resultOverflow))
}

function reportHeightIfNeeded(): void {
  if (shouldSuppressMidStreamResize(status.value, uiState.value.pendingPasteAfterDone)) {
    return
  }
  void nextTick(() => {
    if (shouldSuppressMidStreamResize(status.value, uiState.value.pendingPasteAfterDone)) {
      return
    }
    const naturalH = measureNaturalHeight()
    if (naturalH > window.innerHeight) {
      safePopupResize(naturalH)
    }
  })
}

const editableResult = ref('')
const sourceComposingJustEnded = ref(false)
const resultComposingJustEnded = ref(false)

function handleSourceCompositionEnd(): void {
  sourceComposingJustEnded.value = true
  setTimeout(() => {
    sourceComposingJustEnded.value = false
  }, 0)
}

function handleResultCompositionEnd(): void {
  resultComposingJustEnded.value = true
  setTimeout(() => {
    resultComposingJustEnded.value = false
  }, 0)
}

watch(translatedText, (nextVal) => {
  editableResult.value = nextVal
})

watch([status, translatedText, protectedVerify, error], () => {
  if (protectedVerify.value && !protectedVerify.value.ok) {
    uiState.value.protectedVerificationFailed = true
    uiState.value.protectedWarningMessage = MSG.PROTECTED_TEXT_VERIFY_FAILED
    uiState.value.pendingPasteAfterDone = false
  }
  const finalResult = editableResult.value || translatedText.value
  if (status.value === 'done' && shouldAutoPasteOnDone(uiState.value) && finalResult !== '') {
    uiState.value.pendingPasteAfterDone = false
    void doPasteToTarget(finalResult)
    return
  }
  if (status.value === 'error' || status.value === 'idle') {
    uiState.value.pendingPasteAfterDone = false
  }
  if (status.value === 'done' || status.value === 'error' || status.value === 'streaming') {
    reportHeightIfNeeded()
  }
})

let unsubPopupShow: (() => void) | null = null
let unsubConfigChanged: (() => void) | null = null
let unsubNotify: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('blur', handleWindowBlur)

  unsubPopupShow = window.api.onPopupShow((payload: PopupShowPush) => {
    uiState.value = applyPopupShowState(uiState.value, payload)
    editableResult.value = payload.initialTranslatedText ?? ''

    if (payload.requestId) {
      attachExternal(payload.requestId)
    } else {
      reset()
    }

    if (payload.mode === 'input') {
      void nextTick(() => {
        textareaRef.value?.focus()
      })
    }
  })

  unsubConfigChanged = window.api.onConfigChanged((nextCfg: AppConfig) => {
    config.value = mergeConfig(nextCfg)
  })

  unsubNotify = window.api.onNotify((payload: NotifyPush) => {
    showLocalToast(payload.level, payload.message)
  })

  try {
    const loaded = mergeConfig(await window.api.configGet())
    config.value = loaded
    uiState.value = applyLoadedConfigState(uiState.value, loaded)
  } catch (err) {
    console.error('[alt-t] failed to load popup config:', err)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('blur', handleWindowBlur)
  unsubPopupShow?.()
  unsubConfigChanged?.()
  unsubNotify?.()
  if (toastTimer !== null) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
})
</script>

<template>
  <div class="popup-root">
    <header class="topbar">
      <div class="title-wrap">
        <span class="title">
          {{ uiState.directPasteMode ? 'Alt-T · 回车直填' : 'Alt-T' }}
        </span>
        <span
          v-if="uiState.targetApp"
          class="target-badge"
          :class="{ 'target-warn': uiState.targetChanged }"
          :title="uiState.targetChanged ? '目标窗口已变化，请确认后再填入' : `当前目标应用：${uiState.targetApp}`"
        >
          {{ uiState.targetApp
          }}{{
            uiState.ideRegion === 'terminal'
              ? ' · 终端'
              : uiState.ideRegion === 'editor'
                ? ' · 编辑器'
                : uiState.ideRegion === 'unknown'
                  ? ' · 区域未明'
                  : ''
          }}{{ uiState.targetChanged ? '（已切换）' : '' }}
        </span>
      </div>
      <div class="topbar-actions">
        <button
          type="button"
          class="icon-btn"
          :class="{ active: uiState.directPasteMode }"
          :title="
            uiState.directPasteMode
              ? `已开启回车直填：按 Enter 直接翻译并填入终端或原窗口（IDE 内置终端推荐直接按 ${directHotkey}）`
              : `开启回车直填模式（${directHotkey} 默认开启，IDE 内置终端推荐使用 ${directHotkey}）`
          "
          @click="handleToggleDirectPaste"
        >
          ⚡
        </button>
        <button
          type="button"
          class="icon-btn"
          :class="{ active: pinned }"
          :title="pinned ? '取消置顶' : '置顶窗口'"
          @click="handleTogglePin"
        >
          📌
        </button>
        <button type="button" class="icon-btn" title="设置" @click="handleOpenSettings">
          ⚙
        </button>
        <button type="button" class="icon-btn" title="关闭" @click="handleClose">
          ✕
        </button>
      </div>
    </header>

    <div v-if="toast" class="toast" :class="`toast-${toast.level}`">
      {{ toast.message }}
    </div>

    <main ref="contentRef" class="content">
      <textarea
        ref="textareaRef"
        v-model="uiState.sourceText"
        class="source-input"
        rows="4"
        :maxlength="MAX_MANUAL_INPUT_CHARS"
        :placeholder="
          uiState.directPasteMode
            ? '极速模式：输入中文直接按 Enter 回车，自动译成英文填入终端（Shift+Enter 换行）'
            : `输入文本：Enter 翻译，Ctrl+Enter 翻译并填入终端或原窗口，Shift+Enter 换行（IDE 内置终端推荐 ${directHotkey}）`
        "
        @input="handleSourceInput"
        @compositionstart="sourceComposingJustEnded = false"
        @compositionend="handleSourceCompositionEnd"
        @keydown="handleTextareaKeydown"
      />

      <div class="toolbar">
        <div class="lang-switch" role="group" aria-label="目标语言">
          <button
            type="button"
            class="seg-btn"
            :class="{ active: uiState.targetLang === 'en' }"
            @click="selectTargetLang('en')"
          >
            {{ TARGET_LANG_NAME.en }}
          </button>
          <button
            type="button"
            class="seg-btn"
            :class="{ active: uiState.targetLang === 'zh-Hans' }"
            @click="selectTargetLang('zh-Hans')"
          >
            {{ TARGET_LANG_NAME['zh-Hans'] }}
          </button>
        </div>

        <div class="toolbar-btns">
          <button
            v-if="isBusy"
            type="button"
            class="action-btn stop-btn"
            @click="handleCancelActive"
          >
            停止
          </button>
          <template v-else>
            <button
              type="button"
              class="action-btn"
              :disabled="!canTranslate || uiState.pasting"
              title="跳过翻译，直接将左侧/上方原文填入目标窗口"
              @click="handlePasteOriginal"
            >
              填入原文
            </button>
            <button
              type="button"
              class="action-btn"
              :disabled="!canTranslate"
              title="Enter 仅在浮窗显示译文"
              @click="startTranslation"
            >
              翻译
            </button>
            <button
              type="button"
              class="action-btn primary"
              :disabled="!canTranslate && !editableResult && !translatedText"
              title="快捷键 Ctrl+Enter：翻译后自动切回刚才的终端或窗口并粘贴"
              @click="handleTranslateAndPaste"
            >
              填入窗口
            </button>
          </template>
        </div>
      </div>

      <section ref="resultPanelRef" class="result-panel">
        <div
          v-if="uiState.protectedVerificationFailed || protectedVerify?.ok === false"
          class="verify-warning"
        >
          {{ uiState.protectedWarningMessage || MSG.PROTECTED_TEXT_VERIFY_FAILED }}
        </div>
        <div v-if="status === 'loading' && !translatedText" class="result-placeholder">
          {{ uiState.pendingPasteAfterDone ? '正在翻译并准备填入原窗口...' : '正在翻译...' }}
        </div>
        <textarea
          v-if="status === 'done' && (editableResult || translatedText)"
          v-model="editableResult"
          class="result-editor"
          rows="4"
          placeholder="可微调译文，按 Enter 确认填入原窗口（Shift+Enter 换行）"
          @compositionstart="resultComposingJustEnded = false"
          @compositionend="handleResultCompositionEnd"
          @keydown="handleResultKeydown"
        />
        <div v-else-if="translatedText" class="result-text">{{ translatedText }}</div>
        <div v-if="status === 'error' && error" class="result-error">
          <p class="error-message">{{ error.message }}</p>
          <button
            v-if="canTranslate"
            type="button"
            class="retry-btn"
            @click="startTranslation"
          >
            重试
          </button>
        </div>
        <div v-if="status === 'idle' && !translatedText && !error" class="result-placeholder">
          译文将显示在此处（Ctrl+Enter 可直接译入原窗口；IDE 内置终端推荐按 {{ directHotkey }}）
        </div>

        <footer class="result-footer">
          <span class="provider-meta">{{ providerLabel }}</span>
          <div class="footer-actions">
            <button
              type="button"
              class="copy-btn"
              :disabled="!editableResult && !translatedText"
              @click="handleCopy"
            >
              {{ copied ? '已复制' : '复制' }}
            </button>
          </div>
        </footer>
      </section>
    </main>
  </div>
</template>

<style scoped>
.popup-root {
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
}

.topbar {
  height: 32px;
  padding: 0 8px 0 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}

.icon-btn {
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
}

.icon-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.icon-btn.active {
  background: var(--accent);
  color: var(--accent-fg);
}

.toast {
  flex-shrink: 0;
  margin: 8px 12px 0;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}

.toast-warn {
  background: var(--warn-bg);
  color: var(--warn);
}

.toast-error {
  background: var(--danger-bg);
  color: var(--danger);
}

.content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
}

.source-input {
  flex-shrink: 0;
  width: 100%;
  min-height: 84px;
  max-height: 180px;
  resize: vertical;
  line-height: 1.5;
}

.toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.toolbar-btns {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lang-switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.seg-btn {
  border: none;
  border-radius: 0;
  padding: 4px 10px;
  font-size: 13px;
  background: var(--bg);
}

.seg-btn + .seg-btn {
  border-left: 1px solid var(--border);
}

.seg-btn.active {
  background: var(--accent);
  color: var(--accent-fg);
}

.action-btn {
  min-width: 60px;
  padding: 4px 12px;
  font-size: 13px;
}

.stop-btn {
  color: var(--danger);
  border-color: var(--danger);
}

.result-panel {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 80px;
  overflow-y: auto;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
}

.result-text {
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  line-height: 1.55;
}

.result-editor {
  width: 100%;
  min-height: 72px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  line-height: 1.5;
}

.verify-warning {
  margin-bottom: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--warn-bg);
  color: var(--warn);
  font-size: 12px;
}

.title-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.target-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.target-badge.target-warn {
  color: var(--warn);
  border-color: var(--warn);
}

.result-placeholder {
  color: var(--muted);
  font-size: 13px;
}

.result-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.error-message {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.retry-btn {
  font-size: 12px;
  padding: 2px 10px;
}

.result-footer {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.provider-meta {
  font-size: 12px;
  color: var(--muted);
}

.copy-btn {
  font-size: 12px;
  padding: 2px 10px;
}
</style>
