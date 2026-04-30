# Recording Processor Lambda

Post-stop processor for the `segment_upload_mp4` recording flow.

## What it does

1. Receives an event from the backend with `bucket` + `manifestKey`.
2. Downloads `manifest.json` from S3.
3. For each participant entry in the manifest, downloads the participant's `.webm` segment.
4. Runs FFmpeg once to:
   - Side-by-side `hstack` (1–2 participants) or 2×2 `xstack` (3–4 participants) the participant videos at 1280×720, 24 fps.
   - Mix all participant audio tracks via `amix=duration=longest`.
   - Encode video as H.264 (`libx264`, `preset=ultrafast`, `crf=23`, `yuv420p`, `profile=high`, `level=4.0`) and audio as AAC (`128k` default).
5. Uploads the resulting MP4 to `<manifest_dir>/final.mp4` (`+faststart` enabled).
6. Writes a small `processing-result.json` next to the manifest.

The Lambda always emits MP4. WebM is not produced as a final output.

## Expected event

```json
{
  "type": "recording_manifest_finalized",
  "bucket": "your-bucket",
  "manifestKey": "recordings/<session>/<recording>/manifest.json",
  "recordingId": "vc_rec_xxx",
  "sessionId": "vc_sess_xxx"
}
```

## Required runtime env

- `AWS_REGION` (or `AWS_DEFAULT_REGION`)
- `FFMPEG_PATH` (default `/opt/bin/ffmpeg`)

Optional encoder tuning:

- `FINAL_OUTPUT_PREFIX_SUFFIX` (default `final` — produces `final.mp4`)
- `MP4_PRESET` (default `ultrafast`)
- `MP4_CRF` (default `23`)
- `MP4_AUDIO_BITRATE` (default `128k`)

## IAM permissions

The Lambda execution role needs:

- `s3:GetObject` on the manifest + per-participant segment keys.
- `s3:PutObject` on the final MP4 + result JSON keys.

## Packaging notes

The handler requires an FFmpeg binary inside the Lambda environment. Common options:

- A Lambda Layer that provides `/opt/bin/ffmpeg`.
- A Lambda container image with FFmpeg installed (set `FFMPEG_PATH` accordingly).

## Output artifacts

Given:

- `manifestKey = recordings/a/b/manifest.json`

Outputs:

- `recordings/a/b/final.mp4`
- `recordings/a/b/processing-result.json`
