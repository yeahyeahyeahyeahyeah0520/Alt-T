const URL_CREDENTIAL_RE = /\b(https?:\/\/)(?:[^/\s:@]+:[^/\s]+|[^/\s:@]+)@/gi
const AUTH_BEARER_HEADER_RE = /\b(Authorization\s*:\s*Bearer\s+)([^\s"',;]+)/gi
const BEARER_TOKEN_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi
const OPENAI_PROJ_KEY_RE = /\bsk-proj-[A-Za-z0-9_-]{12,}\b/g
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/g
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g

export function redactUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIAL_RE, '$1[REDACTED]@')
}

export function redactSecretsInText(
  text: string,
  secrets?: string | ReadonlyArray<string>
): string {
  let sanitized = redactUrlCredentials(text)
  sanitized = sanitized.replace(AUTH_BEARER_HEADER_RE, '$1[REDACTED]')
  sanitized = sanitized.replace(BEARER_TOKEN_RE, '$1[REDACTED]')
  sanitized = sanitized.replace(OPENAI_PROJ_KEY_RE, '[REDACTED]')
  sanitized = sanitized.replace(OPENAI_KEY_RE, '[REDACTED]')
  sanitized = sanitized.replace(GOOGLE_API_KEY_RE, '[REDACTED]')

  if (typeof secrets === 'string') {
    const trimmed = secrets.trim()
    if (trimmed !== '') {
      sanitized = sanitized.split(trimmed).join('[REDACTED]')
    }
  } else if (Array.isArray(secrets)) {
    for (const secret of secrets) {
      const trimmed = secret.trim()
      if (trimmed !== '') {
        sanitized = sanitized.split(trimmed).join('[REDACTED]')
      }
    }
  }

  return sanitized
}

export function redactSecret(text: string, secret?: string): string {
  return redactSecretsInText(text, secret)
}

export function createCooldownGate(
  cooldownMs = 60_000,
  now: () => number = () => Date.now()
): { shouldEmit: () => boolean; reset: () => void } {
  let lastEmittedAt = -Infinity
  return {
    shouldEmit(): boolean {
      const current = now()
      if (current - lastEmittedAt < cooldownMs) {
        return false
      }
      lastEmittedAt = current
      return true
    },
    reset(): void {
      lastEmittedAt = -Infinity
    }
  }
}
