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

## 2. Privilege Boundaries & Win32 UIPI (`TokenIntegrityLevel = 25`)

- **UIPI Enforcement**: Standard-integrity processes cannot inject `SendInput` events into elevated (**Run as Administrator**) or System windows.
- **Detection (`src/main/platform/win32Input.ts`)**: `isWindowElevatedOverSelf(hwnd)` queries `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` and `OpenProcessToken` + `GetTokenInformation(TokenIntegrityLevel = 25)` + `GetSidSubAuthority` to compare the target process's integrity RID against the current process.
- **Fail-Safe Behavior**:
  - Selection shortcuts (`Alt+R` / `Alt+E`) abort cleanly before touching the clipboard when targeting an elevated window.
  - Paste actions (`Alt+T` / `Ctrl+Enter`) targeting an elevated window preserve the translated text on the clipboard without restoring the previous snapshot and prompt the user to press `Ctrl+V` / `Shift+Insert` manually.
- **Hidden Desktop Rejection**: `isRunningOnHiddenDesktop()` refuses to launch a persistent GUI instance inside non-interactive sandbox desktops.

---

## 3. Credential Storage, Secret Redaction & Crash Handling

- **Encrypted Storage (`src/main/services/configStore.ts`)**:
  - When `safeStorage.isEncryptionAvailable()` is true (DPAPI on Windows), `openai.apiKey` is encrypted before writing to disk (`openai.encryptedKey`), and `openai.apiKey` is stored as `""`.
- **End-to-End Redaction (`src/main/core/redact.ts`, `logger.ts`, `httpClient.ts`, `index.ts`)**:
  - `redactSecretsInText` and `redactUrlCredentials` strip `http(s)://user:pass@` proxy/URL credentials, `Authorization: Bearer ...` headers, `Bearer` tokens, `sk-...` / `sk-proj-...` / `AIza...` key patterns, and the currently loaded `apiKey`.
  - All log lines (`alt-t.log`), HTTP error snippets, and `uncaughtException` system notifications pass through redaction, with crash notifications rate-limited by a 60-second cooldown gate (`createCooldownGate(60_000)`).
  - Source/translated text previews in logs are truncated to 40 characters (`truncatePreview(text, 40)`).

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

- **Loopback-Only Keyless OpenAI Policy (`src/main/core/baseUrl.ts`, `openaiCompatible.ts`)**:
  - `isLoopbackBaseUrl()` permits an empty `apiKey` only for `localhost`, `127.0.0.0/8`, and `::1`. Non-loopback endpoints with an empty `apiKey` fail locally with `ProviderError('CONFIG')` before any socket connection is attempted.
- **Prompt Injection Hardening (`src/shared/types.ts`, `src/main/core/openaiPayload.ts`)**:
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
2. Report privately via **GitHub Security Advisories** (`https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/security/advisories/new`).
3. Please include:
   - Affected file(s) / component(s) and Alt-T version
   - Step-by-step reproduction instructions
   - Impact assessment (e.g., privilege escalation, IPC bypass, secret disclosure)
4. We aim to acknowledge reports within 72 hours and coordinate a fix before public disclosure.
