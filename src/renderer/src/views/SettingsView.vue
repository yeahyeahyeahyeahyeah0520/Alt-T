<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  findDuplicateHotkeys,
  isProtectedPromptId,
  isValidGlobalAccelerator,
  mergeConfig,
  restoreDefaultPrompts,
  TEXT_EXCLUDED_PROMPT_IDS
} from '../../../shared/config'
import { truncatePreview } from '../../../shared/text'
import {
  DEFAULT_CONFIG,
  TARGET_LANG_NAME,
  type AppConfig,
  type HistoryItem,
  type HotkeyConfig,
  type PromptTemplate
} from '../../../shared/types'

type HotkeyStatusKind = 'idle' | 'valid' | 'invalid' | 'occupied' | 'duplicate'

interface HotkeyFieldMeta {
  key: keyof HotkeyConfig
  label: string
}

const HOTKEY_FIELDS: HotkeyFieldMeta[] = [
  { key: 'directInputTranslate', label: '极速译入终端/窗口' },
  { key: 'replaceTranslate', label: '取词并原地替换' },
  { key: 'selectionTranslate', label: '取词并浮窗翻译' },
  { key: 'togglePopup', label: '显示/隐藏主浮窗' }
]

const HOTKEY_LABEL_MAP: Record<keyof HotkeyConfig, string> = {
  directInputTranslate: '极速译入终端/窗口',
  replaceTranslate: '取词并原地替换',
  selectionTranslate: '取词并浮窗翻译',
  togglePopup: '显示/隐藏主浮窗'
}

const form = ref<AppConfig>(mergeConfig(DEFAULT_CONFIG))
const historyItems = ref<HistoryItem[]>([])
const latestPopupWidth = ref(DEFAULT_CONFIG.popupWidth)
const latestPopupHeight = ref(DEFAULT_CONFIG.popupHeight)

const hotkeyStatus = ref<Record<keyof HotkeyConfig, HotkeyStatusKind>>({
  directInputTranslate: 'idle',
  replaceTranslate: 'idle',
  selectionTranslate: 'idle',
  togglePopup: 'idle'
})

const hotkeyConflicts = ref<Array<{ key: keyof HotkeyConfig; accelerator: string }>>([])
const saveError = ref('')
const saving = ref(false)
const historyExpanded = ref(false)

const selectablePrompts = computed<PromptTemplate[]>(() =>
  form.value.openai.prompts.filter((p) => !TEXT_EXCLUDED_PROMPT_IDS.includes(p.id))
)

const activePrompt = computed<PromptTemplate | undefined>(() =>
  selectablePrompts.value.find((p) => p.id === form.value.openai.activePromptId)
)

const canDeletePrompt = computed(() => {
  const current = activePrompt.value
  return Boolean(current && !isProtectedPromptId(current.id) && selectablePrompts.value.length > 1)
})

const recentHistory = computed(() => historyItems.value.slice(0, 50))

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
  const firstSelectable = remaining.find((p) => !TEXT_EXCLUDED_PROMPT_IDS.includes(p.id))
  form.value.openai.activePromptId = (firstSelectable ?? remaining[0]).id
}

function handleRestoreDefaultPrompts(): void {
  const restored = restoreDefaultPrompts(form.value.openai.prompts)
  form.value.openai.prompts = restored
  const selectable = restored.filter((p) => !TEXT_EXCLUDED_PROMPT_IDS.includes(p.id))
  if (!selectable.some((p) => p.id === form.value.openai.activePromptId)) {
    form.value.openai.activePromptId = selectable[0]?.id ?? restored[0]?.id ?? 'translate'
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

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

async function handleSave(): Promise<void> {
  saving.value = true
  hotkeyConflicts.value = []
  saveError.value = ''

  try {
    const temperature = clampNumber(
      form.value.openai.temperature,
      0,
      2,
      DEFAULT_CONFIG.openai.temperature
    )
    const historyLimit = Math.round(
      clampNumber(form.value.historyLimit, 0, 1000, DEFAULT_CONFIG.historyLimit)
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
      popupWidth: latestPopupWidth.value,
      popupHeight: latestPopupHeight.value,
      history: historyItems.value
    })

    const reply = await window.api.configSet({ config: payload })
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
          提示：在 VS Code / Antigravity 等 IDE 内置终端中，推荐使用 Alt+T 极速译入英文并回车上屏。
        </div>
      </section>

      <section class="group">
        <h2 class="group-title">翻译源</h2>
        <div class="row">
          <label class="label" for="primary-provider">主翻译源</label>
          <select id="primary-provider" v-model="form.primaryProvider">
            <option value="edge">Edge 免费直连</option>
            <option value="openai">OpenAI 兼容</option>
          </select>
        </div>
        <div class="row">
          <span class="label">自动回退</span>
          <label class="checkbox-label">
            <input v-model="form.enableFallback" type="checkbox" />
            主源失败后自动改用备用源
          </label>
        </div>
      </section>

      <section class="group">
        <h2 class="group-title">OpenAI 兼容</h2>
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
          <input
            id="openai-api-key"
            v-model="form.openai.apiKey"
            type="password"
            autocomplete="off"
          />
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
              默认关闭（安全浮窗模式）：在终端划选按 Alt+R 时先弹出译文预览，按 Enter 安全填入，避免盲发退格误删命令行；开启后（Option B）将按字形簇自动退格替换。VS Code 等 IDE 内置终端推荐直接按 Alt+T。
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
          <span class="label">记录历史</span>
          <label class="checkbox-label">
            <input v-model="form.historyEnabled" type="checkbox" />
            保存翻译历史记录
          </label>
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
