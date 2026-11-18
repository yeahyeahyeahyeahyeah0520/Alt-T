export interface WaitDeps {
  readText: () => string | Promise<string>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * Poll clipboard until its text differs from `sentinel` or `timeoutMs` elapses.
 * First read occurs after `sleep(intervalMs)`. When `now() - start >= timeoutMs`,
 * performs one final read before returning `null`.
 */
export async function waitForClipboardChange(
  sentinel: string,
  deps: WaitDeps,
  intervalMs: number,
  timeoutMs: number
): Promise<string | null> {
  const start = deps.now()
  while (deps.now() - start < timeoutMs) {
    await deps.sleep(intervalMs)
    const text = await deps.readText()
    if (text !== sentinel) {
      return text
    }
  }
  const finalText = await deps.readText()
  return finalText !== sentinel ? finalText : null
}

/**
 * Pure guard: only restore a saved clipboard snapshot if the clipboard still holds
 * the transient text we injected (never overwrite text the user copied manually meanwhile).
 */
export function shouldRestoreClipboard(currentText: string, injectedText: string): boolean {
  return currentText === injectedText
}
