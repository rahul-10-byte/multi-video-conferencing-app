# End-to-End Scalability Test Plan

This folder contains a practical test kit for validating backend signaling scalability for:

- `250` rooms
- `3` users per room
- total `750` concurrent joins

It also includes a repeatable checklist for media and TURN verification.

## What is automated vs manual

- **Automated (k6)**: Session creation, token issuance, WebSocket join at scale.
- **Manual+metrics**: Media quality, ICE candidate behavior, and TURN relay usage during representative calls.

## Prerequisites

1. Backend reachable on public HTTPS (for example `https://test.heavenhue.in`).
2. `k6` installed on load generator host.
3. `VC_API_KEY` value if API key protection is enabled.
4. Backend and coturn logs available during test run.

## Quick start

Run from `vc-backend`:

```bash
k6 run \
  -e BASE_URL=https://test.heavenhue.in \
  -e API_KEY=123456789 \
  -e ROOM_COUNT=250 \
  -e USERS_PER_ROOM=3 \
  -e VUS=150 \
  -e MAX_DURATION=25m \
  load-tests/k6-signaling-rooms.js
```

## Recommended staged run

Run these in order:

1. `20 rooms x 3 users`
2. `50 rooms x 3 users`
3. `100 rooms x 3 users`
4. `150 rooms x 3 users`
5. `250 rooms x 3 users`

Example:

```bash
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=100 -e USERS_PER_ROOM=3 -e VUS=80 load-tests/k6-signaling-rooms.js
```

### Staged command list (50x3 -> 100x3 -> 150x3 -> 250x3)

Run from `vc-backend`:

```bash
# Stage 1: 50 rooms x 3 users (150 joins)
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=50 -e USERS_PER_ROOM=3 -e VUS=60 -e MAX_DURATION=15m load-tests/k6-signaling-rooms.js

# Stage 2: 100 rooms x 3 users (300 joins)
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=100 -e USERS_PER_ROOM=3 -e VUS=80 -e MAX_DURATION=20m load-tests/k6-signaling-rooms.js

# Stage 3: 150 rooms x 3 users (450 joins)
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=150 -e USERS_PER_ROOM=3 -e VUS=110 -e MAX_DURATION=25m load-tests/k6-signaling-rooms.js

# Stage 4: 250 rooms x 3 users (750 joins)
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=250 -e USERS_PER_ROOM=3 -e VUS=150 -e MAX_DURATION=30m load-tests/k6-signaling-rooms.js
```

## k6 outputs to watch

- `http_req_failed` threshold: `< 2%`
- `join_token_success_rate`: `> 98%`
- `ws_join_success_rate`: `> 97%`
- `join_e2e_ms p95`: `< 3000ms`

## Runtime observability commands

Run these in parallel while k6 is active.

### VC backend

```bash
pm2 logs mvc-app --lines 0 | rg "\[ws\]|failed_to_start|handler_error"
```

### Coturn

```bash
docker logs -f coturn | rg -i "alloc|relay|401|session|timeout"
```

### Host health

```bash
top
sudo ss -s
```

## Media-plane validation (post-load sanity)

After each stage, run a real 2-3 user browser call and verify:

1. `iceConnectionState` becomes `connected`/`completed`.
2. `iceCandidatePair` is not `n/a`.
3. Audio/video render bi-directionally.
4. No spike in coturn allocation timeouts during active media.

## Pass/Fail template

- **PASS**:
  - k6 thresholds pass for target stage.
  - backend stable (no restart loops).
  - browser media call still works after stage.
- **FAIL**:
  - ws join failures > 3%.
  - p95 join latency above 3s sustained.
  - backend process restarts or OOM.
  - post-load media call stuck at ICE `new`.

## Notes

- This script stress-tests signaling and WS join path, not full RTP media throughput.
- For full RTP load testing, add WebRTC bot clients (headless browsers or dedicated SFU load clients).

## Media bot test (real browser WebRTC)

Use Puppeteer bots to exercise create/join + mediasoup send/recv transports with fake media devices.

Install dependencies first:

```bash
npm install
```

Run:

```bash
BASE_URL=https://test.heavenhue.in ROOM_COUNT=20 USERS_PER_ROOM=3 HOLD_SECONDS=120 MAX_OPEN_PAGES=15 npm run load:media-bots
```

Environment knobs:

- `BASE_URL`: backend/frontend URL
- `ROOM_COUNT`: total rooms to create
- `USERS_PER_ROOM`: participants per room (default `3`)
- `HOLD_SECONDS`: per-bot connected hold window
- `MAX_OPEN_PAGES`: browser concurrency cap (important on laptops)
- `HEADLESS`: `true|false` (default `true`)
- `CONNECT_TIMEOUT_MS`: join/connect timeout per participant
- `FAKE_VIDEO_FILE`: optional `.y4m` file path for deterministic fake video
- `FAKE_AUDIO_FILE`: optional `.wav` file path for deterministic fake audio
- `BROWSER_EXECUTABLE_PATH`: optional path to local Chrome/Chromium executable

Example with 30s clip and 10-minute hold:

```bash
BASE_URL=https://test.heavenhue.in ROOM_COUNT=20 USERS_PER_ROOM=3 HOLD_SECONDS=600 MAX_OPEN_PAGES=15 FAKE_VIDEO_FILE=load-tests/assets/bbb_1080p15_30s.y4m FAKE_AUDIO_FILE=load-tests/assets/bbb_audio_10min.wav npm run load:media-bots
```

If you get `spawn UNKNOWN` on Windows, run:

```bash
npx puppeteer browsers install chrome
```

Or use installed Chrome explicitly:

```bash
BASE_URL=https://test.heavenhue.in ROOM_COUNT=20 USERS_PER_ROOM=3 HOLD_SECONDS=600 MAX_OPEN_PAGES=15 FAKE_VIDEO_FILE=load-tests/assets/bbb_1080p15_30s.y4m FAKE_AUDIO_FILE=load-tests/assets/bbb_audio_10min.wav BROWSER_EXECUTABLE_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" npm run load:media-bots
```

Recommended staged media-bot runs:

```bash
# Stage 1
BASE_URL=https://test.heavenhue.in ROOM_COUNT=20 USERS_PER_ROOM=3 HOLD_SECONDS=120 MAX_OPEN_PAGES=15 npm run load:media-bots

# Stage 2
BASE_URL=https://test.heavenhue.in ROOM_COUNT=50 USERS_PER_ROOM=3 HOLD_SECONDS=180 MAX_OPEN_PAGES=20 npm run load:media-bots

# Stage 3
BASE_URL=https://test.heavenhue.in ROOM_COUNT=100 USERS_PER_ROOM=3 HOLD_SECONDS=240 MAX_OPEN_PAGES=25 npm run load:media-bots
```

The runner prints JSON summary with:

- total participants attempted
- successful joins
- failed joins
- participants that reached `iceConnectionState: connected`
- sample errors/diagnostics for quick triage

## Fake-media transport/prod/cons test (no browser)

Use this for efficient mediasoup signaling/media-control stress without launching Chrome.
It exercises:

- `join`
- `createTransport`
- `connectTransport`
- `produce` (audio/video dummy RTP params)
- `listProducers`
- `consume`

Run:

```bash
BASE_URL=https://test.heavenhue.in API_KEY=123456789 ROOM_COUNT=20 USERS_PER_ROOM=3 HOLD_SECONDS=120 CONCURRENCY=30 npm run load:fake-media-ws
```

Staged examples:

```bash
# 50 rooms x 3 users
BASE_URL=https://test.heavenhue.in API_KEY=123456789 ROOM_COUNT=50 USERS_PER_ROOM=3 HOLD_SECONDS=120 CONCURRENCY=45 npm run load:fake-media-ws

# 100 rooms x 3 users
BASE_URL=https://test.heavenhue.in API_KEY=123456789 ROOM_COUNT=100 USERS_PER_ROOM=3 HOLD_SECONDS=180 CONCURRENCY=60 npm run load:fake-media-ws

# 150 rooms x 3 users
BASE_URL=https://test.heavenhue.in API_KEY=123456789 ROOM_COUNT=150 USERS_PER_ROOM=3 HOLD_SECONDS=240 CONCURRENCY=75 npm run load:fake-media-ws
```

Summary output:

- `fake_media_summary.ok`: participants that completed full flow
- `fake_media_summary.failed`: participants that failed any stage
- `sampleErrors`: representative failures for debugging

## Soak mode (keep users connected)

Set `HOLD_SECONDS` to keep each joined WebSocket session alive and send periodic `listProducers` pings.

Example (hold each user for 5 minutes):

```bash
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=250 -e USERS_PER_ROOM=3 -e VUS=150 -e HOLD_SECONDS=300 -e MAX_DURATION=40m load-tests/k6-signaling-rooms.js
```

Suggested staged soak commands:

```bash
# 50 rooms x 3 users, hold 120s
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=50 -e USERS_PER_ROOM=3 -e VUS=60 -e HOLD_SECONDS=120 -e MAX_DURATION=25m load-tests/k6-signaling-rooms.js

# 100 rooms x 3 users, hold 180s
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=100 -e USERS_PER_ROOM=3 -e VUS=80 -e HOLD_SECONDS=180 -e MAX_DURATION=30m load-tests/k6-signaling-rooms.js

# 150 rooms x 3 users, hold 240s
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=150 -e USERS_PER_ROOM=3 -e VUS=110 -e HOLD_SECONDS=240 -e MAX_DURATION=35m load-tests/k6-signaling-rooms.js

# 250 rooms x 3 users, hold 300s
k6 run -e BASE_URL=https://test.heavenhue.in -e API_KEY=123456789 -e ROOM_COUNT=250 -e USERS_PER_ROOM=3 -e VUS=150 -e HOLD_SECONDS=300 -e MAX_DURATION=40m load-tests/k6-signaling-rooms.js
```
