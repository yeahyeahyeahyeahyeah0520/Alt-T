# Architecture Overview — Alt-T

Alt-T is structured around a strict unidirectional layered architecture (`L0`–`L5`, `Preload`, and `Renderer`) enforced automatically by [`scripts/check-rules.mjs`](./scripts/check-rules.mjs). Pure domain logic (`L0` + `L1`) has zero Electron, `koffi`, or `undici` imports so unit and fault-injection tests execute directly in Node.js via `tsx`, while OS integration (`L3`) and services (`L4`) expose dependency-injection seams (`set*ForTest`) for deterministic testing.

---

## 1. Layered Architecture & Dependency Boundaries

```mermaid
flowchart TB
    subgraph Renderer["Renderer Layer (Sandbox = true, No Node / No Direct HTTP)"]
        R_VIEWS["src/renderer/src/views/<br/>PopupView.vue · SettingsView.vue"]
        R_COMP["src/renderer/src/composables/useTranslate.ts"]
        R_VIEWS --> R_COMP
    end

    subgraph Preload["Preload Bridge (CJS)"]
        P_API["src/preload/index.ts<br/>contextBridge window.api + invokeWithFallback"]
    end

    subgraph L5["L5 — App, Windows, IPC & Tray"]
        M_IDX["src/main/index.ts<br/>Lifecycle · CSP · Permissions · Smoke"]
        M_IPC["src/main/ipc.ts<br/>assertTrustedSender · Args Validation"]
        M_WIN["src/main/windows/<br/>popupWindow.ts · settingsWindow.ts"]
        M_TRAY["src/main/tray.ts · appState.ts"]
    end

    subgraph L4["L4 — Application Services"]
        S_SEL["selectionService.ts<br/>Alt+R/Alt+E Flow · Paste Engine"]
        S_HK["hotkeyService.ts<br/>GlobalShortcut · Retry · Heal · Dispose"]
        S_TR["translateService.ts<br/>Request Map · Stream/Once"]
        S_CFG["configStore.ts<br/>DPAPI · Atomic EPERM Retry · Quit Flags"]
        S_LOG["logger.ts<br/>Rotating Log · Secret Scrubbing"]
    end

    subgraph L3["L3 — Platform Adapters & Win32 FFI"]
        P_HOST["hostPlatform.ts<br/>Win32 / macOS / X11 / Wayland Seam"]
        P_WIN32["win32Input.ts<br/>koffi SendInput · UIPI · Classifiers"]
        P_CLIP["clipboardBackup.ts<br/>Multi-Format Snapshot · Win+V Exclusion"]
        P_SCR["screenGeometry.ts · autoLaunch.ts"]
    end

    subgraph L2["L2 — HTTP & Translation Providers"]
        PR_FB["fallback.ts<br/>Retryable Failover"]
        PR_OAI["openaiCompatible.ts<br/>Stream/Once · Loopback Policy"]
        PR_EDGE["edgeDirect.ts<br/>Zero-Config Edge Endpoint"]
        PR_HTTP["httpClient.ts<br/>undici fetch · ProxyAgent · Timeout/Abort Markers"]
    end

    subgraph L1["L1 — Pure Main Core (Zero Electron/koffi/undici)"]
        C_CORE["src/main/core/<br/>baseUrl.ts · clipboardPolicy.ts · geometry.ts<br/>openaiPayload.ts · sseParser.ts · redact.ts"]
    end

    subgraph L0["L0 — Pure Shared Contracts (Zero Node/Electron/DOM)"]
        SH["src/shared/<br/>types.ts · config.ts · text.ts · popupState.ts"]
    end

    Renderer -- "window.api (IPC)" --> Preload
    Preload -- "ipcMain.handle / webContents.send" --> L5
    Preload --> L0
    R_VIEWS --> L0
    L5 --> L4
    L5 --> L3
    L5 --> L1
    L5 --> L0
    L4 --> L3
    L4 --> L2
    L4 --> L1
    L4 --> L0
    L3 --> L1
    L3 --> L0
    L2 --> L1
    L2 --> L0
    L1 --> L0
```

### Layer Rules Enforced by `scripts/check-rules.mjs`
- **`core-no-electron`**: `src/shared/**` and `src/main/core/**` cannot import or `require` `electron`, `koffi`, or `undici`.
- **`renderer-no-main` & `renderer-no-http`**: `src/renderer/**` and `src/preload/**` cannot import `src/main/**`; renderer cannot call `fetch()`, `XMLHttpRequest`, or `axios`.
- **`platform-guard`**: Direct `process.platform` checks are isolated inside `src/main/platform/**`.
- **`popup-close-guard`**: `popupWindow.ts` `'close'` listener must guard with `isQuitting()` before `preventDefault() + hide()`.

---

## 2. `Alt+R` Selection & Terminal Direct-Paste Flow

This diagram captures the end-to-end execution of `runSelectionFlow('replace')` (`Alt+R`) and `pasteTextToWindow` (`Alt+T` / `Enter`-to-paste) across `selectionService.ts`, `win32Input.ts`, `clipboardBackup.ts`, and `popupWindow.ts`.

```mermaid
sequenceDiagram
    autonumber
    actor User as Developer
    participant HK as hotkeyService
    participant SEL as selectionService
    participant WIN as win32Input / hostPlatform
    participant CLIP as clipboardBackup
    participant TR as translateService (OpenAI / Edge)
    participant POP as popupWindow / PopupView

    User->>HK: Press Alt+R (or Alt+T)
    alt Alt+R Selection Replace
        HK->>SEL: runSelectionFlow('replace')
        Note over SEL: S0: Acquire mutex busy=true + 30s watchdog AbortController
        SEL->>WIN: S1: getActiveTargetHandle()
        WIN-->>SEL: handle0
        SEL->>WIN: isOwnProcessWindow(handle0)?
        alt Own Process Window
            SEL-->>HK: Return 'no-selection'
        else External Window
            SEL->>WIN: isWindowElevatedOverSelf(handle0) [TokenIntegrityLevel=25]
            alt Elevated / UIPI Blocked
                SEL-->>User: Notify "未选中文本或目标窗口为高权限(UIPI)"
            else Same or Lower Integrity
                SEL->>WIN: getTargetCopyKind / getTargetPasteKind + GetWindowTextW (wt)
                Note over WIN: Class-first: CASCADIA -> wt; Console/mintty -> conhost<br/>putty/kitty/xshell/mobaxterm -> conhost; Code.exe -> normal
                SEL->>WIN: S2: releasePressedModifiers()
                SEL->>CLIP: S3: snap1 = backupClipboard() + writeSentinel() [Win+V excluded]
                SEL->>WIN: S4: dispatchCopyShortcut(copyKind) [Ctrl+C / Ctrl+Shift+C / Ctrl+Insert]
                SEL->>CLIP: S5: waitForClipboardChange(25ms, 220ms term / 400ms std)
                alt Timeout (no selection) & Terminal
                    SEL->>CLIP: restoreClipboard(snap1)
                    SEL->>POP: openDirectInput(handle0) [Fallback to Alt+T]
                else Text Captured
                    SEL->>CLIP: S7: restoreClipboard(snap1); seqAfterS7 = GetClipboardSequenceNumber()
                    SEL->>TR: S10b: translateOnce({text, to}, watchdog.signal)
                    TR-->>SEL: translatedText (with retryable fallback)
                    alt pasteKind != 'normal' & !terminalAutoBackspace (Option A Default)
                        SEL->>POP: showPopupAtCursor(directPaste: true) + translateDone
                        Note over POP: User reviews translation & presses Enter
                        POP->>SEL: IPC popup:paste-to-target
                    else pasteKind != 'normal' & terminalAutoBackspace (Option B)
                        SEL->>WIN: Verify handleNow == handle0 & !wtTitleChanged
                        SEL->>WIN: releasePressedModifiers() + batched VK_BACK (20/batch, 8ms)
                    else pasteKind == 'normal' (GUI App)
                        SEL->>WIN: Verify handleNow == handle0 (else S11 showInactiveAtCursor)
                    end
                    Note over SEL,CLIP: Paste & Sequence-Safe Restore
                    SEL->>WIN: Pre-hide releasePressedModifiers() + SetForegroundWindow(target)
                    SEL->>POP: hidePopup() [if from popup]
                    SEL->>WIN: Poll 15ms x 8 confirming foreground == target
                    alt Foreground Confirmed
                        SEL->>CLIP: Reuse snap1 if seq == seqAfterS7, else backup snap2
                        SEL->>CLIP: writeTransientClipboardText() [OS monitor/history/cloud excluded]
                        SEL->>WIN: dispatchPasteShortcut(pasteKind)
                        SEL->>SEL: Wait 320ms (POST_PASTE_RESTORE_DELAY_MS)
                        SEL->>CLIP: restoreClipboardIfUnchanged(snap, text, seqAfterWrite)
                    else Foreground Mismatch / UIPI
                        SEL->>CLIP: Write plain translation to clipboard (no restore)
                        SEL-->>User: Prompt manual Ctrl+V / Shift+Insert
                    end
                end
            end
        end
    end
```

---

## 3. Popup State Machine & Reentrancy Protection

`src/shared/popupState.ts`, `PopupView.vue`, `popupWindow.ts`, and `hotkeyService.ts` coordinate to prevent async races, focus steals, and window-size pollution.

```mermaid
stateDiagram-v2
    [*] --> Hidden: Pre-created hidden BrowserWindow

    Hidden --> DirectInput: Alt+T (inject VK_MASK 0xE8 + cancelActiveReplaceFlow)
    Hidden --> CenteredInput: Alt+Q (inject VK_MASK 0xE8 + cancelActiveReplaceFlow)
    Hidden --> SelectionStream: Alt+E (mode='selection', requestId attached)
    Hidden --> TerminalPreview: Alt+R Option A (mode='selection', directPaste=true)

    state DirectInput {
        [*] --> LockedEn
        LockedEn: directPasteMode = true
        LockedEn: targetLang = 'en', manualLangLocked = true
        LockedEn: hasReceivedPopupShow = true (blocks late configGet overwrite)
    }

    state CenteredInput {
        [*] --> AutoDetectLang
        AutoDetectLang: directPasteMode = false
        AutoDetectLang: detectTargetLang on input until manual select
    }

    DirectInput --> Translating: Enter (text <= 5000 chars, pendingPasteAfterDone = true)
    CenteredInput --> Translating: Enter (pendingPasteAfterDone = false) / Ctrl+Enter (pendingPasteAfterDone = true)
    SelectionStream --> Translating: Streaming chunks (stream = config.openai.stream)

    state Translating {
        [*] --> ActiveRequest
        ActiveRequest: shouldSuppressMidStreamResize = (streaming && pendingPasteAfterDone)
        ActiveRequest: programmaticResizeUntil (250ms) guards config.popupHeight
    }

    Translating --> Pasting: done & pendingPasteAfterDone == true
    Translating --> IdleVisible: done & pendingPasteAfterDone == false (measureNaturalHeight -> popupResize)
    Translating --> IdleVisible: Esc / Stop button (translateCancel -> AbortController.abort)

    state BlurHandling {
        [*] --> CheckBlur
        CheckBlur: handlePopupBlurState(state, pinned, isBusy)
        CheckBlur: If pendingPasteAfterDone && !pasting -> clear flag + warn toast
        CheckBlur: If !pinned && !isBusy && !pasting -> popupHide()
    }

    Translating --> BlurHandling: Window blur
    IdleVisible --> BlurHandling: Window blur
    BlurHandling --> Hidden: shouldHide == true
    Pasting --> Hidden: Pre-hide SetForegroundWindow -> hide() -> 15ms x 8 confirm -> paste
    IdleVisible --> Hidden: Esc / Close button / Alt+T or Alt+Q toggle

    note right of Translating
        render-process-gone recovery:
        Max 3 reloads per 5000ms window
        (150ms, 1500ms, 3000ms backoff)
    end note
```

---

## 4. Watchdog, AutoLaunch & 24/7 Lifecycle

`start-silent.vbs`, `watchdog.vbs`, `autoLaunch.ts`, `configStore.ts`, `hotkeyService.ts`, and `index.ts` guarantee clean startup, crash recovery, and zero-residue shutdowns.

```mermaid
flowchart TD
    START(["Windows Startup .lnk or Manual Launch"]) --> VBS_TYPE{"Launcher"}

    VBS_TYPE -- "start-silent.vbs" --> STRIP1["Pure ASCII No-BOM VBS<br/>Strip ELECTRON_RUN_AS_NODE / TTL_SMOKE / FP_SMOKE<br/>Verify electron.exe & out\\main\\index.js"]
    STRIP1 --> RUN_ONCE["shell.Run(&quot;electron.exe .&quot;, 0, False)"]

    VBS_TYPE -- "watchdog.vbs" --> STRIP2["Pure ASCII No-BOM VBS<br/>Strip env vars & verify binaries"]
    STRIP2 --> WD_LOOP["exitCode = shell.Run(&quot;electron.exe .&quot;, 0, True)"]

    WD_LOOP --> CHECK_EXIT{"exitCode == 0<br/>OR clean-exit.flag<br/>OR legacy intentional-quit.flag?"}
    CHECK_EXIT -- "Yes (Intentional Quit)" --> WD_STOP(["Watchdog exits cleanly (0)"])
    CHECK_EXIT -- "No (Crash / Non-zero)" --> BACKOFF["Reset backoff to 2s if uptime >= 30s<br/>Else double backoff (2s .. 60s) & Sleep"]
    BACKOFF --> WD_LOOP

    subgraph MainProcess["Electron Main Process (src/main/index.ts)"]
        BOOT0["1. Pre-ready switches: wm-window-animations-disabled,<br/>disable-features=RendererCodeIntegrity, disableHardwareAcceleration"]
        BOOT1["2. Guard: isRunningOnHiddenDesktop() & requestSingleInstanceLock()"]
        BOOT2["3. app.whenReady(): deny default permissions,<br/>enforce PRODUCTION_CSP, clearCleanExit()"]
        BOOT3["4. configStore.load() (DPAPI hydrate + EPERM retry)<br/>Create popupWindow, tray, registerIpc"]
        BOOT4["5. syncAutoLaunch(cfg.autoLaunch):<br/>Skip if ELECTRON_RENDERER_URL<br/>Remove orphan legacy watchdog shortcut<br/>Use PORTABLE_EXECUTABLE_FILE if portable<br/>Compare readShortcutLink before rewrite"]
        BOOT5["6. Register global hotkeys + 60s healMissingHotkeys()<br/>+ coalesced powerMonitor (resume/unlock/active)"]
        QUIT["before-quit:<br/>setQuitting(true) -> markCleanExit()<br/>(clean-exit.flag + legacy intentional-quit.flag)<br/>hotkeyService.dispose() -> tray.destroy() -> translateService.disposeAll()"]

        BOOT0 --> BOOT1 --> BOOT2 --> BOOT3 --> BOOT4 --> BOOT5
        BOOT5 -- "Tray Quit / app.quit()" --> QUIT
    end

    RUN_ONCE --> BOOT0
    WD_LOOP --> BOOT0
```

---

## 5. Module Index

| Layer | Path | Primary Responsibility |
| :--- | :--- | :--- |
| **L0** | `src/shared/types.ts` | `AppConfig`, `DEFAULT_CONFIG`, hardened `DEFAULT_PROMPTS`, `IPC_CHANNELS`, `RendererApi` |
| **L0** | `src/shared/config.ts` | `mergeConfig`, `isValidGlobalAccelerator`, `normalizeAcceleratorKey`, `findDuplicateHotkeys`, protected prompts |
| **L0** | `src/shared/text.ts` | `detectTargetLang`, `countGraphemes` (`Intl.Segmenter`), `countTerminalEraseChars`, `normalizeTerminalCapturedText` |
| **L0** | `src/shared/popupState.ts` | Pure popup UI state transitions, `directPaste` lang lock, blur cleanup, `5000`-char validation |
| **L1** | `src/main/core/*` | `baseUrl.ts` (`isLoopbackBaseUrl`), `clipboardPolicy.ts`, `geometry.ts`, `openaiPayload.ts`, `sseParser.ts`, `redact.ts` |
| **L2** | `src/main/providers/*` | `httpClient.ts` (`undici`), `openaiCompatible.ts`, `edgeDirect.ts`, `fallback.ts` |
| **L3** | `src/main/platform/*` | `win32Input.ts`, `hostPlatform.ts`, `clipboardBackup.ts`, `screenGeometry.ts`, `autoLaunch.ts` |
| **L4** | `src/main/services/*` | `selectionService.ts`, `hotkeyService.ts`, `translateService.ts`, `configStore.ts`, `logger.ts` |
| **L5** | `src/main/*` | `index.ts`, `ipc.ts`, `tray.ts`, `appState.ts`, `windows/popupWindow.ts`, `windows/settingsWindow.ts` |
| **P / R** | `src/preload/`, `src/renderer/` | `contextBridge` API with fallback, `PopupView.vue`, `SettingsView.vue`, `useTranslate.ts` |
