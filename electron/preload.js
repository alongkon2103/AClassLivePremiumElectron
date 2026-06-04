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
      'settings:save',
      'hotkey:startCapture',  // แจ้ง main ว่ากำลังรอ user กดปุ่ม assign
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
      'tiktok:gift',
      'tiktok:chat',
      'tiktok:like',
      'tiktok:follow',
      'tiktok:error',
      'settings:update',
      'hotkey:win-adjust',
      'hotkey:spin-trigger',
      'hotkey:rawkey',        // รับ raw keycode จาก uiohook (ใช้ตอน assign hotkey)
      'hotkey:registered',    // รับสรุป hotkey ที่ลงทะเบียนตอนนี้ (ใช้ใน Debug Panel)
      'update:available',
      'update:progress',
      'update:downloaded',
      'update:error',
      'auth:callback',
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
      'auth:open-external',
      'hotkey:uiohookAvailable', // เช็คว่า uiohook พร้อมใช้ไหม
      'os:getLocale',         // ดึง locale ของเครื่อง (เช่น "en-US", "th-TH") เพื่อใช้เป็นภาษาเริ่มต้น
      'app:restart',          // ปิดและเปิดโปรแกรมใหม่ (relaunch + exit)
    ];
    if (!validChannels.includes(channel)) {
      throw new Error(`Invalid IPC channel: ${channel}`);
    }
    return await ipcRenderer.invoke(channel, data);
  },

  getVersion: () => require('../package.json').version,
});