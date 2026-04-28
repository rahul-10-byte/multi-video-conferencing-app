# Recording Processor Lambda

Minimal post-stop processor for the `segment_upload` backend flow.

## What it does

1. Receives event payload from backend:
   - `bucket`
   - `manifestKey`
2. Reads `manifest.json` from S3.
3. Downloads chunk files grouped by participant.
4. Concats per-participant chunk sequence with FFmpeg.
5. If multiple participants exist, merges participant files into one final WebM.
6. Uploads final media to:
   - `<manifest_dir>/final.webm`
7. Uploads processing status to:
   - `<manifest_dir>/processing-result.json`

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

Optional:

- `FINAL_OUTPUT_PREFIX_SUFFIX` (default `final`)

## IAM permissions

Lambda role needs:

- `s3:GetObject` on manifest/chunk keys
- `s3:PutObject` on final/result keys

## Packaging notes

- This handler requires an FFmpeg binary available in Lambda.
- Common options:
  - Lambda Layer containing `/opt/bin/ffmpeg`
  - Lambda container image with FFmpeg installed

## Output artifacts

Given:

- `manifestKey = recordings/a/b/manifest.json`

Outputs:

- `recordings/a/b/final.webm`
- `recordings/a/b/processing-result.json`
