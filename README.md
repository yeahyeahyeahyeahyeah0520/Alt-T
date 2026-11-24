# Alt-T

**[English](./README.md) | [简体中文](./README.zh-CN.md)**

> A lightweight, hardened Windows desktop translator & **one-key `Enter`-to-Terminal prompt injector** built with Electron 45, Vue 3, `koffi` Win32 `SendInput`, and `undici` — crafted for AI coding CLIs (`Claude Code`, `Codex`, `Antigravity`, `Gemini CLI`, `PowerShell`, `SSH`) and everyday developer workflows.

[![CI](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/actions/workflows/ci.yml/badge.svg)](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/actions/workflows/ci.yml)
[![Release](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/actions/workflows/release.yml/badge.svg)](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-4F46E5.svg)](./LICENSE)
[![OS: Windows primary | macOS/Linux experimental](https://img.shields.io/badge/OS-Windows%20primary%20%7C%20macOS%2FLinux%20experimental-0078D4.svg)](#cross-platform-support-matrix)
[![Zero node-gyp](https://img.shields.io/badge/Native%20Deps-Zero%20node--gyp-success.svg)](#build--packaging)

---

## Download & Quick Install

Download prebuilt Windows binaries from the [**Latest GitHub Release**](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/releases/latest):
- **`Alt-T-<version>-setup.exe`** — Standard NSIS installer (custom install directory, Start Menu shortcut, optional Startup launch).
- **`Alt-T-<version>-portable.exe`** — Single-file portable executable (no installation required).

> [!NOTE]
> **Windows SmartScreen Notice (Unsigned Open-Source Build)**: Because community builds do not yet carry a commercial EV code-signing certificate, Windows SmartScreen may show *"Windows protected your PC"* on first launch. Click **More info → Run anyway** after verifying the file hash against the release's `SHA256SUMS.txt`:
> ```powershell
> Get-FileHash .\Alt-T-0.1.0-setup.exe -Algorithm SHA256
> ```

## First run in 60 seconds

1. Install and launch Alt-T. It stays in the tray; the target terminal does not need to be elevated.
2. Confirm the provider in Settings. If text must stay on the machine, choose local Ollama and keep strict local-only mode enabled.
3. Return to VS Code, Cursor, Antigravity, or Windows Terminal, press `Alt+T`, type one sentence, and press `Enter`.

The first-run success check is visible in the popup: the target application is identified, the data scope is shown, and `Ctrl+Enter` puts the translated text back into the original window. If the target runs as Administrator, run Alt-T at the same integrity level; otherwise Alt-T keeps the result on the clipboard and explains how to paste it manually.

## Verification scope

| Capability | Status | Notes |
| --- | --- | --- |
| Windows build, unit tests, production audit | Verified | Current CI and local `npm run verify` pass |
| Windows NSIS / Portable packaging | Verified | Installers and SHA-256 checksums are generated |
| Real VS Code / Cursor / Antigravity focus trees | Manual validation pending | Headless checks are not claimed as desktop acceptance |
| Elevated windows, IME composition, physical hotkeys | Manual validation pending | Run the acceptance matrix on the target machine |
| macOS / Linux cross-window injection | Experimental | Depends on accessibility permissions and X11/Wayland tooling; Windows is the release focus |

## Data boundaries

- The popup status strip shows the target window, network scope, and history/logging state before a send.
- Strict local-only mode permits only `localhost`, `127.0.0.0/8`, and `::1`; it bypasses proxies, blocks redirects, and disables external fallback.
- API keys use the system credential store when available. If it is unavailable, the key remains memory-only and is never written as plaintext.
- Original-text logging is off by default. History can be disabled or set to `0` for the current session only.
- These settings do not weaken target re-verification, UIPI blocking, or protected technical-text validation.

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
- **🔌 Zero-Config Dual Engine, Dual-Path Edge Resilience & One-Click Test**: Works out of the box via Microsoft Edge (`edge`, with automatic `translatetext` → `auth` Bearer token cognitive v3 failover) and supports any OpenAI-compatible endpoint (`Ollama`, `DeepSeek`, `OpenAI`, `OpenRouter`, `SiliconFlow`, or keyless local loopback LLMs) with quick presets, an isolated **Test Connection** button in Settings, and automatic failover (`enableFallback`).
- **🧱 Prompt-Injection-Hardened Developer Templates & Technical Fragment Protection**: Built-in `translate` and `cli-prompt` templates treat input strictly as literal source text, while `protectTechnicalText` (`true` by default) masks fenced/inline code, URLs, Windows/POSIX paths (including CJK & spaces), CLI `--flags`, env vars, and `@mentions` with collision-free placeholders (`[[ALTT_N]]`)—aborting auto-paste and holding in preview whenever any placeholder is missing, duplicated, invented, or corrupted.
- **🔒 Hardened Security & Privacy**:
  - **Strict Local-Only Mode (`localOnlyMode`)**: Auto-enabled when applying local loopback presets or toggled in Settings; enforces loopback-only URLs and connect-time DNS IP checks, bypasses proxy agents, blocks HTTP `3xx` redirects, and forbids external providers (`edge`) and fallback egress.
  - **Privacy-First Logging, History Retention & DPAPI No-Plaintext Fallback**: Original text preview logging (`logOriginalTextPreview`) defaults to `false` (metadata only); history defaults to `30`-day retention (`0` keeps session history in RAM only); `safeStorage` encryption failures keep API keys memory-only for the session without writing plaintext to disk or overwriting valid ciphertext.
  - **Zero `Win + V` History Pollution**: Transient clipboard writes use single-`ClipboardItem` OS exclusion markers (`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`, `CanUploadToCloudClipboard`).
- **🔄 Pre-Send Safety, Target Visibility & Direct Original Paste**: Pre-hide target capture, synchronous pre-send re-verification of HWND/PID/exe/class immediately before paste (and before every `20`-char `VK_BACK` batch in Option B, preserving translation on clipboard after partial deletion), explicit 4-state `PopupPasteReply` (`pasted | clipboard-only | cancelled | error`), target-app badge, editable preview confirmation (`confirmBeforePaste` + IME `compositionend` guards), **"Insert Original"** direct paste without translation, bounded per-app overrides (`appOverrides`), and monotonic metadata-only metrics (`metrics.ts`).

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

### IDE Integrated Terminals (`VS Code`, `Cursor`, `Windsurf`, `Antigravity`)
> [!IMPORTANT]
> **Inside VS Code, Cursor, Windsurf, or Antigravity integrated terminals, always prefer `Alt + T` (`directInputTranslate`).**
>
> `Code.exe` stays classified as `'normal'` for regular editor panes so normal text selection continues to use `Ctrl+C` / `Ctrl+V`. To guard integrated terminals from accidental `^C` (`SIGINT`), Alt-T layers three protections:
> 1. **Off-Thread Windows UI Automation Worker**: On known Electron/JetBrains IDEs (`code.exe`, `cursor.exe`, `windsurf.exe`, `antigravity.exe`, `vscodium.exe`, `trae.exe`, etc.), Alt-T runs UIA checks inside an isolated Node `worker_threads` worker (`win32UiaWorker.ts`) with timeout termination and circuit breaking, classifying focus into a tri-state `'editor' | 'terminal' | 'unknown'`. Confirmed terminal panes upgrade to `'wt'` (`Ctrl+Shift+C` / safe preview), whereas `'unknown'` (timeout, PID mismatch, or non-editor widgets) refuses blind `Ctrl+C` / `Ctrl+Shift+C` and switches to direct input (`Alt+R`) or manual copy prompt (`Alt+E`).
> 2. **Zero-`Ctrl+C` Force-Popup List (`forcePopupOnReplaceExes`)**: If accessibility is disabled in your IDE, add `code.exe` (or `cursor.exe`) in Settings under **防误触强制浮窗**—pressing `Alt + R` on those executables skips `Ctrl+C` entirely and opens the `Alt + T` direct-input bar.
> 3. **Direct Input Flow (`Alt + T`)**: Never sends a copy keystroke and pastes cleanly into every IDE integrated terminal.

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

- **Encrypted API Key & Safe Failure Fallback**: When `safeStorage` encryption is available (DPAPI on Windows), `openai.apiKey` is encrypted at rest into `openai.encryptedKey`. If encryption is unavailable or fails (or uses insecure Linux `basic_text`), keys remain memory-only for the session with a Settings warning—never written in plaintext to disk and never clobbering existing ciphertext.
- **Strict Local-Only Mode (`localOnlyMode`)**: Selecting a local loopback preset (`Ollama`) enables strict local-only mode (also toggleable in Settings): enforces `localhost` / `127.0.0.0/8` / `::1` both at URL validation and DNS connect time, bypasses HTTP proxies, blocks `3xx` redirects, and disables external `edge` / non-loopback fallbacks and draft tests.
- **Privacy & Confirmation Controls**: Configure `logOriginalTextPreview` (default `false`), `historyRetentionDays` (default `30`, `0` = session RAM only), `protectTechnicalText` (default `true`), `confirmBeforePaste` (default `false`), custom terminal/force-popup process lists, and guardrail-bounded `appOverrides` (per-app language, prompt template, direct paste, and protection settings that can never weaken global `localOnlyMode` or safety fences).
- **CI Verification Scope**: GitHub Actions runs automated `typecheck`, static `check`, mocked/local-HTTP unit tests (`npm test`), and `electron-vite build` across `windows-latest`, `macos-latest`, and `ubuntu-latest`, plus isolated headless smoke boot (`ALT_T_SMOKE=1 npm run smoke`) on Windows; real interactive hotkey registration, cross-window keystroke injection (`SendInput` / `CGEvent` / `xdotool`), and live IDE UIA trees require an interactive local desktop session.
- **One-Click Presets & Isolated Connection Test**: Use the Settings preset selector (`Ollama`, `DeepSeek`, `OpenAI`, `OpenRouter`, `SiliconFlow`) and **Test Connection** button to verify unsaved provider/proxy drafts without writing history or overwriting disk config.
- **Clipboard Format Scope**: During selection capture and paste, Alt-T backs up and restores `text/plain`, `text/html`, `text/rtf`, and `image/*`. Non-text/image OS formats such as file drops (`CF_HDROP`) are not backed up.

---

## Silent Launcher & 24/7 Watchdog (Windows)

Both `.vbs` scripts are pure 7-bit ASCII (no BOM), strip `ELECTRON_RUN_AS_NODE`, `ALT_T_SMOKE`, and legacy `FP_SMOKE`, verify `electron.exe` and `out\main\index.js`, and run from the repository root:

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

| Capability | Windows 10 / 11 (Tier 1) | macOS (Tier 2) | Linux X11 (Tier 3) | Linux Wayland (Tier 3) |
| :--- | :---: | :---: | :---: | :---: |
| **Floating Popup & Dual-Engine Translation** | ✅ Native | ✅ Native | ✅ Native | ✅ Native |
| **`Alt + T` Direct-Paste to Terminal** | ✅ `koffi` Win32 `SendInput` | ✅ `koffi` `CGEvent` (`osascript` fallback)* | ✅ `xdotool` | ✅ `ydotool` / `wtype` (or clipboard fallback)** |
| **`Alt + R` / `Alt + E` Selection Capture** | ✅ Class + UIA + UIPI aware | ✅ `koffi` `CGEvent` (`Cmd+C`)* | ✅ `xdotool` | ✅ `ydotool` / `wtype` (or clipboard fallback)** |
| **Option B Terminal Auto-Backspace** | ✅ `VK_BACK` batched | ✅ `CGEvent` `0x33` batched* | ✅ `xdotool` async | ✅ `ydotool` / `wtype` async |
| **Clipboard History Exclusion (`Win + V`)** | ✅ `ClipboardItem` OS tags | — | — | — |
| **Silent Startup / Auto-Launch** | ✅ `.lnk` / Login Item | ✅ `LoginItemSettings` | ✅ `~/.config/autostart` | ✅ `~/.config/autostart` |

*\* macOS uses native `koffi` `ApplicationServices.framework` (`CGEventPost` + `AXIsProcessTrusted`) with sub-2ms latency and opens **System Settings → Privacy & Security → Accessibility** automatically on first denied call.*  
*\*\* On Linux Wayland, installing `ydotool` (universal `uinput`, e.g. `sudo apt install ydotool` + `ydotoold`) or `wtype` (`wlroots` compositors) enables synthetic keystrokes; otherwise Alt-T automatically falls back to copying translations cleanly to the clipboard.*

---

## Build & Packaging

### Prerequisites
- **OS**: Windows 10 / 11 (x64) for full Win32 native integration & packaging
- **Node.js**: `>= 22.12.0` (or `^20.19.0`) — zero `node-gyp` compilation required (`koffi` ships prebuilt binaries; packaging automatically strips unused locales and foreign-architecture `koffi` binaries)

### Commands

```powershell
# 1. Install dependencies
npm install

# 2. Run the full verification suite safely (isolated smoke mode — never steals live hotkeys; legacy FP_SMOKE=1 also accepted)
$env:ALT_T_SMOKE="1"; npm run verify

# 3. Build slimmed Windows NSIS installer + Portable executable (en-US/zh-CN locales, target-arch koffi, @electron/fuses)
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
