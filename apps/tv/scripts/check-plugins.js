'use strict';

// Two rules of the plugins plan (docs/plugins-plan.md), checked:
//   • plugins are set up on the server's dashboard only (goal 7, §6.3): the TV
//     app renders what plugins show and nothing else: no admin route, plugin
//     settings / grants / profiles / account-linking / install route, admin
//     plugin type, or plugin permissions in the plugin adapter;
//   • the 18+ section is a plugin (§7.1b): no `adult` / 18+ / xxx / porn in the
//     core's code (the TV app and its shell, the server, the protocol). What
//     stays on purpose (adults-only library folders, the plugins' audience
//     rule, the `adult` accent token, filters keeping adult titles out, old
//     migrations) is the plural `adults`, or carries the marker.
//
//   npm run check:plugins                exits 1 and lists the offending lines
//
// A deliberate exception carries a marker on its line, with the reason:
//   … // plugins-check: allow (reason)        (# in YAML; JSON: ALLOWED_LINES)
// Comments are left out: only code counts.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..', '..');
const DIRS = [path.join(ROOT, 'src', 'app'), path.join(ROOT, 'electron')];
const ADAPTER = path.join(ROOT, 'src', 'app', 'plugins') + path.sep;
// where the 18+ rule looks, besides DIRS
const CORE = [path.join(REPO, 'apps', 'server', 'lib'), path.join(REPO, 'apps', 'server', 'index.js'),
  path.join(REPO, 'apps', 'server', 'bin'), path.join(REPO, 'packages', 'protocol')];
const SKIP = [path.join(REPO, 'apps', 'server', 'lib', 'db', 'migrations'), path.join(REPO, 'packages', 'protocol', 'types'),
  path.join(REPO, 'packages', 'protocol', 'node_modules')];
// files without comments: the lines that may name the `adult` accent token
const ALLOWED_LINES = { 'plugin.schema.json': /"accent"|"enum": \["adult"\]|^\s*"adult"\s*$/ };
const SECTION = { name: 'the 18+ section in the core (it is a plugin: plugins/velvet)', re: /\badult\b|18\+|\bxxx\b|\bporn/i };

const RULES = [
  { name: 'an admin route (the dashboard\'s, never a client\'s)', re: /['"`/]admin\/|\/admin['"`]/ },
  {
    name: 'a plugin set-up route (settings, grants, profiles, accounts, install: the dashboard\'s)',
    re: /plugins\/[^'"`\s]*\/(settings|grants|profiles|links|packages|reload|rollback|clear)\b|plugins\/packages\b/,
  },
  { name: 'an admin plugin type', re: /\b(AdminPlugins?|PluginSettings|PluginSettingDefinition|PluginLink(Start|Progress)?|PluginPackagePreview)\b/ },
  { name: 'plugin permissions in the TV (granted on the dashboard)', re: /\bpermissions\b|\bgrants?\b/, only: ADAPTER },
];

function files(dir, pattern) {
  if (SKIP.includes(dir) || !fs.existsSync(dir)) return [];
  if (fs.statSync(dir).isFile()) return [dir];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full, pattern);
    return pattern.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

// comments out, line numbers kept
function strip(text, file) {
  const yaml = /\.ya?ml$/.test(file), json = /\.json$/.test(file), allow = ALLOWED_LINES[path.basename(file)];
  const raw = text.split('\n');
  return text
    .replace(json || yaml ? /$^/ : /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, block => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line, i) => ({
      code: yaml ? line.replace(/(^|\s)#.*$/, '$1') : json ? line : line.replace(/(^|[^:])\/\/.*$/, '$1'),
      // the marker is read before comments go (it is one)
      allowed: /(\/\/|#|<!--)\s*plugins-check:\s*allow\b/.test(raw[i]) || !!(allow && allow.test(raw[i])),
    }));
}

const problems = [];
function check(file, rules) {
  strip(fs.readFileSync(file, 'utf8'), file).forEach(({ code, allowed }, i) => {
    if (allowed) return;
    for (const rule of rules) {
      if (rule.only && !file.startsWith(rule.only)) continue;
      if (rule.re.test(code)) problems.push(path.relative(process.cwd(), file) + ':' + (i + 1) + '  ' + rule.name + '\n    ' + code.trim());
    }
  });
}
DIRS.flatMap(d => files(d, /\.(ts|js|html)$/)).forEach(file => check(file, RULES.concat([SECTION])));
CORE.flatMap(d => files(d, /\.(js|ts|json|ya?ml)$/)).forEach(file => check(file, [SECTION]));

if (problems.length) {
  console.error(problems.join('\n'));
  console.error('\n' + problems.length + ' problem(s). Plugins are set up on the dashboard (docs/plugins-plan.md §6.3); the TV only renders them; the 18+ section is a plugin (§7.1b).');
  process.exit(1);
}
console.log('No plugin set-up in the TV app, no 18+ section in the core.');
