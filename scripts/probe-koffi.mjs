import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const koffi = require('koffi')

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t'
})
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t'
})
const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT })
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION })

const sizeofInput = koffi.sizeof(INPUT)
console.log(`sizeof(INPUT)=${sizeofInput}`)
if (sizeofInput !== 40) {
  console.error(`Expected sizeof(INPUT) === 40, got ${sizeofInput}`)
  process.exit(1)
}

const user32 = koffi.load('user32.dll')
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)')
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)')
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
const OpenInputDesktop = user32.func(
  'intptr_t __stdcall OpenInputDesktop(uint32 dwFlags, bool fInherit, uint32 dwDesiredAccess)'
)
const SetThreadDesktop = user32.func('bool __stdcall SetThreadDesktop(intptr_t hDesktop)')
const CloseDesktop = user32.func('bool __stdcall CloseDesktop(intptr_t hDesktop)')

// Non-interactive CLI subshells may not be attached to the active input desktop (GetForegroundWindow() === 0).
// Attach this probe thread to the input desktop when needed so SendInput can reach WinSta0\Default.
if (GetForegroundWindow() === 0) {
  const DESKTOP_ALL_ACCESS = 0x01ff
  const hDesk = OpenInputDesktop(0, false, DESKTOP_ALL_ACCESS)
  if (hDesk) {
    SetThreadDesktop(hDesk)
    CloseDesktop(hDesk)
  }
}

const INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002
const VK_PA1 = 0xfc
const VK_MENU = 0x12

const events = [
  { type: INPUT_KEYBOARD, u: { ki: { wVk: VK_PA1, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } } },
  {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: VK_PA1, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } }
  }
]

const sent = SendInput(events.length, events, sizeofInput)
console.log(`SendInput=${sent}`)
if (sent !== 2) {
  console.error(`Expected SendInput === 2, got ${sent}`)
  process.exit(1)
}

const altState = GetAsyncKeyState(VK_MENU)
console.log(`GetAsyncKeyState(0x12)=${altState}`)
if (typeof altState !== 'number') {
  console.error(`Expected number from GetAsyncKeyState, got ${typeof altState}`)
  process.exit(1)
}
