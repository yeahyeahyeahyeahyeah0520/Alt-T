import { MSG } from '../../shared/messages'
import type { ProviderId } from '../../shared/types'

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
const LOOPBACK_IPV6_MAPPED_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/

/**
 * Determine whether a resolved IP address is strictly loopback (`127.0.0.0/8`, `::1`, or IPv4-mapped `127.0.0.0/8`).
 */
export function isLoopbackIp(rawIp: string): boolean {
  let ip = rawIp.trim().toLowerCase()
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1)
  }
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') {
    return true
  }
  if (ip.startsWith('::ffff:')) {
    const mappedV4 = ip.slice('::ffff:'.length)
    const v4Match = LOOPBACK_IPV4_RE.exec(mappedV4)
    if (v4Match) {
      return Number(v4Match[1]) <= 255 && Number(v4Match[2]) <= 255 && Number(v4Match[3]) <= 255
    }
    const hexMatch = LOOPBACK_IPV6_MAPPED_HEX_RE.exec(ip)
    if (hexMatch) {
      const hi = Number.parseInt(hexMatch[1], 16)
      return (hi >> 8) === 127
    }
    return false
  }
  const m = LOOPBACK_IPV4_RE.exec(ip)
  if (!m) return false
  return Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255
}

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
  if (parsed.username !== '' || parsed.password !== '') {
    return false
  }

  let host = parsed.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }

  if (host === 'localhost') {
    return true
  }

  return isLoopbackIp(host)
}

export function validateLocalOnlyTarget(params: {
  localOnlyMode: boolean
  provider: ProviderId
  baseUrl?: string
}): { ok: true } | { ok: false; code: 'LOCAL_ONLY_BLOCKED'; message: string } {
  if (!params.localOnlyMode) {
    return { ok: true }
  }
  if (params.provider === 'edge') {
    return {
      ok: false,
      code: 'LOCAL_ONLY_BLOCKED',
      message: MSG.LOCAL_ONLY_EXTERNAL_BLOCKED
    }
  }
  if (!isLoopbackBaseUrl(params.baseUrl ?? '')) {
    return {
      ok: false,
      code: 'LOCAL_ONLY_BLOCKED',
      message: MSG.LOCAL_ONLY_NON_LOOPBACK_BLOCKED
    }
  }
  return { ok: true }
}
