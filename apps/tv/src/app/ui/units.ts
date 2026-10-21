// dp(n): n pixels of the 1440 × 810 design, as a CSS length that scales with
// the window, like dp() in the stylesheets (src/styles/_px.scss). For lengths
// set from code (GSAP tweens, inline styles); never write 'npx'.
export const DESIGN_PX_PER_REM = 16;

export function dp(n:number):string {
  return n / DESIGN_PX_PER_REM + 'rem';
}
