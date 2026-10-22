'use strict';

// The UI system's stylesheet rules (docs/ui-system-plan.md §9), checked:
// no colour, font, stacking or px literal outside src/styles/_tokens.scss, and
// every font size from the type scale (--px-text-*).
//
//   npm run check:ui -w apps/tv          exits 1 and lists the offending lines
//
// A deliberate exception carries a marker on its line, with the reason:
//   font-size: max(12px, …);   // ui-check: allow (readability floor, real pixels)
// @font-face blocks may name their families.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const SKIP = new Set([path.join(SRC, 'styles', '_tokens.scss'), path.join(SRC, 'styles', '_px.scss')]);

const RULES = [
  { name: 'colour literal (use a --px-color / --px-surface token)', re: /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/ },
  { name: 'font family literal (use --px-font-*)', re: /font-family:\s*['"]/, unlessFontFace: true },
  { name: 'z-index literal (use --px-z-*)', re: /z-index:\s*-?\d/ },
  { name: 'px length (use dp(n))', re: /\b\d*\.?\d+px\b/ },
  { name: 'font size outside the type scale (use --px-text-*)', re: /font-size:(?!\s*(?:var\(--px-text-|inherit\b|\d+%|\d*\.?\d+em\b))/ },
];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return entry.name.endsWith('.scss') && !SKIP.has(full) ? [full] : [];
  });
}

// comments out, line numbers kept
function strip(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map(line => {
      const allowed = /\/\/\s*ui-check:\s*allow\b/.test(line);
      const code = line.replace(/(^|[^:])\/\/.*$/, '$1');
      return { code, allowed };
    });
}

const problems = [];
for (const file of files(SRC)) {
  let inFontFace = false;
  let depth = 0;
  strip(fs.readFileSync(file, 'utf8')).forEach(({ code, allowed }, i) => {
    if (/@font-face/.test(code)) {
      inFontFace = true;
      depth = 0;
    }
    if (!allowed) {
      for (const rule of RULES) {
        if (rule.unlessFontFace && inFontFace) continue;
        if (rule.re.test(code)) problems.push(path.relative(process.cwd(), file) + ':' + (i + 1) + '  ' + rule.name + '\n    ' + code.trim());
      }
    }
    if (inFontFace) {
      depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
      if (depth <= 0 && /\}/.test(code)) inFontFace = false;
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error('\n' + problems.length + ' problem(s). Tokens: src/styles/_tokens.scss; units: dp() (src/styles/_px.scss).');
  process.exit(1);
}
console.log('UI stylesheets: no literals outside the tokens.');
