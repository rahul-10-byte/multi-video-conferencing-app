const http = require("http");
const path = require("path");
const express = require("express");
const { v7: uuidv7 } = require("uuid");
const { config } = require("./config");
const { registry, reconnectTimeoutTotal, backendErrorsTotal } = require("./metrics");
const { SessionStore } = require("./services/sessionStore");
const { TokenService } = require("./services/tokenService");
const {
  InMemoryReplayStore,
  InMemoryReconnectStore
} = require("./services/stateStores");
const { MediasoupService } = require("./services/mediasoupService");
const { EventBus } = require("./services/eventBus");
const { PostgresReadModel } = require("./services/postgresReadModel");
const { OtpService } = require("./services/otpService");
const { RecordingService } = require("./services/recordingService");
const { RecordingPipelineService } = require("./services/recordingPipelineService");
const { setupWebSocketServer } = require("./ws");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const frontendStaticDir = path.resolve(__dirname, "../frontend");
app.use(express.static(frontendStaticDir));
app.use((req, res, next) => {
  const startMs = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startMs;
    console.log(
      `[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms) ip=${req.ip || req.socket?.remoteAddress || "unknown"}`
    );
  });
  next();
});

const sessionStore = new SessionStore(config.roomIdleTtlSeconds);
const mediasoupService = new MediasoupService(config.mediasoup);
let replayStore = new InMemoryReplayStore();
let reconnectStore = new InMemoryReconnectStore();
let tokenService = new TokenService(config, replayStore);
let eventBus = new EventBus();
let readModel = null;
const otpService = new OtpService({
  ttlSeconds: config.otpTtlSeconds,
  maxAttempts: config.otpMaxAttempts,
  fixedCode: config.testOtpCode
});
const recordingPipelineService = new RecordingPipelineService(config.recording);
const recordingService = new RecordingService(config.recording);
const nodeId = `node_${uuidv7().replaceAll("-", "")}`;
let reconnectWorkerRunning = false;

function requireApiKey(req, res, next) {
  if (!config.apiKey) {
    console.log(`[auth] api key disabled -> allow ${req.method} ${req.originalUrl}`);
    next();
    return;
  }
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const apiKey = req.headers["x-api-key"] || bearer;
  if (apiKey !== config.apiKey) {
    const reason = apiKey ? "mismatch" : "missing";
    console.log(
      `[auth] rejected ${req.method} ${req.originalUrl} reason=${reason} ip=${req.ip || req.socket?.remoteAddress || "unknown"}`
    );
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  console.log(`[auth] accepted ${req.method} ${req.originalUrl}`);
  next();
}

function validRole(role) {
  return role === "agent" || role === "customer";
}

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/readyz", (_req, res) => {
  const mediasoupReady = mediasoupService.isReady();
  if (!mediasoupReady) {
    res.status(503).json({ status: "not_ready", mediasoup: "not_initialized" });
    return;
  }
  res.json({ status: "ready", mediasoup: "ok" });
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  const metrics = await registry.metrics();
  res.send(metrics);
});

app.post("/v1/sessions", async (req, res) => {
  const { externalRef = null, metadata = {}, ttlSeconds = 3600 } = req.body || {};
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 24 * 60 * 60) {
    res.status(400).json({ error: "invalid_ttl_seconds" });
    return;
  }
  if (metadata && typeof metadata !== "object") {
    res.status(400).json({ error: "invalid_metadata" });
    return;
  }
  const session = sessionStore.createSession({ externalRef, metadata, ttlSeconds });
  await readModel?.upsertSession(session);
  await eventBus.emit("session_created", { sessionId: session.sessionId, data: { metadata, externalRef } });
  res.status(201).json({
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  });
});

app.post("/v1/sessions/:sessionId/join-token", requireApiKey, (req, res) => {
  const { sessionId } = req.params;
  const { participantId, role, displayName = null, ttlSeconds } = req.body || {};
  if (!participantId || !role) {
    res.status(400).json({ error: "participantId and role are required" });
    return;
  }
  if (!validRole(role)) {
    res.status(400).json({ error: "invalid_role" });
    return;
  }
  if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900)) {
    res.status(400).json({ error: "invalid_ttl_seconds" });
    return;
  }

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  if (role === "customer" && !otpService.consumeVerified(sessionId, participantId)) {
    res.status(403).json({ error: "otp_verification_required" });
    return;
  }

  const issued = tokenService.issueJoinToken({ sessionId, participantId, role, ttlSeconds });
  sessionStore.upsertParticipant(sessionId, {
    participantId,
    role,
    displayName,
    state: "token_issued",
    joinedAt: new Date().toISOString()
  });
  res.json({
    token: issued.token,
    expiresAt: issued.expiresAt,
    wsUrl: config.wsUrl,
    sessionId
  });
});

app.get("/v1/ice-servers", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }

  res.json({
    iceServers: [
      { urls: [config.turn.stunUrl] },
      {
        urls: [config.turn.turnUrl],
        username: config.turn.username,
        credential: config.turn.password,
        credentialType: "password"
      }
    ],
    ttlSeconds: config.turn.ttlSeconds
  });
});

app.get("/v1/sessions/resolve", (req, res) => {
  const roomName = String(req.query.roomName || "").trim();
  if (!roomName) {
    res.status(400).json({ error: "roomName is required" });
    return;
  }
  const session = sessionStore.findSessionByRoomName(roomName);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  res.json({
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    roomName: session?.metadata?.roomName || null
  });
});

app.get("/v1/sessions/:sessionId/participants", requireApiKey, (req, res) => {
  const { sessionId } = req.params;
  const participants = sessionStore.listParticipants(sessionId);
  if (!participants) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  res.json({ participants, total: participants.length });
});

app.post("/v1/sessions/:sessionId/customer-invite", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { participantId, channel = "link" } = req.body || {};
  if (!participantId) {
    res.status(400).json({ error: "participantId is required" });
    return;
  }
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  const challenge = otpService.issueChallenge(sessionId, participantId);
  const sentAt = new Date().toISOString();
  const inviteLink = `${config.customerInviteBaseUrl}?sessionId=${encodeURIComponent(sessionId)}&participantId=${encodeURIComponent(participantId)}`;
  sessionStore.addInviteLink(sessionId, inviteLink);
  await readModel?.appendInviteLink(sessionId, inviteLink, sentAt);
  await readModel?.upsertSession(sessionStore.getSession(sessionId));
  await eventBus.emit("customer_invited", {
    sessionId,
    participantId,
    role: "customer",
    channel,
    inviteLink,
    testMode: true
  });
  res.json({
    sessionId,
    participantId,
    inviteLink,
    sentAt,
    otp: {
      testMode: true,
      code: config.testOtpCode,
      expiresAt: challenge.expiresAt
    }
  });
});

app.post("/v1/sessions/:sessionId/customer-verify-otp", async (req, res) => {
  const { sessionId } = req.params;
  const { participantId, otp } = req.body || {};
  if (!participantId || !otp) {
    res.status(400).json({ error: "participantId and otp are required" });
    return;
  }
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  const result = otpService.verify(sessionId, participantId, otp);
  if (!result.ok) {
    res.status(400).json({ error: result.reason, attemptsLeft: result.attemptsLeft ?? null });
    return;
  }
  await eventBus.emit("otp_verified", { sessionId, participantId, role: "customer", verifiedAt: result.verifiedAt });
  res.json({ sessionId, participantId, verified: true, verifiedAt: result.verifiedAt });
});

app.post("/v1/sessions/:sessionId/leave", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const session = sessionStore.leaveSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  await readModel?.upsertSession(session);
  await eventBus.emit("session_ended", { sessionId, reason: "api_leave" });
  res.json({ sessionId, status: session.status, endedAt: new Date().toISOString() });
});

app.post("/v1/sessions/:sessionId/recording/start", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { initiatedBy = "system" } = req.body || {};
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  const sessionParticipants = sessionStore.listParticipants(sessionId) || [];
  if (sessionParticipants.length > 0) {
    const actor = sessionParticipants.find((p) => p.participantId === initiatedBy);
    if (!actor || actor.role !== "agent") {
      res.status(403).json({ error: "agent_role_required_for_recording" });
      return;
    }
  }
  const result = await recordingService.start(sessionId, initiatedBy, mediasoupService);
  if (!result.ok) {
    res.status(409).json({ error: result.reason, detail: result.detail || null });
    return;
  }
  await readModel?.saveRecording(result.recording);
  await eventBus.emit("recording_started", {
    sessionId,
    recordingId: result.recording.recordingId,
    initiatedBy
  });
  res.json({ recording: result.recording });
});

app.post("/v1/sessions/:sessionId/recording/stop", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { stoppedBy = "system" } = req.body || {};
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  const sessionParticipants = sessionStore.listParticipants(sessionId) || [];
  if (sessionParticipants.length > 0) {
    const actor = sessionParticipants.find((p) => p.participantId === stoppedBy);
    if (!actor || actor.role !== "agent") {
      res.status(403).json({ error: "agent_role_required_for_recording" });
      return;
    }
  }
  const result = await recordingService.stop(sessionId, stoppedBy, {
    onUpdate: async (recording) => {
      await readModel?.saveRecording(recording);
      const eventName =
        recording.state === "failed"
          ? "recording_failed"
          : recording.state === "uploading"
            ? "recording_uploading"
            : recording.state === "uploaded"
              ? "recording_uploaded"
              : "recording_stopped";
      const eventPayload = {
        sessionId,
        recordingId: recording.recordingId,
        stoppedBy,
        durationMs: recording.durationMs
      };
      if (recording.state === "failed" && recording.mergeStderrTail) {
        eventPayload.reason = String(recording.mergeStderrTail).slice(0, 500);
      }
      await eventBus.emit(eventName, eventPayload);
    },
    onUploadFinalize: async ({ recording, segmentDetails }) => {
      if (!recordingPipelineService.isEnabled()) {
        throw new Error("recording_s3_not_configured");
      }
      return await recordingPipelineService.finalizeAndTrigger({
        recording,
        segmentDetails
      });
    }
  });
  if (!result.ok) {
    res.status(409).json({ error: result.reason });
    return;
  }
  await readModel?.saveRecording(result.recording);
  await eventBus.emit(result.recording.state === "processing" ? "recording_processing" : "recording_stopped", {
    sessionId,
    recordingId: result.recording.recordingId,
    stoppedBy,
    durationMs: result.recording.durationMs
  });
  res.json({ recording: result.recording });
});

app.post("/v1/sessions/:sessionId/disposition", requireApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { outcome, notes = null, resolvedBy = null } = req.body || {};
  const allowedOutcomes = new Set(["resolved", "follow_up", "dropped"]);
  if (!allowedOutcomes.has(outcome)) {
    res.status(400).json({ error: "invalid_outcome" });
    return;
  }
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  const disposition = {
    sessionId,
    outcome,
    notes,
    resolvedBy,
    resolvedAt: new Date().toISOString()
  };
  sessionStore.setDisposition(sessionId, disposition);
  await readModel?.upsertDisposition(disposition);
  await eventBus.emit("session_dispositioned", disposition);
  res.json({ disposition });
});

app.get("/v1/sessions/:sessionId", requireApiKey, (req, res) => {
  const { sessionId } = req.params;
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  res.json({
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastActivityAt: session.lastActivityAt,
    participantCount: session.participants.size,
    metadata: session.metadata,
    inviteLinks: session.inviteLinks || [],
    disposition: session.disposition || null,
    activeRecording: recordingService.getActive(sessionId)
  });
});

app.get("/v1/admin/sessions", requireApiKey, async (req, res) => {
  if (!readModel || !readModel.enabled) {
    res.status(503).json({ error: "read_model_disabled" });
    return;
  }
  const limit = Math.min(Number.parseInt(req.query.limit || "50", 10) || 50, 200);
  const sessions = await readModel.listRecentSessions(limit);
  res.json({ sessions, total: sessions.length });
});

app.get("/v1/admin/sessions/:sessionId/events", requireApiKey, async (req, res) => {
  if (!readModel || !readModel.enabled) {
    res.status(503).json({ error: "read_model_disabled" });
    return;
  }
  const { sessionId } = req.params;
  const limit = Math.min(Number.parseInt(req.query.limit || "100", 10) || 100, 500);
  const events = await readModel.listSessionEvents(sessionId, limit);
  res.json({ sessionId, events, total: events.length });
});

app.get(/^(?!\/v1\/|\/healthz$|\/readyz$|\/metrics$).*/, (_req, res) => {
  res.sendFile(path.join(frontendStaticDir, "index.html"));
});

const server = http.createServer(app);

setInterval(() => {
  sessionStore.sweepExpiredSessions();
  replayStore.sweep();
}, Math.max(config.replayCacheSweepSeconds, 5) * 1000);

const timerLogIntervalMs = Math.max(Number.parseInt(String(config.timerLogIntervalMs || 10000), 10) || 10000, 1000);
if (config.timerLogs !== false) {
  setInterval(() => {
    try { sessionStore.logActiveSessionTimers(); } catch (_e) {}
    try { recordingService.logActiveRecordingTimers(); } catch (_e) {}
  }, timerLogIntervalMs);
}

async function processReconnectTimeouts() {
  if (reconnectWorkerRunning) return;
  reconnectWorkerRunning = true;
  try {
    const nowMs = Date.now();
    const expired = await reconnectStore.listExpired(nowMs, config.reconnectCleanupBatchSize);
    for (const reconnectState of expired) {
      const { sessionId, participantId, role = "unknown" } = reconnectState;
      const claimed = await reconnectStore.claimCleanup(
        sessionId,
        participantId,
        nodeId,
        config.reconnectCleanupLockSeconds
      );
      if (!claimed) continue;

      const current = await reconnectStore.getReconnecting(sessionId, participantId);
      if (!current || current.expiresAtMs > Date.now()) continue;

      await reconnectStore.clearReconnecting(sessionId, participantId);
      mediasoupService.closeParticipant(sessionId, participantId);
      sessionStore.removeParticipant(sessionId, participantId);
      reconnectTimeoutTotal.inc();
      await eventBus.emit("participant_left", {
        sessionId,
        participantId,
        role,
        reason: "reconnect_timeout"
      });
    }
  } catch (error) {
    backendErrorsTotal.inc({ area: "reconnect_cleanup_worker" });
  } finally {
    reconnectWorkerRunning = false;
  }
}

async function start() {
  replayStore = new InMemoryReplayStore();
  reconnectStore = new InMemoryReconnectStore();
  tokenService = new TokenService(config, replayStore);
  readModel = new PostgresReadModel(config.db);
  await readModel.connect();
  console.log(readModel.enabled ? "postgres read model connected" : "postgres read model disabled");
  eventBus = new EventBus({ readModel });

  setupWebSocketServer({
    server,
    tokenService,
    sessionStore,
    mediasoupService,
    eventBus,
    reconnectStore,
    config
  });

  await mediasoupService.start();
  setInterval(
    processReconnectTimeouts,
    Math.max(config.reconnectCleanupPollSeconds, 1) * 1000
  );
  server.listen(config.port, () => {
    console.log(`vc-backend listening on ${config.baseUrl}`);
  });
}

start().catch((error) => {
  console.error("failed_to_start", error);
  process.exit(1);
});
