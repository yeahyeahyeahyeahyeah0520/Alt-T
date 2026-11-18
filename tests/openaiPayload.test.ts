import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRequestBody,
  extractNonStreamText,
  renderPrompt
} from '../src/main/core/openaiPayload'
import { DEFAULT_CONFIG, DEFAULT_PROMPTS, ProviderError } from '../src/shared/types'

describe('renderPrompt', () => {
  it('replaces {{to}}, {{toName}}, and {{text}} without double-expanding placeholders inside text', () => {
    const tpl = 'Target={{toName}} ({{to}}). Input: {{text}}'
    const out = renderPrompt(tpl, {
      to: 'zh-Hans',
      text: 'literal {{to}} and {{toName}} and $&'
    })
    assert.equal(out, 'Target=简体中文 (zh-Hans). Input: literal {{to}} and {{toName}} and $&')
  })

  it('maps en target language name properly', () => {
    const out = renderPrompt('{{toName}}:{{to}}', { to: 'en', text: 'x' })
    assert.equal(out, 'English:en')
  })
})

describe('buildRequestBody', () => {
  it('builds a text request body with 2 messages, stream, temperature, and no disallowed params', () => {
    const raw = buildRequestBody(
      DEFAULT_CONFIG.openai,
      { text: 'hello world', to: 'zh-Hans' },
      true
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>

    assert.equal(parsed.model, DEFAULT_CONFIG.openai.model)
    assert.equal(parsed.stream, true)
    assert.equal(parsed.temperature, DEFAULT_CONFIG.openai.temperature)
    assert.equal('max_tokens' in parsed, false)
    assert.equal('stream_options' in parsed, false)

    const messages = parsed.messages as Array<{ role: string; content: unknown }>
    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'system')
    assert.equal(typeof messages[0].content, 'string')
    assert.match(messages[0].content as string, /简体中文 \(zh-Hans\)/)
    assert.equal(messages[1].role, 'user')
    assert.equal(messages[1].content, 'hello world')
  })

  it('falls back to first prompt when activePromptId is missing', () => {
    const cfg = {
      ...DEFAULT_CONFIG.openai,
      activePromptId: 'nonexistent',
      prompts: [DEFAULT_PROMPTS[0]]
    }
    const raw = buildRequestBody(cfg, { text: 'test', to: 'en' }, false)
    const parsed = JSON.parse(raw) as {
      stream: boolean
      messages: Array<{ role: string; content: string }>
    }
    assert.equal(parsed.stream, false)
    assert.equal(parsed.messages[1].content, 'test')
  })
})

describe('extractNonStreamText', () => {
  it('returns content verbatim without trimming', () => {
    const res = extractNonStreamText({
      choices: [{ message: { content: '  你好  \n' } }]
    })
    assert.equal(res, '  你好  \n')
  })

  it('throws PARSE on empty choices, non-string content, empty string, or malformed payloads', () => {
    const badPayloads: unknown[] = [
      null,
      'string',
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: null } }] },
      { choices: [{ message: { content: 123 } }] },
      { choices: [{ message: { content: ['part'] } }] },
      { choices: [{ message: { content: '' } }] }
    ]

    for (const payload of badPayloads) {
      assert.throws(
        () => extractNonStreamText(payload),
        (err: unknown) => err instanceof ProviderError && err.info.code === 'PARSE'
      )
    }
  })
})
