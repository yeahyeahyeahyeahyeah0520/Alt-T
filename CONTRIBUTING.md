# Contributing to FlashPrompt

Thank you for your interest in contributing to **FlashPrompt** (`https://github.com/yeahyeahyeahyeahyeah0520/flashprompt`)!

---

## 1. Prerequisites

- **Operating System**: Windows 10 / 11 (x64) for full Win32 `SendInput` / UIPI / packaging verification
- **Node.js**: `>= 22.12.0` (engines: `^20.19.0 || >=22.12.0`)
- **npm**: bundled with Node.js 22+
- **Native Build Tools**: **Not required** — `koffi@2.16.4` ships prebuilt `win32_x64` N-API binaries with zero `node-gyp` compilation.

---

## 2. Local Setup

```powershell
git clone https://github.com/yeahyeahyeahyeahyeah0520/flashprompt.git
cd flashprompt
npm install
```

Useful development commands:
- `npm run dev` — Launch Electron + Vite dev server
- `npm run build` — Run `typecheck` and build `out/main`, `out/preload`, `out/renderer`
- `node scripts/probe-koffi.mjs` — Probe `koffi` `INPUT` struct layout (`40` bytes) and Win32 `SendInput`
- `node scripts/diagnose-hotkeys.mjs` — Read-only lockfile and sanitized config summary check

---

## 3. Running Verification Safely (`FP_SMOKE=1`)

> [!IMPORTANT]
> Always set `FP_SMOKE=1` (or `TTL_SMOKE=1`) when running `npm run verify` or `npm run smoke` on a machine that may already have a live FlashPrompt instance running. Smoke mode redirects `userData` to `os.tmpdir()` and skips tray creation, single-instance lock acquisition, and global hotkey registration.

```powershell
# PowerShell
$env:FP_SMOKE="1"; npm run verify
```

`npm run verify` runs five sequential gates:
1. `npm run typecheck` (`tsc --noEmit -p tsconfig.node.json` & `vue-tsc --noEmit -p tsconfig.web.json`)
2. `npm run check` (`node scripts/check-rules.mjs`)
3. `npm test` (`node --import tsx --test "tests/**/*.test.ts"`)
4. `electron-vite build`
5. `npm run smoke` (`node scripts/smoke-launch.mjs`)

---

## 4. Static Architecture & Security Gates (`scripts/check-rules.mjs`)

Every commit and PR must pass `npm run check`, which enforces:

| Rule | Scope | Requirement |
| :--- | :--- | :--- |
| `no-forbidden-deps` | `package.json` | Bans `robotjs`, `uiohook`, `sqlite3`, `onnxruntime`, `node-screenshots`, `pinia`, `vuex`, `tailwind`, `element-plus`, `electron-updater`, `axios` (`electron-builder` and `@electron/fuses` are permitted) |
| `core-no-electron` | `src/shared/**`, `src/main/core/**` | Zero imports/requires of `electron`, `koffi`, or `undici` |
| `renderer-no-main` | `src/renderer/**`, `src/preload/**` | Zero imports from `src/main/**` |
| `renderer-no-http` | `src/renderer/**` | Zero direct `fetch()`, `XMLHttpRequest`, or `axios` calls |
| `no-any` | `src/**/*.ts` | Strict TypeScript — use `unknown` + narrowing instead of `any` |
| `no-ts-ignore` | `src/**`, `tests/**` | No `@ts-ignore` or `@ts-expect-error` suppressions |
| `no-key-log` | `src/**` | Never reference `apiKey` on a `console.*` line |
| `no-todo` | `src/**`, `tests/**` | No `TODO`, `FIXME`, or `XXX` markers |
| `no-literal-cjk-range` | `src/**/*.{ts,vue}`, `tests/**` | Use `\u4e00-\u9fff` / `\u200b` / `\ufeff` escapes instead of literal ranges or invisible chars |
| `platform-guard` | `src/**` outside `src/main/platform/` | Keep `process.platform` branches isolated in `src/main/platform/` |
| `popup-close-guard` | `src/main/windows/popupWindow.ts` | `'close'` handler must check `isQuitting()` |
| `vbs-ascii-no-bom` | `*.vbs` | `.vbs` launchers must be pure 7-bit ASCII without UTF-8/UTF-16 BOM |
| `no-personal-path` | `src`, `tests`, `scripts`, `.github`, `*.md`, `*.json`, `*.vbs` | Zero local usernames, `C:\Users\<user>\...`, or personal workspace paths |
| `no-secret-literal` | `src`, `tests`, `scripts`, `.github`, `*.md`, `*.json`, `*.vbs` | Zero real API keys (`sk-...`, `sk-proj-...`, `AIza...`, `ghp_...`, `xoxb-...`) |

---

## 5. Coding & Testing Guidelines

- **Module Style**: Prefer named exports (`export function`, `export const`, `export class`) in `.ts` files and relative imports (no path aliases, so `tsx` runs tests directly).
- **Minimal-Change Principle**: Keep PRs focused; avoid unrelated refactoring.
- **Behavior & Fault-Injection Tests**:
  - Add or update tests in `tests/*.test.ts` for any behavioral fix or new guard.
  - Never hit external networks in unit tests—use local `node:http` mock servers and DI seams (`setWin32ApiForTest`, `setClipboardDepsForTest`, `setConfigStoreDepsForTest`, `setHotkeyDepsForTest`, `setSelectionRuntimeForTest`, `setLoggerDepsForTest`).
  - Do not hardcode expected values in source code or write tautological tests.

---

## 6. Pull Request Checklist

- [ ] `$env:TTL_SMOKE="1"; npm run verify` passes 100% locally.
- [ ] `npm run check` passes with zero rule, `.vbs` ASCII/no-BOM, PII, or secret violations.
- [ ] New or modified behavior is covered by unit / fault-injection tests in `tests/`.
- [ ] Documentation (`README.md`, `README.zh-CN.md`, `ARCHITECTURE.md`, `SECURITY.md`, `NOTES.md`) is updated if architecture, hotkeys, or config schema changed.
- [ ] Zero personal paths, usernames, live config files, or API keys appear in diffs.
