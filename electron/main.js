const { app, BrowserWindow, ipcMain, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ─────────────────────────────────────────────────────────────────────────────
// Hard-fix for Black Screen on some Windows machines
// ─────────────────────────────────────────────────────────────────────────────
app.disableHardwareAcceleration();

// ─────────────────────────────────────────────────────────────────────────────
// Deep Link — single instance lock
// ─────────────────────────────────────────────────────────────────────────────
app.setAsDefaultProtocolClient('aclassstore');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Windows/Linux: second instance sends deep link here
  app.on('second-instance', (event, commandLine) => {
    const url = commandLine.find(arg => arg.startsWith('aclassstore://'));
    if (url) handleDeepLink(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function handleDeepLink(url) {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('token');
    const user = parsed.searchParams.get('user');
    const error = parsed.searchParams.get('error');
    console.log('[DeepLink] Received auth callback');
    if (mainWindow) {
      mainWindow.webContents.send('auth:callback', { token, user, error });
    }
  } catch (e) {
    console.error('[DeepLink] Failed to parse URL:', e.message);
  }
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const appPath = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();

// Load environment variables (optional for production)
const dotEnvPath = path.join(__dirname, '../.env');
if (fs.existsSync(dotEnvPath)) {
  require('dotenv').config({ path: dotEnvPath });
}

const WEB_URL = process.env.WEB_URL || 'https://app.aclassstore.com';
const PRODUCTION_API_URL = process.env.PRODUCTION_API_URL || 'https://api.aclassstore.com';

const { machineIdSync } = require('node-machine-id');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { Rcon } = require('rcon-client');
const { autoUpdater } = require('electron-updater');
const tiktokAuth = require('./tiktokAuth');

// Configure autoUpdater
autoUpdater.autoDownload = true;
autoUpdater.allowPrerelease = false;

autoUpdater.on('update-available', (info) => {
  if (mainWindow) mainWindow.webContents.send('update:available', info);
});

autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) mainWindow.webContents.send('update:progress', progress);
});

autoUpdater.on('update-downloaded', () => {
  if (mainWindow) mainWindow.webContents.send('update:downloaded');
});

autoUpdater.on('error', (err) => {
  console.error('[AutoUpdater Error]', err.message);
});

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall();
});

const { MiddlewareClient } = require('./middlewareClient');
const tiktokService = require('./tiktokService');

let mainWindow;
let overlayWindow;
let tiktokConnection;

// Local SSE Server setup for OBS Overlays
let sseClients = [];
let currentSettings = {};
let overlayServer = null;

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

let keyboard, Key;
try {
  const nut = require('@nut-tree-fork/nut-js');
  keyboard = nut.keyboard;
  Key = nut.Key;
  if (keyboard) keyboard.config.autoDelayMs = 10;
} catch (e) {
  console.error('[Native] Failed to load nut-js:', e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE / Settings helpers
// ─────────────────────────────────────────────────────────────────────────────

function broadcastSettings(settings) {
  currentSettings = settings;
  sseClients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(settings)}\n\n`);
    } catch (e) {
      console.error('Failed to send SSE', e);
    }
  });
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      currentSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      currentSettings.winEnabled = false;
      currentSettings.spinEnabled = false;
      return currentSettings;
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
  return { winEnabled: false, spinEnabled: false };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    if (mainWindow) mainWindow.webContents.send('settings:update', settings);
    if (overlayWindow) overlayWindow.webContents.send('settings:update', settings);
    broadcastSettings(settings);
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hotkey normalization
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHotkey(key) {
  if (!key) return null;

  const original = key.toString().trim();
  let normalized = original;
  const lower = normalized.toLowerCase();

  console.log(`[Hotkey] Normalizing: "${original}"`);

  if (lower.startsWith('numpad')) {
    const code = lower.replace('numpad', '');
    const numMap = {
      '0': 'num0', '1': 'num1', '2': 'num2', '3': 'num3', '4': 'num4',
      '5': 'num5', '6': 'num6', '7': 'num7', '8': 'num8', '9': 'num9',
      'add': 'numadd',
      'subtract': 'numsub',
      'multiply': 'nummult',
      'divide': 'numdiv',
      'decimal': 'numdec',
      'enter': 'enter',
    };
    normalized = numMap[code] ?? code;
  } else {
    normalized = normalized
      .replace(/ArrowUp/i, 'Up')
      .replace(/ArrowDown/i, 'Down')
      .replace(/ArrowLeft/i, 'Left')
      .replace(/ArrowRight/i, 'Right')
      .replace(/Control/i, 'CommandOrControl')
      .replace(/Ctrl/i, 'CommandOrControl')
      .replace(/Meta/i, isMac ? 'Command' : 'Super')
      .replace(/Alt/i, 'Alt')
      .replace(/Escape/i, 'Esc')
      .replace(/ /g, 'Space');
  }

  console.log(`[Hotkey] Result: "${original}" -> "${normalized}"`);
  return normalized;
}

function registerHotkeys(settings) {
  globalShortcut.unregisterAll();

  if (!settings || (!settings.winEnabled && !settings.spinEnabled)) {
    console.log('[Hotkey] Stream Overlays disabled — skipping hotkey registration.');
    return;
  }

  const hotkeys = settings.hotkeys || {};

  const bind = (key, action, val) => {
    const normalized = normalizeHotkey(key);
    if (!normalized) return;
    try {
      const success = globalShortcut.register(normalized, () => {
        console.log(`[Hotkey] Triggered: ${normalized} -> ${action}`);
        if (mainWindow) mainWindow.webContents.send(action, val);
        if (overlayWindow) overlayWindow.webContents.send(action, val);
      });
      if (!success) console.warn(`[Hotkey] Failed to register: ${normalized}`);
    } catch (e) {
      console.error(`[Hotkey] Error registering ${normalized}:`, e.message);
    }
  };

  bind(hotkeys.win, 'hotkey:win-adjust', 1);
  bind(hotkeys.undo, 'hotkey:win-adjust', -1);
  bind(hotkeys.reset, 'hotkey:win-adjust', 'reset');
  bind(hotkeys.spin, 'hotkey:spin-trigger', true);

  if (hotkeys.custom1) bind(hotkeys.custom1.key, 'hotkey:win-adjust', hotkeys.custom1.value);
  if (hotkeys.custom2) bind(hotkeys.custom2.key, 'hotkey:win-adjust', hotkeys.custom2.value);
  if (hotkeys.custom3) bind(hotkeys.custom3.key, 'hotkey:win-adjust', hotkeys.custom3.value);
}

// ─────────────────────────────────────────────────────────────────────────────
// nut-tree keyboard press
// ─────────────────────────────────────────────────────────────────────────────

const NUT_KEY_MAP = {
  Space: Key.Space,
  Enter: Key.Enter,
  Return: Key.Enter,
  Escape: Key.Escape,
  Esc: Key.Escape,
  Tab: Key.Tab,
  Backspace: Key.Backspace,
  Delete: Key.Delete,
  Insert: Key.Insert,
  Home: Key.Home,
  End: Key.End,
  PageUp: Key.PageUp,
  PageDown: Key.PageDown,
  ArrowUp: Key.Up,
  ArrowDown: Key.Down,
  ArrowLeft: Key.Left,
  ArrowRight: Key.Right,
  Up: Key.Up,
  Down: Key.Down,
  Left: Key.Left,
  Right: Key.Right,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4,
  F5: Key.F5, F6: Key.F6, F7: Key.F7, F8: Key.F8,
  F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  Num0: Key.Num0, Num1: Key.Num1, Num2: Key.Num2,
  Num3: Key.Num3, Num4: Key.Num4, Num5: Key.Num5,
  Num6: Key.Num6, Num7: Key.Num7, Num8: Key.Num8,
  Num9: Key.Num9,
  NumAdd: Key.Add,
  NumSubtract: Key.Subtract,
  NumMultiply: Key.Multiply,
  NumDivide: Key.Divide,
  NumDecimal: Key.Decimal,
  NumEnter: Key.Enter,
  NumpadEnter: Key.Enter,
  NumpadAdd: Key.Add,
  NumpadSubtract: Key.Subtract,
  NumpadMultiply: Key.Multiply,
  NumpadDivide: Key.Divide,
  NumpadDecimal: Key.Decimal,
};

const NUT_MODIFIER_MAP = {
  Ctrl: Key.LeftControl,
  Control: Key.LeftControl,
  Shift: Key.LeftShift,
  Alt: Key.LeftAlt,
  Option: Key.LeftAlt,
  Cmd: Key.LeftCmd,
  Command: Key.LeftCmd,
  Meta: isMac ? Key.LeftCmd : Key.LeftWin,
  Win: Key.LeftWin,
  Super: isWin ? Key.LeftWin : Key.LeftCmd,
};

const MAC_OPTION_CHARS = {
  'ƒ': 'f', '≈': 'x', '∂': 'd', '©': 'c', '√': 'v',
  'å': 'a', 'ß': 's', '†': 't', '¬': 'l', 'œ': 'q',
  'ø': 'o', 'π': 'p', '¥': 'y', '"': 'g', 'µ': 'm',
  '∑': 'w', '´': 'e', '®': 'r', '¨': 'u', 'ˆ': 'i',
};

function resolveNutKey(keyStr) {
  if (!keyStr) return undefined;
  const decomposed = MAC_OPTION_CHARS[keyStr];
  if (decomposed) keyStr = decomposed;
  if (NUT_KEY_MAP[keyStr] !== undefined) return NUT_KEY_MAP[keyStr];
  const upperFirst = keyStr.charAt(0).toUpperCase() + keyStr.slice(1).toLowerCase();
  if (NUT_KEY_MAP[upperFirst] !== undefined) return NUT_KEY_MAP[upperFirst];
  if (keyStr.length === 1 && /[a-zA-Z]/.test(keyStr)) {
    const k = Key[`Key${keyStr.toUpperCase()}`];
    if (k !== undefined) return k;
    return Key[keyStr.toUpperCase()];
  }
  if (keyStr.length === 1 && /[0-9]/.test(keyStr)) {
    return Key[`Num${keyStr}`];
  }
  const numpadMatch = keyStr.match(/^[Nn]umpad(\w+)$/);
  if (numpadMatch) {
    const sub = numpadMatch[1];
    const candidate = NUT_KEY_MAP[`Numpad${sub}`] ?? NUT_KEY_MAP[`Num${sub}`];
    if (candidate !== undefined) return candidate;
  }
  return Key[keyStr];
}

// ─────────────────────────────────────────────────────────────────────────────
// Window creation
// ─────────────────────────────────────────────────────────────────────────────

function createMainWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  console.log('[Native] Preload Path:', preloadPath);

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    if (overlayWindow) {
      overlayWindow.destroy();
      overlayWindow = null;
    }
    mainWindow = null;
    app.quit();
  });

  // เปิด link ทั้งหมดใน browser ภายนอก ยกเว้น WEB_URL ของเราเอง
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(WEB_URL).catch(err => {
    console.error(`[Native] Failed to load remote URL: ${WEB_URL}`, err.message);
    const indexPath = path.join(__dirname, '../dist/index.html');
    if (fs.existsSync(indexPath)) {
      console.log('[Native] Falling back to local index.html');
      mainWindow.loadFile(indexPath).catch(localErr => {
        console.error('[Native] Local fallback also failed:', localErr.message);
      });
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  } else {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow) mainWindow.webContents.toggleDevTools();
    });
  }

  mainWindow.webContents.on('render-process-gone', (event, detailed) => {
    console.error('Renderer process gone:', detailed.reason);
  });
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 400,
    height: 300,
    transparent: true,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    overlayWindow.loadURL(`${WEB_URL}/overlay-view`).catch(err => console.error(err));
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html');
    overlayWindow.loadFile(indexPath, { hash: 'overlay-view' }).catch(err => console.error(err));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local SSE / overlay HTTP server
// ─────────────────────────────────────────────────────────────────────────────

function startLocalServer() {
  if (overlayServer) {
    console.log('[Native] Local overlay server is already running.');
    return;
  }

  overlayServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(currentSettings)}\n\n`);
      sseClients.push(res);
      req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
      });
      return;
    }

    // Serve static overlay files & assets
    if (req.url === '/' || req.url === '/index.html') {
      const baseDir = isDev
        ? path.join(__dirname, '../dist') // In dev, we can still serve from local dist if available
        : path.join(app.getAppPath(), 'dist');
      const filePath = path.join(baseDir, 'index.html');
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    if (req.url.startsWith('/overlays/') || req.url.startsWith('/assets/')) {
      const baseDir = isDev
        ? path.join(__dirname, '../dist')
        : path.join(app.getAppPath(), 'dist');

      const filePath = path.join(baseDir, req.url.split('?')[0]);

      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const MIME = {
          '.html': 'text/html',
          '.css':  'text/css',
          '.js':   'text/javascript',
          '.png':  'image/png',
          '.jpg':  'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif':  'image/gif',
          '.svg':  'image/svg+xml',
          '.ico':  'image/x-icon',
          '.mp3':  'audio/mpeg',
          '.wav':  'audio/wav',
        };
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    res.writeHead(404);
    res.end('Not found');
  });

  overlayServer.listen(5555, () => {
    console.log('[Native] Local overlay server running on port 5555');
  });
}

function stopLocalServer() {
  if (overlayServer) {
    overlayServer.close(() => {
      console.log('[Native] Local overlay server stopped.');
      overlayServer = null;
    });
    sseClients.forEach(c => c.end());
    sseClients = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  console.log('App is ready. Registering IPC handlers and creating windows...');

  const settings = loadSettings();
  registerHotkeys(settings);

  // ── TikTok login ──────────────────────────────────────────────────────────
  ipcMain.handle('tiktok:login', async () => {
    console.log('[Native] Received tiktok:login request');
    try {
      return await tiktokAuth.getTikTokSessionId();
    } catch (e) {
      console.error('[Native] TikTok Login Error:', e.message);
      throw e;
    }
  });

  // ── Auth: open external browser for OAuth ────────────────────────────────
  ipcMain.handle('auth:open-external', async (event, url) => {
    await shell.openExternal(url);
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  ipcMain.handle('settings:load', () => loadSettings());

  ipcMain.on('settings:save', (event, settings) => {
    saveSettings(settings);
    registerHotkeys(settings);
    if (settings.winEnabled || settings.spinEnabled) {
      startLocalServer();
    } else {
      stopLocalServer();
    }
  });

  // ── Interactive session ───────────────────────────────────────────────────
  ipcMain.handle('interactive:register-session', async (event, { orderId, username, token }) => {
    try {
      console.log(`[Native] Registering interactive session for ${username} (Order: ${orderId})`);
      const axios = require('axios');
      const response = await axios.post(
        `${PRODUCTION_API_URL}/register`,
        { orderId, username },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      return response.data;
    } catch (error) {
      console.error('[Native] Interactive Registration Error:', error.response?.data || error.message);
      throw error;
    }
  });

  createMainWindow();
  createOverlayWindow();

  // Mac: handle deep link when app already open
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Window controls
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window:maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});
ipcMain.on('window:close', () => { if (mainWindow) mainWindow.close(); });

ipcMain.on('overlay:toggle', () => {
  if (overlayWindow) {
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TikTok connection
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.on('tiktok:connect', async (event, { username, sessionId, idc, token, orderId: passedOrderId }) => {
  tiktokService.stopConnection();

  const orderId = (passedOrderId && passedOrderId !== 'undefined' && passedOrderId !== 'null')
    ? passedOrderId
    : null;

  console.log(`[TikTok] Connecting to ${username} (Order: ${orderId}) with session data...`);

  const middlewareClient = new MiddlewareClient(PRODUCTION_API_URL, token, username, orderId);

  const callbacks = {
    onStatus: (status) => { if (mainWindow) mainWindow.webContents.send('tiktok:status', status); },
    onStats: (stats) => { if (mainWindow) mainWindow.webContents.send('tiktok:stats', stats); },
    onEvent: (eventData) => { if (mainWindow) mainWindow.webContents.send('tiktok:event', eventData); },
  };

  if (orderId) {
    console.log(`[TikTok] Registering orderId: ${orderId}`);
    await middlewareClient.register(orderId);
  } else {
    console.warn('[TikTok] No valid orderId provided for registration');
  }

  tiktokService.startConnection(username, middlewareClient, callbacks, { sessionid: sessionId, idc });
});

ipcMain.on('tiktok:disconnect', () => {
  tiktokService.stopConnection();
  if (mainWindow) mainWindow.webContents.send('tiktok:status', { connected: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// Misc IPC
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('heartbeat:check', () => true);

ipcMain.handle('get-hwid', () => {
  try { return machineIdSync(); } catch { return 'unknown-hwid'; }
});

ipcMain.handle('rcon:send', async (event, { host, port, password, command }) => {
  const rcon = await Rcon.connect({ host, port: parseInt(port), password });
  const response = await rcon.send(command);
  await rcon.end();
  return response;
});

// ─────────────────────────────────────────────────────────────────────────────
// Physical keyboard simulation
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.on('keyboard:press', async (event, keyName) => {
  try {
    console.log(`[Native] Attempting key press: ${keyName}`);

    const parts = keyName.toString().split('+').map(p => p.trim()).filter(Boolean);
    const mainKeyStr = parts[parts.length - 1];
    const modifierStrs = parts.slice(0, parts.length - 1);

    const modifierKeys = modifierStrs
      .map(m => NUT_MODIFIER_MAP[m] ?? NUT_MODIFIER_MAP[m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()])
      .filter(k => k !== undefined);

    const keyToPress = resolveNutKey(mainKeyStr);

    if (keyToPress === undefined) {
      console.warn(`[Native] Key not supported: "${mainKeyStr}" (from "${keyName}")`);
      return;
    }

    if (modifierKeys.length > 0) await keyboard.pressKey(...modifierKeys);
    await keyboard.pressKey(keyToPress);
    await keyboard.releaseKey(keyToPress);
    if (modifierKeys.length > 0) await keyboard.releaseKey(...modifierKeys);

    console.log(`[Native] Successfully pressed: ${keyName}`);
  } catch (error) {
    console.error('[Native] Keyboard Error:', error.message);
  }
});