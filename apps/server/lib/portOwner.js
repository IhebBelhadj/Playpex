'use strict';

// Which process listens on a TCP port (docs/server-separation-plan.md §5.9),
// for the "port in use" message and the recovery page. Best effort: the OS
// may only name processes of the same user (Linux `ss` without root), and any
// failure answers null.
//
//   portOwner(28470) → Promise<{ pid, name } | null>
//   isPlaypex(28470) → Promise<boolean>   another Playpex server answers there

var execFile = require('child_process').execFile,
  http = require('http'),
  protocol = require('@playpex/protocol');

var TIMEOUT_MS = 3000;

function run(cmd, args) {
  return new Promise(function (resolve) {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, function (err, stdout) {
      resolve(err ? '' : String(stdout));
    });
  });
}

function linux(port) {
  return run('ss', ['-ltnpH', 'sport = :' + port]).then(function (out) {
    var m = /users:\(\("([^"]+)",pid=(\d+)/.exec(out);
    return m ? { pid: Number(m[2]), name: m[1] } : null;
  });
}

function mac(port) {
  return run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpc']).then(function (out) {
    var pid = /^p(\d+)/m.exec(out), name = /^c(.+)$/m.exec(out);
    return pid ? { pid: Number(pid[1]), name: name ? name[1] : null } : null;
  });
}

function windows(port) {
  return run('netstat', ['-ano', '-p', 'TCP']).then(function (out) {
    var line = out.split(/\r?\n/).filter(function (l) {
      return /LISTENING/.test(l) && new RegExp('[:.]' + port + '\\s').test(l);
    })[0];
    var pid = line && /(\d+)\s*$/.exec(line.trim());
    if (!pid) {
      return null;
    }
    return run('tasklist', ['/FI', 'PID eq ' + pid[1], '/FO', 'CSV', '/NH']).then(function (list) {
      var name = /^"([^"]+)"/.exec(list.trim());
      return { pid: Number(pid[1]), name: name ? name[1] : null };
    });
  });
}

function portOwner(port) {
  var find = process.platform === 'win32' ? windows : process.platform === 'darwin' ? mac : linux;
  return find(port).catch(function () { return null; });
}

function isPlaypex(port) {
  return new Promise(function (resolve) {
    var req = http.get({ host: '127.0.0.1', port: port, path: protocol.API_PREFIX + '/server', timeout: TIMEOUT_MS }, function (res) {
      var body = '';
      res.on('data', function (d) { body += d; });
      res.on('end', function () {
        try {
          resolve(res.statusCode === 200 && typeof JSON.parse(body).apiVersion === 'number');
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('timeout', function () { req.destroy(); });
    req.on('error', function () { resolve(false); });
  });
}

module.exports = portOwner;
module.exports.portOwner = portOwner;
module.exports.isPlaypex = isPlaypex;
