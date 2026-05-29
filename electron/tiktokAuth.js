const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');

function getStorePath() {
  return path.join(app.getPath('userData'), 'tiktok_session.json');
}

function saveSessionId(sessionid, idc) {
  fs.writeFileSync(getStorePath(), JSON.stringify({ sessionid, idc }), 'utf-8');
}

function loadSessionId() {
  try {
    const data = JSON.parse(fs.readFileSync(getStorePath(), 'utf-8'));
    if (data.sessionid && data.idc) return data;
    return null;
  } catch (e) {
    return null;
  }
}

// ✅ เพิ่ม clearSessionId กลับมา
function clearSessionId() {
  try { fs.unlinkSync(getStorePath()); } catch (e) { }
}

function getTikTokSessionId() {
  return new Promise((resolve, reject) => {
    if (!app.isReady()) {
      return reject(new Error('App not ready'));
    }

    let win = new BrowserWindow({
      width: 500,
      height: 700,
      title: 'Login TikTok',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      }
    });

    win.loadURL('https://www.tiktok.com/login');

    let resolved = false;

    const checkCookie = setInterval(async () => {
      if (!win || win.isDestroyed()) {
        clearInterval(checkCookie);
        if (!resolved) reject(new Error('Window closed'));
        return;
      }

      try {
        const cookies = await win.webContents.session.cookies.get({
          url: 'https://www.tiktok.com',
        });

        console.log('[Cookies found]', cookies.map(c => c.name));

        const sessionCookie = cookies.find(c => c.name === 'sessionid');
        const idcCookie = cookies.find(c => c.name === 'tt-target-idc');

        console.log('[sessionid]', sessionCookie?.value ? 'found' : 'not found');
        console.log('[tt-target-idc]', idcCookie?.value ? 'found' : 'not found');

        if (sessionCookie?.value && idcCookie?.value) {
          resolved = true;
          clearInterval(checkCookie);
          saveSessionId(sessionCookie.value, idcCookie.value);
          win.destroy();
          win = null;
          resolve({ sessionid: sessionCookie.value, idc: idcCookie.value });
        }
      } catch (e) {
        clearInterval(checkCookie);
        if (!resolved) reject(new Error('Cookie read failed'));
      }
    }, 2000);

    win.on('closed', () => {
      clearInterval(checkCookie);
      if (!resolved) reject(new Error('User closed login window'));
    });
  });
}

// ✅ เหลืออันเดียว
async function getOrRequestSessionId() {
  const saved = loadSessionId();
  if (saved) {
    console.log('[TikTok Auth] Using saved sessionid');
    return saved;
  }
  return await getTikTokSessionId();
}

module.exports = { getTikTokSessionId, getOrRequestSessionId, clearSessionId };