'use strict';

// Remote control (docs/remote-control-plan.md §2.5): the WebSocket at
// /api/v1/remote, a relay between the admin (the controller, the dashboard's
// Remote control page) and a device (the target: Playpex TV injects what it
// gets into its own window). Nothing is stored, nothing typed is logged.
//
//   target      a device: its token, or loopback with ?device=<id>; says
//               { type: 'hello', role: 'target', capabilities, screen }
//   controller  the admin's session; ?role=controller&device=<id>
//
// One target socket and one controller per device: a newer one takes over.
// The server checks every message's shape, forwards key / text / pointer to
// the target (only what it declared) and cursor back, sends `state` to both,
// and drops pointer moves (never keys or buttons) while the target's socket
// is behind. A target that says `rtc` gets `signal` messages relayed both ways
// (WebRTC set-up): the pointer then goes straight to it over data channels,
// which the server never sees; this socket stays the fallback.
//
//   remote.control(deviceId)  → { online, playback, keyboard, pointer, text } (sessions, devices)
//   remote.targets()          → GET /remote/targets
//   remote.drop(deviceId)     a revoked device

var WebSocket = require('ws'),
  protocol = require('@playpex/protocol'),
  events = require('../events'),
  log = require('../logger').child('http');

var REMOTE = protocol.REMOTE,
  DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/,
  PING_MS = 30 * 1000,
  BEHIND_BYTES = 64 * 1024,
  MAX_PAYLOAD = 8 * 1024,
  KEY_MAX = 32;

var targets = {},       // deviceId → { socket, deviceId, name, client, paired, capabilities, screen, controller, alive }
  controllers = {},     // deviceId → { socket, deviceId, name, alive }
  pinger = null;

function send(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function capabilitiesOf(target) {
  return target ? target.capabilities : null;
}

function present(target) {
  return {
    deviceId: target.deviceId,
    name: target.name,
    client: target.client,
    paired: target.paired,
    capabilities: target.capabilities,
    screen: target.screen,
    controller: controllers[target.deviceId] ? { name: controllers[target.deviceId].name } : null
  };
}

function changed(deviceId) {
  var t = targets[deviceId];
  events.publish('remote.updated', t ? present(t) : { deviceId: deviceId, gone: true }, { admin: true });
}

// The state both ends see
function stateOf(deviceId, reason) {
  var t = targets[deviceId], c = controllers[deviceId];
  return {
    type: 'state',
    connected: !!(t && t.capabilities && c),
    reason: reason || (!t ? 'offline' : undefined),
    controller: c ? { name: c.name } : null,
    device: t ? { id: t.deviceId, name: t.name } : null,
    capabilities: capabilitiesOf(t),
    screen: t ? t.screen : null
  };
}

function tell(deviceId, reason) {
  var t = targets[deviceId], c = controllers[deviceId], state = stateOf(deviceId, reason);
  if (t) {
    send(t.socket, state);
  }
  if (c) {
    send(c.socket, state);
  }
}

// ── message checks ─────────────────────────────────────────────────────────

function num(v, min, max) {
  return typeof v === 'number' && isFinite(v) ? Math.max(min, Math.min(max, v)) : null;
}

function str(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

// A controller's message as the target gets it, or null (refused)
function clean(msg, caps) {
  if (!msg || typeof msg !== 'object' || !caps) {
    return null;
  }
  if (msg.type === 'key' && caps.keyboard) {
    var key = str(msg.key, KEY_MAX);
    if (!key || (msg.phase !== 'down' && msg.phase !== 'up')) {
      return null;
    }
    return {
      type: 'key', phase: msg.phase, key: key, code: str(msg.code, KEY_MAX) || undefined,
      modifiers: Array.isArray(msg.modifiers) ? msg.modifiers.filter(function (m) { return REMOTE.KEY_MODIFIERS.indexOf(m) >= 0; }) : [],
      repeat: msg.repeat === true
    };
  }
  if (msg.type === 'text' && caps.text) {
    var text = str(msg.text, REMOTE.TEXT_MAX);
    return text ? { type: 'text', text: text } : null;
  }
  if (msg.type === 'pointer' && caps.pointer) {
    if (msg.phase === 'move' && typeof msg.x === 'number') {
      var x = num(msg.x, 0, 1), y = num(msg.y, 0, 1);
      return x === null || y === null ? null : { type: 'pointer', phase: 'move', x: x, y: y };
    }
    if (msg.phase === 'move' || msg.phase === 'wheel') {
      var dx = num(msg.dx, -4000, 4000), dy = num(msg.dy, -4000, 4000);
      return dx === null || dy === null ? null : { type: 'pointer', phase: msg.phase, dx: dx, dy: dy };
    }
    if ((msg.phase === 'down' || msg.phase === 'up') && REMOTE.POINTER_BUTTONS.indexOf(msg.button) >= 0) {
      return { type: 'pointer', phase: msg.phase, button: msg.button };
    }
  }
  return null;
}

// A `signal` message's data as relayed (WebRTC set-up: a description or an
// ICE candidate, opaque to the server), or null: only to a target that said
// rtc, an object, not too big
function signal(msg, caps) {
  if (!caps || !caps.rtc || !msg.data || typeof msg.data !== 'object' || Array.isArray(msg.data)) {
    return null;
  }
  var d = msg.data;
  if (d.description) {
    var desc = d.description;
    return (desc.type === 'offer' || desc.type === 'answer') && str(desc.sdp, REMOTE.RTC.SIGNAL_MAX) ?
      { description: { type: desc.type, sdp: desc.sdp } } : null;
  }
  if ('candidate' in d) {
    var c = d.candidate;
    if (c === null) {
      return { candidate: null };
    }
    if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 1000) {
      return null;
    }
    return { candidate: {
      candidate: c.candidate,
      sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
      sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
      usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : null
    } };
  }
  return null;
}

function parse(data) {
  try {
    return JSON.parse(String(data));
  } catch (e) {
    return null;
  }
}

// ── connections ────────────────────────────────────────────────────────────

function keepAlive(entry) {
  entry.alive = true;
  entry.socket.on('pong', function () { entry.alive = true; });
}

function onTarget(socket, deviceId, who, req) {
  var old = targets[deviceId];
  if (old) {
    old.replaced = true;
    old.socket.close(4000, 'replaced');
  }
  var client = protocol.parseClientHeader(req.headers[protocol.CLIENT_HEADER.toLowerCase()]),
    t = targets[deviceId] = {
      socket: socket, deviceId: deviceId, paired: who.kind === 'device',
      name: who.kind === 'device' ? who.device.name || null : null,
      client: client && client.name ? client.name + (client.version ? '/' + client.version : '') :
        who.kind === 'device' ? who.device.client || null : null,
      capabilities: null, screen: null
    };
  keepAlive(t);
  socket.on('message', function (data) {
    var msg = parse(data);
    if (!msg) {
      return;
    }
    if (msg.type === 'hello') {
      var caps = msg.capabilities || {}, first = !t.capabilities;
      t.capabilities = { keyboard: caps.keyboard === true, pointer: caps.pointer === true, text: caps.text === true,
        rtc: caps.rtc === true && caps.pointer === true };
      var w = num(msg.screen && msg.screen.width, 1, 20000), h = num(msg.screen && msg.screen.height, 1, 20000);
      t.screen = w && h ? { width: w, height: h } : null;
      if (typeof msg.name === 'string' && !t.paired) {
        t.name = msg.name.slice(0, 80) || null;
      }
      tell(deviceId);
      if (first) {
        changed(deviceId);
      }
    } else if (msg.type === 'cursor') {
      var c = controllers[deviceId], x = num(msg.x, 0, 1), y = num(msg.y, 0, 1);
      if (c && x !== null && y !== null) {
        send(c.socket, { type: 'cursor', x: x, y: y });
      }
    } else if (msg.type === 'signal') {
      var to = controllers[deviceId], data = signal(msg, t.capabilities);
      if (to && data) {
        send(to.socket, { type: 'signal', data: data });
      }
    } else if (msg.type === 'bye') {
      endControl(deviceId, 'ended');
    }
  });
  socket.on('close', function () {
    if (targets[deviceId] === t) {
      delete targets[deviceId];
      var c = controllers[deviceId];
      if (c) {
        send(c.socket, stateOf(deviceId, 'offline'));
      }
      changed(deviceId);
    }
  });
  socket.on('error', function () {});
}

// The controller lets go (bye from either end): the target hears it, the
// controller's socket closes
function endControl(deviceId, reason) {
  var c = controllers[deviceId];
  if (!c) {
    return;
  }
  delete controllers[deviceId];
  log.info('remote control of ' + deviceId + ' ended (' + reason + ')');
  tell(deviceId, reason);
  send(c.socket, stateOf(deviceId, reason));
  c.socket.close(1000, reason);
  changed(deviceId);
}

function onController(socket, deviceId, who) {
  var old = controllers[deviceId];
  if (old) {
    delete controllers[deviceId];
    send(old.socket, { type: 'state', connected: false, reason: 'taken' });
    old.socket.close(4001, 'taken');
  }
  var name = (who.user && (who.user.name || who.user.username || who.user.email)) || 'Admin',
    c = controllers[deviceId] = { socket: socket, deviceId: deviceId, name: String(name).slice(0, 80) };
  keepAlive(c);
  log.info('remote control of ' + deviceId + ' started by ' + c.name);
  tell(deviceId);
  changed(deviceId);
  socket.on('message', function (data) {
    if (controllers[deviceId] !== c) {
      return;
    }
    var msg = parse(data);
    if (msg && msg.type === 'bye') {
      return endControl(deviceId, 'ended');
    }
    var t = targets[deviceId];
    if (msg && msg.type === 'signal') {
      var data = t && signal(msg, t.capabilities);
      if (data) {
        send(t.socket, { type: 'signal', data: data });
      }
      return;
    }
    var out = t && clean(msg, t.capabilities);
    if (!out || t.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    // behind: pointer moves are dropped, the next one goes to where the pointer is
    if (out.type === 'pointer' && out.phase === 'move' && t.socket.bufferedAmount > BEHIND_BYTES) {
      return;
    }
    t.socket.send(JSON.stringify(out));
  });
  socket.on('close', function () {
    if (controllers[deviceId] === c) {
      delete controllers[deviceId];
      log.info('remote control of ' + deviceId + ' ended (controller left)');
      tell(deviceId, 'ended');
      changed(deviceId);
    }
  });
  socket.on('error', function () {});
}

function onConnection(socket, req, who) {
  var role = req.query.role === 'controller' ? 'controller' : 'target';
  if (role === 'controller') {
    var device = req.query.device;
    if (who.kind !== 'admin' || typeof device !== 'string' || !DEVICE_ID.test(device)) {
      send(socket, { type: 'state', connected: false, reason: 'refused' });
      return socket.close(4003, 'refused');
    }
    return onController(socket, device, who);
  }
  var id = who.kind === 'device' ? who.device && who.device.id :
    who.kind === 'local' ? req.headers[protocol.DEVICE_HEADER.toLowerCase()] || req.query[protocol.DEVICE_PARAM] : null;
  if (typeof id !== 'string' || !DEVICE_ID.test(id)) {
    send(socket, { type: 'state', connected: false, reason: 'refused' });
    return socket.close(4003, 'refused');
  }
  onTarget(socket, id, who, req);
}

function startPinger() {
  if (pinger) {
    return;
  }
  pinger = setInterval(function () {
    [targets, controllers].forEach(function (all) {
      Object.keys(all).forEach(function (id) {
        var e = all[id];
        if (!e.alive) {
          e.socket.terminate();
          return;
        }
        e.alive = false;
        e.socket.ping();
      });
    });
  }, PING_MS);
  pinger.unref();
}

events.route(REMOTE.PATH, function (socket, req, who) {
  startPinger();
  onConnection(socket, req, who);
}, {
  maxPayload: MAX_PAYLOAD,
  onDetach: function () {
    clearInterval(pinger);
    pinger = null;
    targets = {};
    controllers = {};
  }
});

module.exports = {
  // what the server can make a device do now
  control: function (deviceId) {
    var ev = events.deviceControl(deviceId), t = targets[deviceId], caps = t && t.capabilities;
    return {
      online: ev.online || !!t,
      playback: ev.playback,
      keyboard: !!(caps && caps.keyboard),
      pointer: !!(caps && caps.pointer),
      text: !!(caps && caps.text)
    };
  },
  targets: function () {
    return Object.keys(targets).map(function (id) { return targets[id]; })
      .filter(function (t) { return t.capabilities; }).map(present);
  },
  // a revoked device: its remote socket closes (and its controller is told)
  drop: function (deviceId) {
    var t = targets[deviceId];
    if (t) {
      t.socket.close(4003, 'revoked');
    }
  }
};
