import { desktop } from '../desktop';
import { isWeb } from '../web/web-client';

// How big the whole UI is on this screen: --px-ui-scale (src/styles/_tokens.scss)
// multiplies the root font size, so every dp() length follows (docs/ui-system-plan.md
// §5.1). Per device: a TV across the room and a desk monitor want different
// sizes. Stored in client.json by the shell (localStorage in a browser), chosen
// on the first start (core.display, DisplayGuard), changed in Settings.
//
//   resolveDisplay()      before Angular boots (main.ts): applies the stored scale
//   previewUiScale(s)     applies without storing (the picker, while moving)
//   saveUiScale(s)        applies and stores; display.chosen = true
//   applyFrame(frame)     the screen area: edges and shape (device settings, SettingsService)
//   saveFrame(frame)      the same, kept here until a server has it (the first start)

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

// The screen area chosen before any server knew it (the first start): adopted
// by SettingsService once connected (its LEGACY list), then removed
export const PENDING_FRAME_KEYS = { x: 'playpex.safeArea', y: 'playpex.safeAreaY', shape: 'playpex.shape' };
// The screen area last applied: the boot cache, so the first frame already has
// the right size (docs/web-client-plan.md §3.2)
const FRAME_CACHE_KEY = 'playpex.frame';

// The screen area (docs/web-client-plan.md §3): the window inside the screen
// edges, narrowed to a shape. Everything you read or focus stays inside it and
// the root size follows it; backdrops, the video and scrims go to the edge.
//   x      the left and right edges' inset, a fraction of the width (display.safeArea)
//   y      the top and bottom's, a fraction of the height; null = as x (display.safeAreaY)
//   shape  'fill': any shape; else the largest area of that shape inside, centred (display.shape);
//          'auto': 16:9 in a browser (like YouTube's TV app), the whole window in Playpex TV's own
export type ScreenShape = 'auto' | 'fill' | '16:9' | '21:9' | '4:3';
export interface ScreenFrame {
  x:number;
  y:number | null;
  shape:ScreenShape;
}

export const SCREEN_SHAPES:{ value:ScreenShape, label:string }[] = [
  { value: 'auto', label: isWeb ? 'Automatic (16:9)' : 'Automatic' },
  { value: 'fill', label: 'Fill the screen' },
  { value: '16:9', label: '16:9' },
  { value: '21:9', label: '21:9' },
  { value: '4:3', label: '4:3' },
];

const RATIOS:{ [shape:string]:number } = { '16:9': 16 / 9, '21:9': 21 / 9, '4:3': 4 / 3 };
export const MAX_EDGE = .1;
export const NO_FRAME:ScreenFrame = { x: 0, y: null, shape: 'auto' };

/** The shape `auto` stands for here */
export function effectiveShape(shape:ScreenShape):ScreenShape {
  return shape == 'auto' ? (isWeb && !desktop() ? '16:9' : 'fill') : shape;
}

export const display = {
  /** the stored scale (or the default) */
  scale: DEFAULT_UI_SCALE,
  /** false until someone chose a size on this device */
  chosen: false,
  /** the screen area applied now */
  frame: { ...NO_FRAME } as ScreenFrame,
  applied: false,
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
  applyFrame(bootFrame());
}

// The cache, else a first start's choice still waiting for a server, else none
function bootFrame():ScreenFrame {
  try {
    let cached = localStorage.getItem(FRAME_CACHE_KEY);
    if (cached) return normalFrame(JSON.parse(cached));
    let x = localStorage.getItem(PENDING_FRAME_KEYS.x);
    let y = localStorage.getItem(PENDING_FRAME_KEYS.y);
    let shape = localStorage.getItem(PENDING_FRAME_KEYS.shape);
    return normalFrame({ x: Number(x) || 0, y: y === null || y === '' ? null : Number(y), shape: shape as ScreenShape });
  } catch (e) {
    return { ...NO_FRAME };
  }
}

export function normalFrame(frame:Partial<ScreenFrame> | null | undefined):ScreenFrame {
  let edge = (v:unknown) => Math.min(MAX_EDGE, Math.max(0, Number(v) || 0));
  return {
    x: edge(frame?.x),
    y: frame?.y === null || frame?.y === undefined ? null : edge(frame.y),
    shape: frame?.shape && (frame.shape == 'auto' || frame.shape == 'fill' || RATIOS[frame.shape]) ? frame.shape : 'auto',
  };
}

// The first start's choice: applied, and kept here until a server has it
export function saveFrame(frame:ScreenFrame) {
  frame = applyFrame(frame);
  try {
    localStorage.setItem(PENDING_FRAME_KEYS.x, String(frame.x));
    localStorage.setItem(PENDING_FRAME_KEYS.y, frame.y === null ? '' : String(frame.y));
    localStorage.setItem(PENDING_FRAME_KEYS.shape, frame.shape);
  } catch (e) { }
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

// The screen area → --px-frame-x / -y (where it starts in the window) and
// --px-screen-w / -h (its size). The page (body) is placed and sized to it and
// the root size follows it (styles.scss): the whole app lives inside, the bands
// around are black. Plain CSS, so the browser keeps it right while the window
// is resized. Returns the frame as applied.
export function applyFrame(frame:Partial<ScreenFrame> | null | undefined):ScreenFrame {
  let f = normalFrame(frame);
  let fy = f.y === null ? f.x : f.y;
  let innerW = `100vw * ${1 - 2 * f.x}`;
  let innerH = `100vh * ${1 - 2 * fy}`;
  let shape = effectiveShape(f.shape);
  let ratio = RATIOS[shape];
  let width = ratio ? `min(${innerW}, ${innerH} * ${ratio})` : `(${innerW})`;
  let height = ratio ? `min(${innerH}, ${innerW} / ${ratio})` : `(${innerH})`;
  let root = document.documentElement.style;
  root.setProperty('--px-screen-w', `calc(${width})`);
  root.setProperty('--px-screen-h', `calc(${height})`);
  root.setProperty('--px-frame-x', `calc((100vw - ${width}) / 2)`);
  root.setProperty('--px-frame-y', `calc((100vh - ${height}) / 2)`);
  let changed = JSON.stringify(f) != JSON.stringify(display.frame);
  if (shape != effectiveShape(display.frame.shape) || !display.applied) desktop()?.display?.shape?.(shape)?.catch(() => { });
  display.applied = true;
  display.frame = f;
  try { localStorage.setItem(FRAME_CACHE_KEY, JSON.stringify(f)); } catch (e) { }
  // what listens to the window's size (row chevrons, the Back button, the
  // movement containers' realignment, the too-small guard) measures again
  if (changed) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  return f;
}

/** A frame's insets in words: "None", "3 %", "3 % · 2 %" */
export function frameText(frame:ScreenFrame):string {
  let pct = (v:number) => v == 0 ? '0' : v.toLocaleString('en', { maximumFractionDigits: 1 });
  let x = Math.round(frame.x * 1000) / 10;
  let y = frame.y === null ? x : Math.round(frame.y * 1000) / 10;
  let edges = x == 0 && y == 0 ? 'No edges' : x == y ? `Edges ${pct(x)} %` : `Edges ${pct(x)} % · ${pct(y)} %`;
  return frame.shape == 'auto' || frame.shape == 'fill' ? edges : `${edges} · ${frame.shape}`;
}

function parse(value:string | null):number | null {
  let n = value == null ? NaN : Number(value);
  return n >= .5 && n <= 1.5 ? n : null;
}
