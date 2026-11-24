export type ProtectedKind =
  | 'fence'
  | 'inline-code'
  | 'url'
  | 'path'
  | 'env'
  | 'flag'
  | 'mention'

export interface ProtectedSpan {
  readonly id: number
  readonly token: string
  readonly kind: ProtectedKind
  readonly value: string
}

export interface ProtectedTextResult {
  readonly hasProtected: boolean
  readonly maskedText: string
  readonly prefix: string
  readonly spans: readonly ProtectedSpan[]
}

export type RestoreVerifyReason =
  | 'placeholder-missing'
  | 'placeholder-duplicated'
  | 'placeholder-reordered'
  | 'placeholder-invented'
  | 'placeholder-corrupted'

export interface RestoreVerifyResult {
  readonly ok: boolean
  readonly text: string
  readonly restored: boolean
  readonly reordered: boolean
  readonly reason?: RestoreVerifyReason
  readonly missingTokens: readonly string[]
  readonly unexpectedTokens: readonly string[]
}

interface Candidate {
  readonly start: number
  readonly end: number
  readonly kind: ProtectedKind
  readonly priority: number
  readonly value: string
}

const TOKEN_OPEN = '[['
const TOKEN_CLOSE = ']]'
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/
const CODE_EXTENSION_PATH_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|py|go|rs|java|c|cpp|h|hpp|cs|json|ya?ml|toml|md|txt|sh|ps1|bat|cmd|exe|dll|so|dylib|ini|cfg|conf|env|lock|log|sql|html|css|scss)$/i

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function chooseSafePrefix(source: string): string {
  const lower = source.toLowerCase()
  const base = 'ALTT'
  for (let i = 0; i < 64; i++) {
    const candidate = i === 0 ? base : `${base}${String.fromCharCode(65 + ((i - 1) % 26))}${i > 26 ? String(i) : ''}`
    if (!lower.includes(candidate.toLowerCase())) {
      return candidate
    }
  }
  return `ALTTZ${Date.now().toString(36).toUpperCase()}`
}

function scanFencedCodeBlocks(input: string): Candidate[] {
  const results: Candidate[] = []
  const openFenceRe = /^([`~]{3,})([^\r\n]*)$/gm
  let match: RegExpExecArray | null
  let searchMin = 0

  while ((match = openFenceRe.exec(input)) !== null) {
    if (match.index < searchMin) continue
    const fence = match[1]
    const ch = fence[0]
    const minLen = fence.length
    const lineEnd = input.indexOf('\n', match.index)
    if (lineEnd === -1) continue

    const closeRe = new RegExp(`^${escapeRegExp(ch)}{${minLen},}[ \\t]*(?:\\r?\\n|$)`, 'gm')
    closeRe.lastIndex = lineEnd + 1
    const closeMatch = closeRe.exec(input)
    if (!closeMatch) continue

    const endIdx = closeMatch.index + closeMatch[0].replace(/\r?\n$/, '').length
    results.push({
      start: match.index,
      end: endIdx,
      kind: 'fence',
      priority: 100,
      value: input.slice(match.index, endIdx)
    })
    searchMin = endIdx
  }

  // Fallback for inline ```...``` or ````...```` on a single line
  const inlineFenceRe = /(`{3,})[^\r\n]+\1/g
  let inlineMatch: RegExpExecArray | null
  while ((inlineMatch = inlineFenceRe.exec(input)) !== null) {
    results.push({
      start: inlineMatch.index,
      end: inlineMatch.index + inlineMatch[0].length,
      kind: 'fence',
      priority: 99,
      value: inlineMatch[0]
    })
  }
  return results
}

function scanInlineCodeSpans(input: string): Candidate[] {
  const results: Candidate[] = []
  let i = 0
  while (i < input.length) {
    if (input[i] !== '`') {
      i += 1
      continue
    }
    let tickLen = 0
    while (i + tickLen < input.length && input[i + tickLen] === '`') {
      tickLen += 1
    }
    if (tickLen >= 3) {
      i += tickLen
      continue
    }
    const opener = '`'.repeat(tickLen)
    let search = i + tickLen
    let foundClose = -1
    while (search < input.length) {
      const idx = input.indexOf(opener, search)
      if (idx === -1) break
      const prevChar = idx > 0 ? input[idx - 1] : ''
      const nextChar = idx + tickLen < input.length ? input[idx + tickLen] : ''
      if (prevChar === '`' || nextChar === '`') {
        search = idx + 1
        continue
      }
      foundClose = idx
      break
    }
    if (foundClose !== -1 && foundClose > i + tickLen) {
      const inner = input.slice(i + tickLen, foundClose)
      if (!inner.includes('\n') && inner.trim() !== '') {
        const end = foundClose + tickLen
        results.push({
          start: i,
          end,
          kind: 'inline-code',
          priority: 95,
          value: input.slice(i, end)
        })
        i = end
        continue
      }
    }
    i += tickLen
  }
  return results
}

function trimUrlTrailingPunctuation(raw: string): string {
  let s = raw
  while (s.length > 0) {
    const last = s[s.length - 1]
    if ('.,;:!?<>"\''.includes(last)) {
      s = s.slice(0, -1)
      continue
    }
    if (last === ')' || last === ']' || last === '}') {
      const openChar = last === ')' ? '(' : last === ']' ? '[' : '{'
      let opens = 0
      let closes = 0
      for (const ch of s) {
        if (ch === openChar) opens += 1
        else if (ch === last) closes += 1
      }
      if (closes > opens) {
        s = s.slice(0, -1)
        continue
      }
    }
    break
  }
  return s
}

function scanRegexCandidates(
  input: string,
  re: RegExp,
  kind: ProtectedKind,
  priority: number,
  normalize?: (raw: string, match: RegExpExecArray) => { startOffset: number; value: string } | null
): Candidate[] {
  const results: Candidate[] = []
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const scanner = new RegExp(re.source, flags)
  let m: RegExpExecArray | null
  while ((m = scanner.exec(input)) !== null) {
    if (m[0].length === 0) {
      scanner.lastIndex += 1
      continue
    }
    if (normalize) {
      const normalized = normalize(m[0], m)
      if (!normalized || normalized.value.length === 0) continue
      const start = m.index + normalized.startOffset
      results.push({
        start,
        end: start + normalized.value.length,
        kind,
        priority,
        value: normalized.value
      })
    } else {
      results.push({
        start: m.index,
        end: m.index + m[0].length,
        kind,
        priority,
        value: m[0]
      })
    }
  }
  return results
}

function scanQuotedPaths(input: string): Candidate[] {
  const results: Candidate[] = []
  const quotedRe = /(["'])([A-Za-z]:\\[^"'\r\n]+|\\\\[^"'\r\n]+|\.\.?\/[^"'\r\n]+|\/(?:[^"'\r\n]+\/)*[^"'\r\n]+)\1/g
  let m: RegExpExecArray | null
  while ((m = quotedRe.exec(input)) !== null) {
    const inner = m[2]
    if (inner.includes('://')) continue
    const start = m.index + 1
    results.push({
      start,
      end: start + inner.length,
      kind: 'path',
      priority: 88,
      value: inner
    })
  }
  return results
}

function trimTrailingSentencePunctuation(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, '')
}

function scanUnquotedPaths(input: string): Candidate[] {
  const results: Candidate[] = []

  // Windows drive / UNC path with optional internal spaces in named subdirectories when ending in segment/extension
  const winSpacePathRe =
    /(?:[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\)(?:[^\\/:*?"<>|\r\n`']+\\)+[^\\/:*?"<>|\r\n`'\s,;:!?)]+/g
  let m: RegExpExecArray | null
  while ((m = winSpacePathRe.exec(input)) !== null) {
    const value = trimTrailingSentencePunctuation(m[0])
    if (value === '') continue
    const lastSegSep = value.lastIndexOf('\\')
    if (lastSegSep > 0 && CODE_EXTENSION_PATH_RE.test(value.slice(lastSegSep + 1))) {
      results.push({
        start: m.index,
        end: m.index + value.length,
        kind: 'path',
        priority: 87,
        value
      })
    } else if (!value.includes('  ') && !/[.,;:!?]\s/.test(value)) {
      results.push({
        start: m.index,
        end: m.index + value.length,
        kind: 'path',
        priority: 85,
        value
      })
    }
  }

  // Compact Windows path without spaces (e.g. C:\Windows\System32 or D:\repo\dir.ts)
  results.push(
    ...scanRegexCandidates(
      input,
      /(?:[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\)[^\s\\/:*?"<>|`',;:!?)\]}]+(?:\\[^\s\\/:*?"<>|`',;:!?)\]}]+)*/g,
      'path',
      84,
      (raw) => {
        const trimmed = trimTrailingSentencePunctuation(raw)
        return trimmed.length > 0 ? { startOffset: 0, value: trimmed } : null
      }
    )
  )

  // POSIX & relative paths (avoid matching dates 2026/11/24 or word/word prose)
  const posixRe =
    /(^|[\s([{"'`=:])(\.\.?\/[^\s<>"'`()[\]{},;!?]+|\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*|\/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})(?=$|[\s)\]}>"'`,.;:!?])/g
  while ((m = posixRe.exec(input)) !== null) {
    const lead = m[1]
    const val = m[2]
    if (!val || WINDOWS_DRIVE_RE.test(val)) continue
    results.push({
      start: m.index + lead.length,
      end: m.index + lead.length + val.length,
      kind: 'path',
      priority: 83,
      value: val
    })
  }

  return results
}

function collectAllCandidates(input: string): Candidate[] {
  const candidates: Candidate[] = []
  candidates.push(...scanFencedCodeBlocks(input))
  candidates.push(...scanInlineCodeSpans(input))

  // URLs
  candidates.push(
    ...scanRegexCandidates(
      input,
      /\b(?:https?|wss?|ftp):\/\/[^\s<>"'`]+/gi,
      'url',
      90,
      (raw) => {
        const trimmed = trimUrlTrailingPunctuation(raw)
        return trimmed.length > 0 ? { startOffset: 0, value: trimmed } : null
      }
    )
  )

  candidates.push(...scanQuotedPaths(input))
  candidates.push(...scanUnquotedPaths(input))

  // Template / environment variables
  candidates.push(
    ...scanRegexCandidates(
      input,
      /\{\{[^{}\r\n]+\}\}|\$\{[A-Za-z_][A-Za-z0-9_.-]*\}|%[A-Za-z_][A-Za-z0-9_]*%|\$[A-Za-z_][A-Za-z0-9_]*/g,
      'env',
      80
    )
  )

  // CLI flags
  candidates.push(
    ...scanRegexCandidates(
      input,
      /(^|[\s([{"'`])(--[A-Za-z0-9][A-Za-z0-9-]*(?:=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;!?)\]}]+))?|-[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s"'`,.;:!?)\]}])/g,
      'flag',
      70,
      (_raw, m) => {
        const val = trimTrailingSentencePunctuation(m[2])
        return val.length > 0 ? { startOffset: m[1].length, value: val } : null
      }
    )
  )

  // @mentions and scoped packages
  candidates.push(
    ...scanRegexCandidates(
      input,
      /(^|[\s([{"'`])(@[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)?)(?=$|[\s"'`,.;:!?)\]}])/g,
      'mention',
      65,
      (_raw, m) => ({ startOffset: m[1].length, value: m[2] })
    )
  )

  return candidates
}

function lowerBound(arr: readonly Candidate[], start: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid].start < start) lo = mid + 1
    else hi = mid
  }
  return lo
}

function selectNonOverlapping(candidates: Candidate[]): Candidate[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      b.priority - a.priority ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start
  )
  const chosen: Candidate[] = []
  for (const c of ranked) {
    const idx = lowerBound(chosen, c.start)
    const prev = chosen[idx - 1]
    const next = chosen[idx]
    if (prev && prev.end > c.start) continue
    if (next && next.start < c.end) continue
    chosen.splice(idx, 0, c)
  }
  return chosen
}

export function protectTechnicalText(source: string): ProtectedTextResult {
  if (!source) {
    return {
      hasProtected: false,
      maskedText: source,
      prefix: 'ALTT',
      spans: []
    }
  }
  const chosen = selectNonOverlapping(collectAllCandidates(source))
  if (chosen.length === 0) {
    return {
      hasProtected: false,
      maskedText: source,
      prefix: 'ALTT',
      spans: []
    }
  }

  const prefix = chooseSafePrefix(source)
  const spans: ProtectedSpan[] = []
  let maskedText = ''
  let cursor = 0

  for (const item of chosen) {
    const id = spans.length
    const token = `${TOKEN_OPEN}${prefix}_${id}${TOKEN_CLOSE}`
    maskedText += source.slice(cursor, item.start) + token
    spans.push({
      id,
      token,
      kind: item.kind,
      value: item.value
    })
    cursor = item.end
  }
  maskedText += source.slice(cursor)

  return {
    hasProtected: true,
    maskedText,
    prefix,
    spans
  }
}

export function restoreAndVerifyProtectedText(
  translated: string,
  state: ProtectedTextResult,
  options?: { allowReorder?: boolean }
): RestoreVerifyResult {
  if (!state.hasProtected || state.spans.length === 0) {
    return {
      ok: true,
      text: translated,
      restored: false,
      reordered: false,
      missingTokens: [],
      unexpectedTokens: []
    }
  }

  const allowReorder = options?.allowReorder ?? true
  const spanById = new Map<number, ProtectedSpan>(state.spans.map((s) => [s.id, s]))
  const counts = new Map<number, number>()
  const observedOrder: number[] = []
  const unexpectedTokens: string[] = []

  const escapedPrefix = escapeRegExp(state.prefix)
  const canonicalIdPattern = '(?:0|[1-9]\\d*)'
  const exactTokenRe = new RegExp(`\\[\\[${escapedPrefix}_(${canonicalIdPattern})\\]\\]`, 'g')
  const canonicalExactFullRe = new RegExp(`^\\[\\[${escapedPrefix}_${canonicalIdPattern}\\]\\]$`)
  const residualCheckText = translated.replace(exactTokenRe, ' ')

  let text = translated.replace(exactTokenRe, (fullMatch, idStr: string) => {
    const id = Number.parseInt(idStr, 10)
    const span = spanById.get(id)
    if (!span) {
      unexpectedTokens.push(fullMatch)
      return fullMatch
    }
    counts.set(id, (counts.get(id) ?? 0) + 1)
    observedOrder.push(id)
    return span.value
  })

  // Best-effort lenient restore for minor whitespace, leading-zero, or full-width corruption in preview,
  // while still marking `corruptedDetected` so strict safety check holds auto-paste.
  const fuzzyTokenRe = new RegExp(
    `(?:\\[\\[|［［|【【|\\[)\\s*${escapedPrefix}\\s*[_\\-]?\\s*(\\d+)\\s*(?:\\]\\]|］］|】】|\\])`,
    'gi'
  )
  let corruptedDetected = false
  text = text.replace(fuzzyTokenRe, (fullMatch, idStr: string) => {
    if (canonicalExactFullRe.test(fullMatch)) {
      // Exact-format out-of-range tokens (e.g. [[ALTT_999]]) are already tracked in `unexpectedTokens`
      return fullMatch
    }
    corruptedDetected = true
    const id = Number.parseInt(idStr, 10)
    const span = spanById.get(id)
    if (!span) {
      unexpectedTokens.push(fullMatch)
      return fullMatch
    }
    counts.set(id, (counts.get(id) ?? 0) + 1)
    observedOrder.push(id)
    return span.value
  })
  const cleanedResidual = residualCheckText.replace(fuzzyTokenRe, ' ')

  // Detect leftover corrupted prefix/bracket fragments outside valid tokens (in untranslated gaps only)
  const leftoverPrefixRe = new RegExp(
    `(?:\\[\\[|［［|【【)\\s*${escapedPrefix}|\\b${escapedPrefix}(?:_\\d+|\\d+)\\b`,
    'i'
  )
  if (leftoverPrefixRe.test(cleanedResidual)) {
    corruptedDetected = true
  }

  const missingTokens = state.spans
    .filter((s) => !counts.has(s.id))
    .map((s) => s.token)
  const duplicated = [...counts.values()].some((count) => count > 1)
  const reordered =
    observedOrder.length === state.spans.length &&
    observedOrder.some((id, idx) => id !== idx)

  let reason: RestoreVerifyReason | undefined
  if (corruptedDetected) {
    reason = 'placeholder-corrupted'
  } else if (unexpectedTokens.length > 0) {
    reason = 'placeholder-invented'
  } else if (missingTokens.length > 0) {
    reason = 'placeholder-missing'
  } else if (duplicated) {
    reason = 'placeholder-duplicated'
  } else if (!allowReorder && reordered) {
    reason = 'placeholder-reordered'
  }

  const ok = reason === undefined
  return {
    ok,
    text,
    restored: ok,
    reordered,
    ...(reason ? { reason } : {}),
    missingTokens,
    unexpectedTokens
  }
}
