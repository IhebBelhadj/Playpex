#!/usr/bin/env node
'use strict';

// Writes the deb's install / remove scripts (plan §5.7, firewall): electron-
// builder's own templates (the /usr/bin link, chrome-sandbox, AppArmor) plus,
// when ufw or firewalld is active, rules for the server's ports: HTTP
// 28470/tcp and discovery 28471/udp. Taking the templates from the installed
// app-builder-lib keeps them in step with electron-builder updates.
//
//   node build/linux-scripts.js      → vendor/linux/after-install.sh, after-remove.sh
//
// electron-builder fills in ${executable} / ${sanitizedProductName} as in its
// templates. The rules name the default ports: a port changed later in the
// dashboard needs a rule of its own (the dashboard says so).

const fs = require('fs');
const path = require('path');
const { DEFAULT_PORT, DISCOVERY_PORT } = require('@playpex/protocol');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'linux');
const TEMPLATES = path.join(path.dirname(require.resolve('app-builder-lib/package.json', { paths: [ROOT] })), 'templates', 'linux');

const RULES = [DEFAULT_PORT + '/tcp', DISCOVERY_PORT + '/udp'];

const INSTALL = `
# Playpex Media Server: let devices on the LAN reach the server when a
# firewall is active (HTTP ${RULES[0]}, discovery ${RULES[1]}). Nothing is done
# when none is, or when the rules can't be added: the server runs either way.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
${RULES.map(r => `  ufw allow ${r} comment 'Playpex Media Server' >/dev/null 2>&1 || true`).join('\n')}
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent ${RULES.map(r => '--add-port=' + r).join(' ')} >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 || true
fi
`;

// postrm also runs on upgrades ($1 = upgrade): keep the rules then
const REMOVE = `
# Playpex Media Server: the firewall rules after-install added (not on upgrades)
case "$1" in
  remove|purge|0)
    if command -v ufw >/dev/null 2>&1; then
${RULES.map(r => `      ufw delete allow ${r} >/dev/null 2>&1 || true`).join('\n')}
    fi
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
      firewall-cmd --permanent ${RULES.map(r => '--remove-port=' + r).join(' ')} >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 || true
    fi
    ;;
esac
`;

function write(template, extra, name) {
  const base = fs.readFileSync(path.join(TEMPLATES, template), 'utf8').replace(/\s*$/, '\n');
  fs.writeFileSync(path.join(OUT, name), base + extra, { mode: 0o755 });
}

fs.mkdirSync(OUT, { recursive: true });
write('after-install.tpl', INSTALL, 'after-install.sh');
write('after-remove.tpl', REMOVE, 'after-remove.sh');
process.stdout.write('deb scripts written to ' + path.relative(process.cwd(), OUT) + '\n');
