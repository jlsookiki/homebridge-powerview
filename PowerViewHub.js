'use strict';

const http = require('http');

const Position = {
  BOTTOM: 1,
  TOP: 2,
  VANES: 3,
};

const Defaults = {
  INITIAL_DELAY_MS: 250,
  REQUEST_INTERVAL_MS: 500,
  REQUEST_TIMEOUT_MS: 10000,
  MAX_RETRIES: 2,
  RETRY_DELAY_MS: 2000,
};


class PowerViewHub {
  constructor(log, host, options = {}) {
    this.log = log;
    this.host = host;

    this.requestIntervalMs = options.requestIntervalMs || Defaults.REQUEST_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || Defaults.REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries != null ? options.maxRetries : Defaults.MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs || Defaults.RETRY_DELAY_MS;
    this.initialDelayMs = options.initialDelayMs || Defaults.INITIAL_DELAY_MS;

    this.queue = [];
    this.processing = false;
  }


  // ── HTTP helpers (native http module — zero dependencies) ────────────

  /**
   * Low-level HTTP request. Returns a promise resolving to { statusCode, body }.
   */
  _httpRequest(path, method = 'GET', postData = null, qs = null) {
    return new Promise((resolve, reject) => {
      let fullPath = path;
      if (qs) {
        const params = new URLSearchParams(qs).toString();
        fullPath += '?' + params;
      }

      const bodyStr = postData ? JSON.stringify(postData) : null;

      const options = {
        hostname: this.host,
        port: 80,
        path: fullPath,
        method: method,
        timeout: this.requestTimeoutMs,
        headers: {},
      };

      if (bodyStr) {
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Request timed out');
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  /** GET request, parse JSON. */
  async _httpGet(path, qs = null) {
    const res = await this._httpRequest(path, 'GET', null, qs);
    if (res.statusCode !== 200) {
      throw new Error('HTTP Error ' + res.statusCode);
    }
    return JSON.parse(res.body);
  }

  /** PUT request with JSON body, parse JSON response. */
  async _httpPut(path, data) {
    const res = await this._httpRequest(path, 'PUT', data);
    if (res.statusCode !== 200) {
      throw new Error('HTTP Error ' + res.statusCode);
    }
    return JSON.parse(res.body);
  }


  // ── Serial request queue ────────────────────────────────────────────

  /** Returns true if the error is transient and worth retrying. */
  _isRetryable(err) {
    if (!err) return false;
    const code = err.code || '';
    return [
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
      'ESOCKETTIMEDOUT', 'EPIPE', 'ENOTFOUND',
    ].includes(code);
  }

  /**
   * Add a request to the serial queue.
   * item: { shadeId, action, data, qs, callbacks, retries }
   */
  _enqueue(item) {
    if (!item.retries) item.retries = 0;
    if (!item.callbacks) item.callbacks = [];

    this.queue.push(item);

    if (!this.processing) {
      this._processQueue(this.initialDelayMs);
    }
  }

  /** Process the queue one item at a time with delays between requests. */
  _processQueue(delay) {
    this.processing = true;

    setTimeout(async () => {
      if (this.queue.length === 0) {
        this.processing = false;
        return;
      }

      const item = this.queue.shift();

      try {
        let result;
        const path = '/api/shades/' + item.shadeId;

        if (item.action === 'put') {
          this.log('Queue: PUT shade %s %s', item.shadeId, JSON.stringify(item.data));
          const json = await this._httpPut(path, { shade: item.data });
          result = json.shade;
        } else {
          // GET (with optional ?refresh=true)
          const json = await this._httpGet(path, item.qs || null);
          result = json.shade;
        }

        for (const cb of item.callbacks) {
          cb(null, result);
        }
      } catch (err) {
        if (this._isRetryable(err) && item.retries < this.maxRetries) {
          item.retries++;
          this.log(
            'Retry %d/%d for shade %s (%s)',
            item.retries, this.maxRetries, item.shadeId, err.code || err.message,
          );
          this.queue.unshift(item);
          this._processQueue(this.retryDelayMs);
          return;
        }

        this.log('Error for shade %s: %s', item.shadeId, err.code || err.message);
        for (const cb of item.callbacks) {
          cb(err);
        }
      }

      if (this.queue.length > 0) {
        this._processQueue(this.requestIntervalMs);
      } else {
        this.processing = false;
      }
    }, delay);
  }


  // ── Public API ──────────────────────────────────────────────────────

  /** Get hub user data (not queued — single one-off request at startup). */
  getUserData(callback) {
    this._httpGet('/api/userdata')
      .then((json) => callback(null, json.userData))
      .catch((err) => {
        this.log('Error getting userdata: %s', err.code || err.message);
        callback(err);
      });
  }

  /** Get all shades (not queued — single request for shade discovery). */
  getShades(callback) {
    this._httpGet('/api/shades')
      .then((json) => callback(null, json.shadeData))
      .catch((err) => {
        this.log('Error getting shades: %s', err.code || err.message);
        callback(err);
      });
  }

  /**
   * Get a single shade by ID.
   * ALL requests go through the queue (Gen 1 fix).
   * Coalesces duplicate requests for the same shade.
   */
  getShade(shadeId, refresh, callback) {
    // Coalesce: if there's already a queued GET for this shade with matching refresh, piggyback.
    for (const queued of this.queue) {
      if (queued.shadeId === shadeId && queued.action === 'get') {
        const queuedIsRefresh = !!(queued.qs && queued.qs.refresh);
        if (queuedIsRefresh === !!refresh) {
          queued.callbacks.push(callback);
          return;
        }
      }
    }

    this._enqueue({
      shadeId: shadeId,
      action: 'get',
      qs: refresh ? { refresh: 'true' } : null,
      callbacks: [callback],
    });
  }

  /**
   * Set shade position via PUT.
   * Merges with existing queued PUTs for the same shade (smart coalescing).
   */
  putShade(shadeId, position, value, userValue, callback) {
    // Merge with an existing queued PUT for this shade.
    for (const queued of this.queue) {
      if (queued.shadeId === shadeId && queued.action === 'put' && queued.data && queued.data.positions) {
        // Parse existing positions into a map.
        const positions = {};
        for (let i = 1; queued.data.positions['posKind' + i]; ++i) {
          positions[queued.data.positions['posKind' + i]] = queued.data.positions['position' + i];
        }

        // Set the new position.
        positions[position] = value;

        // Handle vanes/bottom interaction.
        if (position === Position.VANES && userValue) {
          delete positions[Position.BOTTOM];
        } else if (position === Position.VANES && positions[Position.BOTTOM] != null) {
          delete positions[Position.VANES];
        } else if (position === Position.BOTTOM && userValue) {
          delete positions[Position.VANES];
        } else if (position === Position.BOTTOM && positions[Position.VANES] != null) {
          delete positions[Position.BOTTOM];
        }

        // Reconstruct positions object in order.
        let idx = 1;
        queued.data.positions = {};
        for (const pos in positions) {
          queued.data.positions['posKind' + idx] = parseInt(pos);
          queued.data.positions['position' + idx] = positions[pos];
          ++idx;
        }

        queued.callbacks.push(callback);
        return;
      }
    }

    this._enqueue({
      shadeId: shadeId,
      action: 'put',
      data: {
        positions: {
          posKind1: position,
          position1: value,
        },
      },
      callbacks: [callback],
    });
  }

  /** Jog a shade. Coalesces duplicate jog requests. */
  jogShade(shadeId, callback) {
    for (const queued of this.queue) {
      if (queued.shadeId === shadeId && queued.action === 'put' && queued.data && queued.data.motion === 'jog') {
        queued.callbacks.push(callback);
        return;
      }
    }

    this._enqueue({
      shadeId: shadeId,
      action: 'put',
      data: { motion: 'jog' },
      callbacks: [callback],
    });
  }

  /** Calibrate a shade. Coalesces duplicate calibrate requests. */
  calibrateShade(shadeId, callback) {
    for (const queued of this.queue) {
      if (queued.shadeId === shadeId && queued.action === 'put' && queued.data && queued.data.motion === 'calibrate') {
        queued.callbacks.push(callback);
        return;
      }
    }

    this._enqueue({
      shadeId: shadeId,
      action: 'put',
      data: { motion: 'calibrate' },
      callbacks: [callback],
    });
  }
}


module.exports = { PowerViewHub, Position };
