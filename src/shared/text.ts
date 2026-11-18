import type { TargetLang } from './types'

const CJK_CHAR_RE = /[\u4e00-\u9fff]/

const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/**
 * Automatically detect the target translation language.
 * Contains any CJK unified ideograph -> 'en'; otherwise -> 'zh-Hans'.
 */
export function detectTargetLang(text: string): TargetLang {
  return CJK_CHAR_RE.test(text) ? 'en' : 'zh-Hans'
}

/**
 * Truncate text into a single-line preview of at most `max` characters.
 */
export function truncatePreview(text: string, max: number): string {
  if (max <= 0) return ''
  const singleLine = text.replace(/[\r\n]+/g, ' ')
  if (singleLine.length <= max) return singleLine
  if (max === 1) return singleLine.slice(0, 1)
  return singleLine.slice(0, max - 1) + '\u2026'
}

/**
 * Strip accidental trailing spaces/tabs captured from terminal padding cells on single-line selections.
 */
export function normalizeTerminalCapturedText(raw: string): string {
  if (raw.includes('\n') || raw.includes('\r')) {
    return raw
  }
  return raw.replace(/[ \t]+$/g, '')
}

/**
 * Count extended grapheme clusters in a string (1 cluster = 1 interactive Backspace in modern shells/TUIs).
 */
export function countGraphemes(text: string): number {
  if (text === '') return 0
  if (graphemeSegmenter !== null) {
    let count = 0
    for (const _seg of graphemeSegmenter.segment(text)) {
      count++
    }
    return count
  }
  return Array.from(text).length
}

/**
 * Count how many Backspace keystrokes are needed to erase a single-line terminal selection at cursor end.
 * Multi-line selections return 0 to avoid unintended line deletions across prompts.
 */
export function countTerminalEraseChars(captured: string): number {
  if (captured.includes('\n') || captured.includes('\r')) {
    return 0
  }
  const clean = normalizeTerminalCapturedText(captured)
  return countGraphemes(clean)
}
