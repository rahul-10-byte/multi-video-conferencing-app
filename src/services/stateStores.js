class InMemoryReplayStore {
  constructor() {
    this.seen = new Map();
  }

  async consume(jti, expUnixSeconds) {
    this.sweep();
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, expUnixSeconds * 1000);
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [jti, expiresAtMs] of this.seen.entries()) {
      if (expiresAtMs <= now) this.seen.delete(jti);
    }
  }
}

class RedisReplayStore {
  constructor(redis, keyPrefix = "vc:") {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async consume(jti, expUnixSeconds) {
    const ttl = Math.max(expUnixSeconds - Math.floor(Date.now() / 1000), 1);
    const key = `${this.keyPrefix}replay:${jti}`;
    const result = await this.redis.set(key, "1", "EX", ttl, "NX");
    return result === "OK";
  }

  sweep() {}
}

class InMemoryReconnectStore {
  constructor() {
    this.states = new Map();
    this.cleanupLocks = new Map();
  }

  async setReconnecting(sessionId, participantId, role, ttlSeconds) {
    const key = `${sessionId}:${participantId}`;
    this.states.set(key, {
      sessionId,
      participantId,
      role,
      expiresAtMs: Date.now() + ttlSeconds * 1000
    });
  }

  async consumeReconnecting(sessionId, participantId) {
    const key = `${sessionId}:${participantId}`;
    const existing = this.states.get(key);
    if (!existing) return null;
    this.states.delete(key);
    if (existing.expiresAtMs <= Date.now()) return null;
    return existing;
  }

  async listExpired(nowMs, limit = 100) {
    const expired = [];
    for (const state of this.states.values()) {
      if (state.expiresAtMs <= nowMs) expired.push(state);
      if (expired.length >= limit) break;
    }
    return expired;
  }

  async claimCleanup(sessionId, participantId, ownerId, lockSeconds) {
    const key = `${sessionId}:${participantId}`;
    const now = Date.now();
    const existing = this.cleanupLocks.get(key);
    if (existing && existing.expiresAtMs > now) return false;
    this.cleanupLocks.set(key, {
      ownerId,
      expiresAtMs: now + Math.max(lockSeconds, 1) * 1000
    });
    return true;
  }

  async getReconnecting(sessionId, participantId) {
    return this.states.get(`${sessionId}:${participantId}`) || null;
  }

  async clearReconnecting(sessionId, participantId) {
    const key = `${sessionId}:${participantId}`;
    this.states.delete(key);
    this.cleanupLocks.delete(key);
  }
}

class RedisReconnectStore {
  constructor(redis, keyPrefix = "vc:") {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async setReconnecting(sessionId, participantId, role, ttlSeconds) {
    const ttl = Math.max(ttlSeconds, 1);
    const key = `${this.keyPrefix}reconnect:${sessionId}:${participantId}`;
    const payload = JSON.stringify({
      sessionId,
      participantId,
      role,
      expiresAtMs: Date.now() + ttl * 1000
    });
    await this.redis
      .multi()
      .set(key, payload, "EX", ttl)
      .zadd(`${this.keyPrefix}reconnect:deadline`, Date.now() + ttl * 1000, `${sessionId}:${participantId}`)
      .exec();
  }

  async consumeReconnecting(sessionId, participantId) {
    const key = `${this.keyPrefix}reconnect:${sessionId}:${participantId}`;
    const identifier = `${sessionId}:${participantId}`;
    const payload = await this.redis.get(key);
    if (!payload) return null;
    await this.redis.multi().del(key).zrem(`${this.keyPrefix}reconnect:deadline`, identifier).exec();
    try {
      return JSON.parse(payload);
    } catch (_err) {
      return null;
    }
  }

  async listExpired(nowMs, limit = 100) {
    const identifiers = await this.redis.zrangebyscore(
      `${this.keyPrefix}reconnect:deadline`,
      0,
      nowMs,
      "LIMIT",
      0,
      limit
    );
    const results = [];
    for (const identifier of identifiers) {
      const [sessionId, participantId] = identifier.split(":");
      const state = await this.getReconnecting(sessionId, participantId);
      if (state && state.expiresAtMs <= nowMs) {
        results.push(state);
      }
    }
    return results;
  }

  async claimCleanup(sessionId, participantId, ownerId, lockSeconds) {
    const key = `${this.keyPrefix}reconnect-lock:${sessionId}:${participantId}`;
    const result = await this.redis.set(key, ownerId, "EX", Math.max(lockSeconds, 1), "NX");
    return result === "OK";
  }

  async getReconnecting(sessionId, participantId) {
    const key = `${this.keyPrefix}reconnect:${sessionId}:${participantId}`;
    const payload = await this.redis.get(key);
    if (!payload) return null;
    try {
      return JSON.parse(payload);
    } catch (_err) {
      return null;
    }
  }

  async clearReconnecting(sessionId, participantId) {
    const identifier = `${sessionId}:${participantId}`;
    await this.redis
      .multi()
      .del(`${this.keyPrefix}reconnect:${identifier}`)
      .del(`${this.keyPrefix}reconnect-lock:${identifier}`)
      .zrem(`${this.keyPrefix}reconnect:deadline`, identifier)
      .exec();
  }
}

module.exports = {
  InMemoryReplayStore,
  RedisReplayStore,
  InMemoryReconnectStore,
  RedisReconnectStore
};
