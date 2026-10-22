// dp(n): n pixels of the 1440 × 810 design, as a CSS length that scales with
// the window, like dp() in the stylesheets (src/styles/_px.scss). For lengths
// set from code (GSAP tweens, inline styles); never write 'npx'.
export const DESIGN_PX_PER_REM = 16;

export function dp(n:number):string {
  return n / DESIGN_PX_PER_REM + 'rem';
}

export type DurationToken = 'quick' | 'fast' | 'default' | 'slow';

// dur(token): a motion duration of the tokens (--px-dur-*, src/styles/_tokens.scss)
// in seconds, for GSAP and other timelines set from code; 0 with reduced motion
// (the tokens are 0 then). `factor` stretches it for longer moves.
export function dur(token:DurationToken = 'default', factor = 1):number {
  let name = token == 'default' ? '--px-dur' : `--px-dur-${token}`;
  let value = '';
  try { value = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) { }
  let ms = value.endsWith('ms') ? parseFloat(value) : value.endsWith('s') ? parseFloat(value) * 1000 : NaN;
  if (isNaN(ms)) ms = { quick: 100, fast: 150, default: 200, slow: 300 }[token];
  return ms * factor / 1000;
}
