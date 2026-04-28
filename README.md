# Multi Video Conferencing App

Contract-first backend scaffold for Multi Video Conferencing App aligned to `MEDIASOUP_ONLY_VC_PLAN.md`.

## Implemented in this increment

- VC API v1 endpoint stubs:
  - `POST /v1/sessions`
  - `POST /v1/sessions/{sessionId}/join-token`
  - `POST /v1/sessions/{sessionId}/customer-invite`
  - `POST /v1/sessions/{sessionId}/customer-verify-otp`
  - `GET /v1/ice-servers`
  - `GET /v1/sessions/{sessionId}/participants`
  - `POST /v1/sessions/{sessionId}/leave`
  - `POST /v1/sessions/{sessionId}/recording/start`
  - `POST /v1/sessions/{sessionId}/recording/stop`
  - `POST /v1/sessions/{sessionId}/disposition`
  - `GET /v1/sessions/{sessionId}`
  - `GET /healthz`, `GET /readyz`, `GET /metrics`
- WebSocket endpoint: `GET /v1/ws`
- Join token validation with replay protection (`jti` single-use).
- In-memory session and participant store with TTL sweeper.
- Mediasoup worker startup and per-session router lifecycle.
- Optional API key protection for admin/control REST routes (`VC_API_KEY`).
- Reconnect grace handling (`VC_RECONNECT_GRACE_SECONDS`) with state transition to `reconnecting`.
- Reconnect cleanup worker (`VC_RECONNECT_CLEANUP_*`).
- Structured event emission (`EVENT_JSON`) for `session_created`, `participant_joined`, `participant_left`, `session_ended`.
- Quality telemetry ingest (`qualityReport`) with Prometheus metrics and `quality_alert` events.
- Optional Postgres read model persistence for events (`DATABASE_URL`).
- WebRTC transport/producers/consumers flow over WS:
  - `createTransport`
  - `connectTransport`
  - `produce`
  - `listProducers`
  - `consume`
  - `pauseProducer` / `resumeProducer`
  - `chatSend` / `chatMessage`
  - `deviceChanged`
- OpenAPI contract and WS schema under `contracts/`.
- Admin read-model endpoints:
  - `GET /v1/admin/sessions`
  - `GET /v1/admin/sessions/{sessionId}/events`
- Lean SQL read-model tables:
  - `vc_sessions` (includes `invite_links`)
  - `vc_recordings`
  - `vc_dispositions`
  - `vc_session_events`

## Not yet implemented

- TURN REST short-lived credential issuance.
- Production OTP/SMS/email provider integration (current OTP is in-memory test mode).

## Recording (FFmpeg pipeline)

- Recording APIs now spawn an FFmpeg process and store a `.webm` file per session.
- Output path is saved in `recording.storageUri` and persisted in `vc_recordings`.
- Required on server: FFmpeg installed and available in PATH (or set `VC_FFMPEG_PATH`).
- Config:
  - `VC_RECORDING_ENABLED=true`
  - `VC_FFMPEG_PATH=ffmpeg`
  - `VC_RECORDING_OUTPUT_DIR=recordings`
  - `VC_RECORDING_HOST_IP=127.0.0.1`
  - `VC_RECORDING_BASE_PORT=50040`

### Segment Upload + Lambda processing

For incremental S3 uploads and async post-processing:

- `VC_RECORDING_MODE=segment_upload`
- `VC_RECORDING_ENGINE=ffmpeg`
- `VC_RECORDING_CHUNK_SECONDS=5`
- `VC_RECORDING_S3_BUCKET=<bucket>`
- `VC_RECORDING_S3_PREFIX=recordings`
- `VC_RECORDING_PROCESSING_LAMBDA=<lambda-name>`
- `AWS_REGION=<region>`

Lambda handler template is included at:

- `lambda/recording-processor/index.js`
- `lambda/recording-processor/README.md`

## Run

1. Copy `.env.example` to `.env` and update values.
2. Install dependencies:

```bash
npm install
```

3. Start server:

```bash
npm run dev
```

Server default URL: `http://localhost:9000`

## Scalability testing

Use the end-to-end signaling load kit in `load-tests/`:

- Script: `load-tests/k6-signaling-rooms.js`
- Media bot runner: `load-tests/media-bot-runner.js`
- Guide: `load-tests/README.md`

Example run:

```bash
k6 run \
  -e BASE_URL=https://test.heavenhue.in \
  -e API_KEY=123456789 \
  -e ROOM_COUNT=250 \
  -e USERS_PER_ROOM=3 \
  -e VUS=150 \
  load-tests/k6-signaling-rooms.js
```
