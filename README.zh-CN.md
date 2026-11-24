# Alt-T

**[English](./README.md) | [简体中文](./README.zh-CN.md)**

> 轻量、经工程级加固的 Windows 桌面悬浮翻译与 **单键 `Enter` 终端提示词直填工具** —— 基于 Electron 45、Vue 3、`koffi` Win32 `SendInput` 与 `undici` 构建，专为 `Claude Code`、`Codex`、`Antigravity`、`Gemini CLI`、`PowerShell`、`SSH` 等开发者命令行工作流打造。

[![CI](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/actions/workflows/ci.yml/badge.svg)](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/actions/workflows/ci.yml)
[![Release](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/actions/workflows/release.yml/badge.svg)](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-4F46E5.svg)](./LICENSE)
[![OS: Windows primary | macOS/Linux experimental](https://img.shields.io/badge/OS-Windows%20primary%20%7C%20macOS%2FLinux%20experimental-0078D4.svg)](#跨操作系统支持矩阵)
[![Zero node-gyp](https://img.shields.io/badge/Native%20Deps-Zero%20node--gyp-success.svg)](#构建与打包)

---

## 下载与快速安装

前往 [**GitHub 最新发行版页面**](https://github.com/yeahyeahyeahyeahyeah0520/Alt-T/releases/latest) 直接下载 Windows 预构建二进制：
- **`Alt-T-<version>-setup.exe`** — 标准 NSIS 安装包（支持自定义目录、开始菜单快捷方式与开机自启）。
- **`Alt-T-<version>-portable.exe`** — 单文件绿色便携版（免安装直接运行）。

> [!NOTE]
> **Windows SmartScreen（智能筛选器）首次运行提示**：由于开源社区版本暂未购买商业代码签名证书，首次运行可能弹出“Windows 已保护你的电脑”。建议先按下方命令核对发行版附带的 `SHA256SUMS.txt` 校验和，确认一致后点击 **更多信息 → 仍要运行**：
> ```powershell
> Get-FileHash .\Alt-T-0.1.0-setup.exe -Algorithm SHA256
> ```

## 60 秒首次使用

1. 安装并启动 Alt-T；它会缩到系统托盘，不需要把目标终端改成管理员权限。
2. 在设置中确认翻译源：不想上传文本时选择本机 Ollama，并保持“严格仅本地模式”。
3. 回到 VS Code、Cursor、Antigravity 或 Windows Terminal，按 `Alt+T`，输入一句中文后按 `Enter`。

首次使用的成功标准是：浮窗显示正确的目标应用，状态条显示数据去向，按 `Ctrl+Enter` 后英文出现在原窗口。若目标程序以管理员身份运行，请让 Alt-T 也以管理员身份运行；不提升 Alt-T 时会保留译文到剪贴板并提示手动粘贴。

## 当前验证范围

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| Windows 构建、单元测试、生产依赖审计 | 已验证 | 当前提交的 CI 与本地 `npm run verify` 通过 |
| Windows NSIS / Portable 打包 | 已验证 | 已生成安装版、便携版和 SHA-256 校验文件 |
| VS Code / Cursor / Antigravity 真实焦点树 | 待实机验收 | 不把无头测试写成桌面场景通过 |
| 管理员窗口、中文输入法组合态、实体热键 | 待实机验收 | 需要在目标机器上按验收清单复核 |
| macOS / Linux 跨窗按键注入 | 实验性 | 依赖系统辅助功能、X11/Wayland 工具链，当前发布重点是 Windows |

## 你需要知道的数据边界

- 弹窗状态条会显示当前目标窗口、翻译服务范围和历史/日志状态。
- “严格仅本地模式”只允许 `localhost`、`127.0.0.0/8` 和 `::1`，会绕过代理、拦截重定向，并禁止外网回退。
- API Key 优先使用系统密钥库加密；密钥库不可用时只保留在当前会话内存，不写入明文配置。
- 原文日志默认关闭；历史可以关闭，或设置为 `0` 仅保留当前会话。
- 这些开关不会改变目标窗口二次校验、UIPI 拦截和技术片段占位符校验。

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
- **🔌 免配置双引擎、Edge 双路径容灾与一键测速**：开箱即用 **Edge 免费直连**（`edge`，内置 `translatetext` → `auth` 令牌认知接口二级容灾），支持任意 **OpenAI 兼容接口**（内置 `Ollama`、`DeepSeek`、`OpenAI`、`OpenRouter`、`硅基流动` 快速预设与无副作用「测试连接」按钮），主备自动回退（`enableFallback`）。
- **🧱 防注入开发者模板与技术片段保护**：内置 `translate` 与 `cli-prompt` 模板严格将输入视作待译纯文本；默认开启 `protectTechnicalText`，自动将代码块、行内代码、URL、Windows/POSIX 路径（含中文与空格）、命令行 `--flags`、环境变量与 `@mentions` 替换为防冲突占位符（`[[ALTT_N]]`），若模型丢漏、重复、伪造或损坏占位符，自动拦截粘贴并停留在浮窗提示人工核对。
- **🔒 系统级安全与隐私加固**：
  - **严格仅本地模式（`localOnlyMode`）**：选用本地预设自动启用或手动开启，同时校验请求 URL 与连接时 DNS 解析 IP 均为本机回环（`localhost` / `127.0.0.0/8` / `::1`），强制绕过代理、拦截 `3xx` 重定向，并禁止回退或测速任何外网源（如 `edge`）。
  - **日志/历史隐私与密钥无明文降级**：默认关闭原文预览日志（`logOriginalTextPreview: false`），历史默认保留 `30` 天（设 `0` 仅当前会话内存保留，不落盘）；`safeStorage` 不可用或加密失败时密钥仅留存会话内存并提示警告，绝不以明文写入磁盘或覆盖已有密文。
  - **隔离 `Win + V` 剪贴板历史**：瞬时剪贴板写入通过单次 `ClipboardItem` 附加 OS 排除标记，不污染系统剪贴板历史与云剪贴板。
- **🔄 发送前二次校验、目标可见性与原文直填**：隐藏浮窗前移交焦点、在发送粘贴按键前（以及 Option B 每批 `20` 字符退格前）同步二次校验目标窗口 HWND/PID/exe/类名（部分退格后中断时把译文保留在纯文本剪贴板）、统一四态粘贴反馈（`pasted | clipboard-only | cancelled | error`）、标题栏目标进程徽章与漂移告警、可编辑确认模式与输入法 `compositionend` 保护、免翻译「**填入原文**」、受全局护栏严格约束的分应用覆盖（`appOverrides`），以及单调时钟阶段耗时的无隐私指标基线（`metrics.ts`）。

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

### IDE 内置终端（`VS Code` / `Cursor` / `Windsurf` / `Antigravity`）
> [!IMPORTANT]
> **在 VS Code、Cursor、Windsurf 或 Antigravity 的内置终端中，强烈建议直接使用 `Alt + T`（极速译入终端/窗口）。**
>
> `Code.exe` 在普通编辑区保持为 `'normal'`（常规窗口）以确保划词仍可正常使用 `Ctrl+C` / `Ctrl+V`。为防止在内置终端误发 `^C`（`SIGINT`），Alt-T 提供三层组合防护：
> 1. **工作线程隔离的 Windows `UI Automation` 三态探测**：针对已知 IDE（`code.exe`、`cursor.exe`、`windsurf.exe`、`antigravity.exe`、`vscodium.exe`、`trae.exe` 等），探测逻辑运行在独立的 `worker_threads` 工作线程（`win32UiaWorker.ts`）中并带超时终止与熔断，输出 `'editor' | 'terminal' | 'unknown'` 三态结果。确认焦点在集成终端时自动切换为 `'wt'`；当返回 `'unknown'`（超时、PID 不匹配或处于 Chat/SCM 等非主编辑组件）时绝不盲发 `Ctrl+C`/`Ctrl+Shift+C`，`Alt+R` 安全切入输入条，`Alt+E` 提示手动复制。
> 2. **零 `Ctrl+C` 强制浮窗名单（`forcePopupOnReplaceExes`）**：如果编辑器关闭了无障碍树，可在设置页「防误触强制浮窗」中填入 `code.exe` 等进程名——对这些进程按 `Alt + R` 将彻底跳过 `Ctrl+C`，直接切换为 `Alt + T` 独立输入条。
> 3. **极速直填工作流（`Alt + T`）**：全程不向目标窗口发送复制键，天然零 `^C` 风险。

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

- **密钥加密与无明文降级**：当系统支持 `safeStorage`（如 Windows DPAPI，排除 Linux 不安全明文后端）时，`openai.apiKey` 加密存为 `openai.encryptedKey`；若密钥库不可用或加解密异常，密钥仅保存在当前会话内存并警示，绝不向磁盘写入明文，也不会覆写已有有效密文。
- **严格仅本地模式（`localOnlyMode`）**：在设置中选择本地回环预设（如 `Ollama`）会自动开启严格仅本地模式（也可手动开关）：在 URL 解析与 DNS 连接阶段校验回环地址，禁用代理、拦截 `3xx` 重定向，并阻止外网翻译源与测速。
- **隐私、确认模式与分应用覆盖**：可在设置页或 `config.json` 配置 `logOriginalTextPreview`（默认 `false`）、`historyRetentionDays`（默认 `30`，`0` 仅内存会话不落盘）、`protectTechnicalText`（默认 `true`）、`confirmBeforePaste`（默认 `false`）、自定义终端/强制浮窗名单，以及按 exe 配置语言/模板/直填策略的 `appOverrides`（全局安全与隐私红线不可被覆盖削弱）。
- **CI 验证范围说明**：GitHub Actions 在 `windows-latest`、`macos-latest` 与 `ubuntu-latest` 三平台自动执行 `typecheck`、静态规范检查 `check`、`npm test` 单元测试与 `electron-vite build`，并在 Windows 上运行隔离无头冒烟（`ALT_T_SMOKE=1 npm run smoke`）；真实的全局热键占键、跨窗物理按键注入及真实 IDE 焦点树依赖本地交互桌面手工回归。
- **常用服务商预设与无副作用测速**：设置页支持一键填入 `Ollama` / `DeepSeek` / `OpenAI` / `OpenRouter` / `硅基流动` 预设，并可在保存前直接点击「测试连接」验证未保存草稿的连通性与延迟（不写历史、不覆盖磁盘配置）。
- **剪贴板备份范围**：取词/替换期间仅备份与恢复 `text/plain`、`text/html`、`text/rtf` 与位图 `image/*`；文件列表（`CF_HDROP`）等非文本/图片格式不在备份范围内。

---

## 静默启动与 7×24 看门狗（Windows）

仓库根目录的 `.vbs` 脚本均采用纯 7 位 ASCII（无 BOM），启动前会自动清除 `ELECTRON_RUN_AS_NODE`、`ALT_T_SMOKE` 与兼容变量 `FP_SMOKE`，并校验 `electron.exe` 与 `out\main\index.js`：

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

| 能力项 | Windows 10 / 11（一级原生支持） | macOS（二级增强支持） | Linux X11（社区支持） | Linux Wayland（社区支持） |
| :--- | :---: | :---: | :---: | :---: |
| **悬浮翻译与双引擎主备回退** | ✅ 原生支持 | ✅ 原生支持 | ✅ 原生支持 | ✅ 原生支持 |
| **`Alt + T` 回车自动注入终端** | ✅ `koffi` Win32 `SendInput` | ✅ `koffi` `CGEvent`（`osascript` 兜底）* | ✅ `xdotool` | ✅ `ydotool` / `wtype`（无则剪贴板兜底）** |
| **`Alt + R` / `Alt + E` 跨窗取词** | ✅ 类名 + UIA + UIPI 检测 | ✅ `koffi` `CGEvent`（`Cmd+C`）* | ✅ `xdotool` | ✅ `ydotool` / `wtype`（无则剪贴板兜底）** |
| **Option B 终端自动退格替换** | ✅ `VK_BACK` 分批注入 | ✅ `CGEvent` `0x33` 分批注入* | ✅ `xdotool` 异步 | ✅ `ydotool` / `wtype` 异步 |
| **排除系统剪贴板历史（`Win + V`）** | ✅ `ClipboardItem` 原生标记 | — | — | — |
| **静默开机自启** | ✅ `.lnk` / LoginItem | ✅ `LoginItemSettings` | ✅ `~/.config/autostart` | ✅ `~/.config/autostart` |

*\* macOS 通过 `koffi` 直调系统 `ApplicationServices.framework`（`CGEventPost` + `AXIsProcessTrusted`），延迟低于 2 ms；首次缺少辅助功能权限时自动打开 `系统设置 → 隐私与安全性 → 辅助功能`。*  
*\*\* Linux Wayland 安装 `ydotool`（通用内核 `uinput` 方案，例如 `sudo apt install ydotool` 并启动 `ydotoold`）或 `wtype`（`wlroots` 系合成器）即可启用跨窗按键注入；未安装时自动降级为复制到剪贴板并提示粘贴。*

---

## 构建与打包

### 环境要求
- **操作系统**：Windows 10 / 11 (x64)（完整 Win32 原生能力与安装包构建）
- **Node.js**：`>= 22.12.0`（或 `^20.19.0`），全工程零 `node-gyp` 编译（打包钩子自动裁剪无用多国语言包与非目标平台的 `koffi` 二进制）

### 常用命令

```powershell
# 1. 安装依赖
npm install

# 2. 安全运行全套验证（强制隔离冒烟，不抢占线上热键与单实例锁；同时兼容旧变量 FP_SMOKE=1）
$env:ALT_T_SMOKE="1"; npm run verify

# 3. 打包瘦身后的 Windows NSIS 安装包与 Portable 单文件便携版（仅留中英语言包、单架构 koffi、@electron/fuses 加固）
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
