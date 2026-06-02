const fetch = require('node-fetch');

class MiddlewareClient {
  constructor(serverUrl, token, username, orderId = null) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.token = token;
    this.username = username;
    this.orderId = (orderId && orderId !== 'undefined' && orderId !== 'null') ? orderId : null;
  }

  async _req(method, path, body = null, params = null) {
    let url = `${this.serverUrl}${path}`;
    if (params) {
      url += `?${new URLSearchParams(params).toString()}`;
    }

    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };

    if (body) options.body = JSON.stringify(body);

    let lastError;
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);

        if (response.ok) return await response.json().catch(() => true);

        const text = await response.text();
        const err = new Error(`HTTP ${response.status}: ${text}`);
        err._status = response.status;

        // 401/403 → fatal ไม่ retry
        if (response.status === 401 || response.status === 403) throw err;
        // 4xx อื่น (ไม่ใช่ 408) → หยุด retry
        if (response.status >= 400 && response.status < 500) break;

        lastError = err;
      } catch (err) {
        clearTimeout(timer);
        if (err._status === 401 || err._status === 403) throw err;
        lastError = err;
      }

      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }

    console.error(`Middleware ${method} ${path} failed:`, lastError?.message);
    return false;
  }

  register() {
    return this._req('POST', '/register', {
      username: this.username,
      orderId: this.orderId
    });
  }

  push_event(type, data) {
    return this._req('POST', '/push-event', {
      username: this.username,
      orderId: this.orderId,
      type,
      data
    });
  }

  heartbeat() {
    return this._req('POST', '/heartbeat', {
      username: this.username,
      orderId: this.orderId
    });
  }

  stop() {
    return this._req('DELETE', '/stop', null, { username: this.username });
  }

  close() {}
}

module.exports = { MiddlewareClient };