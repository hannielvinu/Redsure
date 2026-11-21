// Minimal Nexconn Platform Chat API client (server side only).
// Signs every request with SHA1(appSecret + nonce + timestamp) as the docs require.
// The App Secret never leaves this process.
import crypto from 'node:crypto';

const HOSTS = {
  SG: ['api.sg-light-api.com', 'api-b.sg-light-api.com'],
  NA: ['api.us-light-api.com', 'api-b.us-light-api.com'],
  SA: ['api.sau-light-api.com', 'api-b.sau-light-api.com'],
};

export class Nexconn {
  constructor({ appKey, appSecret, region = 'SG' }) {
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.hosts = HOSTS[region] || HOSTS.SG;
    this.hostIndex = 0;
  }

  get configured() {
    return Boolean(this.appKey && this.appSecret);
  }

  headers() {
    const nonce = String(Math.floor(Math.random() * 1e12));
    const timestamp = String(Date.now());
    const signature = crypto
      .createHash('sha1')
      .update(this.appSecret + nonce + timestamp)
      .digest('hex');
    return {
      'App-Key': this.appKey,
      Nonce: nonce,
      Timestamp: timestamp,
      Signature: signature,
      'X-Request-ID': crypto.randomUUID().replace(/-/g, ''),
      'Content-Type': 'application/json',
    };
  }

  // POST with primary/backup domain failover (5 s timeout), per the Base URL guide.
  async call(path, body) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const host = this.hosts[this.hostIndex];
      try {
        const res = await fetch(`https://${host}${path}`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = { code: res.status, raw: text };
        }
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        return json;
      } catch (e) {
        lastErr = e;
        this.hostIndex = (this.hostIndex + 1) % this.hosts.length;
      }
    }
    throw lastErr;
  }

  issueToken(userId, name) {
    return this.call('/v4/auth/access-token/issue', { userId, name });
  }

  createGroup(channelId, name, owner, introduction) {
    return this.call('/v4/group-channel/create', {
      channelId,
      name,
      owner,
      groupProfile: { introduction },
      permissions: { joinPerm: 1, memInvitePerm: 2 },
    });
  }

  joinGroup(channelId, userIds) {
    return this.call('/v4/group-channel/join', { channelId, userIds });
  }

  // channelType: 1 = direct, 3 = group
  setMetadata({ messageId, userId, channelType = 3, channelId, metadata }) {
    return this.call('/v4/channel-type/message/metadata/set', {
      messageId,
      userId,
      channelType,
      channelId,
      metadata,
      isEchoToSender: 1,
    });
  }

  async getMetadata(messageId) {
    const r = await this.call('/v4/channel-type/message/metadata/list', { messageId });
    if (r.code !== 0) return { code: r.code, metadata: null };
    const out = {};
    const raw = r.result?.metadata ?? {};
    // The API returns either an object keyed by name or an array of {key, value}.
    if (Array.isArray(raw)) {
      for (const it of raw) out[it.key] = it.value;
    } else {
      for (const [k, v] of Object.entries(raw)) out[k] = typeof v === 'object' && v ? v.value ?? v.v : v;
    }
    return { code: 0, metadata: out };
  }
}
