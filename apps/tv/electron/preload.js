'use strict';

// window.playpex: what the Angular app may ask the main process
// (docs/server-separation-plan.md §10.1). Types: apps/tv/src/app/desktop.ts.
// Device tokens never cross this bridge: the main process adds them to
// requests itself (auth.js).

const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return listener => {
    const handler = (event, value) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('playpex', {
  connection: {
    current: () => ipcRenderer.invoke('connection:current'),
    adoptDeviceId: id => ipcRenderer.invoke('connection:adoptDeviceId', id),
    choose: server => ipcRenderer.invoke('connection:choose', server),
    reconnect: () => ipcRenderer.invoke('connection:reconnect'),
    drop: (reason, detail) => ipcRenderer.invoke('connection:drop', reason, detail),
    forget: id => ipcRenderer.invoke('connection:forget', id)
  },
  discovery: {
    start: () => ipcRenderer.invoke('discovery:start'),
    stop: () => ipcRenderer.invoke('discovery:stop'),
    rescan: () => ipcRenderer.invoke('discovery:rescan'),
    probe: address => ipcRenderer.invoke('discovery:probe', address),
    onChange: on('discovery:servers')
  },
  pairing: {
    start: server => ipcRenderer.invoke('pairing:start', server),
    cancel: () => ipcRenderer.invoke('pairing:cancel'),
    onUpdate: on('pairing:update')
  },
  localServer: {
    status: () => ipcRenderer.invoke('local:status'),
    start: () => ipcRenderer.invoke('local:start')
  },
  updater: {
    state: () => ipcRenderer.invoke('updater:state'),
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onChange: on('updater:state')
  },
  display: {
    get: () => ipcRenderer.invoke('display:get'),
    set: scale => ipcRenderer.invoke('display:set', scale)
  },
  power: action => ipcRenderer.invoke('power', action)
});
