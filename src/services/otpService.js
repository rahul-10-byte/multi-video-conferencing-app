class OtpService {
  constructor({ ttlSeconds = 300, maxAttempts = 5, fixedCode = "123456" } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.maxAttempts = maxAttempts;
    this.fixedCode = fixedCode;
    this.challenges = new Map();
    this.verified = new Map();
  }

  issueChallenge(sessionId, participantId) {
    this.sweep();
    const key = `${sessionId}:${participantId}`;
    const expiresAtMs = Date.now() + this.ttlSeconds * 1000;
    this.challenges.set(key, {
      code: this.fixedCode,
      attempts: 0,
      expiresAtMs
    });
    this.verified.delete(key);
    return {
      expiresAt: new Date(expiresAtMs).toISOString(),
      ttlSeconds: this.ttlSeconds,
      testMode: true
    };
  }

  verify(sessionId, participantId, otp) {
    this.sweep();
    const key = `${sessionId}:${participantId}`;
    const challenge = this.challenges.get(key);
    if (!challenge) return { ok: false, reason: "otp_not_found" };
    if (challenge.expiresAtMs <= Date.now()) {
      this.challenges.delete(key);
      return { ok: false, reason: "otp_expired" };
    }
    if (challenge.attempts >= this.maxAttempts) {
      this.challenges.delete(key);
      return { ok: false, reason: "otp_max_attempts_exceeded" };
    }
    challenge.attempts += 1;
    if (String(otp) !== String(challenge.code)) {
      return { ok: false, reason: "otp_mismatch", attemptsLeft: Math.max(this.maxAttempts - challenge.attempts, 0) };
    }
    this.challenges.delete(key);
    this.verified.set(key, { verifiedAtMs: Date.now(), expiresAtMs: challenge.expiresAtMs });
    return { ok: true, verifiedAt: new Date().toISOString() };
  }

  isVerified(sessionId, participantId) {
    this.sweep();
    const key = `${sessionId}:${participantId}`;
    const mark = this.verified.get(key);
    return Boolean(mark && mark.expiresAtMs > Date.now());
  }

  consumeVerified(sessionId, participantId) {
    this.sweep();
    const key = `${sessionId}:${participantId}`;
    const mark = this.verified.get(key);
    if (!mark || mark.expiresAtMs <= Date.now()) return false;
    this.verified.delete(key);
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [key, challenge] of this.challenges.entries()) {
      if (challenge.expiresAtMs <= now) this.challenges.delete(key);
    }
    for (const [key, mark] of this.verified.entries()) {
      if (mark.expiresAtMs <= now) this.verified.delete(key);
    }
  }
}

module.exports = { OtpService };
