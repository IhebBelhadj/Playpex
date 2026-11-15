// Single source of truth for key bindings. Components never compare `e.key`
// themselves: they ask `actionForKey(e)` and react to the abstract action, so a
// binding (or a future input source like the cursor / a phone remote) only has
// to be wired here. Values are `KeyboardEvent.key` names.

import { isWeb } from './web/web-client';

// `options`: what can be done with the focused thing (a row's Move / Hide): a remote's menu key
export type NavInputAction = 'select' | 'back' | 'up' | 'down' | 'left' | 'right' | 'options';

// Remote and keyboard media keys (docs/ui-system-plan.md §13.2): the player
// takes them (MediaKeys, and the Media Session for hardware keys Chromium
// routes there); a title page's Play takes playPause
export type MediaAction = 'playPause' | 'play' | 'pause' | 'stop' | 'forward' | 'rewind' | 'next' | 'previous';

export type InputAction = NavInputAction | MediaAction;

export const KEY_BINDINGS: Record<InputAction, string[]> = {
  select : ['Enter'],
  // not Backspace: the text keyboard and fields use it (a browser: see actionForKey)
  back   : ['Escape', 'BrowserBack', 'GoBack'],
  up     : ['ArrowUp'],
  down   : ['ArrowDown'],
  left   : ['ArrowLeft'],
  right  : ['ArrowRight'],
  options: ['ContextMenu'],
  playPause : ['MediaPlayPause'],
  play      : ['MediaPlay'],
  pause     : ['MediaPause'],
  stop      : ['MediaStop'],
  forward   : ['MediaFastForward'],
  rewind    : ['MediaRewind'],
  next      : ['MediaTrackNext'],
  previous  : ['MediaTrackPrevious'],
};

export const MEDIA_ACTIONS:MediaAction[] = ['playPause', 'play', 'pause', 'stop', 'forward', 'rewind', 'next', 'previous'];

// Keys the remote control dispatched in a browser (web/web-remote.ts): not
// trusted events, but keys all the same (the pointer's synthetic keys aren't)
export const remoteKeyEvents = new WeakSet<Event>();

/** A key someone pressed: the keyboard, a remote, the admin's remote control */
export function isRealKey(e:KeyboardEvent):boolean {
  return e.isTrusted || remoteKeyEvents.has(e);
}

export function actionForKey(e:KeyboardEvent): InputAction | undefined {
  if (e.key == 'Backspace' && isWeb && backspaceIsBack(e)) return 'back';
  return (Object.keys(KEY_BINDINGS) as InputAction[]).find(action => KEY_BINDINGS[action].includes(e.key));
}

// In a browser (docs/web-client-plan.md §5.4) Backspace is Back too, as on
// web TV apps, except while text is typed: the on-screen keyboard and the PIN
// pad delete with it, and so do real text fields
function backspaceIsBack(e:KeyboardEvent):boolean {
  let target = e.target as HTMLElement | null;
  if (target?.closest?.('input, textarea, [contenteditable="true"]')) return false;
  return !document.querySelector('text-keyboard, pin-pad');
}

export function isMediaAction(action:InputAction | undefined): action is MediaAction {
  return !!action && (MEDIA_ACTIONS as string[]).includes(action);
}

// Mapping handed to the spatial-navigation library (apps/tv/src/plugins/spacialNavigation.js)
export const SPATIAL_NAVIGATION_KEYS = {
  left  : KEY_BINDINGS.left,
  up    : KEY_BINDINGS.up,
  right : KEY_BINDINGS.right,
  down  : KEY_BINDINGS.down,
  enter : KEY_BINDINGS.select,
};
