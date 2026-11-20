/**
 * 面向用户的提示消息常量。
 * 集中管理便于统一维护和未来 i18n 扩展。
 * 修改用语时只需改这一个文件。
 */
export const MSG = {
  // --- 通用状态 ---
  BUSY_LOCKED: '取词或粘贴任务正忙，请稍后重试',
  TRANSLATION_EMPTY: '译文为空，无法填入',

  // --- 目标窗口状态 ---
  TARGET_CLOSED: '原目标窗口已关闭或未记录，请重新从目标窗口呼出浮窗',
  TARGET_MINIMIZED: '原目标窗口已最小化，请先恢复窗口或点击"复制"手动粘贴',
  TARGET_FOREGROUND_LOST:
    '无法切换到原目标窗口，译文已复制到剪贴板，请手动按 Ctrl+V / Shift+Insert 粘贴',
  TARGET_CHANGED: '目标窗口已变化，未替换',
  TARGET_CHANGED_TAB: '目标窗口或标签页已变化，未替换',
  NO_FOREGROUND: '没有前台窗口',

  // --- UIPI / 权限 ---
  UIPI_BLOCKED: '未选中文本或目标窗口为高权限(UIPI)',
  NO_SELECTION_OR_UIPI: '未选中文本或目标窗口为高权限(UIPI)',
  UIPI_PASTE_FALLBACK:
    '目标窗口为管理员权限(UIPI拦截)，译文已复制到剪贴板，请手动按 Ctrl+V / Shift+Insert 粘贴',

  // --- 剪贴板 / 注入 ---
  CLIPBOARD_ONLY_MODE: '译文已复制到剪贴板，请直接粘贴',
  PASTE_SHORTCUT_FAILED: '发送粘贴快捷键失败',
  PASTE_BLOCKED: '自动粘贴受阻，译文已保留在剪贴板，请手动按 Ctrl+V / Shift+Insert 粘贴',
  COPY_SHORTCUT_FAILED: '发送复制快捷键失败',
  NO_TEXT_SELECTED: '选中内容不是文本',
  TEXT_TOO_LONG: '文本超过 5000 字符',
  TRANSLATE_TIMEOUT: '翻译请求超时，请重试',
  POPUP_BLUR_PASTE_CANCELLED: '窗口已失焦，已取消自动填入；翻译完成后可手动点击“填入窗口”',

  // --- 平台 / 系统 ---
  PLATFORM_NO_INJECT: '当前桌面环境不支持跨窗按键取词，请使用 Alt+T 输入翻译',
  SERVICE_NOT_INIT: '翻译服务未初始化',
  MAIN_OUTDATED: '主进程版本过旧，请重启应用以启用该功能',
  UNCAUGHT_ERROR_TITLE: 'Alt-T 错误',

  // --- macOS 专用 ---
  MACOS_ACCESSIBILITY_DENIED_COPY: '请在系统设置 → 辅助功能 中授权 Alt-T',
  MACOS_ACCESSIBILITY_DENIED_PASTE: '未授予系统辅助功能权限，译文已复制到剪贴板，请按 Cmd+V 粘贴',

  // --- 终端专用 ---
  TERMINAL_SELECTION_TRANSLATED: '终端选区已译好：按 Enter 直接填入命令行，按 Esc 关闭',

  // --- 动态格式消息 ---
  inputTooLong: (maxChars: number): string => `输入文本超过 ${maxChars} 字符上限`,
  inputTruncated: (maxChars: number): string => `输入已截断至 ${maxChars} 字符上限`,
  uncaughtErrorBody: (safeMsg: string): string =>
    `发生未捕获异常: ${safeMsg}\n请查看日志或重启 Alt-T`,
  hotkeyConflictSummary: (summary: string): string =>
    `以下快捷键注册冲突（将自动重试）：${summary}`,
  formatFallbackFailure: (
    primary: string,
    primaryMsg: string,
    secondary: string,
    secondaryMsg: string
  ): string => `主源(${primary}): ${primaryMsg}; 备用源(${secondary}): ${secondaryMsg}`
} as const
