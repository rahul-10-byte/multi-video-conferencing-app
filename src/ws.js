const { WebSocketServer } = require("ws");
const {
  joinStageFailuresTotal,
  backendErrorsTotal,
  reconnectAttemptsTotal,
  reconnectSuccessTotal,
  qualityReportsTotal,
  qualityAlertsTotal,
  qualityOutboundRttMs,
  qualityInboundJitterMs,
  qualityInboundPacketLossPct
} = require("./metrics");

function send(ws, event, data, requestId) {
  const message = { event, data };
  if (requestId) message.requestId = requestId;
  ws.send(JSON.stringify(message));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateEventPayload(event, data) {
  if (!isObject(data)) {
    return { ok: false, code: "invalid_payload", detail: `${event} requires object payload` };
  }

  if (event === "join" && typeof data.token !== "string") {
    return { ok: false, code: "invalid_payload", detail: "join.token is required" };
  }
  if (event === "createTransport") {
    const direction = data.direction || "send";
    if (direction !== "send" && direction !== "recv") {
      return { ok: false, code: "invalid_payload", detail: "createTransport.direction must be send|recv" };
    }
  }
  if (event === "connectTransport") {
    if (typeof data.transportId !== "string" || !isObject(data.dtlsParameters)) {
      return { ok: false, code: "invalid_payload", detail: "connectTransport requires transportId and dtlsParameters" };
    }
  }
  if (event === "produce") {
    if (
      typeof data.transportId !== "string" ||
      (data.kind !== "audio" && data.kind !== "video") ||
      !isObject(data.rtpParameters)
    ) {
      return { ok: false, code: "invalid_payload", detail: "produce requires transportId, kind(audio|video), rtpParameters" };
    }
  }
  if (event === "consume") {
    if (typeof data.transportId !== "string" || typeof data.producerId !== "string") {
      return { ok: false, code: "invalid_payload", detail: "consume requires transportId and producerId" };
    }
  }
  if ((event === "pauseProducer" || event === "resumeProducer") && typeof data.producerId !== "string") {
    return { ok: false, code: "invalid_payload", detail: `${event} requires producerId` };
  }
  if (event === "qualityReport") {
    if (!isObject(data)) {
      return { ok: false, code: "invalid_payload", detail: "qualityReport requires object payload" };
    }
  }
  if (event === "chatSend") {
    if (typeof data.text !== "string" || !data.text.trim()) {
      return { ok: false, code: "invalid_payload", detail: "chatSend.text is required" };
    }
  }
  if (event === "deviceChanged") {
    if (typeof data.device !== "string" || !data.device.trim()) {
      return { ok: false, code: "invalid_payload", detail: "deviceChanged.device is required" };
    }
  }
  return { ok: true };
}

function setupWebSocketServer({
  server,
  tokenService,
  sessionStore,
  mediasoupService,
  eventBus,
  reconnectStore,
  config
}) {
  const wss = new WebSocketServer({ noServer: true });
  const sessionSockets = new Map();

  function addSocketToSession(sessionId, ws) {
    if (!sessionSockets.has(sessionId)) sessionSockets.set(sessionId, new Set());
    sessionSockets.get(sessionId).add(ws);
  }

  function removeSocketFromSession(sessionId, ws) {
    const sockets = sessionSockets.get(sessionId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) sessionSockets.delete(sessionId);
  }

  function broadcastToSession(sessionId, event, data) {
    const sockets = sessionSockets.get(sessionId);
    if (!sockets) return;
    for (const socket of sockets) {
      if (socket.readyState === 1) {
        send(socket, event, data);
      }
    }
  }

  server.on("upgrade", (request, socket, head) => {
    if (!request.url || !request.url.startsWith("/v1/ws")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    send(ws, "connected", { version: "v1" });
    // eslint-disable-next-line no-console
    console.log("[ws] client_connected");

    ws.on("message", async (rawData) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch (_err) {
        send(ws, "error", { code: "invalid_json" });
        return;
      }

      try {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
        // eslint-disable-next-line no-console
        console.log(
          `[ws] recv event=${msg?.event || "unknown"} requestId=${requestId || "none"} session=${ws.sessionId || "n/a"} participant=${ws.participantId || "n/a"}`
        );
        const payloadValidation = validateEventPayload(msg.event, msg.data || {});
        if (!payloadValidation.ok && msg.event !== "listProducers" && msg.event !== "leave") {
          send(ws, "error", { code: payloadValidation.code, detail: payloadValidation.detail }, requestId);
          return;
        }

        if (msg.event === "join") {
          const token = msg?.data?.token;
          const rtpCapabilities = msg?.data?.rtpCapabilities || null;
          if (!token) {
            joinStageFailuresTotal.inc({ stage: "ws_join_timeout" });
            send(ws, "error", { code: "missing_token" }, requestId);
            return;
          }

          const result = await tokenService.validateAndConsume(token);
          if (!result.ok) {
            send(ws, "error", { code: result.reason }, requestId);
            return;
          }

          const claims = result.claims;
          const session = sessionStore.getSession(claims.sid);
          if (!session) {
            send(ws, "error", { code: "session_not_found" }, requestId);
            return;
          }

          await mediasoupService.ensureParticipant(claims.sid, claims.sub);
          const reconnectState = await reconnectStore.consumeReconnecting(claims.sid, claims.sub);
          const wasReconnecting = Boolean(reconnectState);
          if (wasReconnecting) {
            reconnectSuccessTotal.inc();
          }
          sessionStore.upsertParticipant(claims.sid, {
            participantId: claims.sub,
            role: claims.role,
            state: wasReconnecting ? "reconnected" : "connected"
          });
          ws.sessionId = claims.sid;
          ws.participantId = claims.sub;
          ws.role = claims.role;
          ws.rtpCapabilities = rtpCapabilities;
          addSocketToSession(claims.sid, ws);
          await eventBus.emit(wasReconnecting ? "participant_reconnected" : "participant_joined", {
            sessionId: claims.sid,
            participantId: claims.sub,
            role: claims.role
          });
          broadcastToSession(claims.sid, "participantPresence", {
            sessionId: claims.sid,
            participantId: claims.sub,
            role: claims.role,
            state: wasReconnecting ? "reconnected" : "connected"
          });
          send(ws, "joined", {
            sessionId: claims.sid,
            participantId: claims.sub,
            role: claims.role,
            routerRtpCapabilities: mediasoupService.getRouterRtpCapabilities(claims.sid)
          }, requestId);
          // eslint-disable-next-line no-console
          console.log(`[ws] joined session=${claims.sid} participant=${claims.sub} role=${claims.role}`);
          return;
        }

        if (msg.event === "createTransport") {
          if (!ws.sessionId || !ws.participantId) {
            send(ws, "error", { code: "unauthorized" }, requestId);
            return;
          }
          const direction = msg?.data?.direction || "send";
          const transport = await mediasoupService.createWebRtcTransport(
            ws.sessionId,
            ws.participantId,
            direction
          );
          const candidateSummary = Array.isArray(transport.iceCandidates)
            ? transport.iceCandidates
                .map((candidate) => {
                  const ip = candidate?.ip || "n/a";
                  const port = candidate?.port || "n/a";
                  const protocol = candidate?.protocol || "n/a";
                  const type = candidate?.type || "n/a";
                  return `${protocol}:${ip}:${port}:${type}`;
                })
                .join(",")
            : "none";
          // eslint-disable-next-line no-console
          console.log(
            `[ws] transport_created session=${ws.sessionId} participant=${ws.participantId} direction=${direction} transportId=${transport.id} candidates=${candidateSummary}`
          );
          send(ws, "transportCreated", { direction, ...transport }, requestId);
          return;
        }

        if (msg.event === "connectTransport") {
          if (!ws.sessionId || !ws.participantId) {
            send(ws, "error", { code: "unauthorized" }, requestId);
            return;
          }
          const transportId = msg?.data?.transportId;
          const dtlsParameters = msg?.data?.dtlsParameters;
          await mediasoupService.connectTransport(ws.sessionId, ws.participantId, transportId, dtlsParameters);
          // eslint-disable-next-line no-console
          console.log(
            `[ws] transport_connected session=${ws.sessionId} participant=${ws.participantId} transportId=${transportId}`
          );
          send(ws, "ack", { event: "connectTransport", transportId }, requestId);
          return;
        }

        if (msg.event === "produce") {
          if (!ws.sessionId || !ws.participantId) {
            send(ws, "error", { code: "unauthorized" }, requestId);
            return;
          }
          const transportId = msg?.data?.transportId;
          const kind = msg?.data?.kind;
          const rtpParameters = msg?.data?.rtpParameters;
          const produced = await mediasoupService.produce(
            ws.sessionId,
            ws.participantId,
            transportId,
            kind,
            rtpParameters
          );
          // eslint-disable-next-line no-console
          console.log(
            `[ws] produced session=${ws.sessionId} participant=${ws.participantId} transportId=${transportId} kind=${kind} producerId=${produced.producerId}`
          );
          send(ws, "produced", produced, requestId);
          return;
        }

        if (msg.event === "consume") {
          if (!ws.sessionId || !ws.participantId) {
            send(ws, "error", { code: "unauthorized" }, requestId);
            return;
          }
          const transportId = msg?.data?.transportId;
          const producerId = msg?.data?.producerId;
          const rtpCapabilities = msg?.data?.rtpCapabilities || ws.rtpCapabilities;
          const consumed = await mediasoupService.consume(
            ws.sessionId,
            ws.participantId,
            transportId,
            producerId,
            rtpCapabilities
          );
          // eslint-disable-next-line no-console
          console.log(
            `[ws] consumed session=${ws.sessionId} participant=${ws.participantId} transportId=${transportId} producerId=${producerId} consumerId=${consumed.consumerId}`
          );
          send(ws, "consumed", consumed, requestId);
          return;
        }

        if (msg.event === "listProducers") {
          if (!ws.sessionId || !ws.participantId) {
            send(ws, "error", { code: "unauthorized" }, requestId);
            return;
          }
          const producers = mediasoupService.listProducers(ws.sessionId, ws.participantId);
          send(ws, "participantUpdate", { producers }, requestId);
          return;
        }

        if (msg.event === "pauseProducer" || msg.event === "resumeProducer") {
          if (ws.role !== "agent") {
            send(ws, "error", { code: "forbidden", detail: "agent_role_required" }, requestId);
            return;
          }
          const producerId = msg?.data?.producerId;
          await mediasoupService.setProducerPaused(
            ws.sessionId,
            ws.participantId,
            producerId,
            msg.event === "pauseProducer"
          );
          send(ws, "ack", { event: msg.event, producerId }, requestId);
          return;
        }

        if (msg.event === "leave") {
          if (ws.sessionId && ws.participantId) {
            removeSocketFromSession(ws.sessionId, ws);
            await reconnectStore.clearReconnecting(ws.sessionId, ws.participantId);
            mediasoupService.closeParticipant(ws.sessionId, ws.participantId);
            sessionStore.removeParticipant(ws.sessionId, ws.participantId);
            await eventBus.emit("participant_left", {
              sessionId: ws.sessionId,
              participantId: ws.participantId,
              role: ws.role,
              reason: "explicit_leave"
            });
            broadcastToSession(ws.sessionId, "participantPresence", {
              sessionId: ws.sessionId,
              participantId: ws.participantId,
              role: ws.role,
              state: "left"
            });
          }
          send(ws, "left", {}, requestId);
          return;
        }

        if (msg.event === "chatSend") {
          if (!ws.sessionId || !ws.participantId) {
            send(ws, "error", { code: "unauthorized" }, requestId);
            return;
          }
          const payload = {
            messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            sessionId: ws.sessionId,
            participantId: ws.participantId,
            role: ws.role,
            text: String(msg.data.text).trim(),
            sentAt: new Date().toISOString()
          };
          broadcastToSession(ws.sessionId, "chatMessage", payload);
          await eventBus.emit("chat_message_sent", payload);
          send(ws, "ack", { event: "chatSend", messageId: payload.messageId }, requestId);
          return;
        }

        if (msg.event === "deviceChanged") {
          if (!ws.sessionId || !ws.participantId) {
            send(ws, "error", { code: "unauthorized" }, requestId);
            return;
          }
          const payload = {
            sessionId: ws.sessionId,
            participantId: ws.participantId,
            role: ws.role,
            device: String(msg.data.device).trim(),
            changedAt: new Date().toISOString()
          };
          broadcastToSession(ws.sessionId, "deviceChanged", payload);
          await eventBus.emit("participant_device_changed", payload);
          send(ws, "ack", { event: "deviceChanged" }, requestId);
          return;
        }

        if (msg.event === "qualityReport") {
          if (!ws.sessionId || !ws.participantId) {
            send(ws, "error", { code: "unauthorized" }, requestId);
            return;
          }
          const report = msg.data || {};
          const packetLoss = Number(report.inboundPacketLossPct || 0);
          const rttMs = Number(report.outboundRttMs || 0);
          const jitterMs = Number(report.inboundJitterMs || 0);
          const severity = packetLoss >= 8 || rttMs >= 800 ? "high" : packetLoss >= 4 || rttMs >= 400 ? "medium" : "low";

          qualityReportsTotal.inc({ severity });
          if (Number.isFinite(rttMs) && rttMs > 0) {
            qualityOutboundRttMs.observe(rttMs);
          }
          if (Number.isFinite(jitterMs) && jitterMs > 0) {
            qualityInboundJitterMs.observe(jitterMs);
          }
          if (Number.isFinite(packetLoss) && packetLoss >= 0) {
            qualityInboundPacketLossPct.observe(packetLoss);
          }

          if (severity !== "low") {
            const payload = {
              sessionId: ws.sessionId,
              participantId: ws.participantId,
              role: ws.role,
              severity,
              metrics: {
                outboundRttMs: report.outboundRttMs ?? null,
                inboundJitterMs: report.inboundJitterMs ?? null,
                inboundPacketLossPct: report.inboundPacketLossPct ?? null,
                iceConnectionState: report.iceConnectionState ?? null
              }
            };
            await eventBus.emit("quality_alert", payload);
            qualityAlertsTotal.inc({ severity });
            send(ws, "qualityAlert", payload);
          }
          send(ws, "ack", { event: "qualityReport", severity }, requestId);
          return;
        }

        send(ws, "ack", { event: msg.event }, requestId);
      } catch (error) {
        backendErrorsTotal.inc({ area: "ws_message_handler" });
        const requestId = typeof msg?.requestId === "string" ? msg.requestId : undefined;
        // eslint-disable-next-line no-console
        console.error(
          `[ws] handler_error event=${msg?.event || "unknown"} requestId=${requestId || "none"} session=${ws.sessionId || "n/a"} participant=${ws.participantId || "n/a"} error=${error.message}`
        );
        send(ws, "error", { code: "internal_error", detail: error.message }, requestId);
      }
    });

    ws.on("close", async () => {
      // eslint-disable-next-line no-console
      console.log(`[ws] client_closed session=${ws.sessionId || "n/a"} participant=${ws.participantId || "n/a"}`);
      if (ws.sessionId && ws.participantId) {
        removeSocketFromSession(ws.sessionId, ws);
        sessionStore.setParticipantState(ws.sessionId, ws.participantId, "reconnecting");
        broadcastToSession(ws.sessionId, "participantPresence", {
          sessionId: ws.sessionId,
          participantId: ws.participantId,
          role: ws.role,
          state: "reconnecting"
        });
        reconnectAttemptsTotal.inc();
        try {
          await reconnectStore.setReconnecting(
            ws.sessionId,
            ws.participantId,
            ws.role || "unknown",
            Math.max(config.reconnectGraceSeconds, 1)
          );
        } catch (_err) {
          // Best effort; reconnect cleanup worker handles expirations.
        }
      }
    });
  });
}

module.exports = { setupWebSocketServer };
