# Recording Processor Lambda

Post-stop processor for the `segment_upload_mp4` recording flow.

## What it does

1. Receives an event from the backend with `bucket` + `manifestKey`.
2. Downloads `manifest.json` from S3.
3. For each participant entry in the manifest, downloads the participant's `.webm` segment.
4. Runs FFmpeg to build the final MP4 (default **dynamic layout**):
   - **Dynamic (default):** `ffprobe` gets each `.webm` duration (one manifest row per stint). The wall-clock timeline is split at every join/leave edge (`joinedOffsetMs` and `joinedOffsetMs + duration`). For each slice, layout matches how many **active segment rows** overlap that slice: **1 → fullscreen 1280×720**, **2 → `hstack`**, **3–4 → `xstack`**. Slice MP4s are concatenated so the output **changes layout** when participants join or leave (up to 4 visible; extras are dropped per slice with a log line). The same `participantId` rejoining after a full mediasoup teardown produces **another manifest row** (new file + `joinedOffsetMs`); static merge still dedupes by participant to one file.
   - **Static (opt-in):** Set `VC_MERGE_LAYOUT=static` to restore the previous single-pass merge (one fixed layout for the whole file, with `joinedOffsetMs` padding on late joiners).
   - Video is normalized to **24 fps**, `yuv420p`; audio is mixed per slice / static path as before; encode **H.264** (`libx264`, `preset=ultrafast`, `crf=23`, `profile=high`, `level=4.0`) and **AAC** (`128k` default).
5. Uploads the resulting MP4 to `<manifest_dir>/final.mp4` (`+faststart` enabled).
6. Writes `processing-result.json` (includes `mergeLayout` and `intervalClipCount` when dynamic).

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
- `FFPROBE_PATH` (optional; default is `ffprobe` next to the `ffmpeg` binary directory — required for **dynamic** layout duration probing)

Optional merge / encoder tuning:

- `VC_MERGE_LAYOUT` — `dynamic` (default) or `static` (legacy single-pass merge).
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

## EC2 off-hours batch (same merge as Lambda)

If the team does not want live Lambda cost or Lambda times out, run the same
handler on an EC2 instance on a schedule (e.g. cron at night). The worker lists
`*/manifest.json` under your S3 prefix, skips jobs that already have
`processing-result.json` with `state: "completed"`, and processes the rest
**one at a time** (queue) by calling the same code as this Lambda.

1. On the instance: **Node 18+**, **ffmpeg** on `PATH` or set **`FFMPEG_PATH`**
   (e.g. `/usr/bin/ffmpeg`), **AWS credentials** (instance role or env) with
   `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on the recordings bucket.

2. Clone or copy this repo, `npm ci`, set env to match production:
   `VC_RECORDING_S3_BUCKET`, `VC_RECORDING_S3_PREFIX` (default `recordings`),
   `AWS_REGION`, `FFMPEG_PATH`.

3. Run manually:

   ```bash
   FFMPEG_PATH=/usr/bin/ffmpeg \
   S3_BUCKET=your-bucket \
   S3_PREFIX=recordings \
   npm run recording-merge-worker -- --since-days=2 --limit=20
   ```

   - **`--since-days=N`** — only manifests whose object `LastModified` in S3 is
     within the last N days (default **1** if unset).
   - **`MERGE_ALL=true`** or **`--all`** — list every manifest under the prefix
     (still obey **`--limit`**).
   - **`--force`** — re-run merge even when `processing-result.json` is already
     `completed`.
   - **`MERGE_USE_MANIFEST_TIME=true`** — after listing, filter by
     `manifest.json` `stoppedAt` (extra S3 reads).

4. Example **cron** (02:00 daily, process yesterday’s window with a safety cap):

   ```cron
   0 2 * * * cd /opt/vc-app && . ./.env && /usr/bin/node scripts/recording-merge-worker.js --since-days=2 --limit=30 >>/var/log/vc-merge.log 2>&1
   ```

   Ensure the VC backend is not required: this job only talks to **S3** + **ffmpeg**.

If recordings still upload during the day, manifests appear in S3 whenever
agents stop a call; the nightly run picks up anything not yet merged (failed or
missing Lambda).
