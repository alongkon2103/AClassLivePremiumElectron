const { WebcastPushConnection } = require('tiktok-live-connector');

let tiktokConnection = null;
let heartbeatTimer = null;
let retryTimer = null;
let isStopping = false;
let retryCount = 0;
let isLive = false;

const HEARTBEAT_INTERVAL = 15000;
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
    } catch (e) { }
    tiktokConnection = null;
  }
}

function startConnection(tiktokUsername, middlewareClient, callbacks, sessionData = null) {
  isStopping = false;
  retryCount = 0;
  isLive = false;

  console.log('[TikTok Service] sessionData:', sessionData);

  async function connect() {
    if (isStopping) return;

    clearTimers();
    destroyConnection();

    const options = {
      processInitialData: true,
      enableWebsocketUpgrade: true,
      requestPollingIntervalMs: 2000,
      reconnectEnabled: false,
    };

    if (sessionData?.sessionid && sessionData?.idc) {
      options.sessionId = sessionData.sessionid;
      options.ttTargetIdc = sessionData.idc;
    }

    console.log('[TikTok] Connecting to username:', tiktokUsername);
    tiktokConnection = new WebcastPushConnection(tiktokUsername, options);

    const setLive = () => {
      if (!isLive) {
        isLive = true;
        console.log('[TikTok] Switching to LIVE state');
        callbacks.onStatus(true, `Live @${tiktokUsername}`, 'LIVE');
        middlewareClient.push_event('status', { connected: true }).catch(() => { });

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          middlewareClient.heartbeat().catch(() => { });
        }, HEARTBEAT_INTERVAL);
      }
    };

    tiktokConnection.on('connected', () => {
      console.log('[TikTok] Connected event');
      retryCount = 0;
      setLive();
    });

    tiktokConnection.on('disconnected', () => {
      console.log('[TikTok] Disconnected event');
      isLive = false;
      clearTimers();
      if (!isStopping) {
        const delay = getRetryDelay();
        callbacks.onStatus(false, `Disconnected — retry in ${Math.round(delay / 1000)}s`, 'WAIT');
        scheduleRetry(delay);
      }
    });

    tiktokConnection.on('streamEnd', () => {
      console.log('[TikTok] Stream ended');
      isLive = false;
      callbacks.onStatus(false, 'Stream ended', 'OFFLINE');
      stopConnection();
    });

    tiktokConnection.on('error', (err) => {
      const errMsg = typeof err === 'string' ? err : err?.message || err?.info || JSON.stringify(err);

      // Non-fatal: websocket upgrade fallback
      if (errMsg.includes('200') || errMsg.includes('falling back')) {
        console.log('[TikTok] Non-fatal info:', errMsg);
        return;
      }

      // ถ้า live อยู่แล้ว error เหล่านี้เป็น noise จาก WS upgrade — ignore
      if (isLive) {
        console.log('[TikTok] Error ignored (already live):', errMsg);
        return;
      }

      console.log('[TikTok Error]', errMsg);
      callbacks.onError?.(errMsg);

      if (!isStopping) {
        clearTimers();
        const delay = getRetryDelay();
        callbacks.onStatus(false, `Error — retry in ${Math.round(delay / 1000)}s`, 'WAIT');
        scheduleRetry(delay);
      }
    });

    tiktokConnection.on('gift', (data) => {
      setLive();
      const diamondCount = data.diamondCount || 0;
      if (diamondCount > 0 || data.repeatEnd) {
        const eventData = {
          id: data.msgId || `${Date.now()}-${Math.random()}`,
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
        middlewareClient.push_event('gift', eventData)
          .then(result => {
            if (!result || result.pushed === false) return;
            callbacks.onGift(eventData);
          })
          .catch(err => console.error('[PUSH_EVENT ERROR]', err?.message || err));
      }
    });

    tiktokConnection.on('chat', (data) => {
      setLive();
      const chatData = {
        username: data.uniqueId,
        nickname: data.nickname,
        comment: data.comment,
        profilePictureUrl: data.profilePictureUrl
      };
      callbacks.onChat?.(chatData);
      middlewareClient.push_event('chat', chatData).catch(() => { });
    });

    tiktokConnection.on('like', (data) => {
      setLive();
      const likeData = {
        username: data.uniqueId,
        nickname: data.nickname,
        likeCount: data.likeCount || 1,
        totalLikeCount: data.totalLikeCount,
        profilePictureUrl: data.profilePictureUrl
      };
      callbacks.onLike?.(likeData);
      middlewareClient.push_event('like', likeData).catch(() => { });
    });

    const handleFollow = (data) => {
      setLive();
      const followData = {
        username: data.uniqueId,
        nickname: data.nickname,
        profilePictureUrl: data.profilePictureUrl
      };
      console.log('[TikTok] Follow Event detected from:', followData.username);
      callbacks.onFollow?.(followData);
      middlewareClient.push_event('follow', followData).catch(() => { });
    };

    tiktokConnection.on('follow', handleFollow);
    tiktokConnection.on('social', (data) => {
      if (data.displayType === 'follow' || data.label?.includes('followed')) {
        handleFollow(data);
      }
    });

    tiktokConnection.on('roomUser', (data) => {
      if (data.viewerCount !== undefined) {
        callbacks.onStats?.({ viewerCount: data.viewerCount });
      }
    });

    try {
      await tiktokConnection.connect();
    } catch (err) {
      const msg = err?.message || err?.info || (typeof err === 'string' ? err : JSON.stringify(err)) || 'Unknown error';
      console.log('[TikTok Connect Exception]', msg);
      // ไม่ retry ตรงนี้ — ปล่อยให้ disconnected event จัดการ
    }
  }

  function scheduleRetry(delay) {
    if (isStopping || isLive) return;
    retryTimer = setTimeout(connect, delay);
  }

  connect();
}

function stopConnection() {
  isStopping = true;
  isLive = false;
  clearTimers();
  destroyConnection();
}

module.exports = { startConnection, stopConnection };