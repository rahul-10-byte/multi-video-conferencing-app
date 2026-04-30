# Multi Video Conferencing App

Mediasoup-based backend for the Multi Video Conferencing App, aligned to
`MEDIASOUP_ONLY_VC_PLAN.md`.

## API surface

The full REST + WebSocket surface is documented in `contracts/`:

- `contracts/openapi.yaml` — OpenAPI 3.0 spec for every `/v1/*`, `/healthz`,
  `/readyz`, and `/metrics` route.
- `contracts/asyncapi.yaml` — AsyncAPI 2.6 spec for the `/v1/ws` channel,
  covering all client-to-server and server-to-client message types.

Render either with the official viewers (Swagger UI, Redoc, AsyncAPI Studio,
etc.) — neither file is enforced at runtime, so keep them in sync when you
change the wire format.

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

## Recording

The backend supports a single recording flow: per-participant WebM capture on
the server, S3 upload on stop, and asynchronous merge into a final MP4 by an
AWS Lambda function.

### How it works

1. On `POST /v1/sessions/{id}/recording/start` the server creates one
   plain-RTP transport per producer, consumes audio + video for each
   participant, and spawns an FFmpeg process that writes a single
   `.webm` file per participant to `VC_RECORDING_OUTPUT_DIR`.
2. On `POST /v1/sessions/{id}/recording/stop` each FFmpeg process is
   gracefully stopped (`SIGINT` flush), every per-participant `.webm` is
   uploaded to S3, a `manifest.json` is written next to them, and the
   recording-processor Lambda is invoked asynchronously with the manifest
   key.
3. The Lambda downloads the per-participant WebMs, hstacks/xstacks them
   with audio mix, encodes a single `final.mp4`, and writes a small
   `processing-result.json`. See `lambda/recording-processor/README.md`.
4. The server deletes the local `.webm` files after a successful upload
   to keep disk usage bounded. If upload or Lambda invocation fails, the
   local files are kept for manual recovery.

### Required server config

- FFmpeg installed and available in `PATH` (or set `VC_FFMPEG_PATH`).
- AWS credentials available to the process (instance role, profile, or
  static keys).

### Environment variables

| Var | Purpose | Example |
|---|---|---|
| `VC_RECORDING_ENABLED` | master on/off switch | `true` |
| `VC_FFMPEG_PATH` | ffmpeg binary path | `ffmpeg` |
| `VC_RECORDING_OUTPUT_DIR` | local scratch dir | `recordings` |
| `VC_RECORDING_HOST_IP` | IP that the SDP advertises for plain-RTP transport | `127.0.0.1` |
| `VC_RECORDING_BASE_PORT` | base UDP port (allocator increments by 2) | `50040` |
| `VC_RECORDING_S3_BUCKET` | bucket for per-participant + final artifacts | `atlas-vc-recordings` |
| `VC_RECORDING_S3_PREFIX` | key prefix inside the bucket | `recordings` |
| `VC_RECORDING_PROCESSING_LAMBDA` | Lambda function to invoke on stop | `atlas-vc-recording-processor` |
| `AWS_REGION` | region for S3 + Lambda clients | `ap-south-2` |

### S3 layout

```
s3://<bucket>/<prefix>/<sessionId>/<recordingId>/
    ├── <participantA>/<recordingId>_<participantA>.webm
    ├── <participantB>/<recordingId>_<participantB>.webm
    ├── manifest.json
    ├── final.mp4                    (written by Lambda)
    └── processing-result.json       (written by Lambda)
```

### Lambda

Source lives in this repo at `lambda/recording-processor/`. Deploy with:

```bash
cd lambda/recording-processor
zip recording-processor.zip index.js
aws lambda update-function-code \
  --region <region> \
  --function-name <function-name> \
  --zip-file fileb://recording-processor.zip
```

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
