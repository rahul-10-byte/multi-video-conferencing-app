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
  customerInviteBaseUrl: process.env.VC_CUSTOMER_INVITE_BASE_URL || "http://localhost:3000/vc/join",
  otpTtlSeconds: intFromEnv("VC_OTP_TTL_SECONDS", 300),
  otpMaxAttempts: intFromEnv("VC_OTP_MAX_ATTEMPTS", 5),
  testOtpCode: process.env.VC_TEST_OTP_CODE || "123456",
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
  recording: {
    enabled: (process.env.VC_RECORDING_ENABLED || "true").toLowerCase() === "true",
    engine: (process.env.VC_RECORDING_ENGINE || "gstreamer").toLowerCase(),
    ffmpegPath: process.env.VC_FFMPEG_PATH || "ffmpeg",
    gstreamerPath: process.env.VC_GSTREAMER_PATH || "gst-launch-1.0",
    outputDir: process.env.VC_RECORDING_OUTPUT_DIR || "recordings",
    hostIp: process.env.VC_RECORDING_HOST_IP || "127.0.0.1",
    basePort: intFromEnv("VC_RECORDING_BASE_PORT", 50040)
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
