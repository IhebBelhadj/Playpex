// Single source of truth for key bindings. Components never compare `e.key`
// themselves: they ask `actionForKey(e)` and react to the abstract action, so a
// binding (or a future input source like the cursor / a phone remote) only has
// to be wired here. Values are `KeyboardEvent.key` names.

export type InputAction = 'select' | 'back' | 'up' | 'down' | 'left' | 'right';

export const KEY_BINDINGS: Record<InputAction, string[]> = {
  select : ['Enter'],
  back   : ['Escape'],
  up     : ['ArrowUp'],
  down   : ['ArrowDown'],
  left   : ['ArrowLeft'],
  right  : ['ArrowRight'],
};

export function actionForKey(e:KeyboardEvent): InputAction | undefined {
  return (Object.keys(KEY_BINDINGS) as InputAction[]).find(action => KEY_BINDINGS[action].includes(e.key));
}

// Mapping handed to the spatial-navigation library (src/plugins/spacialNavigation.js)
export const SPATIAL_NAVIGATION_KEYS = {
  left  : KEY_BINDINGS.left,
  up    : KEY_BINDINGS.up,
  right : KEY_BINDINGS.right,
  down  : KEY_BINDINGS.down,
  enter : KEY_BINDINGS.select,
};
