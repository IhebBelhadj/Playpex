import { DESIGN_PX_PER_REM } from './units';

// TMDB image sizes for what's on screen: an image shown dp(n) wide is n design
// pixels × the root size (window and --px-ui-scale, ui/display.ts) × the
// device pixel ratio × its focus zoom real pixels. A fixed w342 was too small
// at 4K and twice too big in a small window.
//
//   posterBase = tmdbImageBase('poster', 180);    // in a field: once per page
//   <img [src]="posterBase + movie.poster_path">

// TMDB's sizes per image type (configuration API), smallest first: [name, width]
const SIZES = {
  poster: [['w92', 92], ['w154', 154], ['w185', 185], ['w342', 342], ['w500', 500], ['w780', 780]],
  still: [['w92', 92], ['w185', 185], ['w300', 300]],
  profile: [['w45', 45], ['w185', 185], ['h632', 421]],       // h632: 632 high, ~421 wide (2:3)
  backdrop: [['w300', 300], ['w780', 780], ['w1280', 1280]],
} as const;

export type TmdbImageKind = keyof typeof SIZES;

export function tmdbImageBase(kind:TmdbImageKind, widthDp:number, zoom = 1.1):string {
  let rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || DESIGN_PX_PER_REM;
  let needed = widthDp / DESIGN_PX_PER_REM * rootPx * (window.devicePixelRatio || 1) * zoom;
  let size = (SIZES[kind] as readonly (readonly [string, number])[]).find(([, width]) => width >= needed);
  return 'https://image.tmdb.org/t/p/' + (size ? size[0] : 'original');
}
