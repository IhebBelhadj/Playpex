'use strict';

// Remote control (docs/remote-control-plan.md §2.6): the renderer gets the
// admin's input over the server's remote socket and hands it here; this
// injects it into **our own window only** with webContents.sendInputEvent,
// so it arrives as real Chromium input (trusted, hit-tested): the keymap,
// spatial navigation, FocusEngine and PointerService react as to a local
// keyboard and mouse. Never OS-level input: the remote can't leave Playpex TV.
//
//   remote.inject(webContents, input)
//     { kind: 'key', phase: 'down'|'up', key, modifiers?, repeat? }   DOM KeyboardEvent names
//     { kind: 'text', text }
//     { kind: 'mouse', phase: 'move'|'down'|'up'|'wheel', x, y, button?, dx?, dy? }   CSS px of the window

// DOM `key` → Electron's key codes (accelerator names); single characters pass as they are
const KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Return', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', ' ': 'Space',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  MediaPlayPause: 'MediaPlayPause', MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack',
  AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute',
  Shift: 'Shift', Control: 'Control', Alt: 'Alt', Meta: 'Meta', CapsLock: 'Capslock'
};
for (let i = 1; i <= 12; i++) {
  KEYS['F' + i] = 'F' + i;
}

const MODIFIERS = { shift: 'shift', control: 'control', alt: 'alt', meta: 'meta' };
const BUTTONS = { left: 'left', right: 'right', middle: 'middle' };
const TEXT_MAX = 500;

function keyCode(key) {
  if (typeof key !== 'string') {
    return null;
  }
  if (KEYS[key]) {
    return KEYS[key];
  }
  return Array.from(key).length === 1 ? key : null;
}

function finite(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

function inject(contents, input) {
  if (!contents || contents.isDestroyed() || !input || typeof input !== 'object') {
    return;
  }
  if (input.kind === 'key') {
    const code = keyCode(input.key);
    if (!code || (input.phase !== 'down' && input.phase !== 'up')) {
      return;
    }
    const modifiers = (Array.isArray(input.modifiers) ? input.modifiers : []).map(m => MODIFIERS[m]).filter(Boolean);
    if (input.repeat) {
      modifiers.push('isAutoRepeat');
    }
    contents.sendInputEvent({ type: input.phase === 'down' ? 'keyDown' : 'keyUp', keyCode: code, modifiers });
    // a printable key types its character (search fields), like a keyboard does
    if (input.phase === 'down' && Array.from(input.key).length === 1 &&
      !modifiers.some(m => m === 'control' || m === 'meta' || m === 'alt')) {
      contents.sendInputEvent({ type: 'char', keyCode: input.key, modifiers });
    }
    return;
  }
  if (input.kind === 'text' && typeof input.text === 'string') {
    // each character as a key press: fields take its `char`, the on-screen
    // keyboards (text-keyboard) their `keydown`
    Array.from(input.text.slice(0, TEXT_MAX)).forEach(ch => {
      const code = ch === ' ' ? 'Space' : ch;
      contents.sendInputEvent({ type: 'keyDown', keyCode: code });
      contents.sendInputEvent({ type: 'char', keyCode: ch });
      contents.sendInputEvent({ type: 'keyUp', keyCode: code });
    });
    return;
  }
  if (input.kind === 'mouse') {
    const x = Math.round(finite(input.x, 0)), y = Math.round(finite(input.y, 0));
    if (input.phase === 'move') {
      contents.sendInputEvent({ type: 'mouseMove', x, y });
    } else if ((input.phase === 'down' || input.phase === 'up') && BUTTONS[input.button]) {
      contents.sendInputEvent({ type: input.phase === 'down' ? 'mouseDown' : 'mouseUp', x, y, button: BUTTONS[input.button], clickCount: 1 });
    } else if (input.phase === 'wheel') {
      // Chromium's wheel deltas point the other way from the DOM's
      contents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -finite(input.dx, 0), deltaY: -finite(input.dy, 0), canScroll: true });
    }
  }
}

module.exports = { inject, keyCode };
