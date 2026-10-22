import { desktop } from '../desktop';

// How big the whole UI is on this screen: --px-ui-scale (src/styles/_tokens.scss)
// multiplies the root font size, so every dp() length follows (docs/ui-system-plan.md
// §5.1). Per device: a TV across the room and a desk monitor want different
// sizes. Stored in client.json by the shell (localStorage in a browser), chosen
// on the first start (core.display, DisplayGuard), changed in Settings.
//
//   resolveDisplay()      before Angular boots (main.ts): applies the stored scale
//   previewUiScale(s)     applies without storing (the picker, while moving)
//   saveUiScale(s)        applies and stores; display.chosen = true
//   applySafeArea(f)      the screen edges (a device setting, SettingsService)

export interface UiScaleOption {
  value:number;
  label:string;
}

export const UI_SCALES:UiScaleOption[] = [
  { value: .7, label: 'Small' },
  { value: .8, label: 'Medium' },
  { value: .9, label: 'Large' },
  { value: 1, label: 'Larger' },
  { value: 1.15, label: 'Largest' },
];

// _tokens.scss has the same default (the size before anything is resolved)
export const DEFAULT_UI_SCALE = .8;

const STORAGE_KEY = 'playpex.uiScale';

// the screen edges chosen before any server knew them (the first start):
// adopted by SettingsService once connected, applied at boot until then
const SAFE_AREA_KEY = 'playpex.safeArea';

export const display = {
  /** the stored scale (or the default) */
  scale: DEFAULT_UI_SCALE,
  /** false until someone chose a size on this device */
  chosen: false,
  /** the screen edges kept on this device (0–0.06), until the server has them */
  safeArea: 0,
};

export async function resolveDisplay():Promise<void> {
  let stored:number | null = null;
  let bridge = desktop();
  try {
    if (bridge?.display) stored = (await bridge.display.get()).scale;
    else stored = parse(localStorage.getItem(STORAGE_KEY));
  } catch (e) {
    console.error('UI scale: ', e);
  }
  display.chosen = stored != null;
  display.scale = stored ?? DEFAULT_UI_SCALE;
  previewUiScale(display.scale);
  try { display.safeArea = Number(localStorage.getItem(SAFE_AREA_KEY)) || 0; } catch (e) { }
  applySafeArea(display.safeArea);
}

export function saveSafeArea(fraction:number) {
  display.safeArea = fraction;
  applySafeArea(fraction);
  try { localStorage.setItem(SAFE_AREA_KEY, String(fraction)); } catch (e) { }
}

export function previewUiScale(scale:number) {
  document.documentElement.style.setProperty('--px-ui-scale', String(scale));
}

export async function saveUiScale(scale:number):Promise<void> {
  previewUiScale(scale);
  display.scale = scale;
  display.chosen = true;
  let bridge = desktop();
  if (bridge?.display) await bridge.display.set(scale);
  else {
    try { localStorage.setItem(STORAGE_KEY, String(scale)); } catch (e) { }
  }
}

// Screen edges (docs/ui-system-plan.md §13.1): what a TV crops at each edge,
// as a fraction of the screen (setting display.safeArea, 0–0.06). Everything
// you read or focus stays inside --px-safe-x / --px-safe-y.
export function applySafeArea(fraction:number | null | undefined) {
  let f = Math.min(.1, Math.max(0, Number(fraction) || 0));
  let root = document.documentElement.style;
  root.setProperty('--px-safe-x', `calc(100vw * ${f})`);
  root.setProperty('--px-safe-y', `calc(100vh * ${f})`);
}

function parse(value:string | null):number | null {
  let n = value == null ? NaN : Number(value);
  return n >= .5 && n <= 1.5 ? n : null;
}
