import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SseLineParser } from '../src/main/core/sseParser'
import { extractStreamDelta } from '../src/main/core/openaiPayload'
import { ProviderError } from '../src/shared/types'

describe('SseLineParser', () => {
  it('1. parses two complete events in a single chunk', () => {
    const parser = new SseLineParser()
    const events = parser.push('data: {"a":1}\n\ndata: {"a":2}\n\n')
    assert.deepEqual(events, [{ data: '{"a":1}' }, { data: '{"a":2}' }])
  })

  it('2. handles a data line split across chunk boundaries', () => {
    const parser = new SseLineParser()
    assert.deepEqual(parser.push('da'), [])
    assert.deepEqual(parser.push('ta: {"a":1}\n'), [])
    assert.deepEqual(parser.push('\n'), [{ data: '{"a":1}' }])
  })

  it('3. handles CRLF and CR/LF split across two chunks', () => {
    const parser = new SseLineParser()
    assert.deepEqual(parser.push('data: one\r'), [])
    assert.deepEqual(parser.push('\ndata: two\r\n\r'), [])
    assert.deepEqual(parser.push('\n'), [{ data: 'one\ntwo' }])
  })

  it('4. ignores comment lines such as keep-alive', () => {
    const parser = new SseLineParser()
    const events = parser.push(': keep-alive\n\ndata: {"ok":true}\n: mid-comment\n\n')
    assert.deepEqual(events, [{ data: '{"ok":true}' }])
  })

  it('5. joins multiple data lines within one event using newline', () => {
    const parser = new SseLineParser()
    const events = parser.push('event: message\nid: 42\ndata: line1\ndata: line2\n\n')
    assert.deepEqual(events, [{ data: 'line1\nline2' }])
  })

  it('6. strips at most one leading space after colon in data field', () => {
    const parser = new SseLineParser()
    const e1 = parser.push('data:{"x":1}\n\n')
    const e2 = parser.push('data: {"x":1}\n\n')
    const e3 = parser.push('data:  {"x":1}\n\n')
    assert.deepEqual(e1, [{ data: '{"x":1}' }])
    assert.deepEqual(e2, [{ data: '{"x":1}' }])
    assert.deepEqual(e3, [{ data: ' {"x":1}' }])
  })

  it('7. strips leading BOM (U+FEFF) on the first chunk', () => {
    const parser = new SseLineParser()
    const events = parser.push('\uFEFFdata: {"bom":false}\n\n')
    assert.deepEqual(events, [{ data: '{"bom":false}' }])
  })

  it('8. flushes remaining buffered event when stream ends without trailing blank line', () => {
    const parser = new SseLineParser()
    assert.deepEqual(parser.push('data: trailing'), [])
    assert.deepEqual(parser.flush(), [{ data: 'trailing' }])
    assert.deepEqual(parser.flush(), [])
  })

  it('9. handles standalone CR line endings and flush with trailing CR', () => {
    const parser = new SseLineParser()
    assert.deepEqual(parser.push('data: alpha\rdata: beta\r'), [])
    assert.deepEqual(parser.flush(), [{ data: 'alpha\nbeta' }])
  })
})

describe('extractStreamDelta', () => {
  it('10. handles [DONE], normal delta, missing content, invalid JSON, and error field', () => {
    assert.deepEqual(extractStreamDelta(' [DONE] '), { done: true, delta: '' })

    assert.deepEqual(
      extractStreamDelta(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })),
      { done: false, delta: 'hi' }
    )

    assert.deepEqual(
      extractStreamDelta(
        JSON.stringify({ choices: [{ delta: { role: 'assistant', reasoning_content: 'think' } }] })
      ),
      { done: false, delta: '' }
    )

    assert.throws(
      () => extractStreamDelta('{not-json'),
      (err: unknown) => err instanceof ProviderError && err.info.code === 'PARSE'
    )

    assert.throws(
      () => extractStreamDelta(JSON.stringify({ error: { message: 'rate limit', status: 429 } })),
      (err: unknown) =>
        err instanceof ProviderError &&
        err.info.code === 'HTTP' &&
        err.info.message === 'rate limit' &&
        err.info.status === 429
    )
  })
})
