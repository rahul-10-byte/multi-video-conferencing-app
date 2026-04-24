import { Device } from "https://esm.sh/mediasoup-client@3";

const el = {
  landingScreen: document.getElementById("landingScreen"),
  callScreen: document.getElementById("callScreen"),
  backendUrl: document.getElementById("backendUrl"),
  participantId: document.getElementById("participantId"),
  role: document.getElementById("role"),
  customerOtpPanel: document.getElementById("customerOtpPanel"),
  roomActions: document.getElementById("roomActions"),
  createRoomBox: document.getElementById("createRoomBox"),
  joinRoomBox: document.getElementById("joinRoomBox"),
  otpSessionId: document.getElementById("otpSessionId"),
  otpCustomerId: document.getElementById("otpCustomerId"),
  otpCode: document.getElementById("otpCode"),
  verifyOtpBtn: document.getElementById("verifyOtpBtn"),
  otpResult: document.getElementById("otpResult"),
  createRoomName: document.getElementById("createRoomName"),
  joinRoomInput: document.getElementById("joinRoomInput"),
  createRoomBtn: document.getElementById("createRoomBtn"),
  joinRoomBtn: document.getElementById("joinRoomBtn"),
  activeRoomLabel: document.getElementById("activeRoomLabel"),
  leaveBtn: document.getElementById("leaveBtn"),
  audioBtn: document.getElementById("audioBtn"),
  videoBtn: document.getElementById("videoBtn"),
  switchCameraBtn: document.getElementById("switchCameraBtn"),
  startRecordingBtn: document.getElementById("startRecordingBtn"),
  stopRecordingBtn: document.getElementById("stopRecordingBtn"),
  inviteCustomerId: document.getElementById("inviteCustomerId"),
  inviteChannel: document.getElementById("inviteChannel"),
  sendInviteBtn: document.getElementById("sendInviteBtn"),
  inviteResult: document.getElementById("inviteResult"),
  dispositionOutcome: document.getElementById("dispositionOutcome"),
  dispositionNotes: document.getElementById("dispositionNotes"),
  submitDispositionBtn: document.getElementById("submitDispositionBtn"),
  chatInput: document.getElementById("chatInput"),
  chatSendBtn: document.getElementById("chatSendBtn"),
  chatLog: document.getElementById("chatLog"),
  participantsGrid: document.getElementById("participantsGrid"),
  connectionState: document.getElementById("connectionState"),
  diagnostics: document.getElementById("diagnostics"),
  log: document.getElementById("log")
};

const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1500;
const API_KEY = "123456789";

const state = {
  ws: null,
  localStream: null,
  device: null,
  sendTransport: null,
  recvTransport: null,
  producerIds: { audio: null, video: null },
  pendingRequests: new Map(),
  reqSeq: 0,
  consumePollTimer: null,
  diagnosticsTimer: null,
  reconnectTimer: null,
  reconnectInProgress: false,
  reconnectAttempts: 0,
  intentionalLeave: false,
  joined: false,
  recordingActive: false,
  inviteJoinMode: false,
  otpVerifiedKeys: new Set(),
  connectionMeta: null,
  localVideoDeviceIds: [],
  activeVideoDeviceIndex: 0,
  producersById: new Map(),
  consumersByProducerId: new Map(),
  tilesByParticipantId: new Map(),
  audioProducer: null,
  videoProducer: null
};

if (!el.backendUrl.value.trim()) {
  el.backendUrl.value = window.location.origin;
}

function updateRoleDrivenUi() {
  const isCustomer = el.role.value === "customer";
  el.customerOtpPanel.classList.toggle("hidden", !isCustomer);
  if (!state.inviteJoinMode) {
    el.roomActions.classList.remove("hidden");
  }
}

function otpKey(sessionId, participantId) {
  return `${sessionId}:${participantId}`;
}

function configureInviteModeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId");
  const participantId = params.get("participantId");
  if (!sessionId || !participantId) return;
  state.inviteJoinMode = true;
  el.role.value = "customer";
  el.participantId.value = participantId;
  el.joinRoomInput.value = sessionId;
  el.otpSessionId.value = sessionId;
  el.otpCustomerId.value = participantId;
  el.roomActions.classList.add("hidden");
  el.customerOtpPanel.classList.remove("hidden");
  el.otpResult.textContent = "Enter OTP shared by agent, then verify to join call.";
}

function log(message, data) {
  const line = `[${new Date().toISOString()}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`;
  el.log.textContent = `${line}\n${el.log.textContent}`.slice(0, 14000);
}

function setConnectionState(stateName, text) {
  el.connectionState.textContent = text;
  el.connectionState.className = `conn-state ${stateName}`;
}

function showLandingScreen() {
  el.callScreen.classList.add("hidden");
  el.landingScreen.classList.remove("hidden");
}

function showCallScreen() {
  el.landingScreen.classList.add("hidden");
  el.callScreen.classList.remove("hidden");
}

function buildHeaders(base = {}) {
  return {
    ...base,
    "x-api-key": API_KEY,
    Authorization: `Bearer ${API_KEY}`
  };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getJson(url) {
  const res = await fetch(url, { headers: buildHeaders() });
  if (!res.ok) {
    const err = new Error(`${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ensureUniqueParticipantId(baseUrl, sessionId, desiredId) {
  try {
    const participantsResp = await getJson(`${baseUrl}/v1/sessions/${sessionId}/participants`);
    const participants = participantsResp?.participants || [];
    const existingIds = new Set(participants.map((p) => String(p.participantId || "").toLowerCase()));
    let candidate = desiredId;
    let index = 2;
    while (existingIds.has(String(candidate).toLowerCase())) {
      candidate = `${desiredId}-${index}`;
      index += 1;
    }
    if (candidate !== desiredId) {
      log("participant_id_collision_resolved", { from: desiredId, to: candidate });
    }
    return candidate;
  } catch (_err) {
    // If participants endpoint is unavailable, continue with desired id.
    return desiredId;
  }
}

function nextRequestId() {
  state.reqSeq += 1;
  return `req_${Date.now()}_${state.reqSeq}`;
}

function wsRequest(event, data = {}, timeoutMs = 7000) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("ws_not_connected"));
  }
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingRequests.delete(requestId);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    state.pendingRequests.set(requestId, { resolve, reject, timer, event });
    state.ws.send(JSON.stringify({ event, data, requestId }));
  });
}

function handleWsMessage(raw) {
  const msg = JSON.parse(raw.data);
  if (msg.requestId && state.pendingRequests.has(msg.requestId)) {
    const pending = state.pendingRequests.get(msg.requestId);
    clearTimeout(pending.timer);
    state.pendingRequests.delete(msg.requestId);
    if (msg.event === "error") {
      pending.reject(new Error(`${msg.data?.code || "ws_error"} ${msg.data?.detail || ""}`));
    } else {
      pending.resolve(msg);
    }
    return;
  }
  if (msg.event === "qualityAlert") {
    log("quality_alert", msg.data || {});
  } else if (msg.event === "chatMessage") {
    const line = `[${msg.data?.sentAt || new Date().toISOString()}] ${msg.data?.participantId || "unknown"}: ${msg.data?.text || ""}`;
    el.chatLog.textContent = `${line}\n${el.chatLog.textContent}`.slice(0, 10000);
  } else if (msg.event === "deviceChanged") {
    log("device_changed", msg.data || {});
  } else if (msg.event === "error") {
    log("ws_error", msg.data || {});
  }
}

function clearPendingRequests() {
  for (const pending of state.pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("request_cancelled"));
  }
  state.pendingRequests.clear();
}

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function ensureParticipantTile(participantId, isLocal = false) {
  if (state.tilesByParticipantId.has(participantId)) return state.tilesByParticipantId.get(participantId);
  const container = document.createElement("div");
  container.className = "tile";
  const header = document.createElement("div");
  header.className = "tile-header";
  header.textContent = `${participantId}${isLocal ? " (You)" : ""}`;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  video.srcObject = new MediaStream();
  container.appendChild(header);
  container.appendChild(video);
  el.participantsGrid.appendChild(container);
  const tile = { container, video, stream: video.srcObject };
  state.tilesByParticipantId.set(participantId, tile);
  return tile;
}

function cleanupTiles() {
  for (const tile of state.tilesByParticipantId.values()) {
    tile.container.remove();
  }
  state.tilesByParticipantId.clear();
  state.producersById.clear();
}

function removeParticipantTileIfUnused(participantId) {
  const tile = state.tilesByParticipantId.get(participantId);
  if (!tile) return;
  const hasTracks = tile.stream.getTracks().length > 0;
  const isLocal = state.connectionMeta && participantId === state.connectionMeta.participantId;
  if (!hasTracks && !isLocal) {
    tile.container.remove();
    state.tilesByParticipantId.delete(participantId);
  }
}

async function setupMedia() {
  if (state.localStream) return;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    log("media_ready", { mode: "audio_video" });
  } catch (error) {
    log("media_av_failed_retrying_audio_only", { message: error.message });
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      log("media_ready", { mode: "audio_only" });
    } catch (audioError) {
      log("media_capture_unavailable_joining_without_media", { message: audioError.message });
      state.localStream = new MediaStream();
    }
  }
  const localId = state.connectionMeta?.participantId || "local";
  const tile = ensureParticipantTile(localId, true);
  tile.video.srcObject = state.localStream;
  await refreshVideoDevices();
}

async function refreshVideoDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.localVideoDeviceIds = devices.filter((d) => d.kind === "videoinput").map((d) => d.deviceId);
    const currentTrack = state.localStream?.getVideoTracks?.()[0];
    const currentSettings = currentTrack?.getSettings?.() || {};
    const currentDeviceId = currentSettings.deviceId || null;
    const idx = state.localVideoDeviceIds.findIndex((id) => id === currentDeviceId);
    state.activeVideoDeviceIndex = idx >= 0 ? idx : 0;
  } catch (_err) {
    state.localVideoDeviceIds = [];
    state.activeVideoDeviceIndex = 0;
  }
}

function renderDiagnostics(snapshot) {
  el.diagnostics.textContent = [
    `timestamp: ${snapshot.timestamp}`,
    `outboundRttMs: ${snapshot.outboundRttMs ?? "n/a"}`,
    `inboundJitterMs: ${snapshot.inboundJitterMs ?? "n/a"}`,
    `inboundPacketLossPct: ${snapshot.inboundPacketLossPct ?? "n/a"}`,
    `iceConnectionState: ${snapshot.iceConnectionState ?? "n/a"}`,
    `iceCandidatePair: ${snapshot.iceCandidatePair ?? "n/a"}`
  ].join("\n");
}

function createSendTransport(transportOptions) {
  log("send_transport_options", {
    id: transportOptions.id,
    iceCandidates: Array.isArray(transportOptions.iceCandidates) ? transportOptions.iceCandidates.length : 0
  });
  state.sendTransport = state.device.createSendTransport({
    id: transportOptions.id,
    iceParameters: transportOptions.iceParameters,
    iceCandidates: transportOptions.iceCandidates,
    dtlsParameters: transportOptions.dtlsParameters
  });

  state.sendTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await wsRequest("connectTransport", { transportId: state.sendTransport.id, dtlsParameters });
      callback();
    } catch (error) {
      errback(error);
    }
  });

  state.sendTransport.on("produce", async ({ kind, rtpParameters }, callback, errback) => {
    try {
      const response = await wsRequest("produce", {
        transportId: state.sendTransport.id,
        kind,
        rtpParameters
      });
      callback({ id: response.data.producerId });
    } catch (error) {
      errback(error);
    }
  });
  state.sendTransport.on("connectionstatechange", (connectionState) => {
    log("send_transport_state", { connectionState });
  });
}

function createRecvTransport(transportOptions) {
  log("recv_transport_options", {
    id: transportOptions.id,
    iceCandidates: Array.isArray(transportOptions.iceCandidates) ? transportOptions.iceCandidates.length : 0
  });
  state.recvTransport = state.device.createRecvTransport({
    id: transportOptions.id,
    iceParameters: transportOptions.iceParameters,
    iceCandidates: transportOptions.iceCandidates,
    dtlsParameters: transportOptions.dtlsParameters
  });

  state.recvTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await wsRequest("connectTransport", { transportId: state.recvTransport.id, dtlsParameters });
      callback();
    } catch (error) {
      errback(error);
    }
  });
  state.recvTransport.on("connectionstatechange", (connectionState) => {
    log("recv_transport_state", { connectionState });
  });
}

async function consumeMissingProducers() {
  if (!state.joined || !state.recvTransport) return;
  const updateResp = await wsRequest("listProducers", {});
  const producers = updateResp?.data?.producers || [];
  const currentProducerIds = new Set(producers.map((p) => p.producerId));

  for (const p of producers) {
    state.producersById.set(p.producerId, p);
    if (state.consumersByProducerId.has(p.producerId)) continue;
    const consumeResp = await wsRequest("consume", {
      transportId: state.recvTransport.id,
      producerId: p.producerId,
      rtpCapabilities: state.device.rtpCapabilities
    });
    const consumed = consumeResp.data;
    const consumer = await state.recvTransport.consume({
      id: consumed.consumerId,
      producerId: consumed.producerId,
      kind: consumed.kind,
      rtpParameters: consumed.rtpParameters
    });
    const participantId = p.participantId || "participant";
    state.consumersByProducerId.set(consumed.producerId, { consumer, participantId });
    const tile = ensureParticipantTile(participantId, false);
    tile.stream.addTrack(consumer.track);
    tile.video.srcObject = tile.stream;
  }

  for (const [producerId, value] of state.consumersByProducerId.entries()) {
    if (currentProducerIds.has(producerId)) continue;
    const consumer = value.consumer;
    const participantId = value.participantId;
    const tile = state.tilesByParticipantId.get(participantId);
    if (tile) {
      const tracks = tile.stream.getTracks();
      for (const track of tracks) {
        if (track.id === consumer.track.id) {
          tile.stream.removeTrack(track);
          break;
        }
      }
      tile.video.srcObject = tile.stream;
      removeParticipantTileIfUnused(participantId);
    }
    try {
      consumer.close();
    } catch (_err) {}
    state.consumersByProducerId.delete(producerId);
    state.producersById.delete(producerId);
  }
}

async function collectDiagnosticsAndReport() {
  if (!state.joined || !state.sendTransport || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const stats = await state.sendTransport.getStats();
  let outboundRttMs = null;
  let inboundJitterMs = null;
  let inboundPacketLossPct = null;
  let icePair = null;
  stats.forEach((stat) => {
    if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated) {
      icePair = `${stat.localCandidateId || "local"} -> ${stat.remoteCandidateId || "remote"}`;
      if (typeof stat.currentRoundTripTime === "number") outboundRttMs = Math.round(stat.currentRoundTripTime * 1000);
    }
    if (stat.type === "inbound-rtp" && typeof stat.jitter === "number") {
      inboundJitterMs = Math.round(stat.jitter * 1000);
      const packetsLost = Number(stat.packetsLost || 0);
      const packetsReceived = Number(stat.packetsReceived || 0);
      const total = packetsLost + packetsReceived;
      if (total > 0) inboundPacketLossPct = Math.round((packetsLost / total) * 10000) / 100;
    }
  });
  const snapshot = {
    timestamp: new Date().toISOString(),
    outboundRttMs,
    inboundJitterMs,
    inboundPacketLossPct,
    iceConnectionState: state.sendTransport.connectionState || "unknown",
    iceCandidatePair: icePair
  };
  renderDiagnostics(snapshot);
  wsRequest("qualityReport", snapshot, 3000).catch(() => {});
}

async function connectAndJoin(joinToken) {
  const baseUrl = state.connectionMeta.baseUrl;
  const wsUrl = joinToken.wsUrl || baseUrl.replace("http", "ws") + "/v1/ws";
  state.ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    state.ws.onopen = resolve;
    state.ws.onerror = reject;
  });
  state.ws.onmessage = handleWsMessage;
  state.ws.onclose = handleUnexpectedSocketClose;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for connected")), 6000);
    const onConnected = (raw) => {
      const msg = JSON.parse(raw.data);
      if (msg.event === "connected") {
        clearTimeout(timer);
        state.ws.removeEventListener("message", onConnected);
        resolve();
      }
    };
    state.ws.addEventListener("message", onConnected);
  });
  const joinedResp = await wsRequest("join", { token: joinToken.token });
  const joined = joinedResp.data;
  showCallScreen();
  el.activeRoomLabel.textContent = state.connectionMeta.roomLabel;
  state.device = new Device();
  await state.device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });

  const sendTransport = await wsRequest("createTransport", { direction: "send" });
  createSendTransport(sendTransport.data);
  const recvTransport = await wsRequest("createTransport", { direction: "recv" });
  createRecvTransport(recvTransport.data);

  const audioTrack = state.localStream.getAudioTracks()[0];
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (audioTrack) {
    const producer = await state.sendTransport.produce({ track: audioTrack });
    state.audioProducer = producer;
    state.producerIds.audio = producer.id;
  }
  if (videoTrack) {
    const producer = await state.sendTransport.produce({
      track: videoTrack,
      // Default 3-layer simulcast profile for adaptive quality.
      encodings: [
        { rid: "q", scaleResolutionDownBy: 4, maxBitrate: 150_000 },
        { rid: "h", scaleResolutionDownBy: 2, maxBitrate: 500_000 },
        { rid: "f", scaleResolutionDownBy: 1, maxBitrate: 1_200_000 }
      ]
    });
    state.videoProducer = producer;
    state.producerIds.video = producer.id;
  }

  state.joined = true;
  state.reconnectAttempts = 0;
  state.reconnectInProgress = false;
  setConnectionState("connected", "Connected");
  await consumeMissingProducers();
  state.consumePollTimer = setInterval(() => consumeMissingProducers().catch(() => {}), 2000);
  state.diagnosticsTimer = setInterval(() => collectDiagnosticsAndReport().catch(() => {}), 3000);
  el.leaveBtn.disabled = false;
  el.audioBtn.disabled = false;
  el.videoBtn.disabled = false;
  el.switchCameraBtn.disabled = false;
  el.startRecordingBtn.disabled = false;
  el.stopRecordingBtn.disabled = true;
  el.sendInviteBtn.disabled = false;
  el.submitDispositionBtn.disabled = false;
  el.chatSendBtn.disabled = false;
}

async function joinBySessionId(sessionId, roomLabel) {
  const baseUrl = el.backendUrl.value.trim();
  const rawParticipantId = el.participantId.value.trim() || "user";
  const role = el.role.value;
  let participantId = await ensureUniqueParticipantId(baseUrl, sessionId, rawParticipantId);
  state.connectionMeta = { baseUrl, sessionId, participantId, role, roomLabel };
  state.intentionalLeave = false;
  clearReconnectTimer();
  cleanupTiles();
  await setupMedia();
  if (role === "customer") {
    const otp = el.otpCode.value.trim();
    const otpSessionId = el.otpSessionId.value.trim();
    const otpCustomerId = el.otpCustomerId.value.trim() || participantId;
    if (!otp) throw new Error("OTP is required for customer");
    if (!otpSessionId || otpSessionId !== sessionId) {
      throw new Error("OTP Session ID must match selected session");
    }
    const key = otpKey(sessionId, otpCustomerId);
    if (!state.otpVerifiedKeys.has(key)) {
      await postJson(`${baseUrl}/v1/sessions/${sessionId}/customer-verify-otp`, { participantId: otpCustomerId, otp });
      state.otpVerifiedKeys.add(key);
    }
    participantId = otpCustomerId;
  }
  el.participantId.value = participantId;
  state.connectionMeta = { baseUrl, sessionId, participantId, role, roomLabel };
  const joinToken = await postJson(`${baseUrl}/v1/sessions/${sessionId}/join-token`, { participantId, role });
  await connectAndJoin(joinToken);
}

async function createRoomAndJoin() {
  const baseUrl = el.backendUrl.value.trim();
  const roomName = el.createRoomName.value.trim();
  if (!roomName) throw new Error("Room name is required.");
  const created = await postJson(`${baseUrl}/v1/sessions`, {
    metadata: { roomName },
    externalRef: roomName
  });
  await joinBySessionId(created.sessionId, roomName);
}

async function joinRoomByNameOrId() {
  const baseUrl = el.backendUrl.value.trim();
  const input = el.joinRoomInput.value.trim();
  if (!input) throw new Error("Room name or ID is required.");
  let sessionId = input;
  let roomLabel = input;
  if (!input.startsWith("vc_sess_")) {
    const resolved = await getJson(`${baseUrl}/v1/sessions/resolve?roomName=${encodeURIComponent(input)}`);
    sessionId = resolved.sessionId;
    roomLabel = resolved.roomName || input;
  }
  await joinBySessionId(sessionId, roomLabel);
}

async function cleanupConnectionOnly() {
  if (state.consumePollTimer) clearInterval(state.consumePollTimer);
  if (state.diagnosticsTimer) clearInterval(state.diagnosticsTimer);
  state.consumePollTimer = null;
  state.diagnosticsTimer = null;
  if (state.sendTransport) state.sendTransport.close();
  if (state.recvTransport) state.recvTransport.close();
  state.sendTransport = null;
  state.recvTransport = null;
  if (state.ws) {
    try {
      state.ws.close();
    } catch (_err) {}
  }
  state.ws = null;
  clearPendingRequests();
  state.device = null;
  state.producerIds = { audio: null, video: null };
  state.audioProducer = null;
  state.videoProducer = null;
  for (const consumer of state.consumersByProducerId.values()) {
    try {
      consumer.consumer.close();
    } catch (_err) {}
  }
  state.consumersByProducerId.clear();
  cleanupTiles();
  el.diagnostics.textContent = "No diagnostics yet.";
}

async function tryReconnect() {
  if (state.intentionalLeave || !state.connectionMeta || state.reconnectInProgress) return;
  if (state.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    await leave(true);
    return;
  }
  state.reconnectInProgress = true;
  state.reconnectAttempts += 1;
  setConnectionState("reconnecting", `Reconnecting (${state.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`);
  try {
    await cleanupConnectionOnly();
    const { baseUrl, sessionId, participantId, role } = state.connectionMeta;
    const joinToken = await postJson(`${baseUrl}/v1/sessions/${sessionId}/join-token`, { participantId, role });
    await connectAndJoin(joinToken);
  } catch (_err) {
    state.reconnectInProgress = false;
    clearReconnectTimer();
    state.reconnectTimer = setTimeout(() => {
      tryReconnect().catch(() => {});
    }, RECONNECT_DELAY_MS);
  }
}

function handleUnexpectedSocketClose() {
  if (state.intentionalLeave || !state.joined) return;
  state.joined = false;
  setConnectionState("reconnecting", "Reconnecting");
  clearReconnectTimer();
  state.reconnectTimer = setTimeout(() => {
    tryReconnect().catch(() => {});
  }, RECONNECT_DELAY_MS);
}

async function leave(fromReconnectFailure = false) {
  state.intentionalLeave = true;
  clearReconnectTimer();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      await wsRequest("leave", {});
    } catch (_err) {}
  }
  await cleanupConnectionOnly();
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
  }
  state.localStream = null;
  state.connectionMeta = null;
  state.reconnectAttempts = 0;
  state.reconnectInProgress = false;
  state.joined = false;
  el.leaveBtn.disabled = true;
  el.audioBtn.disabled = true;
  el.videoBtn.disabled = true;
  el.switchCameraBtn.disabled = true;
  el.startRecordingBtn.disabled = true;
  el.stopRecordingBtn.disabled = true;
  el.sendInviteBtn.disabled = true;
  el.submitDispositionBtn.disabled = true;
  el.chatSendBtn.disabled = true;
  setConnectionState(fromReconnectFailure ? "failed" : "disconnected", fromReconnectFailure ? "Reconnect Failed" : "Disconnected");
  showLandingScreen();
}

function toggleAudio() {
  const track = state.localStream?.getAudioTracks?.()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el.audioBtn.textContent = track.enabled ? "Mute Audio" : "Unmute Audio";
}

function toggleVideo() {
  const track = state.localStream?.getVideoTracks?.()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el.videoBtn.textContent = track.enabled ? "Stop Video" : "Start Video";
}

async function switchCamera() {
  if (!state.videoProducer || state.localVideoDeviceIds.length < 2) {
    log("camera_switch_unavailable", { reason: "less_than_two_cameras_or_no_video_producer" });
    return;
  }
  state.activeVideoDeviceIndex = (state.activeVideoDeviceIndex + 1) % state.localVideoDeviceIds.length;
  const nextDeviceId = state.localVideoDeviceIds[state.activeVideoDeviceIndex];
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: nextDeviceId } },
    audio: false
  });
  const newTrack = stream.getVideoTracks()[0];
  const oldTrack = state.localStream.getVideoTracks()[0];
  if (oldTrack) {
    state.localStream.removeTrack(oldTrack);
    oldTrack.stop();
  }
  state.localStream.addTrack(newTrack);
  await state.videoProducer.replaceTrack({ track: newTrack });
  const localId = state.connectionMeta?.participantId || "local";
  const tile = ensureParticipantTile(localId, true);
  tile.video.srcObject = state.localStream;
  await wsRequest("deviceChanged", { device: "camera_switched" }, 3000).catch(() => {});
}

async function sendInvite() {
  const baseUrl = el.backendUrl.value.trim();
  const sessionId = state.connectionMeta?.sessionId;
  if (!sessionId) throw new Error("No active session");
  const participantId = el.inviteCustomerId.value.trim();
  if (!participantId) throw new Error("Customer ID required");
  const channel = el.inviteChannel.value.trim() || "link";
  const resp = await postJson(`${baseUrl}/v1/sessions/${sessionId}/customer-invite`, { participantId, channel });
  el.inviteResult.textContent = JSON.stringify(resp, null, 2);
  el.otpSessionId.value = sessionId;
  el.otpCustomerId.value = participantId;
  el.otpCode.value = resp?.otp?.code || "";
  el.otpResult.textContent = "OTP info prefilled from latest invite. Share OTP with customer for test mode.";
}

async function startRecording() {
  const { baseUrl, sessionId, participantId } = state.connectionMeta || {};
  if (!sessionId) throw new Error("No active session");
  await postJson(`${baseUrl}/v1/sessions/${sessionId}/recording/start`, { initiatedBy: participantId || "agent" });
  state.recordingActive = true;
  el.startRecordingBtn.disabled = true;
  el.stopRecordingBtn.disabled = false;
}

async function stopRecording() {
  const { baseUrl, sessionId, participantId } = state.connectionMeta || {};
  if (!sessionId) throw new Error("No active session");
  await postJson(`${baseUrl}/v1/sessions/${sessionId}/recording/stop`, { stoppedBy: participantId || "agent" });
  state.recordingActive = false;
  el.startRecordingBtn.disabled = false;
  el.stopRecordingBtn.disabled = true;
}

async function submitDisposition() {
  const { baseUrl, sessionId, participantId } = state.connectionMeta || {};
  if (!sessionId) throw new Error("No active session");
  const outcome = el.dispositionOutcome.value;
  const notes = el.dispositionNotes.value.trim();
  await postJson(`${baseUrl}/v1/sessions/${sessionId}/disposition`, {
    outcome,
    notes,
    resolvedBy: participantId || "agent"
  });
  log("disposition_submitted", { outcome });
}

async function sendChat() {
  const text = el.chatInput.value.trim();
  if (!text) return;
  await wsRequest("chatSend", { text });
  el.chatInput.value = "";
}

async function verifyOtpFromUi() {
  const baseUrl = el.backendUrl.value.trim();
  const sessionId = el.otpSessionId.value.trim();
  const participantId = el.otpCustomerId.value.trim();
  const otp = el.otpCode.value.trim();
  if (!sessionId || !participantId || !otp) {
    throw new Error("sessionId, customerId and OTP are required");
  }
  const resp = await postJson(`${baseUrl}/v1/sessions/${sessionId}/customer-verify-otp`, { participantId, otp });
  state.otpVerifiedKeys.add(otpKey(sessionId, participantId));
  el.otpResult.textContent = JSON.stringify(resp, null, 2);
  if (state.inviteJoinMode) {
    await joinBySessionId(sessionId, sessionId);
  }
}

el.createRoomBtn.addEventListener("click", () => {
  setConnectionState("reconnecting", "Joining");
  createRoomAndJoin().catch((error) => {
    log("create_room_failed", { message: error.message });
    alert(`Create room failed: ${error.message}`);
  });
});

el.joinRoomBtn.addEventListener("click", () => {
  setConnectionState("reconnecting", "Joining");
  joinRoomByNameOrId().catch((error) => {
    log("join_room_failed", { message: error.message });
    alert(`Join room failed: ${error.message}`);
  });
});

el.leaveBtn.addEventListener("click", () => {
  leave().catch((error) => log("leave_failed", { message: error.message }));
});

el.audioBtn.addEventListener("click", toggleAudio);
el.videoBtn.addEventListener("click", toggleVideo);
el.switchCameraBtn.addEventListener("click", () => {
  switchCamera().catch((error) => log("switch_camera_failed", { message: error.message }));
});
el.sendInviteBtn.addEventListener("click", () => {
  sendInvite().catch((error) => log("send_invite_failed", { message: error.message }));
});
el.startRecordingBtn.addEventListener("click", () => {
  startRecording().catch((error) => log("recording_start_failed", { message: error.message }));
});
el.stopRecordingBtn.addEventListener("click", () => {
  stopRecording().catch((error) => log("recording_stop_failed", { message: error.message }));
});
el.submitDispositionBtn.addEventListener("click", () => {
  submitDisposition().catch((error) => log("disposition_failed", { message: error.message }));
});
el.chatSendBtn.addEventListener("click", () => {
  sendChat().catch((error) => log("chat_send_failed", { message: error.message }));
});
el.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendChat().catch((error) => log("chat_send_failed", { message: error.message }));
  }
});
el.verifyOtpBtn.addEventListener("click", () => {
  verifyOtpFromUi().catch((error) => {
    el.otpResult.textContent = `OTP verification failed: ${error.message}`;
  });
});
el.role.addEventListener("change", updateRoleDrivenUi);

getJson(`${el.backendUrl.value.trim()}/healthz`)
  .then(() => log("backend reachable"))
  .catch((err) => log("backend check failed", { message: err.message }));

setConnectionState("disconnected", "Disconnected");
showLandingScreen();
configureInviteModeFromUrl();
updateRoleDrivenUi();
