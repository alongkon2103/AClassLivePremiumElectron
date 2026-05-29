const { WebcastPushConnection } = require('tiktok-live-connector');

let tiktokConnection = null;
let heartbeatTimer = null;
let retryTimer = null;
let isStopping = false;
let retryCount = 0;

const HEARTBEAT_INTERVAL = 30000;
const BASE_RETRY = 10000;
const MAX_RETRY = 60000;

function getRetryDelay() {
  const delay = Math.min(BASE_RETRY * Math.pow(2, retryCount), MAX_RETRY);
  const jitter = Math.random() * 5000;
  retryCount++;
  return delay + jitter;
}

function clearTimers() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

function destroyConnection() {
  if (tiktokConnection) {
    try {
      tiktokConnection.removeAllListeners();
      tiktokConnection.disconnect();
    } catch (e) {}
    tiktokConnection = null;
  }
}

function startConnection(tiktokUsername, middlewareClient, callbacks, sessionData = null) {
  isStopping = false;
  retryCount = 0;

  async function connect() {
    if (isStopping) return;

    clearTimers();
    destroyConnection();

    const options = {
      processInitialData: true,
      enableWebsocketUpgrade: true,
      requestPollingIntervalMs: 2000,
      reconnectEnabled: false,
      clientParams: {
        "app_type": "web",
        "browser_name": "chrome",
        "browser_version": "122.0.0.0",
        "device_platform": "web",
        "device_id": "7" + Math.floor(Math.random() * 1000000000000000000).toString()
      },
      requestOptions: {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Referer": "https://www.tiktok.com/",
          "Accept-Language": "en-US,en;q=0.9,th;q=0.8",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Cache-Control": "max-age=0",
          "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1"
        }
      }
    };

    if (sessionData?.sessionid && sessionData?.idc) {
      options.sessionId = sessionData.sessionid;
      options.ttTargetIdc = sessionData.idc;
      if (!options.requestOptions.headers) options.requestOptions.headers = {};
      options.requestOptions.headers["Cookie"] = `sessionid=${sessionData.sessionid}; tt-target-idc=${sessionData.idc}`;
      console.log('[TikTok Service] Using session cookie ✅');
    }

    console.log('[TikTok] Connecting to username:', tiktokUsername);
    tiktokConnection = new WebcastPushConnection(tiktokUsername, options);

    tiktokConnection.on('connected', (state) => {
      retryCount = 0;
      callbacks.onStatus({ connected: true, roomId: state.roomId });
      middlewareClient.push_event('status', { connected: true }).catch(() => {});
      heartbeatTimer = setInterval(() => {
        middlewareClient.heartbeat().catch(() => {});
      }, HEARTBEAT_INTERVAL);
    });

    tiktokConnection.on('disconnected', () => {
      clearTimers();
      if (!isStopping) {
        const delay = getRetryDelay();
        callbacks.onStatus({ connected: false, info: `Disconnected — retry in ${Math.round(delay / 1000)}s` });
        scheduleRetry(delay);
      }
    });

    tiktokConnection.on('streamEnd', () => {
      callbacks.onStatus({ connected: false, info: 'Stream ended' });
      stopConnection();
    });

    tiktokConnection.on('error', (err) => {
      console.error('[TikTok Error]', err);
      callbacks.onStatus({ connected: false, error: err.message });
      if (!isStopping) {
        clearTimers();
        const delay = getRetryDelay();
        scheduleRetry(delay);
      }
    });

    // ── Gift — แยกออกมาจัดการเอง เพื่อรอ repeatEnd ก่อน push ──
    tiktokConnection.on('gift', (data) => {
      const diamondCount = data.diamondCount || 0;

      // push เฉพาะตอน streak จบ (repeatEnd) หรือของขวัญที่ไม่มี streak
      if (data.repeatEnd || diamondCount > 0) {
        const eventData = {
          giftId: data.giftId,
          giftName: data.giftName,
          username: data.uniqueId,
          nickname: data.nickname,
          diamond: diamondCount,
          diamondCount: diamondCount,
          repeatCount: data.repeatCount || 1,
          totalValue: diamondCount * (data.repeatCount || 1),
          repeatEnd: data.repeatEnd,
          profilePictureUrl: data.profilePictureUrl,
          timestamp: new Date().toISOString()
        };

        // ถ้ามี streak ให้รอ repeatEnd เท่านั้น
        if (data.giftType === 1 && !data.repeatEnd) return;

        middlewareClient.push_event('gift', eventData).catch(() => {});
        callbacks.onEvent({ type: 'gift', data: eventData });
      }
    });

    // ── Events อื่นๆ (ไม่รวม gift) ──
    const events = ['chat', 'like', 'social', 'roomUser'];
    events.forEach(eventType => {
      tiktokConnection.on(eventType, (data) => {
        if (data.viewerCount !== undefined || data.totalLikeCount !== undefined) {
          callbacks.onStats({
            viewerCount: data.viewerCount || 0,
            likeCount: data.totalLikeCount || 0
          });
        }
        middlewareClient.push_event(eventType, data).catch(() => {});
        callbacks.onEvent({ type: eventType, data });
      });
    });

    try {
      await tiktokConnection.connect();
    } catch (err) {
      if (!isStopping) {
        const delay = getRetryDelay();
        callbacks.onStatus({ connected: false, error: err.message });
        scheduleRetry(delay);
      }
    }
  }

  function scheduleRetry(delay) {
    if (isStopping) return;
    retryTimer = setTimeout(connect, delay);
  }

  connect();
}

function stopConnection() {
  isStopping = true;
  clearTimers();
  destroyConnection();
}

module.exports = { startConnection, stopConnection };