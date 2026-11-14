'use strict';
// Eingaben (Maus/Tastatur) unter Windows per user32 SendInput ausführen.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int X, int Y)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *lpPoint)');

const INPUT_SIZE = koffi.sizeof(INPUT);
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSE = {
  LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, XDOWN: 0x0080, XUP: 0x0100,
  WHEEL: 0x0800, HWHEEL: 0x1000,
};
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;

// KeyboardEvent.code -> Set-1-Scancode (physische Taste, layoutunabhängig). [scan, extended]
const SCAN = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06],
  Digit6: [0x07], Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b], Minus: [0x0c],
  Equal: [0x0d], Backspace: [0x0e], Tab: [0x0f], KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12],
  KeyR: [0x13], KeyT: [0x14], KeyY: [0x15], KeyU: [0x16], KeyI: [0x17], KeyO: [0x18], KeyP: [0x19],
  BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c], ControlLeft: [0x1d], KeyA: [0x1e],
  KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22], KeyH: [0x23], KeyJ: [0x24], KeyK: [0x25],
  KeyL: [0x26], Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2a],
  Backslash: [0x2b], KeyZ: [0x2c], KeyX: [0x2d], KeyC: [0x2e], KeyV: [0x2f], KeyB: [0x30],
  KeyN: [0x31], KeyM: [0x32], Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36],
  NumpadMultiply: [0x37], AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a],
  F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f], F6: [0x40], F7: [0x41], F8: [0x42],
  F9: [0x43], F10: [0x44], NumLock: [0x45], ScrollLock: [0x46],
  Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a], Numpad4: [0x4b],
  Numpad5: [0x4c], Numpad6: [0x4d], NumpadAdd: [0x4e], Numpad1: [0x4f], Numpad2: [0x50],
  Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53], IntlBackslash: [0x56], F11: [0x57], F12: [0x58],
  NumpadEnter: [0x1c, true], ControlRight: [0x1d, true], NumpadDivide: [0x35, true],
  PrintScreen: [0x37, true], AltRight: [0x38, true], Home: [0x47, true], ArrowUp: [0x48, true],
  PageUp: [0x49, true], ArrowLeft: [0x4b, true], ArrowRight: [0x4d, true], End: [0x4f, true],
  ArrowDown: [0x50, true], PageDown: [0x51, true], Insert: [0x52, true], Delete: [0x53, true],
  MetaLeft: [0x5b, true], MetaRight: [0x5c, true], ContextMenu: [0x5d, true],
};

function sendMouse(dwFlags, mouseData = 0) {
  return SendInput(1, { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: mouseData >>> 0, dwFlags, time: 0, dwExtraInfo: 0 } } }, INPUT_SIZE);
}

function sendKey(code, up) {
  const s = SCAN[code];
  if (!s) return 0;
  let flags = KEYEVENTF_SCANCODE;
  if (s[1]) flags |= KEYEVENTF_EXTENDEDKEY;
  if (up) flags |= KEYEVENTF_KEYUP;
  return SendInput(1, { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: s[0], dwFlags: flags, time: 0, dwExtraInfo: 0 } } }, INPUT_SIZE);
}

const BUTTON_FLAGS = {
  0: [MOUSE.LEFTDOWN, MOUSE.LEFTUP, 0],
  1: [MOUSE.MIDDLEDOWN, MOUSE.MIDDLEUP, 0],
  2: [MOUSE.RIGHTDOWN, MOUSE.RIGHTUP, 0],
  3: [MOUSE.XDOWN, MOUSE.XUP, 1],
  4: [MOUSE.XDOWN, MOUSE.XUP, 2],
};

function mouseButton(button, up) {
  const f = BUTTON_FLAGS[button];
  if (!f) return 0;
  return sendMouse(up ? f[1] : f[0], f[2]);
}

const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const MOVE_ABS = 0x0001 | 0x8000 | 0x4000; // MOVE | ABSOLUTE | VIRTUALDESK

function moveTo(x, y) {
  x = Math.round(x); y = Math.round(y);
  if (SetCursorPos(x, y)) return 1;
  // Ausweichweg: absolute Bewegung über den virtuellen Desktop (0..65535)
  const vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
  const vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
  if (vw < 2 || vh < 2) return 0;
  const dx = Math.round(((x - vx) * 65535) / (vw - 1));
  const dy = Math.round(((y - vy) * 65535) / (vh - 1));
  return SendInput(1, { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData: 0, dwFlags: MOVE_ABS, time: 0, dwExtraInfo: 0 } } }, INPUT_SIZE);
}

function wheel(dy, dx) {
  let n = 0;
  if (dy) n += sendMouse(MOUSE.WHEEL, Math.round(dy));
  if (dx) n += sendMouse(MOUSE.HWHEEL, Math.round(dx));
  return n;
}

function cursorPos() {
  const p = {};
  GetCursorPos(p);
  return p;
}

module.exports = { moveTo, mouseButton, wheel, sendKey, cursorPos, hasKey: (c) => !!SCAN[c] };
