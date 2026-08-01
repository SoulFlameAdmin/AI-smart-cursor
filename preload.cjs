"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);

  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("david", {
  submitCommand: (command) =>
    ipcRenderer.invoke("david:submit-command", command),

  getInfo: () =>
    ipcRenderer.invoke("david:get-info"),

  hideCommandPanel: () =>
    ipcRenderer.send("david:hide-command-panel"),

  onPointer: (callback) =>
    subscribe("david:pointer", callback),

  onPointerActive: (callback) =>
    subscribe("david:pointer-active", callback),

  onDisplay: (callback) =>
    subscribe("david:display", callback),

  onStatus: (callback) =>
    subscribe("david:status", callback),

  onCommandPanel: (callback) =>
    subscribe("david:command-panel", callback),

  onRequestInput: (callback) =>
    subscribe("david:request-input", callback)
});


