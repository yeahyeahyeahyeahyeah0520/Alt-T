const CHAT_COMPLETIONS_SUFFIX = '/chat/completions'
const VERSION_PATH_RE = /\/v\d+(?:(?:alpha|beta)\d*)?(?:\/openai)?$/i

/**
 * Normalize a user-provided OpenAI-compatible base URL.
 * Throws Error('BASE_URL_INVALID: <reason>') when invalid.
 */
export function normalizeBaseUrl(input: string): string {
  const s = input.trim()
  if (s === '') {
    throw new Error('BASE_URL_INVALID: empty URL')
  }

  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    throw new Error('BASE_URL_INVALID: invalid URL syntax')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`BASE_URL_INVALID: unsupported protocol "${parsed.protocol}"`)
  }

  let base = (parsed.origin + parsed.pathname).replace(/\/+$/, '')

  if (base.toLowerCase().endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    base = base.slice(0, -CHAT_COMPLETIONS_SUFFIX.length).replace(/\/+$/, '')
  }

  if (VERSION_PATH_RE.test(base)) {
    return base
  }

  return `${base}/v1`
}

/**
 * Build the full `/chat/completions` endpoint URL from a base URL.
 */
export function buildChatCompletionsUrl(input: string): string {
  return `${normalizeBaseUrl(input)}${CHAT_COMPLETIONS_SUFFIX}`
}

const LOOPBACK_IPV4_RE = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Determine whether a base URL targets a local loopback endpoint (`localhost`, `127.0.0.0/8`, `::1`).
 */
export function isLoopbackBaseUrl(input: string): boolean {
  const s = input.trim()
  if (s === '') return false

  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  let host = parsed.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }

  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true
  }

  const m = LOOPBACK_IPV4_RE.exec(host)
  if (!m) return false
  return Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255
}
