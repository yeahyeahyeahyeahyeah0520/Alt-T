# Alt-T

**[English](./README.md) | [简体中文](./README.zh-CN.md)**

> 轻量、经工程级加固的 Windows 桌面悬浮翻译与 **单键 `Enter` 终端提示词直填工具** —— 基于 Electron 45、Vue 3、`koffi` Win32 `SendInput` 与 `undici` 构建，专为 `Claude Code`、`Codex`、`Antigravity`、`Gemini CLI`、`PowerShell`、`SSH` 等开发者命令行工作流打造。

[![CI](https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/actions/workflows/ci.yml/badge.svg)](https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/actions/workflows/ci.yml)
[![Release](https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/actions/workflows/release.yml/badge.svg)](https://github.com/yeahyeahyeahyeahyeah0520/flashprompt/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-4F46E5.svg)](./LICENSE)
[![OS: Windows | macOS | Linux](https://img.shields.io/badge/OS-Windows%20%7C%20macOS%20%7C%20Linux-0078D4.svg)](#跨操作系统支持矩阵)
[![Zero node-gyp](https://img.shields.io/badge/Native%20Deps-Zero%20node--gyp-success.svg)](#构建与打包)

---

## 为什么选择 Alt-T？

在现代终端 TUI（如 `Claude Code`、`Codex`、`Ink` / `Bubbletea` 交互界面）中直接使用中文输入法，经常会遇到**丢字、候选框卡顿、光标错位**；而传统划词翻译工具在终端内按替换热键时发送 `Ctrl+C`，往往直接变成 **`^C` (`SIGINT`) 杀掉正在运行的会话**。

**Alt-T 砍掉了冗余的截图 OCR 与重型依赖（零 `node-gyp` 编译），只把高频翻译与终端上屏做到极致：**

> [!TIP]
> **`Alt + T` 单键极速直填流**：在任意终端或 IDE 中按下 **`Alt + T`** → 在光标旁轻量浮窗中流畅输入中文 → **敲一下 `Enter` 回车** → 自动译成地道技术英文（原样保留 `--flags`、文件路径、反引号代码块、环境变量、`/slash` 指令与 `@mentions`），隐藏浮窗前先将焦点切回原终端并校验句柄，按终端原生协议（`Ctrl+Shift+V` / `Shift+Insert` / `Ctrl+V`）精准粘贴，且**零 `Win + V` 剪贴板历史污染**！

---

## 核心特性

- **⚡ 极速译入终端/窗口（`Alt + T`）**：光标旁唤出默认开启 `⚡ 回车直填`（锁定目标语言为 `English`）的输入框，自动注入 `VK_MASK (0xE8)` 防止误激活目标窗口菜单栏，单键 `Enter` 完成翻译并上屏。
- **🛡️ 防 `^C` 智能双模替换（`Alt + R`）**：
  - **普通 GUI 软件**：自动判断中英方向（`zh-Hans` ↔ `en`）并原地替换选中文本。
  - **终端窗口（默认 Option A + 可选 Option B）**：按 Win32 窗口类名优先识别（`CASCADIA_HOSTING_WINDOW_CLASS`、`ConsoleWindowClass`、`mintty`、`VirtualConsoleClass`）并结合进程名（`wt.exe`、`wezterm-gui.exe`、`alacritty.exe`、`ghostty.exe`、`warp.exe`、`waveterm.exe`、`putty.exe`、`kitty.exe`、`xshell.exe`、`mobaxterm.exe`），确保**绝不误发 `^C`**。详见[终端与 IDE 内置终端使用指引](#终端与-ide-内置终端使用指引)。
- **🔍 划词流式翻译（`Alt + E`）**：选中终端报错或技术文档，在光标旁实时流式展示译文，不修改原窗口（流式与非流式均接入 `AbortController` 取消链路）。
- **🔌 免配置双引擎 + 自动回退**：开箱即用 **Edge 免费直连**（`edge`），支持任意 **OpenAI 兼容接口**（`OpenAI`、`DeepSeek`、`Gemini`、`GLM`、`Qwen` 或本地无密钥回环大模型），主备自动回退（`enableFallback`）。
- **🧱 防提示词注入开发者模板**：内置 `translate`（通用与技术翻译）与 `cli-prompt`（CLI 提示词精炼）模板，严格将用户输入视作待翻译纯文本，拒绝执行输入中的指令，原样保留代码块、CLI 参数、路径与变量名。
- **🔒 系统级安全与隐私加固**：
  - **隔离 `Win + V` 剪贴板历史**：内部瞬时写入通过单次 `ClipboardItem` 附加 `ExcludeClipboardContentFromMonitorProcessing`、`CanIncludeInClipboardHistory` 与 `CanUploadToCloudClipboard`（全零 DWORD 标记）。
  - **DPAPI 密钥加密与全链路脱敏**：使用 Electron `safeStorage` 加密存储 `openai.apiKey`；日志与 60 秒冷却节流的未捕获异常通知自动脱敏密钥、Bearer Token 与代理账号密码；默认拒绝所有浏览器权限、收紧生产环境 CSP，并在打包阶段启用 `@electron/fuses`。
- **🔄 7×24 小时稳定运行与看门狗**：隐藏浮窗前移交焦点 + `15ms × 8` 确认、`TokenIntegrityLevel=25` UIPI 高权检测、`GetClipboardSequenceNumber()` 序列号复用与还原校验、`EPERM` 退避原子写配置、`powerMonitor` 热键自愈，以及纯 ASCII 无 BOM 的 `.vbs` 静默启动器与崩溃重启看门狗。

---

## 默认快捷键总览

| 快捷键 | 配置键名 | 功能说明 |
| :--- | :--- | :--- |
| **`Alt + T`** | `directInputTranslate` | **极速译入终端/窗口**：光标旁弹出 `⚡` 输入框（锁定目标 `English`）→ 输入后按 **`Enter`** 直接译入刚才的终端或窗口 |
| **`Alt + R`** | `replaceTranslate` | **取词并原地替换**：普通 GUI 窗口直接替换选中文本；终端窗口默认弹出预览框（**Option A**）或按设置自动退格替换（**Option B**）；终端未选字时自动切换为 `Alt + T` 输入框 |
| **`Alt + E`** | `selectionTranslate` | **取词并浮窗翻译**：抓取选中文本并在光标旁流式展示译文（非破坏性） |
| **`Alt + Q`** | `togglePopup` | **显示/隐藏主浮窗**：在当前显示器居中呼出主浮窗（`Enter` 仅翻译，`Ctrl + Enter` 翻译并填入原窗口） |
| **`Alt + W`** | *(已移除)* | 早期 `SPEC.md` 中的截图 OCR 功能已在精简重构中移除，由更轻量的文本翻译与 `Alt + T` 终端直填替代（详见 [`NOTES.md`](./NOTES.md)） |

> 提示：设置页内置 `isValidGlobalAccelerator` 校验（要求修饰键+主键或独立 `F1`–`F24`）及规范化重复键检测。

---

## 终端与 IDE 内置终端使用指引

### IDE 内置终端（`VS Code` / `Cursor` / `Antigravity`）
> [!IMPORTANT]
> **在 VS Code、Cursor 或 Antigravity 的内置终端中，强烈建议直接使用 `Alt + T`（极速译入终端/窗口）。**
>
> `Code.exe` 在窗口分类中故意保持为 `'normal'`（普通桌面窗口），以确保你在代码编辑区划词时依然能正常使用 `Ctrl+C` / `Ctrl+V`。由于 Win32 句柄无法单独区分“IDE 编辑器区域”和“IDE 内置终端面板”，在内置终端中使用 `Alt + T` 是最可靠、零 `^C` 风险的交互方式。

### 终端划选 `Alt + R` 策略：Option A（默认）与 Option B
- **Option A — 安全浮窗模式（`terminalAutoBackspace: false`，默认开启）**：
  在已识别的终端（`Windows Terminal`、`ConHost`、`PowerShell`、`WezTerm`、`Alacritty`、`Ghostty`、`Warp`、`Wave`、`PuTTY`、`Mintty`、`Xshell`、`MobaXterm`）中划选文本并按 `Alt + R`，Alt-T 会安全弹出译文预览框（`directPaste: true`）。按一下 **`Enter`** 即可在光标处粘贴译文，按 **`Esc`** 关闭——绝不会盲目发送退格键误删命令行。
- **Option B — 终端划选自动退格替换（在设置页勾选“终端划选自动退格替换”）**：
  适合单行命令行末尾的直接替换。开启后，程序使用 `Intl.Segmenter` 按扩展字形簇（grapheme cluster）精确计数，校验前台 HWND 与 Windows Terminal 标签页标题（`GetWindowTextW`）未变化后，先物理释放修饰键，再分批发送 `VK_BACK`（每批 `20` 个，间隔 `8ms`），最后按终端粘贴快捷键（`Ctrl+Shift+V` 或 `Shift+Insert`）粘贴译文。多行选区会自动返回 `0` 退格数以避免误删历史命令。

---

## Windows UIPI 高权限窗口说明

Windows **用户界面特权隔离（UIPI）** 机制禁止普通权限进程向管理员权限（**以管理员身份运行**）或系统权限窗口注入 `SendInput` 按键。

Alt-T 通过 `OpenProcessToken` + `GetTokenInformation(TokenIntegrityLevel = 25)` + `GetSidSubAuthority` 在操作前主动检测权限边界：
- **对高权限窗口按 `Alt + R` / `Alt + E`**：立即拦截并提示 `未选中文本或目标窗口为高权限(UIPI)`，不会破坏原剪贴板内容。
- **向高权限窗口执行 `Alt + T` / `Ctrl + Enter` 粘贴**：自动跳过剪贴板还原，将译文保留在剪贴板并切回目标窗口，同时提示用户手动按 `Ctrl+V` 或 `Shift+Insert` 粘贴。

---

## 配置文件与本地回环大模型（Ollama 等）

首次运行会在用户数据目录生成 `config.json`（打包版本位于 `%APPDATA%\Alt-T\config.json`），完整字段结构可参考 [`config.example.json`](./config.example.json)。

- **密钥加密存储**：在设置页保存 OpenAI API Key 时，会通过 Windows DPAPI（`safeStorage`）加密写入 `openai.encryptedKey`，磁盘上的 `openai.apiKey` 保持为空。
- **本地回环大模型（免 API Key）**：当 `openai.baseUrl` 指向 `http://localhost:<port>`、`http://127.0.0.1:<port>` 或 `http://[::1]:<port>`（如 `Ollama`、`LM Studio`、`llama.cpp`、`vLLM`）时，允许 `apiKey` 留空直接请求：
  ```json
  "openai": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "apiKey": "",
    "model": "qwen2.5:7b",
    "stream": true
  }
  ```
- **远端接口拦截**：非回环地址若 `apiKey` 为空，会在本地直接抛出 `CONFIG` 错误（`OpenAI API key is empty`），不会向外网发起无效请求。
- **自定义终端白名单**：可在设置页直接配置（或编辑 `config.json` 中的 `customWtExeNames` / `customConhostExeNames`），为第三方终端指定 `Ctrl+Shift+V` 或 `Shift+Insert` 热键协议，修改即刻生效。
- **剪贴板备份范围**：取词/替换期间仅备份与恢复 `text/plain`、`text/html`、`text/rtf` 与位图 `image/*`；文件列表（`CF_HDROP`）等非文本/图片格式不在备份范围内。

---

## 静默启动与 7×24 看门狗（Windows）

仓库根目录的 `.vbs` 脚本均采用纯 7 位 ASCII（无 BOM），启动前会自动清除 `ELECTRON_RUN_AS_NODE` 与 `FP_SMOKE` 环境变量并校验 `electron.exe` 与 `out\main\index.js`：

```powershell
# 无黑框静默启动到系统托盘
wscript.exe //B //NoLogo start-silent.vbs

# 通过 7×24 崩溃自愈看门狗启动
wscript.exe //B //NoLogo watchdog.vbs
```

- **看门狗机制**：`watchdog.vbs` 使用同步阻塞调用 `exitCode = shell.Run(..., 0, True)` 监控主进程。
  - 托盘正常退出（`exitCode = 0`，或检测到 `clean-exit.flag` 显式退出标记）时立即安静退出。
  - 非零异常退出时按指数退避自动重启（`2s` 起步，上限 `60s`；稳定运行 `>= 30s` 后重置退避时间）。
- **便携版开机自启**：通过 `electron-builder` 打包的 Portable 版会识别 `PORTABLE_EXECUTABLE_FILE` 环境变量，在开机启动目录写入指向便携 `.exe` 自身的 `.lnk` 快捷方式。

---

## 跨操作系统支持矩阵

| 能力项 | Windows 10 / 11（主力一等公民） | macOS | Linux（X11） | Linux（Wayland） |
| :--- | :---: | :---: | :---: | :---: |
| **悬浮翻译与双引擎主备回退** | ✅ 原生支持 | ✅ 原生支持 | ✅ 原生支持 | ✅ 原生支持 |
| **`Alt + T` 回车自动注入终端** | ✅ `koffi` Win32 `SendInput` | ✅ `osascript` `Cmd+V`* | ✅ `xdotool` | ⚠️ 复制并归还焦点** |
| **`Alt + R` / `Alt + E` 跨窗取词** | ✅ 类名识别 + UIPI 检测 | ✅ `osascript` `Cmd+C`* | ✅ `xdotool` | ⚠️ 降级复制模式** |
| **排除系统剪贴板历史（`Win + V`）** | ✅ `ClipboardItem` 原生标记 | — | — | — |
| **静默开机自启** | ✅ `.lnk` / LoginItem | ✅ `LoginItemSettings` | ✅ `~/.config/autostart` | ✅ `~/.config/autostart` |

*\* macOS 需在 `系统设置 → 隐私与安全性 → 辅助功能` 授权。*  
*\*\* Linux Wayland 从协议层禁止跨窗注入按键，按 `Enter` 会安全复制到剪贴板并归还目标窗口焦点。*

---

## 构建与打包

### 环境要求
- **操作系统**：Windows 10 / 11 (x64)（完整 Win32 原生能力与安装包构建）
- **Node.js**：`>= 22.12.0`（或 `^20.19.0`），全工程零 `node-gyp` 编译（`koffi` 自带 `win32_x64` 预编译二进制）

### 常用命令

```powershell
# 1. 安装依赖
npm install

# 2. 安全运行全套验证（强制隔离冒烟，不抢占线上热键与单实例锁）
$env:FP_SMOKE="1"; npm run verify

# 3. 打包 Windows NSIS 安装包与 Portable 单文件便携版（含 @electron/fuses 加固）
npm run dist:win
```

其他常用命令：
- `npm run dev` — 启动 Electron + Vite 热重载开发模式
- `npm run typecheck` — 运行主进程（`tsc`）与渲染进程（`vue-tsc`）类型检查
- `npm run check` — 运行架构分层、`.vbs` ASCII/无 BOM 与零泄露静态扫描（`scripts/check-rules.mjs`）
- `npm test` — 运行单元测试与故障注入测试（`node --import tsx --test`）
- `node scripts/probe-koffi.mjs` — 探针校验 `sizeof(INPUT) === 40` 与 Win32 `SendInput`
- `node scripts/diagnose-hotkeys.mjs` — 只读诊断单实例锁状态与脱敏配置摘要

---

## 更多文档

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 分层架构、`Alt+R` / `Alt+T` 交互时序、浮窗状态机与看门狗生命周期（含 Mermaid 图）
- [`SECURITY.md`](./SECURITY.md) — 安全模型、`RendererCodeIntegrity` 开关权衡与补偿控制、UIPI、DPAPI、剪贴板隔离及漏洞上报方式
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — 开发环境搭建、静态规则门禁、单测规范与 PR 检查清单
- [`NOTES.md`](./NOTES.md) — 相对 `SPEC.md` 的架构演进记录与加固偏差说明
- [`config.example.json`](./config.example.json) — 对齐 `AppConfig` 结构的干净配置示例
- [`LICENSE`](./LICENSE) — MIT 开源协议（`yeahyeahyeahyeahyeah0520`）
