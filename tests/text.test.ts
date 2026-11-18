import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  countGraphemes,
  countTerminalEraseChars,
  detectTargetLang,
  normalizeTerminalCapturedText,
  truncatePreview
} from '../src/shared/text'

describe('detectTargetLang', () => {
  it('detects Chinese characters and targets English', () => {
    assert.equal(detectTargetLang('你好'), 'en')
    assert.equal(detectTargetLang('hello 你'), 'en')
  })

  it('targets zh-Hans when no CJK unified ideographs are present', () => {
    assert.equal(detectTargetLang('hello'), 'zh-Hans')
    assert.equal(detectTargetLang('こんにちは'), 'zh-Hans')
    assert.equal(detectTargetLang(''), 'zh-Hans')
    assert.equal(detectTargetLang('123 !?'), 'zh-Hans')
  })
})

describe('truncatePreview', () => {
  it('returns single-line preview capped at max length', () => {
    assert.equal(truncatePreview('hello\nworld', 40), 'hello world')
    assert.equal(truncatePreview('abcdef', 4), 'abc\u2026')
    assert.equal(truncatePreview('abcdef', 0), '')
    assert.equal(truncatePreview('abcdef', 1), 'a')
  })
})

describe('terminal text helpers', () => {
  it('trims trailing horizontal spaces on single-line terminal captures', () => {
    assert.equal(normalizeTerminalCapturedText('帮我检查代码   \t'), '帮我检查代码')
    assert.equal(normalizeTerminalCapturedText('line1  \nline2  '), 'line1  \nline2  ')
  })

  it('counts exact grapheme clusters to backspace for single-line terminal text and 0 for multi-line', () => {
    assert.equal(countTerminalEraseChars('你好世界   '), 4)
    assert.equal(countTerminalEraseChars('hello 你好'), 8)
    assert.equal(countTerminalEraseChars('第一行\n第二行'), 0)
    assert.equal(countTerminalEraseChars('   '), 0)
    assert.equal(countGraphemes('\u26a0\ufe0f'), 1)
    assert.equal(countGraphemes('e\u0301'), 1)
    assert.equal(countGraphemes('\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66'), 1)
    assert.equal(countTerminalEraseChars('fix \u26a0\ufe0f bug   '), 9)
  })
})
