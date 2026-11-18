import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findDuplicateHotkeys,
  isProviderId,
  isTargetLang,
  mergeConfig,
  normalizeAcceleratorKey
} from '../src/shared/config'
import { DEFAULT_CONFIG, DEFAULT_PROMPTS } from '../src/shared/types'

describe('type guards', () => {
  it('validates TargetLang and ProviderId', () => {
    assert.equal(isTargetLang('en'), true)
    assert.equal(isTargetLang('zh-Hans'), true)
    assert.equal(isTargetLang('ja'), false)
    assert.equal(isProviderId('openai'), true)
    assert.equal(isProviderId('edge'), true)
    assert.equal(isProviderId('google'), false)
  })
})

describe('mergeConfig', () => {
  it('returns full default config for non-objects or empty object', () => {
    for (const bad of [null, undefined, 'str', 123, [], {}]) {
      const cfg = mergeConfig(bad)
      assert.deepEqual(cfg, DEFAULT_CONFIG)
      assert.notEqual(cfg, DEFAULT_CONFIG)
      assert.notEqual(cfg.openai.prompts, DEFAULT_PROMPTS)
    }
  })

  it('falls back primaryProvider to edge when invalid', () => {
    assert.equal(mergeConfig({ primaryProvider: 'invalid' }).primaryProvider, 'edge')
    assert.equal(mergeConfig({ primaryProvider: 'openai' }).primaryProvider, 'openai')
  })

  it('clamps historyLimit to [0, 1000]', () => {
    assert.equal(mergeConfig({ historyLimit: -10 }).historyLimit, 0)
    assert.equal(mergeConfig({ historyLimit: 2500 }).historyLimit, 1000)
    assert.equal(mergeConfig({ historyLimit: 50 }).historyLimit, 50)
    assert.equal(mergeConfig({ historyLimit: Number.NaN }).historyLimit, DEFAULT_CONFIG.historyLimit)
  })

  it('falls back to default two prompts when prompts is empty array', () => {
    const cfg = mergeConfig({ openai: { prompts: [], activePromptId: 'missing' } })
    assert.deepEqual(cfg.openai.prompts, DEFAULT_PROMPTS)
    assert.equal(cfg.openai.activePromptId, 'translate')
  })

  it('truncates history to historyLimit and filters invalid entries', () => {
    const items = [
      { id: '1', at: 100, from: 'a', to: '甲', provider: 'edge', target: 'zh-Hans' },
      { id: '2', at: 200, from: 'b', to: '乙', provider: 'openai', target: 'zh-Hans' },
      { id: '3', at: 300, from: 'c', to: '丙', provider: 'edge', target: 'en' }
    ]
    const cfg = mergeConfig({ historyLimit: 2, history: items })
    assert.equal(cfg.history.length, 2)
    assert.equal(cfg.history[0].id, '1')
    assert.equal(cfg.history[1].id, '2')

    const zeroLimit = mergeConfig({ historyLimit: 0, history: items })
    assert.deepEqual(zeroLimit.history, [])
  })

  it('discards unknown fields at root and nested levels', () => {
    const cfg = mergeConfig({
      unknownRoot: 123,
      hotkeys: { replaceTranslate: 'Alt+Shift+R', extraKey: 'x' },
      openai: { model: 'gpt-4o', extraOpenAI: true },
      proxy: { enabled: true, url: 'http://127.0.0.1:7890', extraProxy: 'y' }
    }) as unknown as Record<string, unknown>

    assert.equal('unknownRoot' in cfg, false)
    assert.equal('extraKey' in (cfg.hotkeys as Record<string, unknown>), false)
    assert.equal('extraOpenAI' in (cfg.openai as Record<string, unknown>), false)
    assert.equal('extraProxy' in (cfg.proxy as Record<string, unknown>), false)
  })

  it('merges autoLaunch and directInputTranslate hotkey with defaults', () => {
    const def = mergeConfig({})
    assert.equal(def.autoLaunch, true)
    assert.equal(def.hotkeys.directInputTranslate, 'Alt+T')

    const custom = mergeConfig({
      autoLaunch: false,
      hotkeys: { directInputTranslate: 'Alt+Shift+T' }
    })
    assert.equal(custom.autoLaunch, false)
    assert.equal(custom.hotkeys.directInputTranslate, 'Alt+Shift+T')
  })
})

describe('hotkey duplicate detection', () => {
  it('normalizes accelerator casing and spacing', () => {
    assert.equal(normalizeAcceleratorKey('  alt + shift + t '), 'alt+shift+t')
  })

  it('returns empty array when all 5 default hotkeys are distinct', () => {
    assert.deepEqual(findDuplicateHotkeys(DEFAULT_CONFIG.hotkeys), [])
  })

  it('identifies all conflicting slots when two hotkeys share the same accelerator', () => {
    const dupes = findDuplicateHotkeys({
      ...DEFAULT_CONFIG.hotkeys,
      directInputTranslate: 'alt+q',
      togglePopup: 'Alt+Q'
    })
    assert.deepEqual(dupes, [
      { key: 'directInputTranslate', accelerator: 'alt+q' },
      { key: 'togglePopup', accelerator: 'Alt+Q' }
    ])
  })
})
