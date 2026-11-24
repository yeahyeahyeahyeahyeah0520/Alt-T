# Engineering Notes & Evolution Log (`NOTES.md`)

This document records verified runtime observations, architectural deviations from the original `SPEC.md`, and hardening enhancements implemented for the public open-source release of **Alt-T** (`https://github.com/yeahyeahyeahyeahyeah0520/Alt-T`).

---

## 1. Branding & Lineage: Clean-Room Decoupling to Alt-T

1. **Initial Private Specification (`SPEC.md`)**: Originally drafted as an internal specification referencing an earlier tool.
2. **Clean-Room Open-Source Implementation**: Built clean-room from scratch and unified publicly under **Alt-T** (`https://github.com/yeahyeahyeahyeahyeah0520/Alt-T`, MIT license, `AppUserModelId = 'com.alt-t.app'`), with legacy migration shims (`TTL_SMOKE`, `TTime Lite` watchdog paths, `ocr-translate`) subsequently pruned for simplicity.
3. **Read-Only Diagnostics**: `scripts/diagnose-hotkeys.mjs` inspects the `Alt-T` userData folder read-only via `fs.lstatSync` without stealing `SingletonLock` or printing secrets.

---

## 2. Packaging & Electron Fuses Evolution

- **`SPEC.md` §1.1 Deviation**: The original spec marked `"private": true`, excluded installer tooling (`electron-builder`), and banned extra dependencies in `scripts/check-rules.mjs`.
- **Open-Source Enhancement**:
  - Added `electron-builder` (NSIS installer + Portable executable) and `@electron/fuses` to `devDependencies` for reproducible GitHub Releases and one-click Windows distribution.
  - Synchronized `scripts/check-rules.mjs` so `electron-builder` and `@electron/fuses` are explicitly permitted in `package.json` while keeping `robotjs`, `uiohook`, `sqlite3`, `onnxruntime`, `node-screenshots`, `pinia`, `vuex`, `tailwind`, `element-plus`, `electron-updater`, and `axios` forbidden.
  - Enabled `@electron/fuses` hardening in the post-pack hook (`runAsNode: false`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`) and added high-DPI multi-size `.ico` / `.png` app icons under `build/`.

---

## 3. Feature Pivot: Removal of Screenshot OCR (`Alt+W`)

- **`SPEC.md` §3.4.4 / §4.2 Deviation**: The original spec included `Alt+W` (`screenshotWindow.ts`, `screenshotService.ts`, `ScreenshotView.vue`, `ocr-translate` prompt, `desktopCapturer`, and `computeCropRect`).
- **Why Removed**:
  - Eliminated fullscreen transparent capture overlays, `desktopCapturer` display-matching edge cases on mixed-DPI setups, and Vision-only request paths to keep the main bundle minimal and fast-booting.
  - Replaced `Alt+W` with **`Alt+T` (`directInputTranslate`)**—a cursor-anchored floating input bar (`directPaste: true`, locked to `'en'`) where pressing `Enter` translates developer thoughts and injects them directly into terminals or AI coding CLIs.
- **Prompt Migration**:
  - Replaced `ocr-translate` in `DEFAULT_PROMPTS` with **`cli-prompt`** (`CLI 提示词精炼`) and hardened **`translate`** (`通用与技术翻译`) against prompt injection (treating input strictly as literal source text, preserving backticks, fenced code blocks, file paths, URLs, CLI `--flags`, env vars, `/slash` commands, and `@mentions`).

---

## 4. Pillar 1–4 Hardening Relative to `SPEC.md`

### 4.1 Win32 Input, UIPI, Terminal Classification & Clipboard (`src/main/platform/`, `selectionService.ts`)
- **Terminal `Alt+R` Option A / Option B & Target Re-Verification**:
  - `SPEC.md` assumed uniform `Ctrl+C` / `Ctrl+V` in-place replacement.
  - Added class-first terminal detection (`CASCADIA_HOSTING_WINDOW_CLASS` -> `'wt'`; `ConsoleWindowClass`, `VirtualConsoleClass`, `mintty`, `putty`, `putty-nd` -> `'conhost'`), `warp.exe` / `waveterm.exe` -> `'wt'`, unified `putty.exe`, `kitty.exe`, `xshell.exe`, `mobaxterm.exe` into `CONHOST_EXE_NAMES` (`Ctrl+Insert` / `Shift+Insert`), user-configurable `customWtExeNames` / `customConhostExeNames`, and tri-state IDE focus classification (`'editor' | 'terminal' | 'unknown'`) run inside an isolated `worker_threads` COM UIA worker (`win32UiaWorker.ts`) with timeout termination and circuit breaking (never sending blind `Ctrl+C`/`Ctrl+Shift+C` on `'unknown'`).
  - **Option A (default, `terminalAutoBackspace: false`)**: Selecting text in a terminal and pressing `Alt+R` safely opens the translation popup (`directPaste: true`) so pressing `Enter` pastes at the cursor without blindly erasing shell prompts.
  - **Option B (`terminalAutoBackspace: true`)**: Counts extended grapheme clusters via `Intl.Segmenter`, prepares transient clipboard *before* deleting, verifies foreground handle, PID, exe name, window class, and Windows Terminal tab title (`GetWindowTextW`) before every `20`-char `VK_BACK` batch and immediately before `dispatchPasteShortcut` (preserving the translation on plain clipboard if target drifts after partial deletion).
  - Unified `PopupPasteReply` (`status: 'pasted' | 'clipboard-only' | 'cancelled' | 'error'`) and added `protectTechnicalText` placeholder verification (`protectedText.ts`), `"填入原文"` direct insert, editable result confirm mode (`confirmBeforePaste`), bounded `appOverrides`, `localOnlyMode` network/redirect/DNS isolation, privacy-first defaults (`logOriginalTextPreview: false`, `historyRetentionDays: 30`), `safeStorage` memory-only fallback (without writing plaintext to disk), monotonic stage metrics (`metrics.ts`), and cross-platform CI (`windows-latest`, `macos-latest`, `ubuntu-latest`).
- **UIPI Detection (`TokenIntegrityLevel = 25`)**:
  - Implemented `isWindowElevatedOverSelf(hwnd)` via `advapi32.dll` (`OpenProcessToken`, `GetTokenInformation` class `25`, `koffi.decode(buf, 'void*')`, `GetSidSubAuthorityCount`, `GetSidSubAuthority`), with conservative `false` fallback when `selfRid === null`. Note: `koffi@2.16.4` requires `'void*'` rather than `'intptr_t'` when decoding `TOKEN_MANDATORY_LABEL.Label.Sid`.
  - Intercepts elevated targets in S1 (`未选中文本或目标窗口为高权限(UIPI)`) and falls back in `pasteTextToWindow` (and replace paste catch) to preserving the translation on the clipboard with a manual `Ctrl+V / Shift+Insert` prompt.
- **Modifier & Focus Hygiene**:
  - `MODIFIER_VKS` covers `VK_SHIFT` (`0x10`), `VK_CONTROL` (`0x11`), `VK_MENU` (`0x12`), and L/R/Win keys; `makeKeyEvent` populates `wScan` via `MapVirtualKeyW(wVk, 0)`.
  - `VK_MASK (0xE8)` is injected before `Alt+T` / `Alt+Q` focus switches to suppress stray `WM_SYSKEYUP` menu activation.
  - `pasteTextToWindow` validates `!busy && IsWindow && !IsIconic`, calls `releasePressedModifiers()` and `SetForegroundWindow` **before** hiding the popup, then polls `15ms × 8` to confirm `getActiveTargetHandle() === targetHandle` before pasting (never blind-pasting on failure).
  - `isValidExternalTargetWindow` filters out own PID and Windows shell/taskbar classes (`Shell_TrayWnd`, `NotifyIconOverflowWindow`, `Progman`, `WorkerW`, etc.).
- **Clipboard Sequence & `Win+V` Isolation**:
  - `GetClipboardSequenceNumber()` reuses `snap1` from S7 to S12 when unchanged, extends post-paste wait to `320ms` (`POST_PASTE_RESTORE_DELAY_MS`), verifies the sequence number before restoring, and wraps clipboard ops in 3 short-backoff retries (`20ms`, `40ms`, `80ms`).
  - `writeTransientClipboardText` writes a single `ClipboardItem` containing `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`, and `CanUploadToCloudClipboard` (4-byte little-endian `0`) so sentinels and transient replace payloads do not pollute Windows `Win+V` or cloud clipboard history (while user-clicked Copy remains plain `clipboard.writeText`).

### 4.2 Reentrancy, Popup State Machine, Security & Launchers
- **Reentrancy & State Machine (`src/shared/popupState.ts`, `PopupView.vue`, `popupWindow.ts`, `hotkeyService.ts`)**:
  - `Alt+T` / `Alt+Q` call `cancelActiveReplaceFlow()` to abort any in-flight `Alt+R` background translation.
  - `handleWindowBlur()` clears `pendingPasteAfterDone` when `!pasting` so late async completions never hijack focus.
  - `directPaste` locks `targetLang = 'en'` (`manualLangLocked = true`); `hasReceivedPopupShow` blocks late `configGet()` replies from overwriting `targetLang`; `shouldSuppressMidStreamResize` suppresses `popupResize` while `pendingPasteAfterDone` is true.
  - Enforces a `5000`-char manual input cap on both frontend and backend (`ipc.ts`), unifies `stream = config.openai.stream`, wires `AbortController` to non-streaming `Alt+E` IPC calls, guards `popupWindow` against auto-grow pollution (`programmaticResizeUntil`), syncs `nativeTheme` background color, throttles `render-process-gone` reloads (max 3 per `5000ms`), and coalesces `powerMonitor` debounce timers with full `dispose()`.
- **Security & Privacy (`core/redact.ts`, `core/baseUrl.ts`, `index.ts`, `configStore.ts`, `electron.vite.config.ts`)**:
  - `isLoopbackBaseUrl(url)` permits keyless OpenAI-compatible requests only to `localhost`, `127.0.0.0/8`, and `::1`; non-loopback empty `apiKey` fails locally with `CONFIG` before network egress.
  - `core/redact.ts` scrubs URL credentials (`http(s)://user:pass@`), `Authorization: Bearer ...`, `sk-...`, `sk-proj-...`, `AIza...`, and active API keys from logs, errors, and 60s-cooldown-throttled `uncaughtException` notifications.
  - `session.defaultSession` denies all permission requests/checks; `electron.vite.config.ts` strips dev `localhost` / `ws://localhost:*` from production HTML CSP (`connect-src 'self'`), reinforced by main-process `onHeadersReceived`.
  - `configStore.ts` retries `writeAtomic` `renameSync` on `EPERM` / `EBUSY` / `EACCES` (`15ms`, `35ms`, `70ms`), isolates `addHistory` errors, and encrypts `apiKey` at rest via DPAPI (`safeStorage`).
- **Launchers & Watchdog (`start-silent.vbs`, `watchdog.vbs`, `autoLaunch.ts`)**:
  - Both `.vbs` scripts are pure 7-bit ASCII without BOM, verify `electron.exe` and `out\main\index.js`, strip `ELECTRON_RUN_AS_NODE` / `ALT_T_SMOKE` / `FP_SMOKE`, and pass `"."`.
  - `watchdog.vbs` uses synchronous `exitCode = shell.Run(..., 0, True)`, exits cleanly on `exitCode = 0` or `Alt-T\clean-exit.flag`, restarts crashes with `2s`–`60s` backoff, and never deletes `SingletonLock`.
  - `autoLaunch.ts` skips Startup writes when `ELECTRON_RENDERER_URL` is set, supports `PORTABLE_EXECUTABLE_FILE`, and compares existing shortcuts before rewriting.

---

## 5. Verification Status of `SPEC.md` §6 Unverified Items (`U1`–`U10`)

| Item | Original Concern | Verified Resolution / Status |
|---|---|---|
| **U1** | `disable-features=RendererCodeIntegrity` acceptance in Electron 45 | Accepted and verified via `ALT_T_SMOKE=1` launch on Electron 45.3.3; retained for Windows IME/AV DLL compatibility with compensating sandbox/CSP/Fuses controls (documented in `SECURITY.md`). |
| **U2** | Embedded Node version inside Electron `45.3.3` | Verified `Node 24.22.3` (`win32 x64`), satisfying `undici@7.30.2` (`>=20.18.1`) and `electron-vite@6.0.0`. |
| **U3** | Mixed-DPI screenshot window `setBounds` offset | Obsolete (`Alt+W` screenshot capture removed). `popupWindow.ts` applies post-`show` `setBounds` with `programmaticResizeUntil` guard for mixed-DPI stability. |
| **U4** | `VK_MASK (0xE8)` suppressing stray Alt/Win menu activation | Implemented in `releaseModifiers()`, `injectMaskKey()` (before `Alt+T`/`Alt+Q`), and `sendChordWithModifierGuard()`. |
| **U5** | `undici.ProxyAgent` HTTP target behavior (`CONNECT` vs absolute URI) | Verified with local `node:http` proxy server in `tests/providers.test.ts`; credentials redacted via `redactUrlCredentials`. |
| **U6** | Unofficial Edge `translatetext` endpoint reliability | Retained as zero-config primary/fallback provider with automatic internal failover to `edge.microsoft.com/translate/auth` + Cognitive v3 Bearer endpoint on HTTP 401/403/429/5xx or parse failures; errors reported cleanly via `ProviderError`. |
| **U7** | Conservative locked dependency versions (`ts@5.9.3`, `koffi@2.16.4`, `undici@7.30.2`) | Verified compatible on Node 22/24 and Electron 45.3.3; `koffi@2.16.4` prebuilt `win32_x64` binary verified (`sizeof(INPUT) === 40`). |
| **U8** | Vite 8 `build.rollupOptions` compatibility | Verified cleanly under `vite@8.3.8` + `electron-vite@6.0.0`. |
| **U9** | Clipboard backup excludes `CF_HDROP` and custom binary formats | Retained and explicitly disclosed in `SettingsView.vue` footer and `README*.md`; transient writes tagged to avoid `Win+V` history pollution. |
| **U10** | Vision request 6000ms non-stream timeout | Obsolete (`Alt+W` screenshot OCR removed). |
