import type { RemoteInput } from '../desktop';
import { remoteKeyEvents } from '../keymap';

// Remote control of Playpex TV in a browser (docs/web-client-plan.md §5.3,
// docs/remote-control-plan.md §2.6): a page can't inject real input the way
// the Electron shell does (electron/remote.js, sendInputEvent), so the admin's
// keys, text and pointer become DOM events dispatched in this page. Keys are
// marked (keymap.ts remoteKeyEvents) so the app takes them as keys, not as the
// pointer's synthetic ones; mouse events go to the element under the point,
// where PointerService reads them as it reads a mouse (hover = focus, click =
// select, right click = back, wheel).

const TEXT_MAX = 500;
const MODIFIER_KEYS:{ [m:string]:'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' } = {
  shift: 'shiftKey', control: 'ctrlKey', alt: 'altKey', meta: 'metaKey',
};
const BUTTONS:{ [b:string]:number } = { left: 0, middle: 1, right: 2 };

let pressedOn:Element | null = null;

export function injectWebInput(input:RemoteInput) {
  if (!input || typeof input != 'object') return;
  if (input.kind == 'key') {
    if (typeof input.key != 'string' || (input.phase != 'down' && input.phase != 'up')) return;
    key(input.phase == 'down' ? 'keydown' : 'keyup', input.key, input.modifiers || [], !!input.repeat);
    return;
  }
  if (input.kind == 'text' && typeof input.text == 'string') {
    // each character as a key press: the on-screen keyboards read keydown
    Array.from(input.text.slice(0, TEXT_MAX)).forEach(ch => {
      key('keydown', ch, [], false);
      key('keyup', ch, [], false);
    });
    return;
  }
  if (input.kind == 'mouse') mouse(input);
}

function key(type:'keydown' | 'keyup', name:string, modifiers:string[], repeat:boolean) {
  let init:KeyboardEventInit = { key: name, bubbles: true, cancelable: true, composed: true, repeat };
  modifiers.forEach(m => { if (MODIFIER_KEYS[m]) (init as any)[MODIFIER_KEYS[m]] = true; });
  let event = new KeyboardEvent(type, init);
  remoteKeyEvents.add(event);
  (document.activeElement || document.body).dispatchEvent(event);
}

function mouse(input:Extract<RemoteInput, { kind:'mouse' }>) {
  let x = Number(input.x) || 0, y = Number(input.y) || 0;
  let target = document.elementFromPoint(x, y) || document.body;
  let base:MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  if (input.phase == 'move') {
    target.dispatchEvent(new MouseEvent('mousemove', base));
    return;
  }
  if (input.phase == 'wheel') {
    target.dispatchEvent(new WheelEvent('wheel', { ...base, deltaX: Number(input.dx) || 0, deltaY: Number(input.dy) || 0, deltaMode: 0 }));
    return;
  }
  let button = BUTTONS[input.button || 'left'];
  if (button === undefined) return;
  let init = { ...base, button, buttons: input.phase == 'down' ? 1 << button : 0 };
  if (input.phase == 'down') {
    pressedOn = target;
    target.dispatchEvent(new MouseEvent('mousedown', init));
    return;
  }
  target.dispatchEvent(new MouseEvent('mouseup', init));
  // a press and release on the same element is a click (right: the context menu, Back)
  if (pressedOn && (pressedOn === target || pressedOn.contains(target))) {
    target.dispatchEvent(new MouseEvent(button == 2 ? 'contextmenu' : button == 0 ? 'click' : 'auxclick', init));
  }
  pressedOn = null;
}
