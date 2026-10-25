'use strict';

// The engine port's first rule (docs/media-server-plan.md §4.3), checked: only
// lib/torrents/engines/ knows a torrent engine. Outside it, no file requires
// an engine library (torrent-stream, librqbit…) or an adapter file directly
// (the registry, lib/torrents/engines/index.js, is the way), or mentions
// rqbit in code. Comments are allowed to.
//
//   npm run check:engines -w apps/server     exits 1 and lists the offending lines
//                                            (also part of `npm test`)

var fs = require('fs'),
  path = require('path');

var ROOT = path.join(__dirname, '..'),
  ENGINES = path.join(ROOT, 'lib', 'torrents', 'engines'),
  SCANNED = ['index.js', 'bin', 'lib'];

var RULES = [
  { name: 'requires an engine library', re: /require\(\s*['"](torrent-stream|peer-wire-protocol|webtorrent|librqbit|rqbit[^'"]*)['"]\s*\)/ },
  { name: 'requires an engine adapter directly (use lib/torrents/engines)', re: /require\(\s*['"][^'"]*engines\/(?!index['"])[^'"]+['"]\s*\)/ },
  { name: 'mentions rqbit in code', re: /rqbit/i }
];

function files(dir) {
  var full = path.join(ROOT, dir);
  if (!fs.statSync(full).isDirectory()) {
    return [full];
  }
  return fs.readdirSync(full, { withFileTypes: true }).reduce(function (all, entry) {
    var child = path.join(full, entry.name);
    if (entry.isDirectory()) {
      return child === ENGINES ? all : all.concat(files(path.relative(ROOT, child)));
    }
    return /\.js$/.test(entry.name) ? all.concat([child]) : all;
  }, []);
}

// comments out (line numbers kept); strings stay, requires are strings
function strip(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, function (block) { return block.replace(/[^\n]/g, ' '); })
    .split('\n')
    .map(function (line) { return line.replace(/(^|[^:'"\\])\/\/.*$/, '$1'); });
}

var problems = [];
SCANNED.reduce(function (all, dir) { return all.concat(files(dir)); }, []).forEach(function (file) {
  strip(fs.readFileSync(file, 'utf8')).forEach(function (line, i) {
    RULES.forEach(function (rule) {
      if (rule.re.test(line)) {
        problems.push(path.relative(ROOT, file) + ':' + (i + 1) + '  ' + rule.name + '\n    ' + line.trim());
      }
    });
  });
});

if (problems.length) {
  process.stderr.write('check:engines: ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') +
    ' (only lib/torrents/engines/ may know an engine)\n' + problems.join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('check:engines: ok\n');
