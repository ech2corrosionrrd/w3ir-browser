'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['state', 'focus-url', 'find-open', 'find-close', 'find-result', 'url-blur', 'overlay', 'toast', 'savebar', 'group-edit']);

contextBridge.exposeInMainWorld('api', {
  cmd: (cmd, arg) => ipcRenderer.invoke('cmd', cmd, arg),
  suggest: (text) => ipcRenderer.invoke('suggest', text),
  on: (channel, cb) => { if (EVENTS.has(channel)) ipcRenderer.on(channel, (_, data) => cb(data)); },
});
