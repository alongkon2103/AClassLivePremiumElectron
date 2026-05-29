const axios = require('axios');

class MiddlewareClient {
  constructor(serverUrl, token, username, orderId = null) {
    this.serverUrl = serverUrl.replace(/\/$/, '') + '/';
    this.token = token;
    this.username = username;
    this.orderId = (orderId && orderId !== 'undefined' && orderId !== 'null') ? orderId : null;
    this.lastRegister = 0; // Cache time
    this.lastRegisterId = null;
    
    this.api = axios.create({
      baseURL: this.serverUrl,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
  }

  async _req(method, path, body = null, params = null) {
    let lastError;
    const cleanPath = path.replace(/^\//, '');
    for (let i = 0; i < 3; i++) {
      try {
        const response = await this.api.request({
          method,
          url: cleanPath,
          data: body,
          params
        });
        return response.data || true;
      } catch (err) {
        lastError = err;
        // Only retry on server errors (5xx) or network issues
        if (err.response && err.response.status < 500 && err.response.status !== 408) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
      }
    }
    console.error(`[Middleware] ${method} ${path} failed:`, lastError.message);
    return false;
  }

  async register(orderId = null, force = false) {
    const finalOrderId = orderId || this.orderId;
    
    // Cache logic: skip if same ID/User and registered < 45s ago
    const now = Date.now();
    if (!force && 
        this.lastRegisterId === finalOrderId && 
        (now - this.lastRegister < 45000)) {
      return true; 
    }

    const result = await this._req('POST', 'register', { 
      username: this.username,
      orderId: finalOrderId 
    });

    if (result) {
      this.lastRegister = now;
      this.lastRegisterId = finalOrderId;
    }
    return result;
  }

  push_event(type, data) {
    return this._req('POST', 'push-event', { 
      username: this.username, 
      type: type, 
      data: data 
    });
  }

  heartbeat() {
    return this._req('POST', 'heartbeat', { username: this.username });
  }

  stop() {
    return this._req('DELETE', 'stop', null, { username: this.username });
  }
}

module.exports = { MiddlewareClient };
