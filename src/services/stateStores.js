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

module.exports = {
  InMemoryReplayStore,
  InMemoryReconnectStore
};
