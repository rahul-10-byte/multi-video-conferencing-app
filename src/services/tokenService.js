const jwt = require("jsonwebtoken");
const { v7: uuidv7 } = require("uuid");
const { joinTokensIssuedTotal, replayRejectedTotal, joinStageFailuresTotal } = require("../metrics");

class TokenService {
  constructor(config, replayCache) {
    this.config = config;
    this.replayCache = replayCache;
  }

  issueJoinToken({ sessionId, participantId, role, ttlSeconds }) {
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + (ttlSeconds || this.config.tokenTtlSeconds);
    const payload = {
      sub: participantId,
      sid: sessionId,
      role,
      tenant: "default",
      jti: `jti_${uuidv7().replaceAll("-", "")}`,
      iat: nowSec,
      exp
    };
    const token = jwt.sign(payload, this.config.jwtSecret, {
      algorithm: "HS256",
      issuer: this.config.tokenIssuer,
      audience: this.config.tokenAudience
    });
    joinTokensIssuedTotal.inc();
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async validateAndConsume(token) {
    try {
      const claims = jwt.verify(token, this.config.jwtSecret, {
        algorithms: ["HS256"],
        issuer: this.config.tokenIssuer,
        audience: this.config.tokenAudience,
        clockTolerance: 15
      });
      if (!(await this.replayCache.consume(claims.jti, claims.exp))) {
        replayRejectedTotal.inc();
        return { ok: false, reason: "replay_detected" };
      }
      return { ok: true, claims };
    } catch (error) {
      joinStageFailuresTotal.inc({ stage: "token_validation_failed" });
      return { ok: false, reason: "token_validation_failed", error };
    }
  }
}

module.exports = { TokenService };
