# Windows Acceptance Matrix

This matrix is intentionally separate from CI. It records real desktop behavior that cannot be proven by headless tests.

## Test setup

- Alt-T version / commit:
- Windows version and architecture:
- Keyboard layout and IME:
- Alt-T integrity level: standard / administrator
- Date and tester:

## Matrix

| Target | Target integrity | `Alt+T` input and fill | `Alt+R` editor | `Alt+R` terminal | `Alt+E` | Target switch guard | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows Terminal | Standard | ☐ | ☐ | ☐ | ☐ | ☐ | |
| PowerShell / ConHost | Standard | ☐ | ☐ | ☐ | ☐ | ☐ | |
| VS Code editor | Standard | ☐ | ☐ | n/a | ☐ | ☐ | |
| VS Code integrated terminal | Standard | ☐ | ☐ | ☐ | ☐ | ☐ | |
| Cursor integrated terminal | Standard | ☐ | ☐ | ☐ | ☐ | ☐ | |
| Antigravity integrated terminal | Standard | ☐ | ☐ | ☐ | ☐ | ☐ | |
| Windows Terminal | Administrator | ☐ | ☐ | ☐ | ☐ | ☐ | Verify clipboard-only fallback |
| VS Code / Cursor | Administrator | ☐ | ☐ | ☐ | ☐ | ☐ | Verify equal-integrity behavior |

## Required edge cases

- [ ] Chinese IME composition: `Enter` confirms the candidate before Alt-T handles the command.
- [ ] Popup loses focus before paste: automatic fill is cancelled and the translated text remains recoverable.
- [ ] Target window or terminal tab changes during paste: no text is injected into the new target.
- [ ] UIA returns `unknown`: no blind `Ctrl+C` is sent from `Alt+R`.
- [ ] Technical placeholder is malformed: automatic fill is blocked with an actionable message.
- [ ] Hotkey is occupied: Settings reports the conflict before saving.
- [ ] Clipboard-only fallback preserves the translated text and tells the user how to paste it.

Attach only redacted screenshots or logs. Never attach API keys, authorization headers, or private prompt text.
