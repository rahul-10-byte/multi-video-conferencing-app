const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocket } = require("ws");

function randomPort() {
  return 12000 + Math.floor(Math.random() * 2000);
}

async function waitForHealthy(baseUrl, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch (_err) {
      // keep polling
    }
    await delay(150);
  }
  throw new Error("server did not become healthy in time");
}

function startServerForTest(port, reconnectGraceSeconds = 1) {
  const env = {
    ...process.env,
    VC_API_KEY: "",
    PORT: String(port),
    VC_BASE_URL: `http://127.0.0.1:${port}`,
    VC_WS_URL: `ws://127.0.0.1:${port}/v1/ws`,
    VC_RECONNECT_GRACE_SECONDS: String(reconnectGraceSeconds),
    VC_RECONNECT_CLEANUP_POLL_SECONDS: "1",
    VC_RECONNECT_CLEANUP_BATCH_SIZE: "50"
  };
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (buf) => {
    stderr += buf.toString();
  });

  return { child, getStderr: () => stderr };
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const onError = (err) => reject(err);
    ws.once("open", () => {
      ws.off("error", onError);
      resolve(ws);
    });
    ws.once("error", onError);
  });
}

function nextMessage(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function waitForEvent(ws, event, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const remaining = Math.max(timeoutMs - (Date.now() - start), 50);
    const message = await nextMessage(ws, remaining);
    if (message.event === event) return message;
  }
  throw new Error(`timed out waiting for ${event}`);
}

async function createSessionAndToken(baseUrl, participantId = "agent1") {
  const createdRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json();

  const tokenRes = await fetch(`${baseUrl}/v1/sessions/${created.sessionId}/join-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participantId, role: "agent" })
  });
  assert.equal(tokenRes.status, 200);
  const tokenPayload = await tokenRes.json();
  return { sessionId: created.sessionId, token: tokenPayload.token };
}

test("rejects replayed join token over websocket", async (t) => {
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const { child, getStderr } = startServerForTest(port);

  t.after(() => {
    child.kill("SIGTERM");
  });

  await waitForHealthy(baseUrl);
  const { token } = await createSessionAndToken(baseUrl);

  const ws1 = await connectWs(wsUrl);
  t.after(() => ws1.close());
  await nextMessage(ws1); // connected
  ws1.send(JSON.stringify({ event: "join", data: { token } }));
  const joined = await nextMessage(ws1);
  assert.equal(joined.event, "joined");

  ws1.send(JSON.stringify({ event: "join", data: { token } }));
  const replay = await nextMessage(ws1);
  assert.equal(replay.event, "error");
  assert.equal(replay.data.code, "replay_detected");

  assert.equal(getStderr(), "");
});

test("removes participant after reconnect timeout", async (t) => {
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const { child, getStderr } = startServerForTest(port, 1);

  t.after(() => {
    child.kill("SIGTERM");
  });

  await waitForHealthy(baseUrl);
  const { sessionId, token } = await createSessionAndToken(baseUrl, "agent-timeout");

  const ws = await connectWs(wsUrl);
  await nextMessage(ws); // connected
  ws.send(JSON.stringify({ event: "join", data: { token } }));
  const joined = await nextMessage(ws);
  assert.equal(joined.event, "joined");

  ws.close();
  await delay(2600); // grace + poll + processing

  const participantsRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/participants`);
  assert.equal(participantsRes.status, 200);
  const participants = await participantsRes.json();
  assert.equal(participants.total, 0);

  assert.equal(getStderr(), "");
});

test("echoes requestId on websocket error responses", async (t) => {
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const { child, getStderr } = startServerForTest(port);

  t.after(() => {
    child.kill("SIGTERM");
  });

  await waitForHealthy(baseUrl);
  const ws = await connectWs(wsUrl);
  t.after(() => ws.close());
  await nextMessage(ws); // connected

  const requestId = "req_integration_1";
  ws.send(
    JSON.stringify({
      event: "connectTransport",
      requestId,
      data: { transportId: "t1", dtlsParameters: {} }
    })
  );
  const reply = await nextMessage(ws);
  assert.equal(reply.event, "error");
  assert.equal(reply.requestId, requestId);
  assert.equal(reply.data.code, "unauthorized");
  assert.equal(getStderr(), "");
});

test("requires OTP verification before issuing customer join token", async (t) => {
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, getStderr } = startServerForTest(port);

  t.after(() => {
    child.kill("SIGTERM");
  });

  await waitForHealthy(baseUrl);
  const createdRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json();
  const sessionId = created.sessionId;

  const blockedTokenRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/join-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participantId: "customer-otp-1", role: "customer" })
  });
  assert.equal(blockedTokenRes.status, 403);

  const inviteRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/customer-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participantId: "customer-otp-1", channel: "sms" })
  });
  assert.equal(inviteRes.status, 200);
  const invite = await inviteRes.json();
  assert.equal(invite.otp.code, "123456");

  const verifyRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/customer-verify-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participantId: "customer-otp-1", otp: "123456" })
  });
  assert.equal(verifyRes.status, 200);

  const tokenRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/join-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participantId: "customer-otp-1", role: "customer" })
  });
  assert.equal(tokenRes.status, 200);
  assert.equal(getStderr(), "");
});

test("supports recording start/stop and session disposition endpoints", async (t) => {
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, getStderr } = startServerForTest(port);

  t.after(() => {
    child.kill("SIGTERM");
  });

  await waitForHealthy(baseUrl);
  const createdRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json();
  const sessionId = created.sessionId;

  const startRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/recording/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initiatedBy: "agent-1" })
  });
  assert.equal(startRes.status, 200);
  const started = await startRes.json();
  assert.equal(started.recording.state, "recording");

  const stopRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/recording/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stoppedBy: "agent-1" })
  });
  assert.equal(stopRes.status, 200);
  const stopped = await stopRes.json();
  assert.equal(stopped.recording.state, "stopped");

  const dispositionRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/disposition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome: "resolved", notes: "Issue fixed", resolvedBy: "agent-1" })
  });
  assert.equal(dispositionRes.status, 200);
  const disposition = await dispositionRes.json();
  assert.equal(disposition.disposition.outcome, "resolved");
  assert.equal(getStderr(), "");
});

test("emits chatMessage event when participant sends chat", async (t) => {
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/ws`;
  const { child, getStderr } = startServerForTest(port);

  t.after(() => {
    child.kill("SIGTERM");
  });

  await waitForHealthy(baseUrl);
  const { token: agentToken } = await createSessionAndToken(baseUrl, "agent-chat-1");
  const wsAgent = await connectWs(wsUrl);
  t.after(() => wsAgent.close());
  await nextMessage(wsAgent);
  wsAgent.send(JSON.stringify({ event: "join", data: { token: agentToken } }));
  assert.equal((await nextMessage(wsAgent)).event, "joined");

  wsAgent.send(JSON.stringify({ event: "chatSend", data: { text: "hello customer" }, requestId: "chat_req_1" }));
  const chatEventAgent = await waitForEvent(wsAgent, "chatMessage");
  assert.equal(chatEventAgent.data.text, "hello customer");
  assert.equal(getStderr(), "");
});
