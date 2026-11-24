import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { DEFAULT_CONFIG, type AppConfig, type NotifyPush, type PopupShowPush } from '../src/shared/types'
import { MSG } from '../src/shared/messages'
import {
  mergeAppOverrides,
  mergeConfig,
  normalizeExeBasename,
  resolveEffectiveAppPolicy
} from '../src/shared/config'
import {
  applyPopupShowState,
  createInitialPopupUiState,
  markSourceEditedState,
  shouldAutoPasteOnDone
} from '../src/shared/popupState'
import {
  protectTechnicalText,
  restoreAndVerifyProtectedText
} from '../src/main/core/protectedText'
import { createTranslateService } from '../src/main/services/translateService'
import {
  configureSelectionService,
  pasteTextToWindow,
  runSelectionFlow,
  setSelectionRuntimeForTest,
  type SelectionRuntimeDeps
} from '../src/main/services/selectionService'
import type { ClipboardSnapshot } from '../src/main/platform/clipboardBackup'

afterEach(() => {
  setSelectionRuntimeForTest(null)
  configureSelectionService(null)
})

describe('Batch 3 protected text, popup modes, and per-app overrides (ALT-07..ALT-11)', () => {
  it('T10: protects and restores technical fragments, handles collisions, and detects prompt drift cleanly', () => {
    const sample = [
      'Check D:\\工作区\\测试 1\\app.ts and "C:\\Projects\\my team\\my file.json".',
      'Also inspect ./src/main/index.ts, https://example.com/docs_(v1). and $HOME/${API_KEY}/%APPDATA%.',
      'Run `npm run test` with --max-tokens=100 -rf and ping @team/core twice: --max-tokens=100.',
      'Code fence:\n````ts\nconst x = `inner`;\nconsole.log("[[ALTT_0]]")\n````'
    ].join('\n')

    const masked = protectTechnicalText(sample)
    assert.equal(masked.hasProtected, true)
    assert.notEqual(masked.prefix, 'ALTT') // Collision avoided because sample contained [[ALTT_0]]
    assert.equal(masked.maskedText.includes('D:\\工作区\\测试 1\\app.ts'), false)
    assert.equal(masked.maskedText.includes('https://example.com/docs_(v1)'), false)
    assert.equal(masked.maskedText.includes('--max-tokens=100'), false)
    assert.ok(masked.spans.some((s) => s.value === 'https://example.com/docs_(v1)'))
    assert.ok(masked.maskedText.includes('. and ')) // Trailing sentence period excluded outside URL

    // Idiomatic ZH reordering keeps exact tokens valid
    const tokens = masked.spans.map((s) => s.token)
    const reordered = `${tokens.slice(1).join(' ')} 以及 ${tokens[0]}`
    const okVerify = restoreAndVerifyProtectedText(reordered, masked)
    assert.equal(okVerify.ok, true)
    assert.equal(okVerify.reordered, true)
    assert.ok(okVerify.text.includes('D:\\工作区\\测试 1\\app.ts'))
    assert.ok(okVerify.text.includes('````ts\nconst x = `inner`;\nconsole.log("[[ALTT_0]]")\n````'))

    // Strict allowReorder=false flags reordering
    const strictOrder = restoreAndVerifyProtectedText(reordered, masked, { allowReorder: false })
    assert.equal(strictOrder.ok, false)
    assert.equal(strictOrder.reason, 'placeholder-reordered')

    // Missing token fails verification
    const missing = restoreAndVerifyProtectedText(tokens.slice(1).join(' '), masked)
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'placeholder-missing')
    assert.deepEqual(missing.missingTokens, [tokens[0]])

    // Duplicated token fails verification
    const duped = restoreAndVerifyProtectedText(`${tokens.join(' ')} ${tokens[0]}`, masked)
    assert.equal(duped.ok, false)
    assert.equal(duped.reason, 'placeholder-duplicated')

    // Invented token fails verification
    const invented = restoreAndVerifyProtectedText(`${tokens.join(' ')} [[${masked.prefix}_999]]`, masked)
    assert.equal(invented.ok, false)
    assert.equal(invented.reason, 'placeholder-invented')

    // Fullwidth mangled placeholder fails verification safely
    const mangled = restoreAndVerifyProtectedText(
      tokens.join(' ').replace(tokens[0], `【【${masked.prefix}_0】】`),
      masked
    )
    assert.equal(mangled.ok, false)
    assert.equal(mangled.reason, 'placeholder-corrupted')

    // P3: Leading-zero placeholder variants ([[ALTT_00]], [[ALTT_01]], mixed valid+leading-zero, mixed+unknown) fail strict check as corrupted while restoring preview cleanly
    const zeroSingle = protectTechnicalText('Use --check')
    const leadingZero00 = restoreAndVerifyProtectedText(
      zeroSingle.maskedText.replace('_0]]', '_00]]'),
      zeroSingle
    )
    assert.equal(leadingZero00.ok, false)
    assert.equal(leadingZero00.reason, 'placeholder-corrupted')
    assert.equal(leadingZero00.text, 'Use --check')

    const twoSpans = protectTechnicalText('Run --check and https://example.com')
    const leadingZero01 = restoreAndVerifyProtectedText(
      twoSpans.maskedText.replace('_1]]', '_01]]'),
      twoSpans
    )
    assert.equal(leadingZero01.ok, false)
    assert.equal(leadingZero01.reason, 'placeholder-corrupted')

    const validPlusLeadingZero = restoreAndVerifyProtectedText(
      `${zeroSingle.spans[0].token} and ${zeroSingle.spans[0].token.replace('_0]]', '_00]]')}`,
      zeroSingle
    )
    assert.equal(validPlusLeadingZero.ok, false)
    assert.equal(validPlusLeadingZero.reason, 'placeholder-corrupted')
    assert.equal(validPlusLeadingZero.text, 'Use --check and --check'.replace(/^Use /, ''))

    const validUnknownPlusLeadingZero = restoreAndVerifyProtectedText(
      `${zeroSingle.spans[0].token} [[${zeroSingle.prefix}_999]] ${zeroSingle.spans[0].token.replace('_0]]', '_00]]')}`,
      zeroSingle
    )
    assert.equal(validUnknownPlusLeadingZero.ok, false)
    assert.equal(validUnknownPlusLeadingZero.reason, 'placeholder-corrupted')
    assert.deepEqual(validUnknownPlusLeadingZero.unexpectedTokens, [`[[${zeroSingle.prefix}_999]]`])

    // Canonical invented token + missing canonical token keeps exact reason 'placeholder-invented' (not corrupted)
    const pureInvented = restoreAndVerifyProtectedText(`[[${zeroSingle.prefix}_999]]`, zeroSingle)
    assert.equal(pureInvented.ok, false)
    assert.equal(pureInvented.reason, 'placeholder-invented')
    assert.deepEqual(pureInvented.unexpectedTokens, [`[[${zeroSingle.prefix}_999]]`])
    assert.deepEqual(pureInvented.missingTokens, [zeroSingle.spans[0].token])

    // Normal English prose containing "at" does NOT false-positive when Chinese source uses default prefix ALTT
    const zhSource = protectTechnicalText('请检查 `npm test` 输出')
    assert.equal(zhSource.prefix, 'ALTT')
    const enOut = restoreAndVerifyProtectedText(`Look at ${zhSource.spans[0].token} output`, zhSource)
    assert.equal(enOut.ok, true)
    assert.equal(enOut.text, 'Look at `npm test` output')
  })

  it('T11 & T16: holds auto-paste when LLM drops/corrupts protected placeholder, while restoring valid duplicate tokens via HTTP', async () => {
    let behavior: 'valid' | 'drop-token' = 'drop-token'
    let receivedSystemPrompt = ''

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages: Array<{ role: string; content: string }>
        }
        receivedSystemPrompt = body.messages.find((m) => m.role === 'system')?.content ?? ''
        const userText = body.messages.find((m) => m.role === 'user')?.content ?? ''
        const content =
          behavior === 'drop-token'
            ? 'Translated text missing placeholder completely'
            : `译文：${userText}`
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }

    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      primaryProvider: 'openai',
      enableFallback: false,
      protectTechnicalText: true,
      openai: {
        ...DEFAULT_CONFIG.openai,
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        stream: false,
        prompts: [
          ...DEFAULT_CONFIG.openai.prompts,
          {
            id: 'custom-code',
            name: 'Code Helper',
            systemPrompt: 'CUSTOM_PROMPT_HEADER Translate to {{to}}',
            userPrompt: '{{text}}'
          }
        ]
      },
      appOverrides: [
        {
          exeName: 'C:\\Tools\\Code.exe',
          promptId: 'custom-code',
          defaultTargetLang: 'zh-Hans'
        }
      ]
    }

    const svc = createTranslateService({ getConfig: () => cfg })
    const pasteCalls: string[] = []
    const backspaces: number[] = []
    const popupShows: PopupShowPush[] = []
    const popupNotifies: NotifyPush[] = []
    let clipText = 'old'

    const runtime: SelectionRuntimeDeps = {
      clipboard: {
        readText: async () => clipText,
        writeText: async (t) => {
          clipText = t
        }
      },
      clipboardBackup: {
        backupClipboard: async (): Promise<ClipboardSnapshot> => ({
          text: clipText,
          html: '',
          rtf: '',
          imageBlob: null,
          imageMime: null,
          formats: ['text/plain']
        }),
        writeSentinel: async () => '__SENTINEL__',
        writeTransientClipboardText: async (t) => {
          clipText = t
        },
        restoreClipboard: async (s) => {
          clipText = s.text
        },
        restoreClipboardIfUnchanged: async () => {}
      },
      host: {
        canInjectKeystrokes: () => true,
        getActiveTargetHandle: () => 101,
        isTargetAlive: () => true,
        isTargetMinimized: () => false,
        isOwnProcessWindow: () => false,
        isWindowElevatedOverSelf: () => false,
        focusTarget: () => true,
        getClipboardSequenceNumber: () => 1,
        getTargetCopyKind: () => 'normal',
        getTargetPasteKind: () => 'normal',
        getTargetExeName: () => 'code.exe',
        getTargetClassName: () => 'Chrome_WidgetWin_1',
        getTargetPid: () => 4040,
        getWindowTitle: () => 'Code',
        dispatchCopyShortcut: () => {
          clipText = 'Run `npm test` on C:\\工作区\\my app\\main.ts and `npm test` again'
        },
        dispatchBackspaces: async (n) => {
          backspaces.push(n)
        },
        dispatchPasteShortcut: (k) => {
          pasteCalls.push(k)
        },
        releasePressedModifiers: async () => {}
      },
      configStore: {
        get: () => cfg,
        addHistory: () => cfg
      },
      notifySystem: () => {},
      sleep: async () => {},
      now: () => Date.now(),
      watchdogTimeoutMs: 5000
    }

    setSelectionRuntimeForTest(runtime)
    configureSelectionService({
      translateService: svc,
      showPopupAtCursor: (p) => popupShows.push(p),
      showInactiveAtCursor: (p) => popupShows.push(p),
      pushToPopup: () => {},
      notifyPopup: (n) => popupNotifies.push(n)
    })

    try {
      // Fail-safe hold on corrupted/dropped token in replace mode
      const holdRes = await runSelectionFlow('replace')
      assert.equal(holdRes, 'done')
      assert.equal(pasteCalls.length, 0)
      assert.equal(backspaces.length, 0)
      assert.equal(popupShows.length, 1)
      assert.equal(popupShows[0].protectedVerificationFailed, true)
      assert.equal(popupShows[0].targetApp, 'code.exe')
      assert.ok(receivedSystemPrompt.includes('CUSTOM_PROMPT_HEADER')) // ALT-11 prompt override honored
      assert.ok(popupNotifies.some((n) => n.message === MSG.PROTECTED_TEXT_VERIFY_FAILED))

      // Valid round-trip preserves duplicate inline tokens and Chinese Windows path with spaces
      behavior = 'valid'
      const okRes = await svc.translateOnce({
        text: 'Run `npm test` on C:\\工作区\\my app\\main.ts and `npm test` again',
        to: 'zh-Hans',
        protectTechnicalText: true
      })
      assert.equal(okRes.protectedVerify?.ok, true)
      assert.equal(
        okRes.text,
        '译文：Run `npm test` on C:\\工作区\\my app\\main.ts and `npm test` again'
      )
    } finally {
      svc.disposeAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('T12, T13 & T14: manages popup target info, direct original paste without translation, confirm-before-paste, and stale-edit clearing', async () => {
    // T12 & T14 popup state machine checks
    let st = createInitialPopupUiState('zh-Hans')
    st = applyPopupShowState(st, {
      mode: 'input',
      text: 'hello',
      to: 'en',
      directPaste: true,
      targetApp: 'Code.exe',
      ideRegion: 'terminal',
      targetChanged: true
    })
    assert.equal(st.targetApp, 'Code.exe')
    assert.equal(st.ideRegion, 'terminal')
    assert.equal(st.targetChanged, true)
    assert.equal(st.directPasteMode, false) // targetChanged blocks blind directPaste

    // Protected verify failure blocks direct auto-paste even if requested
    st = applyPopupShowState(st, {
      mode: 'selection',
      text: 'run `x`',
      to: 'zh-Hans',
      directPaste: true,
      protectedVerificationFailed: true,
      protectedWarningMessage: MSG.PROTECTED_TEXT_VERIFY_FAILED
    })
    assert.equal(st.directPasteMode, false)
    assert.equal(st.protectedVerificationFailed, true)

    // Source edit clears pending paste and verification state
    st = applyPopupShowState(st, {
      mode: 'input',
      text: 'draft',
      to: 'en',
      directPaste: true,
      targetApp: 'notepad.exe'
    })
    st = { ...st, pendingPasteAfterDone: true }
    assert.equal(shouldAutoPasteOnDone(st), true)
    st = markSourceEditedState(st)
    assert.equal(st.pendingPasteAfterDone, false)
    assert.equal(st.sourceEditedSinceTranslate, true)
    assert.equal(shouldAutoPasteOnDone(st), false)

    // T14 confirmBeforePaste holds Alt+R replace in popup preview instead of blind paste
    let translateCount = 0
    const pasteCalls: string[] = []
    const shows: PopupShowPush[] = []
    let clipText = 'old'
    const confirmCfg: AppConfig = {
      ...DEFAULT_CONFIG,
      confirmBeforePaste: true
    }

    setSelectionRuntimeForTest({
      clipboard: {
        readText: async () => clipText,
        writeText: async (t) => {
          clipText = t
        }
      },
      clipboardBackup: {
        backupClipboard: async (): Promise<ClipboardSnapshot> => ({
          text: clipText,
          html: '',
          rtf: '',
          imageBlob: null,
          imageMime: null,
          formats: ['text/plain']
        }),
        writeSentinel: async () => '__SENTINEL__',
        writeTransientClipboardText: async (t) => {
          clipText = t
        },
        restoreClipboard: async (s) => {
          clipText = s.text
        },
        restoreClipboardIfUnchanged: async () => {}
      },
      host: {
        canInjectKeystrokes: () => true,
        getActiveTargetHandle: () => 202,
        isTargetAlive: () => true,
        isTargetMinimized: () => false,
        isOwnProcessWindow: () => false,
        isWindowElevatedOverSelf: () => false,
        focusTarget: () => true,
        getClipboardSequenceNumber: () => 2,
        getTargetCopyKind: () => 'normal',
        getTargetPasteKind: () => 'normal',
        getTargetExeName: () => 'notepad.exe',
        getTargetClassName: () => 'Notepad',
        getTargetPid: () => 888,
        getWindowTitle: () => 'Notepad',
        dispatchCopyShortcut: () => {
          clipText = 'Original command'
        },
        dispatchBackspaces: async () => {},
        dispatchPasteShortcut: (k) => {
          pasteCalls.push(k)
        },
        releasePressedModifiers: async () => {}
      },
      configStore: {
        get: () => confirmCfg,
        addHistory: () => confirmCfg
      },
      notifySystem: () => {},
      sleep: async () => {},
      now: () => Date.now(),
      watchdogTimeoutMs: 5000
    })
    configureSelectionService({
      translateService: {
        translateOnce: async () => {
          translateCount += 1
          return { text: '已翻译文本', provider: 'edge', usedFallback: false }
        },
        translateStream: async () => ({ text: '已翻译文本', provider: 'edge', usedFallback: false }),
        cancel: () => {},
        disposeAll: () => {}
      },
      showPopupAtCursor: (p) => shows.push(p),
      showInactiveAtCursor: (p) => shows.push(p),
      pushToPopup: () => {},
      notifyPopup: () => {}
    })

    const resConfirm = await runSelectionFlow('replace')
    assert.equal(resConfirm, 'done')
    assert.equal(translateCount, 1)
    assert.equal(pasteCalls.length, 0)
    assert.equal(shows.length, 1)
    assert.equal(shows[0].confirmBeforePaste, true)

    // T13 Direct insert original calls pasteTextToWindow cleanly with 0 extra translate requests
    const origReply = await pasteTextToWindow(202, 'Original command')
    assert.deepEqual(origReply, { ok: true, status: 'pasted' })
    assert.equal(translateCount, 1)
    assert.equal(pasteCalls.length, 1)
  })

  it('T15: normalizes per-app overrides consistently and enforces global guardrails strictly last', () => {
    assert.equal(normalizeExeBasename('C:\\Program Files\\Microsoft VS Code\\Code.exe'), 'code.exe')

    // Rejects ApplicationFrameHost.exe, deduplicates, and ignores extra untrusted keys
    const sanitized = mergeAppOverrides([
      {
        exeName: 'C:\\Windows\\System32\\ApplicationFrameHost.exe',
        directPaste: true
      },
      {
        exeName: 'C:\\Tools\\Code.exe',
        defaultTargetLang: 'en',
        promptId: 'missing-prompt',
        directPaste: true,
        localOnlyMode: false,
        logOriginalTextPreview: true
      },
      {
        exeName: 'code.exe',
        defaultTargetLang: 'zh-Hans'
      }
    ])
    assert.equal(sanitized.length, 1)
    assert.equal(sanitized[0].exeName, 'code.exe')
    assert.equal(sanitized[0].defaultTargetLang, 'en')
    assert.equal('localOnlyMode' in sanitized[0], false)

    const cfg = mergeConfig({
      localOnlyMode: true,
      logOriginalTextPreview: true,
      forcePopupOnReplaceExes: ['C:\\Windows\\System32\\cmd.exe'],
      appOverrides: [
        { exeName: 'cmd.exe', directPaste: true, promptId: 'nonexistent', protectTechnicalText: false },
        { exeName: 'notepad.exe', directPaste: true, protectTechnicalText: false }
      ]
    })

    // forcePopupOnReplaceExes cannot be overridden by appOverrides.directPaste=true
    const cmdPolicy = resolveEffectiveAppPolicy(cfg, 'CMD.EXE')
    assert.equal(cmdPolicy.forcePopup, true)
    assert.equal(cmdPolicy.canAutoPaste, false)
    assert.equal(cmdPolicy.confirmRequired, true)
    assert.equal(cmdPolicy.localOnlyMode, true)
    assert.equal(cmdPolicy.logOriginalTextPreview, false)
    assert.equal(cmdPolicy.promptId, cfg.openai.activePromptId) // Deleted prompt falls back safely

    // Turning off protectTechnicalText in per-app override forces confirmation instead of blind auto-paste
    const npPolicy = resolveEffectiveAppPolicy(cfg, 'notepad.exe')
    assert.equal(npPolicy.protectTechnicalText, false)
    assert.equal(npPolicy.confirmRequired, true)
    assert.equal(npPolicy.canAutoPaste, false)
  })
})
