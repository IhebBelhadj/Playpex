#!/usr/bin/env node
'use strict';

// Headless entry of Playpex Media Server (systemd, Docker, `npm run server`).
//
//   playpex-server [--no-recovery]
//                               run until SIGINT / SIGTERM. When another program
//                               holds the port: recovery mode (the dashboard only,
//                               on a free loopback port, to choose another port),
//                               or exit 1 with --no-recovery
//   playpex-server set-port N   save another HTTP port in settings.json
//                               (when the default 28470 is taken)
//   playpex-server admin set <username>
//                               set the admin's username and password (asked
//                               for, or the first line of stdin when piped)
//   playpex-server devices list | pending | approve <code> | deny <code> | revoke <id>
//                               paired devices and pairing requests (works
//                               while the server runs: same database)
//
// Exit codes: 0 stopped, 1 failed / crashed (the service manager restarts it),
// 2 usage or invalid value.
//
// The desktop app (apps/server-desktop) runs this same file in an Electron
// utilityProcess: then process.parentPort exists, and lib/host.js talks with
// the supervisor (status for the tray, stop, pairing approvals…).

var net = require('net'),
  settings = require('../lib/settings');

var args = process.argv.slice(2);

function usage() {
  process.stderr.write('usage: playpex-server [start] [--no-recovery] | set-port <port> | admin set <username>\n' +
    '       playpex-server devices list | pending | approve <code> | deny <code> | revoke <id>\n');
  process.exit(2);
}

function portIsFree(port) {
  return new Promise(function (resolve) {
    var probe = net.createServer();
    probe.once('error', function () { resolve(false); });
    probe.listen(port, function () { probe.close(function () { resolve(true); }); });
  });
}

function setPort(value) {
  settings.load();
  var invalid = settings.validatePort(value);
  if (invalid) {
    process.stderr.write(invalid + '\n');
    process.exit(2);
  }
  var port = Number(value);
  portIsFree(port).then(function (free) {
    if (!free) {
      process.stderr.write('Port ' + port + ' is in use right now, pick another one.\n');
      process.exit(2);
    }
    var result = settings.update({ general: { port: port } });
    process.stdout.write('Port ' + port + ' saved in ' + settings.FILE + '. Restart the server to use it.\n');
    if (result.lockedByEnv.length) {
      process.stdout.write('Note: PLAYPEX_PORT / STREAMER_PORT is set and still wins over the file.\n');
    }
    process.exit(0);
  });
}

// ── admin / devices (lib/auth on the same database as a running server) ────

function quietCore() {
  settings.load();
  var logger = require('../lib/logger');
  logger.configure({ level: 'warn', console: true });
  return require('../lib/auth');
}

function finish(promise) {
  promise.then(function () {
    return require('../lib/userData').close();
  }).then(function () {
    process.exit(0);
  }, function (err) {
    process.stderr.write((err.message || String(err)) + '\n');
    process.exit(err.code === 'INVALID' || err.code === 'NOT_FOUND' || err.code === 'CONFLICT' ? 2 : 1);
  });
}

// A password typed without echo, or the first line of stdin when piped
function askPassword(prompt) {
  return new Promise(function (resolve) {
    var readline = require('readline');
    if (!process.stdin.isTTY) {
      var rl = readline.createInterface({ input: process.stdin });
      rl.once('line', function (line) { resolve(line); rl.close(); });
      rl.once('close', function () { resolve(''); });
      return;
    }
    process.stdout.write(prompt);
    var input = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(ch) {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f') {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    });
  });
}

function adminSet(name) {
  var auth = quietCore();
  finish(askPassword('Password for ' + name + ': ').then(function (password) {
    if (!process.stdin.isTTY) {
      return password;
    }
    return askPassword('Again: ').then(function (again) {
      if (again !== password) {
        var err = new Error('The passwords differ');
        err.code = 'INVALID';
        throw err;
      }
      return password;
    });
  }).then(function (password) {
    return auth.setAdmin(name, password);
  }).then(function () {
    process.stdout.write('Admin account set: ' + name + '. Sign in to the dashboard with it.\n');
  }));
}

function table(rows, columns) {
  if (!rows.length) {
    return '';
  }
  var widths = columns.map(function (c) {
    return Math.max(c.length, Math.max.apply(null, rows.map(function (r) { return String(r[c] == null ? '-' : r[c]).length; })));
  });
  function line(values) {
    return values.map(function (v, i) { return String(v == null ? '-' : v).padEnd(widths[i]); }).join('  ').trimEnd() + '\n';
  }
  return line(columns) + rows.map(function (r) { return line(columns.map(function (c) { return r[c]; })); }).join('');
}

function devicesCommand(args) {
  var auth = quietCore(),
    out = function (text) { process.stdout.write(text); };
  switch (args[0] + '/' + args.length) {
    case 'list/1':
      return finish(auth.listDevices().then(function (devices) {
        out(devices.length ? table(devices, ['id', 'name', 'clientId', 'platform', 'address', 'lastSeenAt']) :
          'No paired devices.\n');
      }));
    case 'pending/1':
      return finish(auth.pendingRequests().then(function (requests) {
        out(requests.length ? table(requests, ['userCode', 'clientId', 'client', 'address', 'expiresAt']) :
          'No pairing requests.\n');
      }));
    case 'approve/2':
    case 'deny/2':
      return finish(auth[args[0]](args[1]).then(function () {
        out('Pairing request ' + args[1] + (args[0] === 'approve' ? ' approved: the device is paired once it asks again.\n' : ' denied.\n'));
      }));
    case 'revoke/2':
      return finish(auth.revokeDevice(args[1]).then(function (revoked) {
        if (!revoked) {
          var err = new Error('No device ' + args[1]);
          err.code = 'NOT_FOUND';
          throw err;
        }
        out('Device ' + args[1] + ' revoked.\n');
      }));
    default:
      usage();
  }
}

function run(noRecovery) {
  var core = require('..'),
    log = core.logger.child('server');

  // Logged, then exit: systemd / Docker / the desktop supervisor restart us
  process.on('uncaughtException', function (err) {
    log.error('uncaught exception: ' + err.message, { err: err });
    process.exit(1);
  });
  process.on('unhandledRejection', function (reason) {
    log.error('unhandled rejection: ' + (reason && reason.message || reason),
      { err: reason instanceof Error ? reason : undefined });
  });

  var stopping = false;
  function shutdown(signal) {
    if (stopping) {
      process.exit(1);   // second Ctrl-C: don't wait
    }
    stopping = true;
    log.info(signal === 'supervisor' ? 'stop asked by the desktop app' : 'received ' + signal);
    setTimeout(function () { process.exit(1); }, 10000).unref();
    core.stop().then(function () { process.exit(0); }, function () { process.exit(1); });
  }
  process.on('SIGINT', function () { shutdown('SIGINT'); });
  process.on('SIGTERM', function () { shutdown('SIGTERM'); });

  var host = require('../lib/host');
  if (process.parentPort) {
    host.attachSupervisor(process.parentPort, { stop: shutdown });
  }

  // Port taken by another program → recovery mode (dashboard only, loopback),
  // unless --no-recovery (Docker, scripts: exit and let the manager report it)
  (noRecovery ? core.start() : core.startOrRecover()).then(function () {
    host.pushStatus();
  }, function (err) {
    host.fatal(err);
    if (err.code === 'PORT_IN_USE' || err.code === 'PORT_NOT_ALLOWED') {
      log.error(err.playpex ? 'Another Playpex server is already running on port ' + err.port :
        err.message, { code: err.code, port: err.port });
      log.error('Choose another port: `playpex-server set-port <port>` (npm run server -- set-port <port>), ' +
        'PLAYPEX_PORT=<port>, or "general.port" in ' + settings.FILE);
    } else {
      log.error('cannot start: ' + err.message, { err: err });
    }
    // Lets the message to the supervisor (and the log line) go out first
    setTimeout(function () { process.exit(1); }, process.parentPort ? 300 : 0);
  });
}

if (args[0] === 'admin') {
  if (args[1] !== 'set' || args.length !== 3) {
    usage();
  }
  adminSet(args[2]);
} else if (args[0] === 'devices') {
  devicesCommand(args.slice(1));
} else if (args[0] === 'set-port') {
  if (args.length !== 2) {
    usage();
  }
  setPort(args[1]);
} else if (args.filter(function (a) { return a !== 'start' && a !== '--no-recovery'; }).length === 0 &&
  args.filter(function (a) { return a === 'start'; }).length <= 1) {
  run(args.indexOf('--no-recovery') !== -1);
} else {
  usage();
}
