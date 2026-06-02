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
    if (mainWindow) {
      mainWindow.webContents.send('auth:callback', { token, user, error });
    }
  } catch (e) {
    console.error('[DeepLink] Failed to parse URL:', e.message);
  }
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

const dotEnvPath = path.join(__dirname, '../.env');
if (fs.existsSync(dotEnvPath)) {
  require('dotenv').config({ path: dotEnvPath });
}

const WEB_URL = process.env.WEB_URL || 'https://app.aclassstore.com';
const PRODUCTION_API_URL = process.env.PRODUCTION_API_URL || 'https://api.aclassstore.com';
const BACKEND_API_URL = process.env.BACKEND_API_URL || 'https://backend.aclassstore.com';

const { machineIdSync } = require('node-machine-id');
const { Rcon } = require('rcon-client');
const { autoUpdater } = require('electron-updater');
const tiktokAuth = require('./tiktokAuth');
const { MiddlewareClient } = require('./middlewareClient');
const tiktokService = require('./tiktokService');

let mainWindow;
let overlayWindow;
let tiktokConnection;
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
// uiohook-napi — passive global hotkey listener (does NOT steal keys)
//
// HOW IT WORKS:
//   uiohook fires a keydown event with { keycode, ctrlKey, altKey, shiftKey, metaKey }.
//   We log that keycode once per unique key press during a short "learn" phase
//   when the app first starts, building a name→keycode table dynamically.
//
//   But since we can't know ALL keycodes in advance, we use a two-layer approach:
//
//   1. On every keydown, we forward { keycode, label } to the renderer via
//      'hotkey:rawkey' so the UI can capture it when the user is assigning a key.
//
//   2. Settings still store hotkeys as STRINGS (e.g. "ArrowUp", "Numpad7").
//      We maintain a learned name→keycode map that grows as keys are pressed.
//      When registering, if we already know the keycode for that name we use it;
//      otherwise we register a pending binding that matches as soon as we see
//      the right keycode come through.
//
//   This keeps 100% backward compatibility with existing settings.
// ─────────────────────────────────────────────────────────────────────────────

let uiohook = null;
let uiohookRunning = false;

// name (lowercase) → keycode  — populated at runtime as keys are pressed
const learnedKeycodes = new Map();

// Modifier keycodes — same across all platforms for uiohook-napi
const MODIFIER_KEYCODES = new Set([
  0x001D, 0x011D,  // Ctrl L/R
  0x002A, 0x0036,  // Shift L/R
  0x0038, 0x0138,  // Alt L/R
  0x015B, 0x015C,  // Win/Cmd L/R
  0xE05B, 0xE05C,  // Mac Cmd (some versions)
]);

// ── Static seed table ────────────────────────────────────────────────────────
// Built from empirical uiohook-napi values on Windows and macOS.
// Extended nav keys are reported as large decimal numbers by uiohook on Windows.
// We seed the map so we work even before the user presses those keys once.
const SEED_KEYCODE_MAP = {
  // Arrow keys (Windows extended scancode as reported by uiohook-napi)
  'arrowup': 57416, 'arrowdown': 57424,
  'arrowleft': 57419, 'arrowright': 57421,
  'up': 57416, 'down': 57424,
  'left': 57419, 'right': 57421,
  // Home/End/PgUp/PgDn/Ins/Del (Windows extended)
  'home': 57415, 'end': 57423,
  'pageup': 57417, 'pagedown': 57425,
  'insert': 57426, 'delete': 57427,
  // Function keys (HID scan codes — same Win/Mac in uiohook-napi)
  'f1': 0x003B, 'f2': 0x003C, 'f3': 0x003D, 'f4': 0x003E,
  'f5': 0x003F, 'f6': 0x0040, 'f7': 0x0041, 'f8': 0x0042,
  'f9': 0x0043, 'f10': 0x0044, 'f11': 0x0057, 'f12': 0x0058,
  // Numpad digits
  'numpad0': 0x0052, 'numpad1': 0x004F, 'numpad2': 0x0050, 'numpad3': 0x0051,
  'numpad4': 0x004B, 'numpad5': 0x004C, 'numpad6': 0x004D,
  'numpad7': 0x0047, 'numpad8': 0x0048, 'numpad9': 0x0049,
  'num0': 0x0052, 'num1': 0x004F, 'num2': 0x0050, 'num3': 0x0051,
  'num4': 0x004B, 'num5': 0x004C, 'num6': 0x004D,
  'num7': 0x0047, 'num8': 0x0048, 'num9': 0x0049,
  // Numpad operators
  'numpadadd': 0x004E, 'numpadsubtract': 0x004A,
  'numpadmultiply': 0x0037, 'numpaddivide': 0x0135,
  'numpaddecimal': 0x0053, 'numpadenter': 0x011C,
  'numadd': 0x004E, 'numsub': 0x004A,
  'nummult': 0x0037, 'numdiv': 0x0135,
  'numdec': 0x0053,
  // Common keys
  'enter': 0x001C, 'return': 0x001C,
  'backspace': 0x000E, 'tab': 0x000F,
  'escape': 0x0001, 'esc': 0x0001,
  'space': 0x0039,
  // Letters (HID scan codes)
  'a': 0x001E, 'b': 0x0030, 'c': 0x002E, 'd': 0x0020, 'e': 0x0012,
  'f': 0x0021, 'g': 0x0022, 'h': 0x0023, 'i': 0x0017, 'j': 0x0024,
  'k': 0x0025, 'l': 0x0026, 'm': 0x0032, 'n': 0x0031, 'o': 0x0018,
  'p': 0x0019, 'q': 0x0010, 'r': 0x0013, 's': 0x001F, 't': 0x0014,
  'u': 0x0016, 'v': 0x002F, 'w': 0x0011, 'x': 0x002D, 'y': 0x0015,
  'z': 0x002C,
  // Digit row
  '0': 0x000B, '1': 0x0002, '2': 0x0003, '3': 0x0004, '4': 0x0005,
  '5': 0x0006, '6': 0x0007, '7': 0x0008, '8': 0x0009, '9': 0x000A,
};

// Seed learned map from static table
for (const [name, code] of Object.entries(SEED_KEYCODE_MAP)) {
  learnedKeycodes.set(name, code);
}

// Reverse map: keycode → name (for labelling incoming keys)
const keycodeToName = new Map();
for (const [name, code] of Object.entries(SEED_KEYCODE_MAP)) {
  if (!keycodeToName.has(code)) keycodeToName.set(code, name);
}

/**
 * Parse a settings hotkey string into { keycode, ctrlKey, altKey, shiftKey, metaKey }.
 * Returns null if we cannot resolve the key name to a keycode yet.
 *
 * Accepted formats (same as what the renderer stores):
 *   "ArrowUp"
 *   "Numpad7"
 *   "F11"
 *   "CommandOrControl+Z"
 *   "Ctrl+Shift+A"
 */
function parseHotkeyString(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split('+').map(p => p.trim()).filter(Boolean);

  let ctrlKey = false, altKey = false, shiftKey = false, metaKey = false;
  let mainName = null;

  for (const part of parts) {
    const lo = part.toLowerCase();
    if (lo === 'ctrl' || lo === 'control' || lo === 'commandorcontrol' || lo === 'command' || lo === 'cmd') {
      ctrlKey = true;
    } else if (lo === 'alt' || lo === 'option') {
      altKey = true;
    } else if (lo === 'shift') {
      shiftKey = true;
    } else if (lo === 'meta' || lo === 'super' || lo === 'win') {
      metaKey = true;
    } else {
      mainName = lo;
    }
  }

  if (!mainName) return null;

  const keycode = learnedKeycodes.get(mainName);
  if (keycode === undefined) {
    console.warn('[uiohook] Unknown key name, cannot resolve keycode:', mainName);
    return null;
  }

  return { keycode, ctrlKey, altKey, shiftKey, metaKey };
}

// fingerprint string for fast comparison
function fingerprint(keycode, ctrlKey, altKey, shiftKey, metaKey) {
  return `${keycode}:${ctrlKey ? 1 : 0}:${altKey ? 1 : 0}:${shiftKey ? 1 : 0}:${metaKey ? 1 : 0}`;
}

// Active bindings: Map<fingerprint, { action, val }>
let activeBindings = new Map();

function registerHotkeys(settings) {
  activeBindings.clear();
  // Only keep the DevTools shortcut in globalShortcut; clear everything else
  // We don't call globalShortcut.unregisterAll() so DevTools stays registered
  if (!settings || (!settings.winEnabled && !settings.spinEnabled)) return;

  const hotkeys = settings.hotkeys || {};

  const bind = (keyDef, action, val) => {
    if (!keyDef) return;
    // keyDef is always a string from existing settings
    const key = typeof keyDef === 'string' ? keyDef : keyDef.key ?? keyDef.label ?? String(keyDef);
    const parsed = parseHotkeyString(key);
    if (!parsed) return;
    const fp = fingerprint(parsed.keycode, parsed.ctrlKey, parsed.altKey, parsed.shiftKey, parsed.metaKey);
    activeBindings.set(fp, { action, val });
  };

  bind(hotkeys.win, 'hotkey:win-adjust', 1);
  bind(hotkeys.undo, 'hotkey:win-adjust', -1);
  bind(hotkeys.reset, 'hotkey:win-adjust', 'reset');
  bind(hotkeys.spin, 'hotkey:spin-trigger', true);
  if (hotkeys.custom1) bind(hotkeys.custom1.key, 'hotkey:win-adjust', hotkeys.custom1.value);
  if (hotkeys.custom2) bind(hotkeys.custom2.key, 'hotkey:win-adjust', hotkeys.custom2.value);
  if (hotkeys.custom3) bind(hotkeys.custom3.key, 'hotkey:win-adjust', hotkeys.custom3.value);

  console.log('[uiohook] Registered', activeBindings.size, 'hotkey(s)');
}

function startUiohook() {
  if (uiohookRunning) return;
  try {
    const { uIOhook } = require('uiohook-napi');
    uiohook = uIOhook;

    uiohook.on('keydown', (e) => {
      const { keycode, ctrlKey, altKey, shiftKey, metaKey } = e;
      if (MODIFIER_KEYCODES.has(keycode)) return;

      // Learn: update reverse map
      const knownName = keycodeToName.get(keycode);

      // Forward raw event to renderer (for hotkey assignment UI)
      if (mainWindow) {
        mainWindow.webContents.send('hotkey:rawkey', {
          keycode,
          ctrlKey, altKey, shiftKey, metaKey,
          label: knownName ?? `key_${keycode}`,
        });
      }

      // Check active bindings
      const fp = fingerprint(keycode, ctrlKey, altKey, shiftKey, metaKey);
      const binding = activeBindings.get(fp);
      if (binding) {
        if (mainWindow) mainWindow.webContents.send(binding.action, binding.val);
        if (overlayWindow) overlayWindow.webContents.send(binding.action, binding.val);
      }
    });

    uiohook.start();
    uiohookRunning = true;
    console.log('[uiohook] Started passive global hotkey listener');
  } catch (e) {
    console.error('[uiohook] Failed to load uiohook-napi, falling back to globalShortcut:', e.message);
    uiohook = null;
  }
}

function stopUiohook() {
  if (uiohook && uiohookRunning) {
    try { uiohook.stop(); } catch (_) { }
    uiohookRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// globalShortcut fallback (used only when uiohook-napi is unavailable)
// ─────────────────────────────────────────────────────────────────────────────
function normalizeHotkey(key) {
  if (!key) return null;
  let normalized = key.toString().trim();
  const lower = normalized.toLowerCase();
  if (lower.startsWith('numpad')) {
    const code = lower.replace('numpad', '');
    const numMap = {
      '0': 'num0', '1': 'num1', '2': 'num2', '3': 'num3', '4': 'num4',
      '5': 'num5', '6': 'num6', '7': 'num7', '8': 'num8', '9': 'num9',
      'add': 'numadd', 'subtract': 'numsub', 'multiply': 'nummult',
      'divide': 'numdiv', 'decimal': 'numdec', 'enter': 'enter',
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
  return normalized;
}

function registerHotkeysFallback(settings) {
  globalShortcut.unregisterAll();
  if (!settings || (!settings.winEnabled && !settings.spinEnabled)) return;
  const hotkeys = settings.hotkeys || {};
  const bind = (key, action, val) => {
    const normalized = normalizeHotkey(typeof key === 'string' ? key : key?.key);
    if (!normalized) return;
    try {
      globalShortcut.register(normalized, () => {
        if (mainWindow) mainWindow.webContents.send(action, val);
        if (overlayWindow) overlayWindow.webContents.send(action, val);
      });
    } catch (err) {
      console.error('[globalShortcut] Failed to register:', normalized, err.message);
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

function broadcastSettings(settings) {
  currentSettings = settings;
  sseClients.forEach(client => {
    try { client.write(`data: ${JSON.stringify(settings)}\n\n`); } catch (e) { }
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
  } catch (error) { }
  return { winEnabled: false, spinEnabled: false };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    if (mainWindow) mainWindow.webContents.send('settings:update', settings);
    if (overlayWindow) overlayWindow.webContents.send('settings:update', settings);
    broadcastSettings(settings);
  } catch (error) { }
}

const NUT_KEY_MAP = {
  Space: Key.Space, Enter: Key.Enter, Return: Key.Enter, Escape: Key.Escape, Esc: Key.Escape, Tab: Key.Tab,
  Backspace: Key.Backspace, Delete: Key.Delete, Insert: Key.Insert, Home: Key.Home, End: Key.End,
  PageUp: Key.PageUp, PageDown: Key.PageDown, ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
  Up: Key.Up, Down: Key.Down, Left: Key.Left, Right: Key.Right,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6, F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  Num0: Key.Num0, Num1: Key.Num1, Num2: Key.Num2, Num3: Key.Num3, Num4: Key.Num4, Num5: Key.Num5, Num6: Key.Num6, Num7: Key.Num7, Num8: Key.Num8, Num9: Key.Num9,
  NumAdd: Key.Add, NumSubtract: Key.Subtract, NumMultiply: Key.Multiply, NumDivide: Key.Divide, NumDecimal: Key.Decimal, NumEnter: Key.Enter,
  NumpadEnter: Key.Enter, NumpadAdd: Key.Add, NumpadSubtract: Key.Subtract, NumpadMultiply: Key.Multiply, NumpadDivide: Key.Divide, NumpadDecimal: Key.Decimal,
};

const NUT_MODIFIER_MAP = {
  Ctrl: Key.LeftControl, Control: Key.LeftControl, Shift: Key.LeftShift, Alt: Key.LeftAlt, Option: Key.LeftAlt,
  Cmd: Key.LeftCmd, Command: Key.LeftCmd, Meta: isMac ? Key.LeftCmd : Key.LeftWin, Win: Key.LeftWin, Super: isWin ? Key.LeftWin : Key.LeftCmd,
};

const MAC_OPTION_CHARS = {
  'ƒ': 'f', '≈': 'x', '∂': 'd', '©': 'c', '√': 'v', 'å': 'a', 'ß': 's', '†': 't', '¬': 'l', 'œ': 'q',
  'ø': 'o', 'π': 'p', '¥': 'y', '"': 'g', 'µ': 'm', '∑': 'w', '´': 'e', '®': 'r', '¨': 'u', 'ˆ': 'i',
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
  if (keyStr.length === 1 && /[0-9]/.test(keyStr)) return Key[`Num${keyStr}`];
  const numpadMatch = keyStr.match(/^[Nn]umpad(\w+)$/);
  if (numpadMatch) {
    const sub = numpadMatch[1];
    const candidate = NUT_KEY_MAP[`Numpad${sub}`] ?? NUT_KEY_MAP[`Num${sub}`];
    if (candidate !== undefined) return candidate;
  }
  return Key[keyStr];
}

function createMainWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  mainWindow = new BrowserWindow({
    width: 1500, height: 900, minWidth: 1100, minHeight: 680, frame: false, show: false, backgroundColor: '#000000',
    webPreferences: {
      preload: preloadPath, nodeIntegration: false, contextIsolation: true,
      sandbox: false, webSecurity: false, allowRunningInsecureContent: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    if (overlayWindow) overlayWindow.destroy();
    mainWindow = null;
    app.quit();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  mainWindow.loadURL(WEB_URL).catch(() => {
    const indexPath = path.join(__dirname, '../dist/index.html');
    if (fs.existsSync(indexPath)) mainWindow.loadFile(indexPath);
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  } else {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow) mainWindow.webContents.toggleDevTools();
    });
  }
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 400, height: 300, transparent: true, alwaysOnTop: true, frame: false, resizable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  if (isDev) {
    overlayWindow.loadURL(`${WEB_URL}/overlay-view`).catch(() => { });
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html');
    overlayWindow.loadFile(indexPath, { hash: 'overlay-view' }).catch(() => { });
  }
}

function startLocalServer() {
  if (overlayServer) return;
  overlayServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const urlPath = req.url.split('?')[0];
    if (urlPath === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',                    // ✅ มีอยู่แล้ว
        'Access-Control-Allow-Credentials': 'true',            // ✅ เพิ่ม
        'X-Accel-Buffering': 'no',                            // ✅ เพิ่ม
      });
      res.write(`data: ${JSON.stringify(currentSettings)}\n\n`);
      sseClients.push(res);
      req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
      return;
    }

    const baseDir = isDev
      ? path.join(__dirname, '../dist')
      : path.join(process.resourcesPath, 'app.asar/dist');
    let filePath = path.join(baseDir, urlPath);
    if (urlPath === '/' || urlPath === '/index.html' || !fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
      if (urlPath !== '/' && urlPath !== '/index.html' && path.extname(urlPath)) {
        res.writeHead(404); res.end(); return;
      }
      filePath = path.join(baseDir, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const MIME = {
        '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
        '.json': 'application/json; charset=utf-8',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      };
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    res.writeHead(404); res.end();
  });
  overlayServer.listen(5555, '0.0.0.0');
}

function stopLocalServer() {
  if (overlayServer) {
    overlayServer.close(() => { overlayServer = null; });
    sseClients.forEach(c => c.end());
    sseClients = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App bootstrap
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startUiohook();

  const settings = loadSettings();

  if (uiohookRunning) {
    registerHotkeys(settings);
  } else {
    registerHotkeysFallback(settings);
  }

  ipcMain.handle('tiktok:login', async () => {
    try { return await tiktokAuth.getTikTokSessionId(); } catch (e) { throw e; }
  });
  ipcMain.handle('auth:open-external', async (event, url) => { await shell.openExternal(url); });
  ipcMain.handle('settings:load', () => loadSettings());

  ipcMain.on('settings:save', (event, newSettings) => {
    saveSettings(newSettings);
    if (uiohookRunning) {
      registerHotkeys(newSettings);
    } else {
      registerHotkeysFallback(newSettings);
    }
    if (newSettings.winEnabled || newSettings.spinEnabled) startLocalServer();
    else stopLocalServer();
  });

  ipcMain.handle('interactive:register-session', async (event, { orderId, username, token }) => {
    const axios = require('axios');
    const response = await axios.post(
      `${BACKEND_API_URL}/interactive/register-session`,
      { orderId, username },
      { headers: { 'Authorization': `Bearer ${token}` }, timeout: 10000 }
    );
    return response.data;
  });

  ipcMain.handle('hotkey:uiohookAvailable', () => uiohookRunning);

  createMainWindow();
  createOverlayWindow();

  if (settings.winEnabled || settings.spinEnabled) startLocalServer();

  app.on('open-url', (event, url) => { event.preventDefault(); handleDeepLink(url); });
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => {
  stopUiohook();
  globalShortcut.unregisterAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Window controls
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window:maximize', () => {
  if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.on('overlay:toggle', () => {
  if (overlayWindow) overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
});

// ─────────────────────────────────────────────────────────────────────────────
// TikTok
// ─────────────────────────────────────────────────────────────────────────────
let isStarting = false;

ipcMain.on('tiktok:connect', async (event, { username, sessionId, idc, token, orderId: passedOrderId }) => {
  if (isStarting) {
    console.log('[TikTok] Ignoring duplicate connect request');
    return;
  }
  isStarting = true;

  try {
    tiktokService.stopConnection();
    const orderId = (passedOrderId && passedOrderId !== 'undefined' && passedOrderId !== 'null') 
      ? passedOrderId : null;
    
    // Improved MiddlewareClient from stable project
    const middlewareClient = new MiddlewareClient(PRODUCTION_API_URL, token, username, orderId);

    const send = (channel, data) => {
      if (mainWindow) mainWindow.webContents.send(channel, data);
      if (overlayWindow) overlayWindow.webContents.send(channel, data);
      
      // Also broadcast via SSE for external browser sources (OBS)
      if (sseClients.length > 0) {
        sseClients.forEach(client => {
          try { client.write(`data: ${JSON.stringify({ type: channel, ...data })}\n\n`); } catch (e) { }
        });
      }
    };

    const callbacks = {
      onStatus: (connected, message, state = null) => {
        console.log(`[IPC] Sending Status: ${connected} - ${message}`);
        send('tiktok:status', { connected, message, state: state || (connected ? 'LIVE' : 'OFFLINE') });
      },
      onStats:   (data) => {
        console.log(`[IPC] Sending Stats:`, data);
        send('tiktok:stats',  data);
      },
      onGift:    (data) => {
        console.log(`[IPC] Sending Gift: ${data.giftName} x${data.repeatCount}`);
        send('tiktok:gift',   data);
      },
      onChat:    (data) => {
        console.log(`[IPC] Sending Chat: @${data.uniqueId || data.username}`);
        send('tiktok:chat',   data);
      },
      onLike:    (data) => {
        console.log(`[IPC] Sending Like: ${data.likeCount}`);
        send('tiktok:like',   data);
        if (data.totalLikeCount !== undefined) {
          send('tiktok:stats', { likeCount: data.totalLikeCount });
        }
      },
      onFollow:  (data) => {
        console.log(`[IPC] Sending Follow: @${data.uniqueId || data.username}`);
        send('tiktok:follow', data);
      },
      onError: async (message) => {
        // Ignore "Unexpected server response: 200" as it's a non-fatal fallback message
        if (message.includes('Unexpected server response: 200')) {
          return;
        }

        const isFatal = 
          (message.includes('401') || 
           message.includes('unauthorized') ||
           message.includes('UNAUTHORIZED') ||
           message.includes('sessionid is invalid')) &&
          !message.includes('falling back');

        if (isFatal) {
          console.warn('[TikTok] Fatal session error detected, re-logging...');
          tiktokAuth.clearSessionId();
          tiktokService.stopConnection();

          try {
            send('tiktok:status', { connected: false, message: 'Session หมดอายุ กำลัง login ใหม่...', state: 'WAIT' });
            const newSession = await tiktokAuth.getTikTokSessionId();
            tiktokService.startConnection(username, middlewareClient, callbacks, newSession);
          } catch (err) {
            send('tiktok:status', { connected: false, message: 'Login ไม่สำเร็จ กรุณา connect ใหม่', state: 'OFFLINE' });
          }
          return;
        }

        if (mainWindow) mainWindow.webContents.send('tiktok:error', message);
      }
    };

    if (orderId) {
      try {
        const registered = await middlewareClient.register();
        if (!registered) {
          send('tiktok:status', { connected: false, message: 'Connection rejected by server (Token revoked)', state: 'OFFLINE' });
          return;
        }
        console.log('[Middleware] Register OK:', orderId);
      } catch (e) {
        console.error('[Middleware] Register FAILED:', e.message);
        return;
      }
      
    }

    // Try to get session if not provided or invalid
    let sessionToUse = (sessionId && idc) ? { sessionid: sessionId, idc } : null;
    if (!sessionToUse) {
      try {
        sessionToUse = await tiktokAuth.getOrRequestSessionId();
      } catch (e) {
        console.warn('[TikTok] No session found, connecting as guest');
      }
    }

    tiktokService.startConnection(username, middlewareClient, callbacks, sessionToUse);
  } finally {
    isStarting = false;
  }
});

ipcMain.on('tiktok:disconnect', () => {
  tiktokService.stopConnection();
  if (mainWindow) mainWindow.webContents.send('tiktok:status', { connected: false, message: 'Disconnected', state: 'OFFLINE' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Misc IPC
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('heartbeat:check', () => true);
ipcMain.handle('get-hwid', () => { try { return machineIdSync(); } catch { return 'unknown-hwid'; } });

ipcMain.handle('rcon:send', async (event, { host, port, password, command }) => {
  const rcon = await Rcon.connect({ host, port: parseInt(port), password });
  const response = await rcon.send(command);
  await rcon.end();
  return response;
});

ipcMain.on('keyboard:press', async (event, keyName) => {
  try {
    const parts = keyName.toString().split('+').map(p => p.trim()).filter(Boolean);
    const mainKeyStr = parts[parts.length - 1];
    const modifierStrs = parts.slice(0, parts.length - 1);
    const modifierKeys = modifierStrs
      .map(m => NUT_MODIFIER_MAP[m] ?? NUT_MODIFIER_MAP[m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()])
      .filter(k => k !== undefined);
    const keyToPress = resolveNutKey(mainKeyStr);
    if (keyToPress === undefined) return;
    if (modifierKeys.length > 0) await keyboard.pressKey(...modifierKeys);
    await keyboard.pressKey(keyToPress);
    await keyboard.releaseKey(keyToPress);
    if (modifierKeys.length > 0) await keyboard.releaseKey(...modifierKeys);
  } catch (error) { }
});



