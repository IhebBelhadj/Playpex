#!/usr/bin/env node
'use strict';

// Headless entry of Playpex Media Server (systemd, Docker, `npm run server`).
//
//   playpex-server              run until SIGINT / SIGTERM
//   playpex-server set-port N   save another HTTP port in settings.json
//                               (when the default 28470 is taken)
//
// Exit codes: 0 stopped, 1 failed / crashed (the service manager restarts it),
// 2 usage or invalid value.

var net = require('net'),
  settings = require('../lib/settings');

var args = process.argv.slice(2);

function usage() {
  process.stderr.write('usage: playpex-server [start] | set-port <port>\n');
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

function run() {
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
    log.info('received ' + signal);
    setTimeout(function () { process.exit(1); }, 10000).unref();
    core.stop().then(function () { process.exit(0); }, function () { process.exit(1); });
  }
  process.on('SIGINT', function () { shutdown('SIGINT'); });
  process.on('SIGTERM', function () { shutdown('SIGTERM'); });

  core.start().catch(function (err) {
    if (err.code === 'PORT_IN_USE' || err.code === 'PORT_NOT_ALLOWED') {
      log.error(err.message, { code: err.code, port: err.port });
      log.error('Choose another port: `playpex-server set-port <port>` (npm run server -- set-port <port>), ' +
        'PLAYPEX_PORT=<port>, or "general.port" in ' + settings.FILE);
    } else {
      log.error('cannot start: ' + err.message, { err: err });
    }
    process.exit(1);
  });
}

if (args[0] === 'set-port') {
  if (args.length !== 2) {
    usage();
  }
  setPort(args[1]);
} else if (args.length === 0 || (args[0] === 'start' && args.length === 1)) {
  run();
} else {
  usage();
}
