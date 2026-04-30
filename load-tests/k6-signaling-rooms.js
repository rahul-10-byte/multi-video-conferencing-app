import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "https://test.heavenhue.in";
const API_KEY = __ENV.API_KEY || "";
const ROOM_COUNT = Number(__ENV.ROOM_COUNT || 250);
const USERS_PER_ROOM = Number(__ENV.USERS_PER_ROOM || 3);
const TEST_DURATION_SECONDS = Number(__ENV.TEST_DURATION_SECONDS || 120);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 0);

const joinTokenSuccess = new Rate("join_token_success_rate");
const wsJoinSuccess = new Rate("ws_join_success_rate");
const endToEndJoinMs = new Trend("join_e2e_ms");
const roomsCreatedTotal = new Counter("rooms_created_total");

function authHeaders(extra = {}) {
  const headers = {
    "content-type": "application/json",
    ...extra
  };
  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
    headers.Authorization = `Bearer ${API_KEY}`;
  }
  return headers;
}

function createSession(roomName) {
  const payload = JSON.stringify({
    externalRef: roomName,
    metadata: { roomName }
  });
  const res = http.post(`${BASE_URL}/v1/sessions`, payload, {
    headers: authHeaders()
  });
  const ok = check(res, {
    "create session 201": (r) => r.status === 201
  });
  if (!ok) return null;
  roomsCreatedTotal.add(1);
  return res.json("sessionId");
}

function issueJoinToken(sessionId, participantId, role) {
  const payload = JSON.stringify({ participantId, role });
  const res = http.post(
    `${BASE_URL}/v1/sessions/${sessionId}/join-token`,
    payload,
    { headers: authHeaders() }
  );
  const ok = check(res, {
    "join token 200": (r) => r.status === 200
  });
  joinTokenSuccess.add(ok);
  if (!ok) return null;
  return {
    token: res.json("token"),
    wsUrl: res.json("wsUrl")
  };
}

function wsJoin(wsUrl, token) {
  const started = Date.now();
  let joined = false;
  let shouldCloseAfterHold = false;

  const response = ws.connect(wsUrl, null, function (socket) {
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          event: "join",
          requestId: `req_${__VU}_${__ITER}_${Date.now()}`,
          data: { token }
        })
      );
    });

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.event === "joined") {
          joined = true;
          const elapsed = Date.now() - started;
          endToEndJoinMs.add(elapsed);
          if (HOLD_SECONDS > 0) {
            shouldCloseAfterHold = true;
          } else {
            socket.close();
          }
        }
      } catch (_err) {
        // Ignore malformed frames during load test.
      }
    });

    if (HOLD_SECONDS > 0) {
      socket.setInterval(function () {
        socket.send(
          JSON.stringify({
            event: "listProducers",
            requestId: `req_ping_${__VU}_${__ITER}_${Date.now()}`,
            data: {}
          })
        );
      }, 10000);
    }

    if (HOLD_SECONDS > 0) {
      socket.setTimeout(function () {
        if (shouldCloseAfterHold) {
          socket.close();
        }
      }, Math.max(1000, HOLD_SECONDS * 1000));
    }

    socket.setTimeout(function () {
      socket.close();
    }, Number(__ENV.WS_JOIN_TIMEOUT_MS || 8000) + Math.max(0, HOLD_SECONDS * 1000));
  });

  const upgraded = check(response, {
    "ws connect 101": (r) => r && r.status === 101
  });
  return upgraded && joined;
}

export const options = {
  scenarios: {
    rooms_3_users: {
      executor: "shared-iterations",
      vus: Number(__ENV.VUS || 150),
      iterations: ROOM_COUNT * USERS_PER_ROOM,
      maxDuration: __ENV.MAX_DURATION || "20m"
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    join_token_success_rate: ["rate>0.98"],
    ws_join_success_rate: ["rate>0.97"],
    join_e2e_ms: ["p(95)<3000"]
  }
};

export default function () {
  const idx = __ITER;
  const roomIdx = Math.floor(idx / USERS_PER_ROOM);
  const userInRoom = idx % USERS_PER_ROOM;
  const roomName = `load-room-${roomIdx}`;

  const role = userInRoom === 0 ? "agent" : "customer";
  const participantId = `u-${roomIdx}-${userInRoom}-${__VU}`;
  const start = Date.now();

  let sessionId = null;
  if (userInRoom === 0) {
    sessionId = createSession(roomName);
  } else {
    const resolveRes = http.get(
      `${BASE_URL}/v1/sessions/resolve?roomName=${encodeURIComponent(roomName)}`,
      { headers: authHeaders() }
    );
    check(resolveRes, {
      "resolve session 200|404": (r) => r.status === 200 || r.status === 404
    });
    if (resolveRes.status === 200) {
      sessionId = resolveRes.json("sessionId");
    } else {
      sessionId = createSession(roomName);
    }
  }

  if (!sessionId) {
    wsJoinSuccess.add(false);
    return;
  }

  const joinToken = issueJoinToken(sessionId, participantId, role);
  if (!joinToken?.token || !joinToken?.wsUrl) {
    wsJoinSuccess.add(false);
    return;
  }

  const joined = wsJoin(joinToken.wsUrl, joinToken.token);
  wsJoinSuccess.add(joined);

  const elapsed = Date.now() - start;
  if (elapsed < TEST_DURATION_SECONDS * 10) {
    sleep(Number(__ENV.SLEEP_SECONDS || 0.2));
  }
}
