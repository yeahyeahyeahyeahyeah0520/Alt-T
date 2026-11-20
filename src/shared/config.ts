import {
  DEFAULT_CONFIG,
  DEFAULT_PROMPTS,
  type AppConfig,
  type HistoryItem,
  type HotkeyConfig,
  type OpenAIProviderConfig,
  type PromptTemplate,
  type ProviderId,
  type ProxyConfig,
  type TargetLang
} from './types'

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function cloneDefaultPrompts(): PromptTemplate[] {
  return DEFAULT_PROMPTS.map((p) => ({ ...p }))
}

export function isTargetLang(v: unknown): v is TargetLang {
  return v === 'en' || v === 'zh-Hans'
}

export function isProviderId(v: unknown): v is ProviderId {
  return v === 'openai' || v === 'edge'
}

function mergeHotkeys(raw: unknown): HotkeyConfig {
  const def = DEFAULT_CONFIG.hotkeys
  if (!isRecord(raw)) return { ...def }
  return {
    directInputTranslate:
      typeof raw.directInputTranslate === 'string' && raw.directInputTranslate.trim() !== ''
        ? raw.directInputTranslate.trim()
        : def.directInputTranslate,
    replaceTranslate:
      typeof raw.replaceTranslate === 'string' && raw.replaceTranslate.trim() !== ''
        ? raw.replaceTranslate.trim()
        : def.replaceTranslate,
    selectionTranslate:
      typeof raw.selectionTranslate === 'string' && raw.selectionTranslate.trim() !== ''
        ? raw.selectionTranslate.trim()
        : def.selectionTranslate,
    togglePopup:
      typeof raw.togglePopup === 'string' && raw.togglePopup.trim() !== ''
        ? raw.togglePopup.trim()
        : def.togglePopup
  }
}

function mergePrompts(raw: unknown): PromptTemplate[] {
  if (!Array.isArray(raw)) return cloneDefaultPrompts()
  const out: PromptTemplate[] = []
  const seenIds = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item)) continue
    if (
      typeof item.id !== 'string' ||
      item.id.trim() === '' ||
      typeof item.name !== 'string' ||
      typeof item.systemPrompt !== 'string' ||
      typeof item.userPrompt !== 'string'
    ) {
      continue
    }
    const id = item.id.trim()
    if (seenIds.has(id)) continue
    seenIds.add(id)
    out.push({
      id,
      name: item.name,
      systemPrompt: item.systemPrompt,
      userPrompt: item.userPrompt
    })
  }
  return out.length > 0 ? out : cloneDefaultPrompts()
}

const PROTECTED_PROMPT_IDS: ReadonlySet<string> = new Set(['translate', 'cli-prompt'])

export function isProtectedPromptId(id: string): boolean {
  return PROTECTED_PROMPT_IDS.has(id.trim())
}

export function restoreDefaultPrompts(currentPrompts?: PromptTemplate[]): PromptTemplate[] {
  const defaults = cloneDefaultPrompts()
  if (!Array.isArray(currentPrompts) || currentPrompts.length === 0) {
    return defaults
  }
  const defaultIds = new Set(defaults.map((p) => p.id))
  const customPrompts = currentPrompts
    .filter((p) => !defaultIds.has(p.id))
    .map((p) => ({ ...p }))
  return [...defaults, ...customPrompts]
}

function mergeOpenAI(raw: unknown): OpenAIProviderConfig {
  const def = DEFAULT_CONFIG.openai
  if (!isRecord(raw)) {
    return {
      ...def,
      prompts: cloneDefaultPrompts()
    }
  }
  const prompts = mergePrompts(raw.prompts)
  const rawActiveId = typeof raw.activePromptId === 'string' ? raw.activePromptId.trim() : ''
  const activePromptId =
    rawActiveId !== '' && prompts.some((p) => p.id === rawActiveId)
      ? rawActiveId
      : prompts[0].id

  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : def.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : def.apiKey,
    model: typeof raw.model === 'string' ? raw.model.trim() : def.model,
    stream: typeof raw.stream === 'boolean' ? raw.stream : def.stream,
    activePromptId,
    prompts,
    temperature:
      typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)
        ? clamp(raw.temperature, 0, 2)
        : def.temperature
  }
}

function mergeProxy(raw: unknown): ProxyConfig {
  const def = DEFAULT_CONFIG.proxy
  if (!isRecord(raw)) return { ...def }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : def.enabled,
    url: typeof raw.url === 'string' ? raw.url.trim() : def.url
  }
}

function mergeExeNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const norm = item.trim().toLowerCase()
    if (norm.length === 0 || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

export function createHistoryEntry(params: {
  id: string
  at: number
  from: string
  to: string
  provider: ProviderId
  target: TargetLang
}): HistoryItem {
  return {
    id: params.id,
    at: params.at,
    from: params.from.slice(0, 2000),
    to: params.to.slice(0, 4000),
    provider: params.provider,
    target: params.target
  }
}

function mergeHistory(raw: unknown, limit: number): HistoryItem[] {
  if (!Array.isArray(raw) || limit <= 0) return []
  const out: HistoryItem[] = []
  for (const item of raw) {
    if (out.length >= limit) break
    if (!isRecord(item)) continue
    if (
      typeof item.id !== 'string' ||
      item.id.trim() === '' ||
      typeof item.at !== 'number' ||
      !Number.isFinite(item.at) ||
      typeof item.from !== 'string' ||
      typeof item.to !== 'string' ||
      !isProviderId(item.provider) ||
      !isTargetLang(item.target)
    ) {
      continue
    }
    out.push({
      id: item.id,
      at: item.at,
      from: item.from.slice(0, 2000),
      to: item.to.slice(0, 4000),
      provider: item.provider,
      target: item.target
    })
  }
  return out
}

export const HOTKEY_KEYS: ReadonlyArray<keyof HotkeyConfig> = [
  'directInputTranslate',
  'replaceTranslate',
  'selectionTranslate',
  'togglePopup'
]

const MODIFIER_ALIAS_MAP: Record<string, 'ctrl' | 'alt' | 'shift' | 'super'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  commandorcontrol: 'ctrl',
  cmdorctrl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'super',
  meta: 'super',
  command: 'super',
  cmd: 'super',
  win: 'super'
}

const MODIFIER_ORDER: Record<'ctrl' | 'alt' | 'shift' | 'super', number> = {
  ctrl: 0,
  alt: 1,
  shift: 2,
  super: 3
}

const VALID_NAMED_KEYS = new Set<string>([
  'plus',
  'space',
  'tab',
  'capslock',
  'numlock',
  'scrolllock',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'escape',
  'esc',
  'volumeup',
  'volumedown',
  'volumemute',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause',
  'printscreen',
  'num0',
  'num1',
  'num2',
  'num3',
  'num4',
  'num5',
  'num6',
  'num7',
  'num8',
  'num9',
  'numdec',
  'numadd',
  'numsub',
  'nummult',
  'numdiv'
])

const FUNCTION_KEY_RE = /^f([1-9]|1[0-9]|2[0-4])$/
const SINGLE_KEY_RE = /^[a-z0-9~!@#$%^&*()_\-=\[\]{}\\|;:'",.<>/?`]$/

function isValidMainKey(lowerKey: string): boolean {
  return FUNCTION_KEY_RE.test(lowerKey) || VALID_NAMED_KEYS.has(lowerKey) || SINGLE_KEY_RE.test(lowerKey)
}

export function isValidGlobalAccelerator(accel: string): boolean {
  const trimmed = accel.trim()
  if (trimmed === '') return false
  const rawParts = trimmed.split('+')
  const parts = rawParts.map((p) => p.trim())
  if (parts.some((p) => p === '')) return false

  const seenMods = new Set<string>()
  let mainKey: string | null = null

  for (const part of parts) {
    const lower = part.toLowerCase()
    const mod = MODIFIER_ALIAS_MAP[lower]
    if (mod !== undefined) {
      if (mainKey !== null || seenMods.has(mod)) {
        return false
      }
      seenMods.add(mod)
      continue
    }
    if (mainKey !== null || !isValidMainKey(lower)) {
      return false
    }
    mainKey = lower
  }

  if (mainKey === null) return false
  if (seenMods.size === 0) {
    return FUNCTION_KEY_RE.test(mainKey)
  }
  return true
}

export function normalizeAcceleratorKey(accel: string): string {
  const parts = accel
    .trim()
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)

  const mods: Array<'ctrl' | 'alt' | 'shift' | 'super'> = []
  const modSet = new Set<'ctrl' | 'alt' | 'shift' | 'super'>()
  const rest: string[] = []

  for (const part of parts) {
    const mod = MODIFIER_ALIAS_MAP[part]
    if (mod !== undefined) {
      if (!modSet.has(mod)) {
        modSet.add(mod)
        mods.push(mod)
      }
    } else {
      rest.push(part)
    }
  }

  mods.sort((a, b) => MODIFIER_ORDER[a] - MODIFIER_ORDER[b])
  return [...mods, ...rest].join('+')
}

export function findDuplicateHotkeys(
  hotkeys: HotkeyConfig
): Array<{ key: keyof HotkeyConfig; accelerator: string }> {
  const seen = new Map<string, keyof HotkeyConfig>()
  const duplicates = new Set<keyof HotkeyConfig>()

  for (const key of HOTKEY_KEYS) {
    const raw = hotkeys[key].trim()
    if (raw === '') continue
    const norm = normalizeAcceleratorKey(raw)
    const firstKey = seen.get(norm)
    if (firstKey !== undefined) {
      duplicates.add(firstKey)
      duplicates.add(key)
    } else {
      seen.set(norm, key)
    }
  }

  return HOTKEY_KEYS.filter((k) => duplicates.has(k)).map((key) => ({
    key,
    accelerator: hotkeys[key].trim()
  }))
}

export function mergeConfig(raw: unknown): AppConfig {
  if (!isRecord(raw)) {
    return {
      ...DEFAULT_CONFIG,
      hotkeys: { ...DEFAULT_CONFIG.hotkeys },
      openai: {
        ...DEFAULT_CONFIG.openai,
        prompts: cloneDefaultPrompts()
      },
      proxy: { ...DEFAULT_CONFIG.proxy },
      customWtExeNames: [],
      customConhostExeNames: [],
      history: []
    }
  }

  const historyLimit =
    typeof raw.historyLimit === 'number' && Number.isFinite(raw.historyLimit)
      ? clamp(Math.round(raw.historyLimit), 0, 1000)
      : DEFAULT_CONFIG.historyLimit

  return {
    version: 1,
    autoLaunch: typeof raw.autoLaunch === 'boolean' ? raw.autoLaunch : DEFAULT_CONFIG.autoLaunch,
    terminalAutoBackspace:
      typeof raw.terminalAutoBackspace === 'boolean'
        ? raw.terminalAutoBackspace
        : DEFAULT_CONFIG.terminalAutoBackspace,
    hotkeys: mergeHotkeys(raw.hotkeys),
    primaryProvider: isProviderId(raw.primaryProvider)
      ? raw.primaryProvider
      : DEFAULT_CONFIG.primaryProvider,
    enableFallback:
      typeof raw.enableFallback === 'boolean' ? raw.enableFallback : DEFAULT_CONFIG.enableFallback,
    openai: mergeOpenAI(raw.openai),
    proxy: mergeProxy(raw.proxy),
    defaultTargetLang: isTargetLang(raw.defaultTargetLang)
      ? raw.defaultTargetLang
      : DEFAULT_CONFIG.defaultTargetLang,
    historyEnabled:
      typeof raw.historyEnabled === 'boolean' ? raw.historyEnabled : DEFAULT_CONFIG.historyEnabled,
    historyLimit,
    popupWidth:
      typeof raw.popupWidth === 'number' && Number.isFinite(raw.popupWidth)
        ? clamp(Math.round(raw.popupWidth), 360, 4000)
        : DEFAULT_CONFIG.popupWidth,
    popupHeight:
      typeof raw.popupHeight === 'number' && Number.isFinite(raw.popupHeight)
        ? clamp(Math.round(raw.popupHeight), 200, 4000)
        : DEFAULT_CONFIG.popupHeight,
    customWtExeNames: mergeExeNameList(raw.customWtExeNames),
    customConhostExeNames: mergeExeNameList(raw.customConhostExeNames),
    history: mergeHistory(raw.history, historyLimit)
  }
}
