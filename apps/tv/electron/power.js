'use strict';

// The power menu (Quit / Sleep / Shutdown / Restart) over IPC; replaces the
// express app on :3344 the TV app had while it carried the server.

const { app } = require('electron');
const shutdown = require('electron-shutdown-command');

const ACTIONS = {
  quit: () => app.quit(),
  shutdown: () => shutdown.shutdown(),
  sleep: () => shutdown.sleep(),
  restart: () => shutdown.reboot()
};

function run(action) {
  const fn = ACTIONS[action];
  if (!fn) {
    throw new Error('Unknown power action: ' + action);
  }
  fn();
}

module.exports = { run, ACTIONS: Object.keys(ACTIONS) };
