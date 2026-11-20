# Alt-T

**[English](./README.md) | [简体中文](./README.zh-CN.md)**

> A lightweight, hardened Windows desktop translator & **one-key `Enter`-to-Terminal prompt injector** built with Electron 45, Vue 3, `koffi` Win32 `SendInput`, and `undici` — crafted for AI coding CLIs (`Claude Code`, `Codex`, `Antigravity`, `Gemini CLI`, `PowerShell`, `SSH`) and everyday developer workflows.

[![CI](https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/actions/workflows/ci.yml/badge.svg)](https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/actions/workflows/ci.yml)
[![Release](https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/actions/workflows/release.yml/badge.svg)](https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-4F46E5.svg)](./LICENSE)
[![OS: Windows | macOS | Linux](https://img.shields.io/badge/OS-Windows%20%7C%20macOS%20%7C%20Linux-0078D4.svg)](#cross-platform-support-matrix)
[![Zero node-gyp](https://img.shields.io/badge/Native%20Deps-Zero%20node--gyp-success.svg)](#build--packaging)

---

## Why Alt-T?

Typing non-ASCII / CJK prompts directly inside terminal TUIs (`Claude Code`, `Codex`, `Ink` / `Bubbletea` apps) often causes dropped keystrokes, frozen IME candidate windows, or accidental `^C` (`SIGINT`) session interruptions when traditional translation tools send `Ctrl+C` to unhighlighted terminals.

**Alt-T solves this cleanly with zero screenshot/OCR bloat and zero `node-gyp` native builds:**

> [!TIP]
> **`Alt + T` One-Key Terminal Flow**: Press **`Alt + T`** inside any terminal or IDE → type smoothly in a cursor-anchored floating input bar → press **`Enter`** once → Alt-T translates your input into idiomatic technical English (preserving `--flags`, file paths, backticks, env vars, `/slash` commands, and `@mentions`), restores focus to your exact terminal window before hiding, and injects the text using the terminal's native paste chord (`Ctrl+Shift+V` / `Shift+Insert` / `Ctrl+V`) without polluting `Win + V` clipboard history.

---

## Feature Highlights

- **⚡ One-Key Terminal Direct-Paste (`Alt + T`)**: Cursor-anchored floating input bar with `directPaste` locked to `English`, single-key `Enter` translation + paste, and automatic `VK_MASK (0xE8)` injection to suppress stray Alt menu activation.
- **🛡️ `SIGINT`-Safe Smart Replace (`Alt + R`)**:
  - **GUI Apps**: Captures selection, auto-detects language (`zh-Hans` ↔ `en`), and replaces in-place.
  - **Terminals (Option A Default + Option B Toggle)**: Classifies windows by Win32 class first (`CASCADIA_HOSTING_WINDOW_CLASS`, `ConsoleWindowClass`, `mintty`, `VirtualConsoleClass`) and process name (`wt.exe`, `wezterm-gui.exe`, `alacritty.exe`, `ghostty.exe`, `warp.exe`, `waveterm.exe`, `putty.exe`, `kitty.exe`, `xshell.exe`, `mobaxterm.exe`), ensuring `^C` is never sent. See [Terminal & IDE Integrated Terminal Guidance](#terminal--ide-integrated-terminal-guidance).
- **🔍 Non-Destructive Selection Stream (`Alt + E`)**: Highlights text in any window and streams the translation beside your cursor (`AbortController`-wired for both streaming and non-streaming requests).
- **🔌 Zero-Config Dual Engine & Automatic Failover**: Works out of the box via Microsoft Edge Direct (`edge`) and supports any OpenAI-compatible endpoint (`OpenAI`, `DeepSeek`, `Gemini`, `GLM`, `Qwen`, or keyless local loopback LLMs) with automatic retryable failover (`enableFallback`).
- **🧱 Prompt-Injection-Hardened Developer Templates**: Built-in `translate` (`通用与技术翻译`) and `cli-prompt` (`CLI 提示词精炼`) templates treat input strictly as literal source text and protect code blocks, CLI flags, paths, URLs, and identifiers.
- **🔒 Hardened Security & Privacy**:
  - **Zero `Win + V` History Pollution**: Transient clipboard writes use single-`ClipboardItem` OS exclusion markers (`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`, `CanUploadToCloudClipboard`).
  - **DPAPI Credential Encryption & Redaction**: Encrypts `openai.apiKey` at rest via `safeStorage`, scrubs secrets/Bearer tokens/proxy credentials across logs and 60s-throttled crash notifications, denies all Chromium permission requests, tightens production CSP, and hardens builds with `@electron/fuses`.
- **🔄 24/7 Stability & Watchdog**: Pre-hide `SetForegroundWindow` + `15ms × 8` confirmation, `TokenIntegrityLevel=25` UIPI boundary checks, `GetClipboardSequenceNumber()` verification, `EPERM`-retried atomic config saves, `powerMonitor` hotkey healing, and pure-ASCII VBS silent launcher + crash-recovery watchdog.

---

## Hotkey Reference

| Shortcut | Config Key | Behavior |
| :--- | :--- | :--- |
| **`Alt + T`** | `directInputTranslate` | **Direct Input to Terminal / Window**: Opens cursor popup with `⚡ Direct Paste` (`targetLang = en`). Hit `Enter` to translate & paste directly into the previous window. |
| **`Alt + R`** | `replaceTranslate` | **Selection In-Place Replace**: Replaces selected text in GUI apps. In terminals, defaults to safe popup preview (**Option A**) or optional grapheme-aware backspace replace (**Option B**); opens `Alt + T` bar if nothing is selected. |
| **`Alt + E`** | `selectionTranslate` | **Selection Popup Translate**: Captures selected text and streams the translation beside the cursor (non-destructive). |
| **`Alt + Q`** | `togglePopup` | **Toggle Main Popup**: Opens centered translation popup (`Enter` translates in popup; `Ctrl + Enter` translates & pastes into previous window). |
| **`Alt + W`** | *(Removed)* | Screenshot OCR from the early `SPEC.md` design was removed in favor of lightweight text translation and `Alt + T` terminal direct-paste (see [`NOTES.md`](./NOTES.md)). |

> Note: Global shortcuts are validated (`isValidGlobalAccelerator` requires at least one modifier key or standalone `F1`–`F24`) and checked for normalized duplicates in Settings.

---

## Terminal & IDE Integrated Terminal Guidance

### IDE Integrated Terminals (`VS Code`, `Cursor`, `Antigravity`)
> [!IMPORTANT]
> **Inside VS Code, Cursor, or Antigravity integrated terminals, always prefer `Alt + T` (`directInputTranslate`).**
>
> `Code.exe` is intentionally classified as `'normal'` (GUI editor) rather than `'wt'` so that normal editor selections keep using standard `Ctrl+C` / `Ctrl+V`. Because Win32 cannot distinguish an integrated terminal pane from the surrounding IDE editor frame by HWND alone, pressing `Alt + T` inside the integrated terminal is the cleanest, zero-`SIGINT` way to compose and inject commands or prompts.

### Terminal `Alt + R` Strategy: Option A (Default) vs. Option B
- **Option A — Safe Popup Preview (`terminalAutoBackspace: false`, default)**:
  When you highlight text inside a recognized terminal (`Windows Terminal`, `ConHost`, `PowerShell`, `WezTerm`, `Alacritty`, `Ghostty`, `Warp`, `Wave`, `PuTTY`, `Mintty`, `Xshell`, `MobaXterm`) and press `Alt + R`, Alt-T translates the text and opens a cursor popup (`directPaste: true`). Press **`Enter`** once to paste at your terminal cursor, or **`Esc`** to dismiss—never blindly backspacing your command line.
- **Option B — Auto-Backspace Replace (`terminalAutoBackspace: true` in Settings)**:
  For single-line terminal input right at the cursor end, enabling **"终端划选自动退格替换"** counts extended grapheme clusters via `Intl.Segmenter`, verifies the foreground HWND and Windows Terminal tab title (`GetWindowTextW`) haven't changed, physically releases modifiers, sends batched `VK_BACK` keystrokes (`20` per batch, `8ms` interval), and injects the translation via the terminal's paste chord (`Ctrl+Shift+V` or `Shift+Insert`). Multi-line selections always return `0` erase characters to prevent deleting prior shell lines.

---

## Windows UIPI & Elevated Windows

Windows **User Interface Privilege Isolation (UIPI)** blocks a standard-privilege process from sending `SendInput` keystrokes or inspecting process handles of an elevated (**Run as Administrator**) or System window.

Alt-T queries `OpenProcessToken` + `GetTokenInformation(TokenIntegrityLevel = 25)` + `GetSidSubAuthority` before simulating input:
- **`Alt + R` / `Alt + E` on an elevated window**: Intercepts the boundary cleanly and notifies `未选中文本或目标窗口为高权限(UIPI)` without corrupting your clipboard.
- **`Alt + T` / `Ctrl + Enter` paste targeting an elevated window**: Preserves the translated text on your clipboard (skipping clipboard restoration), focuses the target window, and prompts you to paste manually with `Ctrl+V` or `Shift+Insert`.

---

## Configuration & Local Loopback LLM Setup

On first run, Alt-T initializes `config.json` in your user data directory (e.g., `%APPDATA%\Alt-T\config.json` in packaged builds, or refer to [`config.example.json`](./config.example.json) for the full schema).

- **Encrypted API Key**: When you save an OpenAI API key in Settings, Alt-T encrypts it at rest via Electron DPAPI (`safeStorage`) into `openai.encryptedKey` and leaves `openai.apiKey` empty on disk.
- **Local Loopback LLMs (Keyless)**: Endpoints targeting `http://localhost:<port>`, `http://127.0.0.1:<port>`, or `http://[::1]:<port>` (such as `Ollama`, `LM Studio`, `llama.cpp`, or `vLLM`) are permitted with an empty `apiKey`:
  ```json
  "openai": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "apiKey": "",
    "model": "qwen2.5:7b",
    "stream": true
  }
  ```
- **Remote Endpoints**: Any non-loopback `baseUrl` with an empty `apiKey` fails fast locally with error code `CONFIG` (`OpenAI API key is empty`) without sending any network request.
- **Custom Terminal Exe Whitelist**: Add custom terminal `.exe` names in Settings (or `customWtExeNames` / `customConhostExeNames` in `config.json`) to route extra terminals to `Ctrl+Shift+V` or `Shift+Insert` without modifying source code.
- **Clipboard Format Scope**: During selection capture and paste, Alt-T backs up and restores `text/plain`, `text/html`, `text/rtf`, and `image/*`. Non-text/image OS formats such as file drops (`CF_HDROP`) are not backed up.

---

## Silent Launcher & 24/7 Watchdog (Windows)

Both `.vbs` scripts are pure 7-bit ASCII (no BOM), strip `ELECTRON_RUN_AS_NODE` and `FP_SMOKE`, verify `electron.exe` and `out\main\index.js`, and run from the repository root:

```powershell
# Launch silently into the system tray (no console window)
wscript.exe //B //NoLogo start-silent.vbs

# Launch under the 24/7 crash-recovery watchdog
wscript.exe //B //NoLogo watchdog.vbs
```

- **Watchdog behavior**: `watchdog.vbs` runs Electron synchronously (`exitCode = shell.Run(..., 0, True)`).
  - Normal tray quit (`exitCode = 0`, or presence of `clean-exit.flag`) stops the watchdog cleanly.
  - Non-zero crashes automatically restart the app with capped exponential backoff (`2s` up to `60s`, resetting to `2s` after `>= 30s` of stable uptime).
- **Portable Auto-Launch**: Packaged Portable builds detect `PORTABLE_EXECUTABLE_FILE` and register the Startup `.lnk` shortcut directly to the portable `.exe` path.

---

## Cross-Platform Support Matrix

| Capability | Windows 10 / 11 (Tier 1) | macOS | Linux (X11) | Linux (Wayland) |
| :--- | :---: | :---: | :---: | :---: |
| **Floating Popup & Dual-Engine Translation** | ✅ Native | ✅ Native | ✅ Native | ✅ Native |
| **`Alt + T` Direct-Paste to Terminal** | ✅ `koffi` Win32 `SendInput` | ✅ `osascript` `Cmd+V`* | ✅ `xdotool` | ⚠️ Clipboard fallback** |
| **`Alt + R` / `Alt + E` Selection Capture** | ✅ Class + UIPI aware | ✅ `osascript` `Cmd+C`* | ✅ `xdotool` | ⚠️ Clipboard fallback** |
| **Clipboard History Exclusion (`Win + V`)** | ✅ `ClipboardItem` OS tags | — | — | — |
| **Silent Startup / Auto-Launch** | ✅ `.lnk` / Login Item | ✅ `LoginItemSettings` | ✅ `~/.config/autostart` | ✅ `~/.config/autostart` |

*\* macOS requires **Accessibility** permission for synthetic `Cmd+C` / `Cmd+V`.*  
*\*\* Linux Wayland blocks cross-window keystroke injection by design; Alt-T safely copies translations to the clipboard and returns focus.*

---

## Build & Packaging

### Prerequisites
- **OS**: Windows 10 / 11 (x64) for full Win32 native integration & packaging
- **Node.js**: `>= 22.12.0` (or `^20.19.0`) — zero `node-gyp` compilation required (`koffi` ships prebuilt `win32_x64` binaries)

### Commands

```powershell
# 1. Install dependencies
npm install

# 2. Run the full verification suite safely (isolated smoke mode — never steals live hotkeys)
$env:FP_SMOKE="1"; npm run verify

# 3. Build Windows NSIS installer + Portable executable (with @electron/fuses hardening)
npm run dist:win
```

Other helpful scripts:
- `npm run dev` — Start Vite + Electron dev mode
- `npm run typecheck` — Run `tsc` (node) + `vue-tsc` (web)
- `npm run check` — Run static architecture, `.vbs` ASCII/no-BOM, and zero-leakage checks (`scripts/check-rules.mjs`)
- `npm test` — Run unit & fault-injection test suite (`node --import tsx --test`)
- `node scripts/probe-koffi.mjs` — Verify `sizeof(INPUT) === 40` and Win32 `SendInput`
- `node scripts/diagnose-hotkeys.mjs` — Safe read-only lockfile & sanitized config diagnostics

---

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Layered architecture, `Alt+R` / `Alt+T` flows, popup state machine, and watchdog lifecycle (with Mermaid diagrams)
- [`SECURITY.md`](./SECURITY.md) — Threat model, `RendererCodeIntegrity` trade-off & compensating controls, UIPI, DPAPI, clipboard isolation, and vulnerability reporting
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — Setup, static rule gates, testing standards, and PR checklist
- [`NOTES.md`](./NOTES.md) — Engineering deviation log & hardening evolution from `SPEC.md`
- [`config.example.json`](./config.example.json) — Clean reference configuration matching `AppConfig`
- [`LICENSE`](./LICENSE) — MIT License (`yeahyeahyeahyeahyeah0520`)
