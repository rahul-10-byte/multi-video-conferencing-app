require("dotenv").config();

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const config = {
  port: intFromEnv("PORT", 9000),
  baseUrl: process.env.VC_BASE_URL || "http://localhost:9000",
  wsUrl: process.env.VC_WS_URL || "ws://localhost:9000/v1/ws",
  tokenIssuer: process.env.VC_TOKEN_ISSUER || "vc-backend",
  tokenAudience: process.env.VC_TOKEN_AUDIENCE || "vc-client",
  tokenTtlSeconds: intFromEnv("VC_TOKEN_TTL_SECONDS", 120),
  jwtSecret: process.env.VC_JWT_SECRET || "unsafe-dev-secret",
  apiKey: process.env.VC_API_KEY || "",
  roomIdleTtlSeconds: intFromEnv("ROOM_IDLE_TTL_SECONDS", 300),
  replayCacheSweepSeconds: intFromEnv("REPLAY_CACHE_SWEEP_SECONDS", 30),
  reconnectGraceSeconds: intFromEnv("VC_RECONNECT_GRACE_SECONDS", 20),
  reconnectCleanupPollSeconds: intFromEnv("VC_RECONNECT_CLEANUP_POLL_SECONDS", 2),
  reconnectCleanupBatchSize: intFromEnv("VC_RECONNECT_CLEANUP_BATCH_SIZE", 100),
  reconnectCleanupLockSeconds: intFromEnv("VC_RECONNECT_CLEANUP_LOCK_SECONDS", 30),
  redis: {
    url: process.env.REDIS_URL || "",
    keyPrefix: process.env.REDIS_KEY_PREFIX || "vc:"
  },
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    clientId: process.env.KAFKA_CLIENT_ID || "vc-backend",
    topic: process.env.KAFKA_EVENTS_TOPIC || "vc.events"
  },
  db: {
    url: process.env.DATABASE_URL || "",
    ssl: (process.env.DATABASE_SSL || "false").toLowerCase() === "true",
    poolMax: intFromEnv("DATABASE_POOL_MAX", 10)
  },
  mediasoup: {
    rtcMinPort: intFromEnv("MEDIASOUP_RTC_MIN_PORT", 40000),
    rtcMaxPort: intFromEnv("MEDIASOUP_RTC_MAX_PORT", 49999),
    listenIp: process.env.MEDIASOUP_LISTEN_IP || "127.0.0.1",
    announcedAddress: process.env.MEDIASOUP_ANNOUNCED_ADDRESS || undefined,
    maxIncomingBitrate: intFromEnv("MEDIASOUP_MAX_INCOMING_BITRATE", 1500000)
  },
  turn: {
    stunUrl: process.env.TURN_STUN_URL || "stun:localhost:3478",
    turnUrl: process.env.TURN_URL || "turn:localhost:3478?transport=udp",
    username: process.env.TURN_USERNAME || "sfuuser",
    password: process.env.TURN_PASSWORD || "sfupass123",
    ttlSeconds: intFromEnv("TURN_CREDENTIAL_TTL_SECONDS", 120)
  }
};

module.exports = { config };
