import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildChatCompletionsUrl, normalizeBaseUrl } from '../src/main/core/baseUrl'

describe('normalizeBaseUrl', () => {
  it('1. appends /v1 when bare origin has no path', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com'), 'https://api.openai.com/v1')
  })

  it('2. strips trailing slash and appends /v1', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/'), 'https://api.openai.com/v1')
  })

  it('3. keeps existing /v1', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1')
  })

  it('4. strips trailing slash after /v1', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
  })

  it('5. strips /chat/completions suffix and keeps /v1', () => {
    assert.equal(
      normalizeBaseUrl('https://api.openai.com/v1/chat/completions'),
      'https://api.openai.com/v1'
    )
  })

  it('6. keeps /v1beta/openai versioned path as-is', () => {
    assert.equal(
      normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'),
      'https://generativelanguage.googleapis.com/v1beta/openai'
    )
  })

  it('7. strips trailing slash on /v1beta/openai/', () => {
    assert.equal(
      normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/'),
      'https://generativelanguage.googleapis.com/v1beta/openai'
    )
  })

  it('8. keeps /v4 versioned path as-is', () => {
    assert.equal(
      normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4'),
      'https://open.bigmodel.cn/api/paas/v4'
    )
  })

  it('9. trims whitespace and appends /v1 to non-versioned subpath', () => {
    assert.equal(normalizeBaseUrl('  https://example.com/api  '), 'https://example.com/api/v1')
  })

  it('10. supports http localhost with port', () => {
    assert.equal(normalizeBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1')
  })

  it('11. strips query string and hash fragment', () => {
    assert.equal(
      normalizeBaseUrl('https://example.com/v1?key=1#x'),
      'https://example.com/v1'
    )
  })

  it('12. rejects URL without protocol', () => {
    assert.throws(() => normalizeBaseUrl('example.com'), /BASE_URL_INVALID/)
  })

  it('13. rejects empty or whitespace-only URL', () => {
    assert.throws(() => normalizeBaseUrl(''), /BASE_URL_INVALID/)
    assert.throws(() => normalizeBaseUrl('   '), /BASE_URL_INVALID/)
  })

  it('14. rejects unsupported protocol such as ftp:', () => {
    assert.throws(() => normalizeBaseUrl('ftp://x.com'), /BASE_URL_INVALID/)
  })

  it('15. strips case-insensitive /Chat/Completions/ suffix', () => {
    assert.equal(
      normalizeBaseUrl('https://api.openai.com/v1/Chat/Completions/'),
      'https://api.openai.com/v1'
    )
  })
})

describe('buildChatCompletionsUrl', () => {
  it('16. appends /chat/completions to normalized Gemini OpenAI base URL', () => {
    assert.equal(
      buildChatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai'),
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    )
  })
})
