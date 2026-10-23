'use strict';

// Plugins are set up on the server's dashboard only (docs/plugins-plan.md
// goal 7, §6.3): the TV app renders what plugins show and nothing else. This
// looks for anything that would set one up from the TV: admin routes, a
// plugin's settings / grants / profiles / account-linking / install routes,
// the admin's plugin types, plugin permissions in the plugin adapter.
//
//   npm run check:plugins -w apps/tv     exits 1 and lists the offending lines
//
// A deliberate exception carries a marker on its line, with the reason:
//   … // plugins-check: allow (reason)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = [path.join(ROOT, 'src', 'app'), path.join(ROOT, 'electron')];
const ADAPTER = path.join(ROOT, 'src', 'app', 'plugins') + path.sep;

const RULES = [
  { name: 'an admin route (the dashboard\'s, never a client\'s)', re: /['"`/]admin\/|\/admin['"`]/ },
  {
    name: 'a plugin set-up route (settings, grants, profiles, accounts, install: the dashboard\'s)',
    re: /plugins\/[^'"`\s]*\/(settings|grants|profiles|links|packages|reload|rollback|clear)\b|plugins\/packages\b/,
  },
  { name: 'an admin plugin type', re: /\b(AdminPlugins?|PluginSettings|PluginSettingDefinition|PluginLink(Start|Progress)?|PluginPackagePreview)\b/ },
  { name: 'plugin permissions in the TV (granted on the dashboard)', re: /\bpermissions\b|\bgrants?\b/, only: ADAPTER },
];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full);
    return /\.(ts|js|html)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

// comments out, line numbers kept
function strip(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, block => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map(line => ({
      code: line.replace(/(^|[^:])\/\/.*$/, '$1'),
      allowed: /\/\/\s*plugins-check:\s*allow\b/.test(line),
    }));
}

const problems = [];
for (const file of DIRS.flatMap(files)) {
  strip(fs.readFileSync(file, 'utf8')).forEach(({ code, allowed }, i) => {
    if (allowed) return;
    for (const rule of RULES) {
      if (rule.only && !file.startsWith(rule.only)) continue;
      if (rule.re.test(code)) problems.push(path.relative(process.cwd(), file) + ':' + (i + 1) + '  ' + rule.name + '\n    ' + code.trim());
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error('\n' + problems.length + ' problem(s). Plugins are set up on the dashboard (docs/plugins-plan.md §6.3); the TV only renders them.');
  process.exit(1);
}
console.log('TV app: no plugin set-up (settings, permissions, accounts, installs).');
