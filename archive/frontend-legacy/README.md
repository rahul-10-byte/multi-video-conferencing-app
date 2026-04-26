# Multi Video Conferencing App Frontend

Simple HTML/JS frontend for Multi Video Conferencing App integration.

## Scope

- Create or reuse session.
- Join via backend-issued token.
- Real mediasoup-client transport handling (send/recv transports).
- WebSocket request correlation using `requestId` for deterministic signaling.
- Basic media controls (audio/video toggle).
- Leave call.
- Automatic reconnect with bounded retries and fresh join-token issuance.
- Live diagnostics panel (RTT/jitter/packet loss/ICE state) with backend `qualityReport` telemetry.
- Status log for signaling responses.

## Run

Serve this directory with any static file server.

Example with Python:

```bash
python -m http.server 8081
```

Then open:

- `http://localhost:8081`

Ensure `vc-backend` is running and update Backend URL in UI if needed.

Note: frontend imports `mediasoup-client` from CDN (`esm.sh`), so internet access is required for first load.
