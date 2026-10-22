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

export const display = {
  /** the stored scale (or the default) */
  scale: DEFAULT_UI_SCALE,
  /** false until someone chose a size on this device */
  chosen: false,
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

function parse(value:string | null):number | null {
  let n = value == null ? NaN : Number(value);
  return n >= .5 && n <= 1.5 ? n : null;
}
