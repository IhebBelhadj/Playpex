'use strict';

// Contrast of the token pairs the UI really uses (docs/ui-system-plan.md §13.6,
// decision P: listed by hand in src/styles/_tokens.scss). Each line
//
//   // contrast: <text token> on <ground token> [over <base token|white>] [large|ui]
//
// is checked against WCAG 2: 4.5:1 for body text, 3:1 for `large` text (the
// heading step and up) and `ui` (focus treatments, rings, bars). Translucent
// grounds are laid over the base (default --px-surface-bg; `over white` = the
// worst case of a scrim over a bright picture), translucent text over that.
//
//   npm run check:contrast -w apps/tv        a table; exits 1 on a pair under its minimum

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'styles', '_tokens.scss');
const text = fs.readFileSync(FILE, 'utf8');

// :root's custom properties (the first definition wins: themes come later)
const tokens = {};
for (const m of text.matchAll(/^\s*(--px-[\w-]+):\s*([^;]+);/gm)) {
  if (!(m[1] in tokens)) tokens[m[1]] = m[2].trim();
}

function parse(value, seen = new Set()) {
  value = value.trim();
  const ref = /^var\((--px-[\w-]+)\)$/.exec(value);
  if (ref) {
    if (value === 'white') return { r: 255, g: 255, b: 255, a: 1 };
    if (seen.has(ref[1]) || !(ref[1] in tokens)) throw new Error('unknown token ' + ref[1]);
    seen.add(ref[1]);
    return parse(tokens[ref[1]], seen);
  }
  let hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = h.split('').map(c => c + c).join('');
    const n = i => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length == 8 ? n(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
  throw new Error('not a colour: ' + value);
}

function color(name) {
  if (name === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (!(name in tokens)) throw new Error('unknown token ' + name);
  return parse(tokens[name], new Set([name]));
}

const over = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});

function luminance(c) {
  const channel = v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const pairs = [];
for (const m of text.matchAll(/\/\/\s*contrast:\s*(--px-[\w-]+)\s+on\s+(--px-[\w-]+)(?:\s+over\s+(--px-[\w-]+|white))?(?:\s+(large|ui))?/g)) {
  pairs.push({ fg: m[1], bg: m[2], base: m[3] || '--px-surface-bg', kind: m[4] || 'body' });
}
if (!pairs.length) {
  console.error('No `// contrast:` lines in ' + path.relative(process.cwd(), FILE));
  process.exit(1);
}

let failed = 0;
const rows = pairs.map(p => {
  const ground = over(color(p.bg), color(p.base));
  const value = ratio(over(color(p.fg), ground), ground);
  const min = p.kind === 'body' ? 4.5 : 3;
  const ok = value >= min;
  if (!ok) failed++;
  return [ok ? 'ok  ' : 'LOW ', value.toFixed(2).padStart(5) + ':1', ('≥ ' + min).padEnd(5), p.fg + ' on ' + p.bg + (p.base !== '--px-surface-bg' ? ' over ' + p.base : '') + (p.kind !== 'body' ? ' (' + p.kind + ')' : '')];
});
rows.forEach(r => console.log(r.join('  ')));
console.log(pairs.length + ' pairs, ' + failed + ' under their minimum');
process.exit(failed ? 1 : 0);
