'use strict';

// One plugin's sandbox (docs/plugins-plan.md §4.1), in its own worker thread:
// a QuickJS runtime compiled to WebAssembly with nothing in it but the
// prelude's `playpex` (./prelude.js). This file is ours and runs as Node; the
// plugin's code only ever runs inside QuickJS.
//
// Messages (./sandbox.js is the other side):
//   in   { type: 'init', code, permissions, limits }
//        { type: 'call', callId, kind, name, args, ctx }        args / ctx: JSON strings
//        { type: 'reply', hostId, ok, value?, bytes?, error? }  value: JSON string
//   out  { type: 'ready', registered } · { type: 'fatal', error }
//        { type: 'register', kind, name } · { type: 'log', level, message, fields }
//        { type: 'host', hostId, callId, api, args, bytes? }
//        { type: 'result', callId, ok, value?, error?, cpuMs }
//
// CPU: every time we run plugin code (a handler, a host reply's continuation,
// the job queue) an interrupt handler stops it once that stretch runs past what
// is left of its call's budget (LIMITS.cpuMsPerCall); waiting for the host
// doesn't count. An interrupted call fails with CPU_LIMIT.

var workerThreads = require('worker_threads'),
  qjs = require('quickjs-emscripten-core'),
  variant = require('@jitl/quickjs-wasmfile-release-sync'),
  PRELUDE = require('./prelude');

var port = workerThreads.parentPort,
  rt = null,
  vm = null,
  dispatchFn = null,
  deadline = 0,
  current = null,          // the call whose code is running now (host calls are counted to it)
  spent = new Map(),       // callId → CPU ms so far
  hostCalls = new Map(),   // hostId → { deferred, callId }
  nextHostId = 1,
  limits = null,
  permissions = null,
  registered = { hook: [], data: [], event: [], job: [] };

function codeOf(message) {
  return /interrupted/.test(message) ? 'CPU_LIMIT' : /out of memory/.test(message) ? 'OUT_OF_MEMORY' :
    /stack overflow/.test(message) ? 'STACK_OVERFLOW' : null;
}

/** A QuickJS error handle → { code, message } (and disposes it) */
function errorOf(handle) {
  var e;
  try {
    e = vm.dump(handle);
  } catch (err) {
    e = { message: String(err && err.message) };
  }
  handle.dispose();
  var message = e && typeof e === 'object' ? String(e.message || e.name || 'error') : String(e);
  return {
    code: codeOf(message) || (e && typeof e.code === 'string' ? e.code.slice(0, 40) : 'HANDLER_ERROR'),
    message: message.slice(0, 500)
  };
}

/** Runs plugin code on behalf of a call, under its CPU budget */
function enter(callId, work) {
  var used = spent.get(callId) || 0,
    started = Date.now(),
    previous = current;
  current = callId;
  deadline = started + Math.max(1, limits.cpuMsPerCall - used);
  try {
    return work();
  } finally {
    deadline = 0;
    current = previous;
    if (callId != null) {
      spent.set(callId, used + (Date.now() - started));
    }
  }
}

/** Runs pending jobs (promise continuations) until none is left */
function pump(callId) {
  for (var i = 0; i < 1000; i++) {
    var result = enter(callId, function () { return rt.executePendingJobs(); });
    if (!result.error) {
      result.dispose && result.dispose();
      return;
    }
    // an uncaught error in a job: the promises involved reject on their own
    var e = errorOf(result.error);
    if (e.code === 'OUT_OF_MEMORY') {
      port.postMessage({ type: 'log', level: 'warn', message: 'out of memory in a job', fields: '' });
    }
  }
}

// ── natives the prelude gets ────────────────────────────────────────────────

function nativeHost(apiHandle, argsHandle, bytesHandle) {
  var api = vm.getString(apiHandle),
    args = vm.getString(argsHandle),
    bytes,
    deferred = vm.newPromise(),
    hostId = nextHostId++;
  if (bytesHandle && vm.typeof(bytesHandle) === 'object') {
    var view = vm.getArrayBuffer(bytesHandle);
    bytes = Buffer.from(view.value);
    view.dispose();
  }
  hostCalls.set(hostId, { deferred: deferred, callId: current });
  port.postMessage({ type: 'host', hostId: hostId, callId: current, api: api, args: args, bytes: bytes });
  return deferred.handle;
}

var REGISTER = {
  hook: function (name) {
    return (permissions.hooks || []).indexOf(name) !== -1 ? '' : 'hook ' + name + ' isn\'t in permissions.hooks';
  },
  event: function (name) {
    var family = { playback: 'playback', download: 'downloads', library: 'library', watchlist: 'watchlist', watched: 'watchlist', rating: 'watchlist' }[name.split('.')[0]];
    return family && (permissions.events || []).indexOf(family) !== -1 ? '' : 'events of ' + name + ' aren\'t in permissions.events';
  },
  job: function () {
    return permissions.schedule ? '' : 'schedule needs permissions.schedule';
  },
  data: function (name) {
    return /^[a-z][A-Za-z0-9]{0,39}$/.test(name) ? '' : 'a data handler name is [a-z][A-Za-z0-9]{0,39}';
  }
};

function nativeRegister(kindHandle, nameHandle) {
  var kind = vm.getString(kindHandle), name = vm.getString(nameHandle),
    why = REGISTER[kind] ? REGISTER[kind](name) : 'unknown kind';
  if (!why && registered[kind].indexOf(name) === -1) {
    registered[kind].push(name);
    port.postMessage({ type: 'register', kind: kind, name: name });
  }
  return vm.newString(why);
}

var logged = { minute: 0, count: 0 };
function nativeLog(levelHandle, messageHandle, fieldsHandle) {
  var minute = Math.floor(Date.now() / 60000);
  if (minute !== logged.minute) {
    logged.minute = minute;
    logged.count = 0;
  }
  if (++logged.count > 100) {
    return;   // a plugin can't flood the server log
  }
  port.postMessage({ type: 'log', level: vm.getString(levelHandle), message: vm.getString(messageHandle).slice(0, 2000),
    fields: vm.getString(fieldsHandle).slice(0, 4000) });
}

// ── messages ────────────────────────────────────────────────────────────────

function init(message) {
  limits = message.limits;
  permissions = message.permissions || {};
  return qjs.newQuickJSWASMModuleFromVariant(variant.default || variant).then(function (module) {
    rt = module.newRuntime();
    rt.setMemoryLimit(limits.memoryBytes);
    rt.setMaxStackSize(limits.stackBytes);
    rt.setInterruptHandler(function () { return deadline !== 0 && Date.now() > deadline; });
    vm = rt.newContext();

    var natives = [vm.newFunction('host', nativeHost), vm.newFunction('register', nativeRegister), vm.newFunction('log', nativeLog)],
      made = enter(null, function () { return vm.evalCode(PRELUDE, 'prelude.js'); });
    if (made.error) {
      throw new Error('prelude: ' + errorOf(made.error).message);
    }
    var dispatch = enter(null, function () { return vm.callFunction(made.value, vm.undefined, natives[0], natives[1], natives[2]); });
    made.value.dispose();
    natives.forEach(function (n) { n.dispose(); });
    if (dispatch.error) {
      throw new Error('prelude: ' + errorOf(dispatch.error).message);
    }
    dispatchFn = dispatch.value;

    // The plugin's code: its top level registers handlers, under one call's budget
    var loaded = enter('load', function () { return vm.evalCode(message.code, 'server.js'); });
    if (loaded.error) {
      var e = errorOf(loaded.error);
      throw Object.assign(new Error(e.message), { code: e.code });
    }
    loaded.value.dispose();
    pump('load');
    spent.delete('load');
    port.postMessage({ type: 'ready', registered: registered });
  });
}

function onCall(message) {
  var callId = message.callId;
  function finish(reply) {
    reply.type = 'result';
    reply.callId = callId;
    reply.cpuMs = spent.get(callId) || 0;
    spent.delete(callId);
    port.postMessage(reply);
  }
  var result = enter(callId, function () {
    var handles = [message.kind, message.name, message.args, message.ctx].map(function (s) { return vm.newString(s); }),
      r = vm.callFunction(dispatchFn, vm.undefined, handles[0], handles[1], handles[2], handles[3]);
    handles.forEach(function (h) { h.dispose(); });
    return r;
  });
  if (result.error) {
    finish({ ok: false, error: errorOf(result.error) });
    return;
  }
  vm.resolvePromise(result.value).then(function (settled) {
    if (settled.error) {
      finish({ ok: false, error: errorOf(settled.error) });
    } else {
      var json = vm.getString(settled.value);
      settled.value.dispose();
      finish({ ok: true, value: json });
    }
  });
  result.value.dispose();
  pump(callId);
}

function onReply(message) {
  var pending = hostCalls.get(message.hostId);
  if (!pending) {
    return;
  }
  hostCalls.delete(message.hostId);
  enter(pending.callId, function () {
    if (message.ok) {
      var array = vm.newArray(),
        json = vm.newString(message.value === undefined ? 'null' : message.value);
      vm.setProp(array, 0, json);
      json.dispose();
      if (message.bytes) {
        var bytes = Buffer.from(message.bytes),
          buffer = vm.newArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        vm.setProp(array, 1, buffer);
        buffer.dispose();
      }
      pending.deferred.resolve(array);
      array.dispose();
    } else {
      var error = vm.newError({ name: 'PlaypexError', message: message.error.message }),
        code = vm.newString(message.error.code);
      vm.setProp(error, 'code', code);
      code.dispose();
      pending.deferred.reject(error);
      error.dispose();
    }
    pending.deferred.dispose();
  });
  pump(pending.callId);
}

port.on('message', function (message) {
  try {
    if (message.type === 'init') {
      init(message).catch(function (err) {
        port.postMessage({ type: 'fatal', error: { code: err.code || 'LOAD_FAILED', message: String(err.message).slice(0, 500) } });
      });
    } else if (message.type === 'call') {
      onCall(message);
    } else if (message.type === 'reply') {
      onReply(message);
    }
  } catch (err) {
    // a QuickJS failure outside plugin code (memory of the runtime itself): this sandbox is done
    port.postMessage({ type: 'fatal', error: { code: codeOf(String(err.message)) || 'SANDBOX_FAILED', message: String(err.message).slice(0, 500) } });
  }
});
