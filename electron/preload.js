const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  send: (channel, data) => {
    const validChannels = [
      'window:minimize',
      'window:maximize',
      'window:close',
      'overlay:toggle',
      'tiktok:connect',
      'tiktok:disconnect',
      'keyboard:press',
      'settings:save'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  on: (channel, func) => {
    const validChannels = [
      'tiktok:status',
      'tiktok:event',
      'tiktok:stats',
      'settings:update',
      'hotkey:win-adjust',
      'hotkey:spin-trigger',
      'update:available',
      'update:progress',
      'update:downloaded',
      'update:error',
      'auth:callback'  // ← รับ deep link OAuth callback
    ];
    if (!validChannels.includes(channel)) return () => {};
    const subscription = (event, ...args) => func(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  invoke: async (channel, data) => {
    const validChannels = [
      'heartbeat:check',
      'get-hwid',
      'rcon:send',
      'settings:load',
      'tiktok:login',
      'interactive:register-session',
      'update:install',
      'auth:open-external'  // ← เปิด browser ภายนอกสำหรับ OAuth
    ];
    if (!validChannels.includes(channel)) {
      throw new Error(`Invalid IPC channel: ${channel}`);
    }
    return await ipcRenderer.invoke(channel, data);
    },
    getVersion: () => require('../package.json').version
    });