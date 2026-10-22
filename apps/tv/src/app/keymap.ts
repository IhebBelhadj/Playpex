// Single source of truth for key bindings. Components never compare `e.key`
// themselves: they ask `actionForKey(e)` and react to the abstract action, so a
// binding (or a future input source like the cursor / a phone remote) only has
// to be wired here. Values are `KeyboardEvent.key` names.

export type NavInputAction = 'select' | 'back' | 'up' | 'down' | 'left' | 'right';

// Remote and keyboard media keys (docs/ui-system-plan.md §13.2): the player
// takes them (MediaKeys, and the Media Session for hardware keys Chromium
// routes there); a title page's Play takes playPause
export type MediaAction = 'playPause' | 'play' | 'pause' | 'stop' | 'forward' | 'rewind' | 'next' | 'previous';

export type InputAction = NavInputAction | MediaAction;

export const KEY_BINDINGS: Record<InputAction, string[]> = {
  select : ['Enter'],
  // not Backspace: the text keyboard and fields use it
  back   : ['Escape', 'BrowserBack', 'GoBack'],
  up     : ['ArrowUp'],
  down   : ['ArrowDown'],
  left   : ['ArrowLeft'],
  right  : ['ArrowRight'],
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

export function actionForKey(e:KeyboardEvent): InputAction | undefined {
  return (Object.keys(KEY_BINDINGS) as InputAction[]).find(action => KEY_BINDINGS[action].includes(e.key));
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
