<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  clamp,
  findDuplicateHotkeys,
  HOTKEY_KEYS,
  isProtectedPromptId,
  isValidGlobalAccelerator,
  mergeConfig,
  OPENAI_PROVIDER_PRESETS,
  restoreDefaultPrompts
} from '../../../shared/config'
import { truncatePreview } from '../../../shared/text'
import {
  DEFAULT_CONFIG,
  TARGET_LANG_NAME,
  type AppConfig,
  type HistoryItem,
  type HotkeyConfig,
  type PromptTemplate,
  type ProviderId,
  type ProviderTestReply
} from '../../../shared/types'

type HotkeyStatusKind = 'idle' | 'valid' | 'invalid' | 'occupied' | 'duplicate'

const HOTKEY_LABEL_MAP: Record<keyof HotkeyConfig, string> = {
  directInputTranslate: '极速译入终端/窗口',
  replaceTranslate: '取词并原地替换',
  selectionTranslate: '取词并浮窗翻译',
  togglePopup: '显示/隐藏主浮窗'
}

const HOTKEY_FIELDS = HOTKEY_KEYS.map((key) => ({
  key,
  label: HOTKEY_LABEL_MAP[key]
}))

const form = ref<AppConfig>(mergeConfig(DEFAULT_CONFIG))
const historyItems = ref<HistoryItem[]>([])
const latestPopupWidth = ref(DEFAULT_CONFIG.popupWidth)
const latestPopupHeight = ref(DEFAULT_CONFIG.popupHeight)
const customWtInput = ref('')
const customConhostInput = ref('')
const forcePopupInput = ref('')
const selectedPresetId = ref('')
const testingProvider = ref(false)
const providerTestResult = ref<ProviderTestReply | null>(null)

const hotkeyStatus = ref<Record<keyof HotkeyConfig, HotkeyStatusKind>>({
  directInputTranslate: 'idle',
  replaceTranslate: 'idle',
  selectionTranslate: 'idle',
  togglePopup: 'idle'
})

const hotkeyConflicts = ref<Array<{ key: keyof HotkeyConfig; accelerator: string }>>([])
const saveError = ref('')
const saveNotice = ref('')
const clearStoredKey = ref(false)

function handleClearApiKey(): void {
  form.value.openai.apiKey = ''
  clearStoredKey.value = true
}
const saving = ref(false)
const historyExpanded = ref(false)

const selectablePrompts = computed<PromptTemplate[]>(() => form.value.openai.prompts)

const activePrompt = computed<PromptTemplate | undefined>(() =>
  selectablePrompts.value.find((p) => p.id === form.value.openai.activePromptId)
)

const canDeletePrompt = computed(() => {
  const current = activePrompt.value
  return Boolean(current && !isProtectedPromptId(current.id) && selectablePrompts.value.length > 1)
})

const recentHistory = computed(() => historyItems.value.slice(0, 50))
const directHotkey = computed(() => form.value.hotkeys.directInputTranslate.trim() || 'Alt+T')
const replaceHotkey = computed(() => form.value.hotkeys.replaceTranslate.trim() || 'Alt+R')

function parseExeNameList(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\r\n,;]+/)) {
    const trimmed = part.trim().toLowerCase()
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

async function checkHotkey(key: keyof HotkeyConfig): Promise<void> {
  const accel = form.value.hotkeys[key].trim()
  if (!accel || !isValidGlobalAccelerator(accel)) {
    hotkeyStatus.value[key] = 'invalid'
    return
  }
  const dupes = findDuplicateHotkeys(form.value.hotkeys)
  if (dupes.some((item) => item.key === key)) {
    hotkeyStatus.value[key] = 'duplicate'
    return
  }
  try {
    const reply = await window.api.hotkeyCheck(accel)
    if (!reply.valid) {
      hotkeyStatus.value[key] = 'invalid'
    } else if (reply.occupied) {
      hotkeyStatus.value[key] = 'occupied'
    } else {
      hotkeyStatus.value[key] = 'valid'
    }
  } catch (err) {
    hotkeyStatus.value[key] = 'invalid'
    saveError.value = err instanceof Error ? err.message : String(err)
  }
}

function addPrompt(): void {
  const id = `prompt-${Date.now()}`
  const newPrompt: PromptTemplate = {
    id,
    name: '自定义模板',
    systemPrompt:
      'You are a professional technical translator. Translate the user text into {{toName}} ({{to}}), keeping code and CLI flags intact. Output only the translation.',
    userPrompt: '{{text}}'
  }
  form.value.openai.prompts.push(newPrompt)
  form.value.openai.activePromptId = id
}

function deletePrompt(): void {
  if (!canDeletePrompt.value) return
  const targetId = form.value.openai.activePromptId
  if (isProtectedPromptId(targetId)) return
  const remaining = form.value.openai.prompts.filter((p) => p.id !== targetId)
  if (remaining.length === 0) return
  form.value.openai.prompts = remaining
  form.value.openai.activePromptId = remaining[0].id
}

function handleRestoreDefaultPrompts(): void {
  const restored = restoreDefaultPrompts(form.value.openai.prompts)
  form.value.openai.prompts = restored
  if (!restored.some((p) => p.id === form.value.openai.activePromptId)) {
    form.value.openai.activePromptId = restored[0]?.id ?? 'translate'
  }
}

function handleApplyPreset(): void {
  const preset = OPENAI_PROVIDER_PRESETS.find((item) => item.id === selectedPresetId.value)
  if (!preset) return
  form.value.openai.baseUrl = preset.baseUrl
  form.value.openai.model = preset.model
  const isLoopbackPreset =
    preset.id === 'ollama' ||
    /^https?:\/\/(?:localhost|127\.|\[::1\])/i.test(preset.baseUrl.trim())
  if (isLoopbackPreset) {
    form.value.localOnlyMode = true
    form.value.primaryProvider = 'openai'
    form.value.enableFallback = false
    form.value.logOriginalTextPreview = false
  }
  providerTestResult.value = null
}

async function handleTestProvider(target?: ProviderId): Promise<void> {
  if (testingProvider.value) return
  const provider = target ?? form.value.primaryProvider
  testingProvider.value = true
  providerTestResult.value = null
  try {
    const temperature = parseFiniteClamp(
      form.value.openai.temperature,
      0,
      2,
      DEFAULT_CONFIG.openai.temperature
    )
    providerTestResult.value = await window.api.providerTest({
      provider,
      openai: {
        ...form.value.openai,
        temperature
      },
      proxy: { ...form.value.proxy },
      localOnlyMode: form.value.localOnlyMode
    })
  } catch (err) {
    providerTestResult.value = {
      ok: false,
      provider,
      latencyMs: 0,
      errorCode: 'NETWORK',
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  } finally {
    testingProvider.value = false
  }
}

async function handleClearHistory(): Promise<void> {
  try {
    await window.api.historyClear()
    historyItems.value = []
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  }
}

function parseFiniteClamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, min, max) : fallback
}

async function handleSave(): Promise<void> {
  saving.value = true
  hotkeyConflicts.value = []
  saveError.value = ''
  saveNotice.value = ''

  try {
    const temperature = parseFiniteClamp(
      form.value.openai.temperature,
      0,
      2,
      DEFAULT_CONFIG.openai.temperature
    )
    const historyLimit = Math.round(
      parseFiniteClamp(form.value.historyLimit, 0, 1000, DEFAULT_CONFIG.historyLimit)
    )
    const historyRetentionDays = Math.round(
      parseFiniteClamp(
        form.value.historyRetentionDays,
        0,
        365,
        DEFAULT_CONFIG.historyRetentionDays
      )
    )

    const invalidHotkeys = HOTKEY_FIELDS.filter(
      (field) => !isValidGlobalAccelerator(form.value.hotkeys[field.key])
    ).map((field) => ({
      key: field.key,
      accelerator: form.value.hotkeys[field.key].trim()
    }))
    if (invalidHotkeys.length > 0) {
      hotkeyConflicts.value = invalidHotkeys
      saveError.value = '存在无效快捷键格式，请使用修饰键+按键（例如 Alt+T）或 F1-F24。'
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    const dupes = findDuplicateHotkeys(form.value.hotkeys)
    if (dupes.length > 0) {
      hotkeyConflicts.value = dupes
      saveError.value = '存在相同的重复快捷键，请为不同功能分配不同组合键。'
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    const payload = mergeConfig({
      ...form.value,
      openai: {
        ...form.value.openai,
        temperature
      },
      historyLimit,
      historyRetentionDays,
      logOriginalTextPreview: form.value.localOnlyMode
        ? false
        : form.value.logOriginalTextPreview,
      popupWidth: latestPopupWidth.value,
      popupHeight: latestPopupHeight.value,
      customWtExeNames: parseExeNameList(customWtInput.value),
      customConhostExeNames: parseExeNameList(customConhostInput.value),
      forcePopupOnReplaceExes: parseExeNameList(forcePopupInput.value),
      history: historyItems.value
    })

    const reply = await window.api.configSet({
      config: payload,
      ...(clearStoredKey.value && payload.openai.apiKey.trim() === ''
        ? { clearStoredEncryptedKey: true }
        : {})
    })
    clearStoredKey.value = false
    if (reply.hotkeyConflicts.length > 0) {
      hotkeyConflicts.value = reply.hotkeyConflicts
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (!reply.ok) {
      saveError.value = '保存配置失败，请检查输入项后重试。'
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (reply.storageWarning) {
      saveNotice.value = `${reply.storageWarning}（其余配置已保存；若需关闭窗口请点击“取消”）`
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    window.close()
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } finally {
    saving.value = false
  }
}

function handleCancel(): void {
  window.close()
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

let unsubConfigChanged: (() => void) | null = null

onMounted(async () => {
  unsubConfigChanged = window.api.onConfigChanged((nextCfg: AppConfig) => {
    const normalized = mergeConfig(nextCfg)
    form.value.autoLaunch = normalized.autoLaunch
    historyItems.value = normalized.history
    latestPopupWidth.value = normalized.popupWidth
    latestPopupHeight.value = normalized.popupHeight
  })

  try {
    const loaded = mergeConfig(await window.api.configGet())
    form.value = loaded
    historyItems.value = loaded.history
    latestPopupWidth.value = loaded.popupWidth
    latestPopupHeight.value = loaded.popupHeight
    customWtInput.value = (loaded.customWtExeNames ?? []).join(', ')
    customConhostInput.value = (loaded.customConhostExeNames ?? []).join(', ')
    forcePopupInput.value = (loaded.forcePopupOnReplaceExes ?? []).join(', ')
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  }
})

onUnmounted(() => {
  unsubConfigChanged?.()
})
</script>

<template>
  <div class="settings-root">
    <div v-if="hotkeyConflicts.length > 0 || saveError" class="alert-error">
      <div v-if="hotkeyConflicts.length > 0">
        <strong>以下快捷键注册失败（冲突或无效）：</strong>
        <ul class="conflict-list">
          <li v-for="item in hotkeyConflicts" :key="item.key">
            {{ HOTKEY_LABEL_MAP[item.key] }}：{{ item.accelerator }}
          </li>
        </ul>
      </div>
      <div v-if="saveError">{{ saveError }}</div>
    </div>
    <div v-if="saveNotice" class="alert-warn">{{ saveNotice }}</div>

    <div class="sections">
      <section class="group">
        <h2 class="group-title">快捷键</h2>
        <div v-for="field in HOTKEY_FIELDS" :key="field.key" class="row">
          <label class="label" :for="`hk-${field.key}`">{{ field.label }}</label>
          <div class="hotkey-cell">
            <input
              :id="`hk-${field.key}`"
              v-model="form.hotkeys[field.key]"
              type="text"
              placeholder="例如 Alt+T"
              @blur="checkHotkey(field.key)"
            />
            <span
              v-if="hotkeyStatus[field.key] === 'valid'"
              class="hk-status hk-valid"
            >
              ✓ 可用
            </span>
            <span
              v-else-if="hotkeyStatus[field.key] === 'invalid'"
              class="hk-status hk-invalid"
            >
              ✗ 语法错误
            </span>
            <span
              v-else-if="hotkeyStatus[field.key] === 'occupied'"
              class="hk-status hk-occupied"
            >
              ⚠ 已被占用
            </span>
            <span
              v-else-if="hotkeyStatus[field.key] === 'duplicate'"
              class="hk-status hk-invalid"
            >
              ✗ 应用内重复
            </span>
          </div>
        </div>
        <div class="hint">
          提示：在 VS Code / Antigravity 等 IDE 内置终端中，推荐使用 {{ directHotkey }} 极速译入英文并回车上屏。
        </div>
      </section>

      <section class="group">
        <h2 class="group-title">翻译源</h2>
        <div class="row">
          <label class="label" for="primary-provider">主翻译源</label>
          <div class="inline-actions">
            <select id="primary-provider" v-model="form.primaryProvider">
              <option value="edge">Edge 免费直连</option>
              <option value="openai">OpenAI 兼容</option>
            </select>
            <button type="button" :disabled="testingProvider" @click="handleTestProvider()">
              {{ testingProvider ? '测试中...' : '测试连接' }}
            </button>
          </div>
        </div>
        <div class="row">
          <span class="label">自动回退</span>
          <label class="checkbox-label">
            <input v-model="form.enableFallback" type="checkbox" />
            主源失败后自动改用备用源
          </label>
        </div>
        <div
          v-if="providerTestResult"
          class="test-result"
          :class="providerTestResult.ok ? 'test-ok' : 'test-err'"
        >
          <template v-if="providerTestResult.ok">
            ✓ {{ providerTestResult.provider === 'edge' ? 'Edge' : 'OpenAI' }} 连接成功（{{
              providerTestResult.latencyMs
            }} ms）：{{ providerTestResult.sampleText || 'ok' }}
          </template>
          <template v-else>
            ✗ {{ providerTestResult.provider === 'edge' ? 'Edge' : 'OpenAI' }} 测试失败（{{
              providerTestResult.errorCode || 'ERROR'
            }}）：{{ providerTestResult.errorMessage }}
          </template>
        </div>
      </section>

      <section class="group">
        <h2 class="group-title">OpenAI 兼容</h2>
        <div class="row">
          <label class="label" for="openai-preset">快速预设</label>
          <div class="inline-actions">
            <select id="openai-preset" v-model="selectedPresetId" @change="handleApplyPreset">
              <option value="">选择常用服务商预设（保留当前 API Key）</option>
              <option v-for="preset in OPENAI_PROVIDER_PRESETS" :key="preset.id" :value="preset.id">
                {{ preset.label }}
              </option>
            </select>
            <button
              type="button"
              :disabled="testingProvider"
              @click="handleTestProvider('openai')"
            >
              {{ testingProvider ? '测试中...' : '测 OpenAI' }}
            </button>
          </div>
        </div>
        <div class="row">
          <label class="label" for="openai-base-url">Base URL</label>
          <div class="stack-cell">
            <input
              id="openai-base-url"
              v-model="form.openai.baseUrl"
              type="text"
              placeholder="https://api.openai.com/v1"
            />
            <span class="hint">可带或不带 /v1</span>
          </div>
        </div>
        <div class="row">
          <label class="label" for="openai-api-key">API Key</label>
          <div class="inline-actions">
            <input
              id="openai-api-key"
              v-model="form.openai.apiKey"
              type="password"
              autocomplete="off"
              @input="clearStoredKey = false"
            />
            <button
              type="button"
              title="清除内存和磁盘中保存的 API Key"
              @click="handleClearApiKey"
            >
              清除密钥
            </button>
          </div>
        </div>
        <div class="row">
          <label class="label" for="openai-model">模型</label>
          <input id="openai-model" v-model="form.openai.model" type="text" />
        </div>
        <div class="row">
          <span class="label">流式输出</span>
          <label class="checkbox-label">
            <input v-model="form.openai.stream" type="checkbox" />
            启用流式推送
          </label>
        </div>
        <div class="row">
          <label class="label" for="openai-temperature">Temperature</label>
          <input
            id="openai-temperature"
            v-model.number="form.openai.temperature"
            type="number"
            min="0"
            max="2"
            step="0.1"
          />
        </div>

        <div class="prompt-block">
          <div class="row">
            <label class="label" for="prompt-select">Prompt 模板</label>
            <div class="prompt-toolbar">
              <select id="prompt-select" v-model="form.openai.activePromptId">
                <option
                  v-for="tpl in selectablePrompts"
                  :key="tpl.id"
                  :value="tpl.id"
                >
                  {{ tpl.name || tpl.id }}
                </option>
              </select>
              <button type="button" @click="addPrompt">新建</button>
              <button
                type="button"
                :disabled="!canDeletePrompt"
                :title="
                  activePrompt && isProtectedPromptId(activePrompt.id)
                    ? '内置默认模板不可删除'
                    : '删除当前自定义模板'
                "
                @click="deletePrompt"
              >
                删除
              </button>
              <button
                type="button"
                title="恢复内置默认模板（保留自定义模板）"
                @click="handleRestoreDefaultPrompts"
              >
                恢复默认模板
              </button>
            </div>
          </div>

          <template v-if="activePrompt">
            <div class="row">
              <label class="label" for="prompt-name">名称</label>
              <input id="prompt-name" v-model="activePrompt.name" type="text" />
            </div>
            <div class="row">
              <label class="label" for="prompt-system">System Prompt</label>
              <textarea
                id="prompt-system"
                v-model="activePrompt.systemPrompt"
                rows="3"
              />
            </div>
            <div class="row">
              <label class="label" for="prompt-user">User Prompt</label>
              <textarea
                id="prompt-user"
                v-model="activePrompt.userPrompt"
                rows="2"
              />
            </div>
          </template>
        </div>
      </section>

      <section class="group">
        <h2 class="group-title">代理</h2>
        <div class="row">
          <span class="label">启用代理</span>
          <label class="checkbox-label">
            <input v-model="form.proxy.enabled" type="checkbox" />
            通过 HTTP/HTTPS 代理请求
          </label>
        </div>
        <div class="row">
          <label class="label" for="proxy-url">代理地址</label>
          <input
            id="proxy-url"
            v-model="form.proxy.url"
            type="text"
            placeholder="http://127.0.0.1:7890"
          />
        </div>
      </section>

      <section class="group">
        <h2 class="group-title">其他</h2>
        <div class="row">
          <span class="label">开机自启</span>
          <label class="checkbox-label">
            <input v-model="form.autoLaunch" type="checkbox" />
            登录系统时自动在后台静默启动
          </label>
        </div>
        <div class="row">
          <span class="label">终端高级</span>
          <div class="stack-cell">
            <label class="checkbox-label">
              <input v-model="form.terminalAutoBackspace" type="checkbox" />
              终端划选自动退格替换
            </label>
            <span class="hint">
              默认关闭（安全浮窗模式）：在终端划选按 {{ replaceHotkey }} 时先弹出译文预览，按 Enter 安全填入，避免盲发退格误删命令行；开启后将按字形簇自动退格替换（支持 Windows / macOS 与支持按键注入的 Linux 环境）。IDE 内置终端推荐直接按 {{ directHotkey }}。
            </span>
          </div>
        </div>
        <div class="row">
          <label class="label" for="custom-wt-exes">Ctrl+Shift+V 终端</label>
          <div class="stack-cell">
            <input
              id="custom-wt-exes"
              v-model="customWtInput"
              type="text"
              placeholder="例如 custom-wt.exe, myterm.exe（逗号分隔）"
            />
            <span class="hint">自定义追加使用 Ctrl+Shift+V 复制/粘贴的终端 exe 文件名</span>
          </div>
        </div>
        <div class="row">
          <label class="label" for="custom-conhost-exes">Shift+Insert 终端</label>
          <div class="stack-cell">
            <input
              id="custom-conhost-exes"
              v-model="customConhostInput"
              type="text"
              placeholder="例如 my-terminal.exe（逗号分隔）"
            />
            <span class="hint">自定义追加使用 Ctrl+Insert / Shift+Insert 的终端 exe 文件名</span>
          </div>
        </div>
        <div class="row">
          <label class="label" for="force-popup-exes">防误触强制浮窗</label>
          <div class="stack-cell">
            <input
              id="force-popup-exes"
              v-model="forcePopupInput"
              type="text"
              placeholder="例如 code.exe, cursor.exe（逗号分隔）"
            />
            <span class="hint">
              对列出的进程按 {{ replaceHotkey }} 时绝不发送 Ctrl+C，直接切换为 {{ directHotkey }} 独立输入条（适合关闭了无障碍树的 IDE 内置终端防误杀命令）
            </span>
          </div>
        </div>
        <div class="row">
          <label class="label" for="default-lang">默认目标语言</label>
          <select id="default-lang" v-model="form.defaultTargetLang">
            <option value="zh-Hans">{{ TARGET_LANG_NAME['zh-Hans'] }}</option>
            <option value="en">{{ TARGET_LANG_NAME.en }}</option>
          </select>
        </div>
        <div class="row">
          <span class="label">严格本地模式</span>
          <div class="stack-cell">
            <label class="checkbox-label">
              <input
                v-model="form.localOnlyMode"
                type="checkbox"
                @change="form.localOnlyMode && (form.logOriginalTextPreview = false)"
              />
              严格仅本地翻译（仅允许本机回环地址，禁止外网回退、HTTP 重定向与代理）
            </label>
          </div>
        </div>
        <div class="row">
          <span class="label">日志隐私</span>
          <label class="checkbox-label">
            <input
              v-model="form.logOriginalTextPreview"
              type="checkbox"
              :disabled="form.localOnlyMode"
            />
            允许在调试日志中记录截断原文预览（默认关闭，仅本地模式下强制禁用）
          </label>
        </div>
        <div class="row">
          <span class="label">记录历史</span>
          <label class="checkbox-label">
            <input v-model="form.historyEnabled" type="checkbox" />
            保存翻译历史记录
          </label>
        </div>
        <div class="row">
          <label class="label" for="history-retention-days">保留天数</label>
          <div class="stack-cell">
            <input
              id="history-retention-days"
              v-model.number="form.historyRetentionDays"
              type="number"
              min="0"
              max="365"
              step="1"
            />
            <span class="hint">0 = 仅当前会话保留（不写入磁盘）；大于 0 按天数自动清理过期记录（默认 30 天）</span>
          </div>
        </div>
        <div class="row">
          <label class="label" for="history-limit">历史上限</label>
          <div class="history-limit-cell">
            <input
              id="history-limit"
              v-model.number="form.historyLimit"
              type="number"
              min="0"
              max="1000"
              step="1"
            />
            <button type="button" @click="handleClearHistory">清空历史</button>
          </div>
        </div>
      </section>

      <section class="group">
        <details :open="historyExpanded" @toggle="historyExpanded = ($event.target as HTMLDetailsElement).open">
          <summary class="history-summary">
            历史记录（只读，显示最近 {{ recentHistory.length }} 条）
          </summary>
          <div v-if="recentHistory.length === 0" class="history-empty">
            暂无历史记录
          </div>
          <ul v-else class="history-list">
            <li v-for="item in recentHistory" :key="item.id" class="history-item">
              <div class="history-meta">
                <span>{{ formatTime(item.at) }}</span>
                <span>{{ item.provider === 'edge' ? 'Edge' : 'OpenAI' }}</span>
              </div>
              <div class="history-text">
                {{ truncatePreview(item.from, 60) }} → {{ truncatePreview(item.to, 60) }}
              </div>
            </li>
          </ul>
        </details>
      </section>
    </div>

    <footer class="footer">
      <span class="footer-note">
        取词/替换期间仅备份与恢复纯文本、HTML、RTF 与位图剪贴板格式
      </span>
      <div class="footer-actions">
        <button type="button" @click="handleCancel">取消</button>
        <button type="button" class="primary" :disabled="saving" @click="handleSave">
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.settings-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 14px;
  gap: 12px;
}

.alert-error {
  padding: 8px 12px;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 13px;
}

.alert-warn {
  padding: 8px 12px;
  border: 1px solid #d97706;
  border-radius: 6px;
  background: rgba(217, 119, 6, 0.12);
  color: #b45309;
  font-size: 13px;
}

.conflict-list {
  margin: 4px 0 0;
  padding-left: 18px;
}

.sections {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.group {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--bg-elevated);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-title {
  margin: 0 0 2px;
  font-size: 14px;
  font-weight: 600;
}

.row {
  display: grid;
  grid-template-columns: 112px 1fr;
  align-items: center;
  gap: 8px;
}

.label {
  font-size: 13px;
  color: var(--fg);
}

.stack-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hint {
  font-size: 12px;
  color: var(--muted);
}

.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.hotkey-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hotkey-cell input {
  flex: 1;
}

.inline-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.inline-actions select {
  flex: 1;
}

.test-result {
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  word-break: break-word;
  border: 1px solid var(--border);
}

.test-ok {
  color: var(--success);
  background: var(--bg);
}

.test-err {
  color: var(--danger);
  background: var(--danger-bg);
  border-color: var(--danger);
}

.hk-status {
  font-size: 12px;
  white-space: nowrap;
}

.hk-valid {
  color: var(--success);
}

.hk-invalid {
  color: var(--danger);
}

.hk-occupied {
  color: var(--warn);
}

.prompt-block {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prompt-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.prompt-toolbar select {
  flex: 1;
}

.history-limit-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-limit-cell input {
  width: 110px;
}

.history-summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  user-select: none;
}

.history-empty {
  margin-top: 8px;
  font-size: 13px;
  color: var(--muted);
}

.history-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.history-item {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}

.history-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
}

.history-text {
  margin-top: 2px;
  font-size: 13px;
  word-break: break-all;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.footer-note {
  font-size: 12px;
  color: var(--muted);
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
