#!/usr/bin/env node
'use strict';

// Makes the app and tray icons from the Playpex mark (apps/tv/app_icon.svg),
// needs rsvg-convert (librsvg) and ImageMagick (`magick`). The results are
// committed; run again after changing the mark: npm run icons -w apps/server-desktop
//
//   build/icon.png                        1024 px, electron-builder makes .ico / .icns from it
//   assets/tray/<state>.png (+ @2x)       Linux tray, 32 / 64 px
//   assets/tray/<state>.ico               Windows tray, 16–64 px
//   assets/tray/macTemplate.png (+ @2x)   macOS menu bar (template: black + alpha), 16 / 32 px
//   assets/tray/mac-<state>.png (+ @2x)   macOS, coloured states
// States: running, warning (recovery mode, restarting), error, stopped.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TRAY = path.join(ROOT, 'assets', 'tray');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-icons-'));

const MARK = '9.24,11.1 21.58,17.23 14.34,24.17 26.79,16.99 7,7.21 7,11.5 7,24.79';
const GOLD = '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="7" y1="16" x2="26.792" y2="16">' +
  '<stop offset="0" stop-color="#E3CC97"/><stop offset="0.7241" stop-color="#F6E084"/><stop offset="0.9412" stop-color="#D1B372"/></linearGradient>';
const DOTS = { warning: '#F5A524', error: '#E5484D' };

function svg(body, defs) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs>' + (defs || '') + '</defs>' + body + '</svg>';
}

function dot(state, ring) {
  return DOTS[state] ? '<circle cx="25" cy="25" r="6.5" fill="' + DOTS[state] + '" stroke="' + ring + '" stroke-width="1.5"/>' : '';
}

function coloured(state) {
  const mark = state === 'stopped' ? '#8A8A8A' : 'url(#g)';
  return svg('<circle cx="16" cy="16" r="15" fill="#2D2D2D"/><polygon points="' + MARK + '" fill="' + mark + '"/>' + dot(state, '#2D2D2D'), GOLD);
}

function render(source, size, out) {
  const file = path.join(TMP, path.basename(out) + '.svg');
  fs.writeFileSync(file, source);
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, file]);
}

fs.mkdirSync(TRAY, { recursive: true });
render(coloured('running'), 1024, path.join(ROOT, 'build', 'icon.png'));

['running', 'warning', 'error', 'stopped'].forEach(state => {
  const source = coloured(state);
  render(source, 32, path.join(TRAY, state + '.png'));
  render(source, 64, path.join(TRAY, state + '@2x.png'));
  const sizes = [16, 24, 32, 48, 64].map(size => {
    const out = path.join(TMP, state + '-' + size + '.png');
    render(source, size, out);
    return out;
  });
  execFileSync('magick', sizes.concat(path.join(TRAY, state + '.ico')));
  if (state !== 'running') {
    // macOS: a dark disc reads on light and dark menu bars
    render(source, 16, path.join(TRAY, 'mac-' + state + '.png'));
    render(source, 32, path.join(TRAY, 'mac-' + state + '@2x.png'));
  }
});

// macOS template: the mark alone, black on transparent
const template = svg('<polygon points="' + MARK + '" fill="#000"/>');
render(template, 16, path.join(TRAY, 'macTemplate.png'));
render(template, 32, path.join(TRAY, 'macTemplate@2x.png'));

fs.rmSync(TMP, { recursive: true, force: true });
process.stdout.write('icons written to build/ and assets/tray/\n');
