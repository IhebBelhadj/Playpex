'use strict';

// Core-only host calls (docs/plugin-layer-plan.md §8): what only the code the
// server ships (./builtin) may ask, through `playpex.core.call(name, args)`
// in its sandbox. A plugin that isn't trusted gets PERMISSION_DENIED, whatever its
// manifest says; every call counts in its Activity like any host call.
//
//   register(name, fn(plugin, args, bytes) → Promise)   a call (the Stremio bridge's `stremio.get`, tests' `test.echo`)
//   unregister(name)
//   call(plugin, name, args, bytes) → Promise

var calls = {};

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function register(name, fn) {
  if (!/^[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error('a core call is named <area>.<name>: ' + name);
  }
  calls[name] = fn;
}

function unregister(name) {
  delete calls[name];
}

function call(plugin, name, args, bytes) {
  if (!plugin.trusted) {
    return Promise.reject(failure('PERMISSION_DENIED', 'core.call is the core\'s own: only code the server ships may use it'));
  }
  var fn = calls[String(name)];
  if (!fn) {
    return Promise.reject(failure('INVALID', 'no core call ' + String(name).slice(0, 60)));
  }
  try {
    return Promise.resolve(fn(plugin, args || {}, bytes));
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = {
  register: register,
  unregister: unregister,
  call: call
};
