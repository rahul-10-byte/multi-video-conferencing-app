const { WebSocket } = require("ws");

const BASE_URL = process.env.BASE_URL || "https://test.heavenhue.in";
const API_KEY = process.env.API_KEY || "123456789";
const ROOM_COUNT = Number(process.env.ROOM_COUNT || 20);
const USERS_PER_ROOM = Number(process.env.USERS_PER_ROOM || 3);
const HOLD_SECONDS = Number(process.env.HOLD_SECONDS || 120);
const CONCURRENCY = Number(process.env.CONCURRENCY || 30);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);
const SOAK_PING_INTERVAL_SECONDS = Number(process.env.SOAK_PING_INTERVAL_SECONDS || 15);
const MAX_CONSUMES_PER_PARTICIPANT = Number(process.env.MAX_CONSUMES_PER_PARTICIPANT || 50);
const CONSUME_NEW_PRODUCERS_DURING_HOLD = (process.env.CONSUME_NEW_PRODUCERS_DURING_HOLD || "true").toLowerCase() !== "false";
const PROGRESS_LOG_INTERVAL_SECONDS = Number(process.env.PROGRESS_LOG_INTERVAL_SECONDS || 10);

const RTP_CAPABILITIES = {
  codecs: [
    {
      mimeType: "audio/opus",
      kind: "audio",
      preferredPayloadType: 100,
      clockRate: 48000,
      channels: 2,
      parameters: {},
      rtcpFeedback: []
    },
    {
      mimeType: "video/VP8",
      kind: "video",
      preferredPayloadType: 101,
      clockRate: 90000,
      parameters: {},
      rtcpFeedback: [
        { type: "goog-remb", parameter: "" },
        { type: "ccm", parameter: "fir" },
        { type: "nack", parameter: "" },
        { type: "nack", parameter: "pli" }
      ]
    }
  ],
  headerExtensions: [],
  fecMechanisms: []
};

const DUMMY_DTLS_PARAMETERS = {
  role: "auto",
  fingerprints: [
    {
      algorithm: "sha-256",
      value: "12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF"
    }
  ]
};

function buildAudioRtpParameters() {
  return {
    mid: "0",
    codecs: [
      {
        mimeType: "audio/opus",
        payloadType: 100,
        clockRate: 48000,
        channels: 2,
        parameters: {},
        rtcpFeedback: []
      }
    ],
    headerExtensions: [],
    encodings: [{ ssrc: Math.floor(Math.random() * 1e9) }],
    rtcp: { cname: `audio-${Date.now()}`, reducedSize: true, mux: true }
  };
}

function buildVideoRtpParameters() {
  return {
    mid: "1",
    codecs: [
      {
        mimeType: "video/VP8",
        payloadType: 101,
        clockRate: 90000,
        parameters: {},
        rtcpFeedback: [
          { type: "goog-remb", parameter: "" },
          { type: "ccm", parameter: "fir" },
          { type: "nack", parameter: "" },
          { type: "nack", parameter: "pli" }
        ]
      }
    ],
    headerExtensions: [],
    encodings: [{ ssrc: Math.floor(Math.random() * 1e9) }],
    rtcp: { cname: `video-${Date.now()}`, reducedSize: true, mux: true }
  };
}

function headers() {
  return {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    Authorization: `Bearer ${API_KEY}`
  };
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  return { status: res.status, data };
}

async function createSession(roomName) {
  const { status, data } = await httpJson(`${BASE_URL}/v1/sessions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ metadata: { roomName }, externalRef: roomName })
  });
  if (status !== 201 || !data.sessionId) {
    throw new Error(`create_session_failed status=${status}`);
  }
  return data.sessionId;
}

async function resolveOrCreateSession(roomName, shouldCreate) {
  if (shouldCreate) return createSession(roomName);
  const { status, data } = await httpJson(
    `${BASE_URL}/v1/sessions/resolve?roomName=${encodeURIComponent(roomName)}`,
    { headers: headers() }
  );
  if (status === 200 && data.sessionId) return data.sessionId;
  return createSession(roomName);
}

async function issueToken(sessionId, participantId, role) {
  const { status, data } = await httpJson(`${BASE_URL}/v1/sessions/${sessionId}/join-token`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ participantId, role })
  });
  if (status !== 200 || !data.token || !data.wsUrl) {
    throw new Error(`join_token_failed status=${status}`);
  }
  return data;
}

function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function wsRequest(ws, state, event, data) {
  state.reqSeq += 1;
  const requestId = `req_${Date.now()}_${state.reqSeq}`;
  const payload = JSON.stringify({ event, data, requestId });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error(`ws_timeout event=${event}`));
    }, REQUEST_TIMEOUT_MS);
    state.pending.set(requestId, { resolve, reject, timer });
    ws.send(payload);
  });
}

function attachWsHandlers(ws, state) {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_err) {
      return;
    }
    if (!msg.requestId) return;
    const pending = state.pending.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending.delete(msg.requestId);
    if (msg.event === "error") {
      pending.reject(new Error(`ws_error code=${msg.data?.code || "unknown"} detail=${msg.data?.detail || ""}`));
    } else {
      pending.resolve(msg);
    }
  });
}

function classifyStage(errorMessage) {
  const message = String(errorMessage || "");
  if (message.includes("create_session_failed")) return "create_session";
  if (message.includes("join_token_failed")) return "join_token";
  if (message.includes("ws_timeout event=join") || message.includes("ws_error") && message.includes("join")) return "join";
  if (message.includes("ws_timeout event=createTransport")) return "create_transport";
  if (message.includes("ws_timeout event=connectTransport")) return "connect_transport";
  if (message.includes("ws_timeout event=produce")) return "produce";
  if (message.includes("ws_timeout event=consume")) return "consume";
  if (message.includes("ws_timeout event=listProducers")) return "list_producers";
  if (message.includes("ws_closed")) return "socket_closed";
  return "unknown";
}

async function consumeVisibleProducers({
  ws,
  state,
  recvTransportId,
  consumedProducerIds,
  ownProducerIds
}) {
  const listed = await wsRequest(ws, state, "listProducers", {});
  const producers = (listed.data && listed.data.producers) || [];
  let consumedNow = 0;

  for (const producer of producers) {
    if (!producer || !producer.producerId) continue;
    if (ownProducerIds.has(producer.producerId)) continue;
    if (consumedProducerIds.has(producer.producerId)) continue;
    if (consumedProducerIds.size >= MAX_CONSUMES_PER_PARTICIPANT) break;

    await wsRequest(ws, state, "consume", {
      transportId: recvTransportId,
      producerId: producer.producerId,
      rtpCapabilities: RTP_CAPABILITIES
    });
    consumedProducerIds.add(producer.producerId);
    consumedNow += 1;
  }

  return {
    listedCount: producers.length,
    consumedNow
  };
}

async function joinAndFlow(participant) {
  const sessionId = await resolveOrCreateSession(participant.roomName, participant.createRoom);
  const token = await issueToken(sessionId, participant.participantId, participant.role);
  const ws = await connectWebSocket(token.wsUrl);
  const state = { reqSeq: 0, pending: new Map() };
  attachWsHandlers(ws, state);
  const ownProducerIds = new Set();
  const consumedProducerIds = new Set();
  let listPingCount = 0;
  let maxListedProducers = 0;
  let consumeOps = 0;

  try {
    await wsRequest(ws, state, "join", { token: token.token, rtpCapabilities: RTP_CAPABILITIES });

    const sendTransport = await wsRequest(ws, state, "createTransport", { direction: "send" });
    const recvTransport = await wsRequest(ws, state, "createTransport", { direction: "recv" });

    await wsRequest(ws, state, "connectTransport", {
      transportId: sendTransport.data.id,
      dtlsParameters: DUMMY_DTLS_PARAMETERS
    });
    await wsRequest(ws, state, "connectTransport", {
      transportId: recvTransport.data.id,
      dtlsParameters: DUMMY_DTLS_PARAMETERS
    });

    const producedAudio = await wsRequest(ws, state, "produce", {
      transportId: sendTransport.data.id,
      kind: "audio",
      rtpParameters: buildAudioRtpParameters()
    });
    const producedVideo = await wsRequest(ws, state, "produce", {
      transportId: sendTransport.data.id,
      kind: "video",
      rtpParameters: buildVideoRtpParameters()
    });
    ownProducerIds.add(producedAudio.data.producerId);
    ownProducerIds.add(producedVideo.data.producerId);

    const initialConsume = await consumeVisibleProducers({
      ws,
      state,
      recvTransportId: recvTransport.data.id,
      consumedProducerIds,
      ownProducerIds
    });
    listPingCount += 1;
    maxListedProducers = Math.max(maxListedProducers, initialConsume.listedCount);
    consumeOps += initialConsume.consumedNow;

    const holdMs = HOLD_SECONDS * 1000;
    const intervalMs = Math.max(1000, SOAK_PING_INTERVAL_SECONDS * 1000);
    const startedAt = Date.now();

    while (Date.now() - startedAt < holdMs) {
      const remainingMs = holdMs - (Date.now() - startedAt);
      const waitMs = Math.min(intervalMs, Math.max(0, remainingMs));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      if (CONSUME_NEW_PRODUCERS_DURING_HOLD) {
        const cycleConsume = await consumeVisibleProducers({
          ws,
          state,
          recvTransportId: recvTransport.data.id,
          consumedProducerIds,
          ownProducerIds
        });
        listPingCount += 1;
        maxListedProducers = Math.max(maxListedProducers, cycleConsume.listedCount);
        consumeOps += cycleConsume.consumedNow;
      } else {
        const listed = await wsRequest(ws, state, "listProducers", {});
        const listedCount = ((listed.data && listed.data.producers) || []).length;
        listPingCount += 1;
        maxListedProducers = Math.max(maxListedProducers, listedCount);
      }
    }

    return {
      ok: true,
      consumeOps,
      consumedUnique: consumedProducerIds.size,
      listPingCount,
      maxListedProducers
    };
  } finally {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ws_closed"));
    }
    ws.close();
  }
}

function buildParticipants() {
  const out = [];
  for (let room = 0; room < ROOM_COUNT; room += 1) {
    const roomName = `fake-media-room-${room}`;
    for (let idx = 0; idx < USERS_PER_ROOM; idx += 1) {
      out.push({
        roomName,
        participantId: `fake-${room}-${idx}`,
        role: idx === 0 ? "agent" : "customer",
        createRoom: idx === 0
      });
    }
  }
  return out;
}

async function run() {
  const participants = buildParticipants();
  const queue = [...participants];
  const result = {
    ok: 0,
    failed: 0,
    samples: [],
    stageFailures: {},
    consumeOps: 0,
    consumedUniqueTotal: 0,
    listPings: 0,
    maxListedProducersSeen: 0
  };
  let inFlight = 0;
  const totalParticipants = participants.length;
  const startedAt = Date.now();
  const progressIntervalMs = Math.max(1000, PROGRESS_LOG_INTERVAL_SECONDS * 1000);
  const progressTimer = setInterval(() => {
    const done = result.ok + result.failed;
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    console.log(
      JSON.stringify({
        event: "fake_media_progress",
        total: totalParticipants,
        done,
        ok: result.ok,
        failed: result.failed,
        inFlight,
        queued: queue.length,
        elapsedSeconds
      })
    );
  }, progressIntervalMs);

  console.log(
    JSON.stringify({
      event: "fake_media_start",
      baseUrl: BASE_URL,
      roomCount: ROOM_COUNT,
      usersPerRoom: USERS_PER_ROOM,
      totalParticipants: participants.length,
      holdSeconds: HOLD_SECONDS,
      concurrency: CONCURRENCY,
      soakPingIntervalSeconds: SOAK_PING_INTERVAL_SECONDS,
      maxConsumesPerParticipant: MAX_CONSUMES_PER_PARTICIPANT,
      consumeNewProducersDuringHold: CONSUME_NEW_PRODUCERS_DURING_HOLD,
      progressLogIntervalSeconds: PROGRESS_LOG_INTERVAL_SECONDS
    })
  );

  async function worker() {
    while (queue.length > 0) {
      const participant = queue.shift();
      if (!participant) return;
      inFlight += 1;
      try {
        const flow = await joinAndFlow(participant);
        result.ok += 1;
        result.consumeOps += flow.consumeOps || 0;
        result.consumedUniqueTotal += flow.consumedUnique || 0;
        result.listPings += flow.listPingCount || 0;
        result.maxListedProducersSeen = Math.max(
          result.maxListedProducersSeen,
          flow.maxListedProducers || 0
        );
      } catch (error) {
        result.failed += 1;
        const stage = classifyStage(error.message);
        result.stageFailures[stage] = (result.stageFailures[stage] || 0) + 1;
        result.samples.push({
          participantId: participant.participantId,
          roomName: participant.roomName,
          stage,
          error: error.message
        });
      } finally {
        inFlight -= 1;
      }
    }
  }

  try {
    const workers = Array.from({ length: Math.min(CONCURRENCY, participants.length) }).map(() => worker());
    await Promise.all(workers);
  } finally {
    clearInterval(progressTimer);
  }

  console.log(
    JSON.stringify({
      event: "fake_media_summary",
      total: participants.length,
      ok: result.ok,
      failed: result.failed,
      stageFailures: result.stageFailures,
      consumeOps: result.consumeOps,
      consumedUniqueTotal: result.consumedUniqueTotal,
      listPings: result.listPings,
      maxListedProducersSeen: result.maxListedProducersSeen,
      sampleErrors: result.samples.slice(0, 20)
    })
  );

  if (result.failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error(JSON.stringify({ event: "fake_media_fatal", error: error.message }));
  process.exit(1);
});
