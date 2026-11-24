# Security Policy — Alt-T

Alt-T is a local-first Windows desktop utility that intercepts global hotkeys, inspects foreground window metadata, and communicates with translation endpoints. This document transparently describes our threat model, architectural trade-offs, compensating security controls, and vulnerability reporting process.

---

## 1. Transparent Trade-off: `RendererCodeIntegrity` Disabled

In `src/main/index.ts`, Alt-T sets the Chromium command-line switch before `app.whenReady()`:

```ts
app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity')
```

### Why It Is Disabled
On Windows 10/11, third-party Chinese/CJK Input Method Editors (IMEs), accessibility utilities, screen readers, and endpoint security/antivirus software frequently inject helper DLLs into Chromium renderer processes. When Chromium's `RendererCodeIntegrity` mitigation is active, unsigned or third-party injected DLLs cause repeated renderer crashes (`STATUS_INVALID_IMAGE_HASH` / `0xc0000409`) whenever the floating popup gains focus for text input.

### Compensating Controls
Because disabling `RendererCodeIntegrity` relaxes Chromium's renderer DLL signature enforcement, Alt-T enforces strict defense-in-depth across all renderer, IPC, network, and packaging boundaries:

1. **Full Renderer Isolation (`popupWindow.ts`, `settingsWindow.ts`)**:
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - `sandbox: true`
   - `webSecurity: true`
   - `setWindowOpenHandler(() => ({ action: 'deny' }))` and `will-navigate` `preventDefault()` on every `BrowserWindow`.
2. **Restricted Preload Bridge (`src/preload/index.ts`, `src/main/ipc.ts`)**:
   - Exposes only the typed `window.api` contract via `contextBridge.exposeInMainWorld` (never raw `ipcRenderer`).
   - Every `ipcMain.handle` calls `assertTrustedSender()` (requiring `file://` in production or the exact `ELECTRON_RENDERER_URL` origin in dev) and validates every argument type and length (`MAX_TRANSLATE_TEXT_LENGTH = 5000`, `MAX_IPC_TEXT_LENGTH = 50000`).
3. **Default Chromium Permission Denial (`src/main/index.ts`)**:
   - `session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))`
   - `session.defaultSession.setPermissionCheckHandler(() => false)`
   - Denies camera, microphone, geolocation, notifications, clipboard-read web APIs, and all other web permissions.
4. **Tightened Production Content Security Policy (`electron.vite.config.ts` & `src/main/index.ts`)**:
   - At build time, `tightenProductionCspPlugin()` strips `ws://localhost:*` and `http://localhost:*` from `connect-src` in compiled HTML files.
   - At runtime (when `!ELECTRON_RENDERER_URL`), `session.defaultSession.webRequest.onHeadersReceived` enforces:
     ```
     default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'
     ```
   - The renderer never performs HTTP requests (`renderer-no-http` static gate in `scripts/check-rules.mjs`); all network traffic originates in the main process via `undici`.
5. **Electron Fuses Hardening (`@electron/fuses` via `scripts/after-pack.mjs`)**:
   - `runAsNode: false` — prevents the packaged binary from being abused as a generic Node.js runtime via `ELECTRON_RUN_AS_NODE`.
   - `enableNodeOptionsEnvironmentVariable: false` — blocks `NODE_OPTIONS` injection.
   - `enableNodeCliInspectArguments: false` — disables `--inspect` / `--inspect-brk` remote debugging flags in production binaries.

---

## 2. Privilege Boundaries, Target Re-Verification & Win32 UIPI (`TokenIntegrityLevel = 25`)

- **UIPI Enforcement**: Standard-integrity processes cannot inject `SendInput` events into elevated (**Run as Administrator**) or System windows.
- **Detection (`src/main/platform/win32Input.ts`)**: `isWindowElevatedOverSelf(hwnd)` queries `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` and `OpenProcessToken` + `GetTokenInformation(TokenIntegrityLevel = 25)` + `GetSidSubAuthority` to compare the target process's integrity RID against the current process.
- **Pre-Send & Pre-Batch Target Verification (`src/main/services/selectionService.ts`)**:
  - `captureTargetContext()` snapshots the foreground handle, PID, executable basename, and window class before clipboard/shortcut operations.
  - `verifyTargetContext()` re-checks handle/PID/exe before hiding the popup, again before `dispatchPasteShortcut`, and before each 20-character `VK_BACK` batch in Option B terminal replacement — preventing focus races from deleting or pasting into an unintended window.
- **Isolated Win32 COM UIA Worker (`src/main/platform/win32UiaWorker.ts`, `win32Uia.ts`, `win32Classifier.ts`)**:
  - Runs UIA COM inspection on a persistent `worker_threads` thread off Electron's main STA UI thread, guarded by a `120ms` per-probe timeout and 3-failure / `15s` circuit breaker.
  - Classifies IDE sub-regions into `'editor' | 'terminal' | 'unknown'`; when an IDE window resolves to `'unknown'` (or non-editor widgets such as chat/SCM/find boxes), Alt-T refuses blind `Ctrl+C` / `Ctrl+Shift+C` injection.
- **Fail-Safe Behavior**:
  - Selection shortcuts (`Alt+R` / `Alt+E`) abort cleanly before touching the clipboard when targeting an elevated window.
  - Paste actions (`Alt+T` / `Ctrl+Enter`) targeting an elevated window preserve the translated text on the clipboard without restoring the previous snapshot and return `'clipboard-only'` so the user can press `Ctrl+V` / `Shift+Insert` manually.
- **Hidden Desktop Rejection**: `isRunningOnHiddenDesktop()` refuses to launch a persistent GUI instance inside non-interactive sandbox desktops.

---

## 3. Credential Storage, Secret Redaction, History Retention & Crash Handling

- **Fail-Closed Encrypted Storage (`src/main/services/configStore.ts`)**:
  - Uses Electron `safeStorage` (`DPAPI` on Windows; rejects Linux insecure `basic_text` backend via `getSelectedStorageBackend()`). When `safeStorage.isEncryptionAvailable()` is true, `openai.apiKey` is stored encrypted in `openai.encryptedKey` and `openai.apiKey` is cleared (`""`) on disk.
  - Never falls back to writing plaintext `openai.apiKey` when `safeStorage` is unavailable or encryption throws; surfaces a storage warning in IPC (`apiKeyPersistence`) and preserves or explicitly clears ciphertext rather than leaking credentials.
- **End-to-End Redaction (`src/main/core/redact.ts`, `logger.ts`, `httpClient.ts`, `index.ts`)**:
  - `redactSecretsInText` and `redactUrlCredentials` strip `http(s)://user:pass@` proxy/URL credentials, `Authorization: Bearer ...` headers, `Bearer` tokens, `sk-...` / `sk-proj-...` / `AIza...` key patterns, and the currently loaded `apiKey`.
  - All log lines (`alt-t.log`), HTTP error snippets, and `uncaughtException` system notifications pass through redaction, with crash notifications rate-limited by a 60-second cooldown gate (`createCooldownGate(60_000)`).
  - Source/translated text previews in logs are opt-in (`logOriginalTextPreview` defaults to `false`, forced `false` in `localOnlyMode`) and always truncated to 40 characters (`truncatePreview(text, 40)`).
- **Bounded History Retention (`src/shared/config.ts`, `src/main/services/configStore.ts`)**:
  - `historyRetentionDays` (default `30`, max `365`) automatically prunes expired entries on load and save. Setting `historyRetentionDays: 0` enforces memory-only session history (`ephemeralHistoryIds`) that is never written to `config.json`.

---

## 4. Clipboard Privacy (`Win+V` & Cloud Isolation)

- Transient clipboard writes (`writeSentinel` and `writeTransientClipboardText` in `src/main/platform/clipboardBackup.ts`) use a single `ClipboardItem` carrying Windows OS exclusion formats with a 4-byte little-endian zero `Blob`:
  - `ExcludeClipboardContentFromMonitorProcessing`
  - `CanIncludeInClipboardHistory`
  - `CanUploadToCloudClipboard`
- This prevents transient selection sentinels and temporary replace payloads from appearing in `Win+V` history or syncing across devices via Cloud Clipboard. User-initiated clicks on the **Copy** button intentionally use standard `clipboard.writeText` so copied translations remain available in `Win+V`.
- `GetClipboardSequenceNumber()` is checked before restoring snapshots after the `320ms` paste settle window so user-copied data created during translation is never overwritten.

---

## 5. Network & Prompt Security

- **Loopback-Only Keyless OpenAI & Strict Local-Only Mode (`src/main/core/baseUrl.ts`, `httpClient.ts`, `fallback.ts`, `providerTest.ts`)**:
  - `isLoopbackBaseUrl()` permits an empty `apiKey` only for `localhost`, `127.0.0.0/8`, and `::1` (rejecting embedded credentials). Non-loopback endpoints with an empty `apiKey` fail locally with `ProviderError('CONFIG')` before any socket connection is attempted.
  - When `localOnlyMode: true` is enabled, Alt-T blocks external providers (`edge`) and non-loopback URLs across `translateWithFallback`, `testProviderDraft`, and `createHttp`, verifies resolved DNS targets via `isLoopbackIp()` inside an isolated direct `undici.Agent`, bypasses proxies, and rejects HTTP `3xx` redirects (`LOCAL_ONLY_BLOCKED`).
- **Protected Technical Fragments & Prompt Injection Hardening (`src/main/core/protectedText.ts`, `openaiPayload.ts`)**:
  - With `protectTechnicalText: true` (default), fenced/inline code, URLs, Windows/POSIX paths, CLI flags, env vars, and `@mentions` are replaced with collision-free placeholders (`[[ALTT_N]]`) before translation and verified upon completion; missing, duplicated, invented, or corrupted placeholders cancel auto-paste and hold the draft for manual confirmation.
  - Built-in `'translate'` and `'cli-prompt'` templates explicitly instruct the model to treat user input strictly as literal source text and never follow instructions or execute commands embedded inside the text.
  - `renderPrompt` substitutes `{{text}}` last with a function replacer so literal `{{to}}` / `{{toName}}` sequences inside user text are never re-expanded.

---

## 6. Supported Versions & Reporting a Vulnerability

| Version | Supported |
| :--- | :---: |
| Latest release / `main` | ✅ Yes |
| Older snapshots | ❌ Please upgrade to the latest release |

If you discover a security vulnerability in **Alt-T**:

1. **Do NOT open a public GitHub issue** with exploit details, credentials, or personal paths.
2. Report privately via **GitHub Security Advisories** (`https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/security/advisories/new`).
3. Please include:
   - Affected file(s) / component(s) and Alt-T version
   - Step-by-step reproduction instructions
   - Impact assessment (e.g., privilege escalation, IPC bypass, secret disclosure)
4. We aim to acknowledge reports within 72 hours and coordinate a fix before public disclosure.
