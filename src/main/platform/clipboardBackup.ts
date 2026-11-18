import crypto from 'node:crypto'
import { clipboard as electronClipboard, ClipboardItem as ElectronClipboardItem } from 'electron'
import { shouldRestoreClipboard } from '../core/clipboardPolicy'
import {
  getClipboardSequenceNumber as hostGetClipboardSequenceNumber,
  writeHistoryExcludedClipboardText
} from './hostPlatform'

export interface ClipboardItemLike {
  readonly types: readonly string[]
  getType: (type: string) => Promise<Blob | Electron.ClipboardBookmark>
}

export interface ClipboardSnapshot {
  text: string
  html: string
  rtf: string
  imageBlob: Blob | null
  imageMime: string | null
  formats: string[]
}

export interface ClipboardLike {
  read: () => Promise<ClipboardItemLike[]>
  readText: () => Promise<string>
  write: (data: Electron.ClipboardItem[]) => Promise<void>
  writeText: (text: string) => Promise<void>
  clear: () => void
}

export interface ClipboardManagerDeps {
  clipboard: ClipboardLike
  createClipboardItem: (items: Record<string, string | Blob>) => Electron.ClipboardItem
  writePrivateClipboardText: (text: string) => Promise<boolean>
  getClipboardSequenceNumber: () => number
  sleep: (ms: number) => Promise<void>
}

export interface ClipboardManager {
  backupClipboard: () => Promise<ClipboardSnapshot>
  restoreClipboard: (snapshot: ClipboardSnapshot) => Promise<void>
  restoreClipboardIfUnchanged: (
    snapshot: ClipboardSnapshot,
    expectedCurrentText: string,
    expectedSequence?: number
  ) => Promise<void>
  writeTransientClipboardText: (text: string) => Promise<void>
  writeSentinel: () => Promise<string>
}

const KNOWN_FORMAT_PREFIXES = ['text/plain', 'text/html', 'text/rtf', 'image/']
const CLIPBOARD_READ_TIMEOUT_MS = 300
const RETRY_BACKOFF_MS = [20, 40, 80] as const

const OS_CLIPBOARD_EXCLUDE_MONITOR =
  'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"'
const OS_CLIPBOARD_CAN_INCLUDE_HISTORY =
  'electron application/osclipboard;format="CanIncludeInClipboardHistory"'
const OS_CLIPBOARD_CAN_UPLOAD_CLOUD =
  'electron application/osclipboard;format="CanUploadToCloudClipboard"'

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getDefaultDeps(): ClipboardManagerDeps {
  return {
    clipboard: electronClipboard,
    createClipboardItem: (items) => new ElectronClipboardItem(items),
    writePrivateClipboardText: writeHistoryExcludedClipboardText,
    getClipboardSequenceNumber: hostGetClipboardSequenceNumber,
    sleep: defaultSleep
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallbackValue: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(fallbackValue)
      }
    }, ms)
    promise
      .then((val) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(val)
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(fallbackValue)
        }
      })
  })
}

async function retryClipboardOp<T>(
  op: () => Promise<T> | T,
  sleepFn: (ms: number) => Promise<void>
): Promise<T> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await op()
    } catch (err) {
      lastErr = err
      if (attempt < RETRY_BACKOFF_MS.length - 1) {
        await sleepFn(RETRY_BACKOFF_MS[attempt])
      }
    }
  }
  throw lastErr
}

export { shouldRestoreClipboard }

export function createClipboardManager(
  overrides?: Partial<ClipboardManagerDeps>
): ClipboardManager {
  const deps: ClipboardManagerDeps = {
    ...getDefaultDeps(),
    ...overrides
  }

  async function readTextSafe(): Promise<string> {
    try {
      return await withTimeout(
        retryClipboardOp(() => deps.clipboard.readText(), deps.sleep),
        150,
        ''
      )
    } catch {
      return ''
    }
  }

  async function backupClipboard(): Promise<ClipboardSnapshot> {
    let text = ''
    let html = ''
    let rtf = ''
    let imageBlob: Blob | null = null
    let imageMime: string | null = null
    const formatSet = new Set<string>()

    try {
      const items = await withTimeout<ClipboardItemLike[] | null>(
        retryClipboardOp(() => deps.clipboard.read(), deps.sleep),
        CLIPBOARD_READ_TIMEOUT_MS,
        null
      )
      if (items === null) {
        text = await readTextSafe()
      } else {
        for (const item of items) {
          for (const mime of item.types) {
            formatSet.add(mime)
          }
          if (text === '' && item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain')
            if (blob instanceof Blob) {
              text = await blob.text()
            }
          }
          if (html === '' && item.types.includes('text/html')) {
            const blob = await item.getType('text/html')
            if (blob instanceof Blob) {
              html = await blob.text()
            }
          }
          if (rtf === '' && item.types.includes('text/rtf')) {
            const blob = await item.getType('text/rtf')
            if (blob instanceof Blob) {
              rtf = await blob.text()
            }
          }
          if (imageBlob === null) {
            const imgType = item.types.find((t) => t.startsWith('image/'))
            if (imgType) {
              const blob = await item.getType(imgType)
              imageBlob = blob instanceof Blob ? blob : null
              imageMime = imgType
            }
          }
        }
      }
    } catch {
      text = await readTextSafe()
    }

    const formats = Array.from(formatSet)
    const extraFormats = formats.filter(
      (fmt) => !KNOWN_FORMAT_PREFIXES.some((prefix) => fmt.startsWith(prefix))
    )
    if (extraFormats.length > 0) {
      console.log('[fp] clipboard has non-backed formats:', extraFormats.join(', '))
    }

    return { text, html, rtf, imageBlob, imageMime, formats }
  }

  async function restoreClipboard(snapshot: ClipboardSnapshot): Promise<void> {
    try {
      if (
        snapshot.text === '' &&
        snapshot.html === '' &&
        snapshot.rtf === '' &&
        snapshot.imageBlob === null
      ) {
        await retryClipboardOp(() => {
          deps.clipboard.clear()
        }, deps.sleep)
        return
      }

      const payload: Record<string, string | Blob> = {}
      if (snapshot.text !== '') payload['text/plain'] = snapshot.text
      if (snapshot.html !== '') payload['text/html'] = snapshot.html
      if (snapshot.rtf !== '') payload['text/rtf'] = snapshot.rtf
      if (snapshot.imageBlob !== null) {
        payload[snapshot.imageMime ?? 'image/png'] = snapshot.imageBlob
      }

      await withTimeout(
        retryClipboardOp(
          () => deps.clipboard.write([deps.createClipboardItem(payload)]),
          deps.sleep
        ),
        CLIPBOARD_READ_TIMEOUT_MS,
        undefined
      )
    } catch (err) {
      console.warn('[fp] restoreClipboard failed:', err)
    }
  }

  async function restoreClipboardIfUnchanged(
    snapshot: ClipboardSnapshot,
    expectedCurrentText: string,
    expectedSequence?: number
  ): Promise<void> {
    if (expectedSequence !== undefined && expectedSequence > 0) {
      const currentSeq = deps.getClipboardSequenceNumber()
      if (currentSeq > 0) {
        if (currentSeq !== expectedSequence) {
          return
        }
        await restoreClipboard(snapshot)
        return
      }
    }

    let current = expectedCurrentText
    try {
      current = await withTimeout(
        retryClipboardOp(() => deps.clipboard.readText(), deps.sleep),
        150,
        expectedCurrentText
      )
    } catch {
      current = expectedCurrentText
    }
    if (!shouldRestoreClipboard(current, expectedCurrentText)) {
      return
    }
    await restoreClipboard(snapshot)
  }

  async function writeTransientClipboardText(text: string): Promise<void> {
    const zeroDwordBlob = new Blob([new Uint8Array([0, 0, 0, 0])])
    try {
      const item = deps.createClipboardItem({
        'text/plain': text,
        [OS_CLIPBOARD_EXCLUDE_MONITOR]: zeroDwordBlob,
        [OS_CLIPBOARD_CAN_INCLUDE_HISTORY]: zeroDwordBlob,
        [OS_CLIPBOARD_CAN_UPLOAD_CLOUD]: zeroDwordBlob
      })
      await retryClipboardOp(() => deps.clipboard.write([item]), deps.sleep)
      return
    } catch {
      // Fallback to native Win32 private clipboard write if ClipboardItem OS format is unavailable
    }

    const ok = await deps.writePrivateClipboardText(text)
    if (!ok) {
      await retryClipboardOp(() => deps.clipboard.writeText(text), deps.sleep)
    }
  }

  async function writeSentinel(): Promise<string> {
    const sentinel = '\u200b__FP_' + crypto.randomUUID() + '__'
    await writeTransientClipboardText(sentinel)
    return sentinel
  }

  return {
    backupClipboard,
    restoreClipboard,
    restoreClipboardIfUnchanged,
    writeTransientClipboardText,
    writeSentinel
  }
}

let activeManager: ClipboardManager | null = null

function getActiveManager(): ClipboardManager {
  if (activeManager === null) {
    activeManager = createClipboardManager()
  }
  return activeManager
}

export function setClipboardDepsForTest(overrides: Partial<ClipboardManagerDeps> | null): void {
  activeManager = overrides === null ? null : createClipboardManager(overrides)
}

export function backupClipboard(): Promise<ClipboardSnapshot> {
  return getActiveManager().backupClipboard()
}

export function restoreClipboard(snapshot: ClipboardSnapshot): Promise<void> {
  return getActiveManager().restoreClipboard(snapshot)
}

export function restoreClipboardIfUnchanged(
  snapshot: ClipboardSnapshot,
  expectedCurrentText: string,
  expectedSequence?: number
): Promise<void> {
  return getActiveManager().restoreClipboardIfUnchanged(
    snapshot,
    expectedCurrentText,
    expectedSequence
  )
}

export function writeTransientClipboardText(text: string): Promise<void> {
  return getActiveManager().writeTransientClipboardText(text)
}

export function writeSentinel(): Promise<string> {
  return getActiveManager().writeSentinel()
}
