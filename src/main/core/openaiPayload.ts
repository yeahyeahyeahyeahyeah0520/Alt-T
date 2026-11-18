import {
  DEFAULT_PROMPTS,
  ProviderError,
  TARGET_LANG_NAME,
  type OpenAIProviderConfig,
  type PromptTemplate,
  type ProviderRequest,
  type TargetLang
} from '../../shared/types'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function renderPrompt(tpl: string, vars: { to: TargetLang; text: string }): string {
  let out = tpl.split('{{to}}').join(vars.to)
  out = out.split('{{toName}}').join(TARGET_LANG_NAME[vars.to])
  out = out.replace(/\{\{text\}\}/g, () => vars.text)
  return out
}

function selectPrompt(cfg: OpenAIProviderConfig): PromptTemplate {
  const list = cfg.prompts.length > 0 ? cfg.prompts : DEFAULT_PROMPTS
  return list.find((p) => p.id === cfg.activePromptId) ?? list[0]
}

export function buildMessages(prompt: PromptTemplate, req: ProviderRequest): ChatMessage[] {
  const sys = renderPrompt(prompt.systemPrompt, { to: req.to, text: req.text })
  const renderedUsr = renderPrompt(prompt.userPrompt, { to: req.to, text: req.text })
  const usr = renderedUsr.trim() === '' ? req.text : renderedUsr

  return [
    { role: 'system', content: sys },
    { role: 'user', content: usr }
  ]
}

export function buildRequestBody(
  cfg: OpenAIProviderConfig,
  req: ProviderRequest,
  stream: boolean
): string {
  const prompt = selectPrompt(cfg)
  const messages = buildMessages(prompt, req)
  return JSON.stringify({
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    stream
  })
}

export function extractNonStreamText(json: unknown): string {
  if (!isRecord(json) || !Array.isArray(json.choices) || json.choices.length === 0) {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'openai',
      message: 'Missing choices in OpenAI response',
      retryable: true
    })
  }

  const firstChoice = json.choices[0]
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'openai',
      message: 'Missing message in OpenAI response',
      retryable: true
    })
  }

  const content = firstChoice.message.content
  if (typeof content !== 'string' || content === '') {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'openai',
      message: 'Empty or non-string content in OpenAI response',
      retryable: true
    })
  }

  return content
}

export function extractStreamDelta(data: string): { done: boolean; delta: string } {
  if (data.trim() === '[DONE]') {
    return { done: true, delta: '' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'openai',
      message: 'Invalid JSON in SSE event',
      retryable: true
    })
  }

  if (!isRecord(parsed)) {
    throw new ProviderError({
      code: 'PARSE',
      provider: 'openai',
      message: 'SSE event JSON is not an object',
      retryable: true
    })
  }

  if ('error' in parsed && parsed.error !== undefined && parsed.error !== null) {
    let errMsg = 'OpenAI stream error'
    let status: number | undefined
    if (isRecord(parsed.error)) {
      if (typeof parsed.error.message === 'string' && parsed.error.message !== '') {
        errMsg = parsed.error.message
      }
      if (typeof parsed.error.status === 'number' && Number.isFinite(parsed.error.status)) {
        status = parsed.error.status
      }
    } else if (typeof parsed.error === 'string' && parsed.error !== '') {
      errMsg = parsed.error
    }

    throw new ProviderError({
      code: 'HTTP',
      provider: 'openai',
      message: errMsg,
      status,
      retryable: true
    })
  }

  if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
    const firstChoice = parsed.choices[0]
    if (isRecord(firstChoice) && isRecord(firstChoice.delta)) {
      const content = firstChoice.delta.content
      if (typeof content === 'string') {
        return { done: false, delta: content }
      }
    }
  }

  return { done: false, delta: '' }
}
