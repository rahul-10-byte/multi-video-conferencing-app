const path = require("path");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1" });
const ffmpegPath = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";
const outputPrefixSuffix = String(process.env.FINAL_OUTPUT_PREFIX_SUFFIX || "final").replace(/^\/+|\/+$/g, "");

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function runProcess(binary, args, timeoutMs = 14 * 60 * 1000) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_e) {}
      reject(new Error(`process_timeout ${binary}`));
    }, timeoutMs);
    proc.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8000);
    });
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stderr });
        return;
      }
      reject(new Error(`${binary}_failed code=${code} detail=${stderr}`));
    });
  });
}

async function runProcessCapture(binary, args, timeoutMs = 120_000) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_e) {}
      reject(new Error(`process_timeout ${binary}`));
    }, timeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${binary}_failed code=${code} detail=${stderr}`));
    });
  });
}

function resolveFfprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const dir = path.dirname(ffmpegPath);
  return path.join(dir, "ffprobe");
}

async function probeDurationMs(localPath, ffprobePath, fallbackMs) {
  try {
    const { stdout } = await runProcessCapture(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      localPath
    ]);
    const sec = Number.parseFloat(String(stdout).trim());
    if (Number.isFinite(sec) && sec > 0.05) {
      return Math.round(sec * 1000);
    }
  } catch (err) {
    console.warn(`[lambda] ffprobe_failed path=${localPath} error=${err?.message || err}`);
  }
  return Math.max(0, Math.round(Number(fallbackMs) || 0));
}

async function probeHasStream(localPath, ffprobePath, streamLetter) {
  try {
    const { stdout } = await runProcessCapture(ffprobePath, [
      "-v",
      "error",
      "-select_streams",
      streamLetter,
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      localPath
    ]);
    return stdout
      .trim()
      .split("\n")
      .some((line) => line.length > 0);
  } catch {
    return false;
  }
}

/**
 * concat=n=v:a= requires every input to expose both [i:v] and [i:a]. Interval
 * clips occasionally end up video-only or audio-only (e.g. muted / camera-off
 * edge cases), which yields code=234 "matches no streams".
 */
async function normalizeIntervalClipForConcat(ffmpegPath, ffprobePath, clipPath, outPath, audioBitrate) {
  const hasV = await probeHasStream(clipPath, ffprobePath, "v");
  const hasA = await probeHasStream(clipPath, ffprobePath, "a");
  if (hasV && hasA) {
    await fsp.copyFile(clipPath, outPath);
    return;
  }
  const durSec = Math.max((await probeDurationMs(clipPath, ffprobePath, 10_000)) / 1000, 0.05);
  console.warn(
    `[lambda] concat_pad_streams clip=${path.basename(clipPath)} hasV=${hasV} hasA=${hasA} durSec=${durSec.toFixed(3)}`
  );
  if (hasV && !hasA) {
    await runProcess(ffmpegPath, [
      "-y",
      "-loglevel",
      "warning",
      "-i",
      clipPath,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      audioBitrate,
      "-shortest",
      "-movflags",
      "+faststart",
      outPath
    ]);
    return;
  }
  if (!hasV && hasA) {
    await runProcess(ffmpegPath, [
      "-y",
      "-loglevel",
      "warning",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=1280x720:r=24`,
      "-i",
      clipPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-t",
      String(durSec.toFixed(4)),
      "-movflags",
      "+faststart",
      outPath
    ]);
    return;
  }
  throw new Error(`concat_normalize_no_usable_streams path=${clipPath}`);
}

// IMPORTANT: WebM streams from the browser MediaRecorder / mediasoup pipeline
// are VFR and contain many runs of frames with identical PTS (the 1ms
// container tick can't fit bursty packet output). The previous chain used
// `settb=AVTB,setpts=PTS-STARTPTS,fps=24` which, in combination with those
// duplicate PTS values, made `fps` treat ~46% of source frames as past-tense
// duplicates and drop them — collapsing a 10min session to ~3.5min of video
// while audio (`amix=duration=longest`) ran the full length. The fix:
//   - Do NOT touch PTS with `setpts=PTS-STARTPTS` or `settb=AVTB`. Let `fps`
//     resample directly from the container's native PTS.
//   - Pre-pad each branch with `tpad=clone` so `hstack`/`xstack` never
//     starves if one participant's stream genuinely ends early.
//   - Add `-shortest` at the muxer to trim the output to the audio length so
//     we never emit endless cloned frames past the real end of the call.
const TPAD_TAIL = "tpad=stop_mode=clone:stop_duration=7200";
const VIDEO_PREP = "fps=fps=24:round=near,format=yuv420p";

// For each participant who joined AFTER the recording started, prepend
// `tpad=start_duration=<sec>:start_mode=add:color=black` to video and `adelay=<ms>` to
// audio so the merged timeline lines up: their tile only appears at their actual
// join moment instead of being squashed back to t=0.
function videoOffsetPrefix(joinedOffsetMs) {
  const sec = Math.max(Number(joinedOffsetMs) || 0, 0) / 1000;
  if (sec <= 0.05) return "";
  return `tpad=start_duration=${sec.toFixed(3)}:start_mode=add:color=black,`;
}

function audioOffsetPrefix(joinedOffsetMs) {
  const ms = Math.max(Math.round(Number(joinedOffsetMs) || 0), 0);
  if (ms <= 50) return "";
  return `adelay=${ms}|${ms},`;
}

function buildMergeArgs(participantInputs, outputFile) {
  const args = ["-loglevel", "warning"];
  for (const input of participantInputs) {
    args.push("-fflags", "+genpts", "-avoid_negative_ts", "make_zero", "-i", input.localPath);
  }
  const videoCount = participantInputs.length;
  const audioCount = participantInputs.length;
  const filters = [];
  const videoOffsets = participantInputs.map((p) => videoOffsetPrefix(p.joinedOffsetMs));
  if (videoCount === 1) {
    filters.push(`[0:v]${videoOffsets[0]}${VIDEO_PREP},scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]`);
  } else if (videoCount === 2) {
    filters.push(`[0:v]${videoOffsets[0]}${VIDEO_PREP},scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,${TPAD_TAIL}[v0]`);
    filters.push(`[1:v]${videoOffsets[1]}${VIDEO_PREP},scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,${TPAD_TAIL}[v1]`);
    filters.push("[v0][v1]hstack=inputs=2:shortest=0[vout]");
  } else {
    const capped = Math.min(videoCount, 4);
    for (let i = 0; i < capped; i += 1) {
      filters.push(`[${i}:v]${videoOffsets[i]}${VIDEO_PREP},scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,${TPAD_TAIL}[v${i}]`);
    }
    const joined = Array.from({ length: capped }, (_v, i) => `[v${i}]`).join("");
    const layout = capped === 3 ? "0_0|640_0|0_360" : "0_0|640_0|0_360|640_360";
    filters.push(`${joined}xstack=inputs=${capped}:layout=${layout}:fill=black:shortest=0[vout]`);
  }
  if (audioCount > 0) {
    const cappedAudio = Math.min(audioCount, 6);
    const audioPrep = Array.from({ length: cappedAudio }, (_v, i) => `[${i}:a]${audioOffsetPrefix(participantInputs[i].joinedOffsetMs)}aresample=async=1:first_pts=0[a${i}]`).join(";");
    filters.push(`${audioPrep};${Array.from({ length: cappedAudio }, (_v, i) => `[a${i}]`).join("")}amix=inputs=${cappedAudio}:duration=longest:dropout_transition=2[aout]`);
  }
  args.push("-filter_complex", filters.join(";"));
  const preset = String(process.env.MP4_PRESET || "ultrafast");
  const crf = String(process.env.MP4_CRF || "23");
  const audioBitrate = String(process.env.MP4_AUDIO_BITRATE || "128k");
  args.push(
    "-map", "[vout]",
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", crf,
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.0"
  );
  if (audioCount > 0) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", audioBitrate);
  }
  if (videoCount > 1) args.push("-shortest");
  args.push("-movflags", "+faststart", "-f", "mp4", outputFile);
  return args;
}

function useStaticMergeLayout() {
  return String(process.env.VC_MERGE_LAYOUT || "dynamic").toLowerCase() === "static";
}

function collectTimelineBoundaries(participants, timelineEndMs) {
  const raw = new Set();
  raw.add(0);
  raw.add(Math.max(1, Math.round(timelineEndMs)));
  for (const p of participants) {
    raw.add(Math.round(p.joinedOffsetMs));
    raw.add(Math.round(p.joinedOffsetMs + p.durationMs));
  }
  const sorted = Array.from(raw).sort((a, b) => a - b);
  const deduped = [];
  for (const x of sorted) {
    if (deduped.length === 0 || x - deduped[deduped.length - 1] > 25) {
      deduped.push(x);
    }
  }
  return deduped;
}

function activeParticipantsInInterval(participants, t0, t1) {
  return participants.filter((p) => p.joinedOffsetMs < t1 && p.joinedOffsetMs + p.durationMs > t0);
}

async function renderIntervalClip({
  ffmpegPath,
  clipIndex,
  intervalStartMs,
  intervalEndMs,
  actives,
  preset,
  crf,
  audioBitrate,
  tmpRoot
}) {
  const outPath = path.join(tmpRoot, `clip-${String(clipIndex).padStart(4, "0")}.mp4`);
  const durationSec = (intervalEndMs - intervalStartMs) / 1000;
  if (durationSec < 0.04) return null;

  const capped = actives
    .slice()
    .sort(
      (a, b) =>
        a.joinedOffsetMs - b.joinedOffsetMs || String(a.participantId).localeCompare(String(b.participantId))
    )
    .slice(0, 4);
  const n = capped.length;
  if (n === 0) return null;

  const args = ["-loglevel", "warning", "-y"];
  for (const p of capped) {
    args.push("-fflags", "+genpts", "-avoid_negative_ts", "make_zero", "-i", p.localPath);
  }

  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const p = capped[i];
    const join = p.joinedOffsetMs;
    const startSec = Math.max(0, (intervalStartMs - join) / 1000);
    const endSec = Math.min(p.durationMs / 1000, (intervalEndMs - join) / 1000);
    if (endSec <= startSec + 0.02) {
      console.warn(`[lambda] skip_interval_clip empty_trim participant=${p.participantId} t0=${intervalStartMs} t1=${intervalEndMs}`);
      return null;
    }
    parts.push(
      `[${i}:v]trim=start=${startSec.toFixed(4)}:end=${endSec.toFixed(4)},setpts=PTS-STARTPTS,${VIDEO_PREP}[vs${i}]`
    );
    parts.push(
      `[${i}:a]atrim=start=${startSec.toFixed(4)}:end=${endSec.toFixed(4)},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[as${i}]`
    );
  }

  if (n === 1) {
    parts.push(
      `[vs0]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]`
    );
    parts.push(`[as0]aformat=sample_rates=48000:sample_fmts=fltp:channel_layouts=stereo[aout]`);
  } else if (n === 2) {
    parts.push(
      `[vs0]scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2[c0];[vs1]scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2[c1]`
    );
    parts.push(`[c0][c1]hstack=inputs=2:shortest=1[vout]`);
    parts.push(`[as0][as1]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
  } else {
    const nc = n;
    const scales = [];
    for (let i = 0; i < nc; i += 1) {
      scales.push(
        `[vs${i}]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[c${i}]`
      );
    }
    parts.push(scales.join(";"));
    const joined = Array.from({ length: nc }, (_v, i) => `[c${i}]`).join("");
    const layout = nc === 3 ? "0_0|640_0|0_360" : "0_0|640_0|0_360|640_360";
    parts.push(`${joined}xstack=inputs=${nc}:layout=${layout}:fill=black:shortest=1[vout]`);
    const astr = Array.from({ length: nc }, (_v, i) => `[as${i}]`).join("");
    parts.push(`${astr}amix=inputs=${nc}:duration=first:dropout_transition=2[aout]`);
  }

  args.push("-filter_complex", parts.join(";"));
  args.push(
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    crf,
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-t",
    durationSec.toFixed(4),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outPath
  );

  await runProcess(ffmpegPath, args);
  return outPath;
}

async function concatMp4Clips(ffmpegPath, ffprobePath, clipPaths, outputFile, timeoutMs) {
  if (clipPaths.length === 0) throw new Error("no_clips_to_concat");
  const audioBitrate = String(process.env.MP4_AUDIO_BITRATE || "128k");
  const tmpDir = path.dirname(clipPaths[0]);
  const normalized = [];
  for (let i = 0; i < clipPaths.length; i += 1) {
    const normPath = path.join(tmpDir, `concat-norm-${i}.mp4`);
    await normalizeIntervalClipForConcat(ffmpegPath, ffprobePath, clipPaths[i], normPath, audioBitrate);
    normalized.push(normPath);
  }
  if (normalized.length === 1) {
    await fsp.copyFile(normalized[0], outputFile);
    return;
  }
  const preset = String(process.env.MP4_PRESET || "ultrafast");
  const crf = String(process.env.MP4_CRF || "23");
  const args = ["-loglevel", "warning", "-y"];
  for (const c of normalized) {
    args.push("-i", c);
  }
  const pairs = [];
  for (let i = 0; i < normalized.length; i += 1) {
    pairs.push(`[${i}:v][${i}:a]`);
  }
  const fc = `${pairs.join("")}concat=n=${normalized.length}:v=1:a=1[v][a]`;
  args.push("-filter_complex", fc);
  args.push(
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    crf,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-movflags",
    "+faststart",
    outputFile
  );
  await runProcess(ffmpegPath, args, timeoutMs);
}

async function runDynamicTimelineMerge({ participantInputs, manifest, tmpRoot, finalOutput }) {
  const ffprobePath = resolveFfprobePath();
  const recordingDurationMs = Number.isFinite(Number(manifest.durationMs)) ? Number(manifest.durationMs) : 0;

  for (const p of participantInputs) {
    const fallback = Math.max(0, recordingDurationMs - p.joinedOffsetMs);
    p.durationMs = await probeDurationMs(p.localPath, ffprobePath, fallback);
    if (p.durationMs < 200 && recordingDurationMs > p.joinedOffsetMs + 200) {
      p.durationMs = Math.max(p.durationMs, recordingDurationMs - p.joinedOffsetMs);
    }
  }

  const ends = participantInputs.map((p) => p.joinedOffsetMs + p.durationMs);
  const timelineEndMs = Math.max(recordingDurationMs || 0, ...ends, 500);

  const boundaries = collectTimelineBoundaries(participantInputs, timelineEndMs);
  const preset = String(process.env.MP4_PRESET || "ultrafast");
  const crf = String(process.env.MP4_CRF || "23");
  const audioBitrate = String(process.env.MP4_AUDIO_BITRATE || "128k");

  const clipPaths = [];
  let clipIndex = 0;

  for (let b = 0; b < boundaries.length - 1; b += 1) {
    const t0 = boundaries[b];
    const t1 = boundaries[b + 1];
    if (t1 - t0 < 40) continue;

    let actives = activeParticipantsInInterval(participantInputs, t0, t1);
    if (actives.length === 0) continue;
    if (actives.length > 4) {
      console.warn(`[lambda] interval_cap t0=${t0} t1=${t1} count=${actives.length}`);
      actives = actives
        .slice()
        .sort(
          (a, b) =>
            a.joinedOffsetMs - b.joinedOffsetMs || String(a.participantId).localeCompare(String(b.participantId))
        )
        .slice(0, 4);
    }

    const clip = await renderIntervalClip({
      ffmpegPath,
      clipIndex,
      intervalStartMs: t0,
      intervalEndMs: t1,
      actives,
      preset,
      crf,
      audioBitrate,
      tmpRoot
    });
    if (clip) {
      clipPaths.push(clip);
      clipIndex += 1;
    }
  }

  if (clipPaths.length === 0) {
    throw new Error("dynamic_merge_no_clips");
  }

  await concatMp4Clips(ffmpegPath, ffprobePath, clipPaths, finalOutput, 14 * 60 * 1000);
  console.log(
    `[lambda] dynamic_merge_done clips=${clipPaths.length} timelineEndMs=${timelineEndMs} boundaries=${boundaries.length}`
  );
  return { mergeLayout: "dynamic", intervalClipCount: clipPaths.length };
}

async function buildParticipantInputsForMerge(bucket, segments, tmpRoot) {
  if (useStaticMergeLayout()) {
    const byParticipant = new Map();
    for (const seg of segments) {
      if (!seg?.key) continue;
      const participantId = String(seg.participantId || "unknown");
      const list = byParticipant.get(participantId) || [];
      list.push(seg);
      byParticipant.set(participantId, list);
    }
    if (byParticipant.size === 0) throw new Error("manifest_has_no_valid_segment_keys");
    const participantInputs = [];
    for (const [participantId, participantSegments] of byParticipant.entries()) {
      participantSegments.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0));
      const seg = participantSegments[0];
      const safeId = participantId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const localFile = path.join(tmpRoot, `${safeId}.webm`);
      await downloadToFile(bucket, seg.key, localFile);
      const stat = await fsp.stat(localFile);
      const joinedOffsetMs = Number.isFinite(Number(seg.joinedOffsetMs)) ? Number(seg.joinedOffsetMs) : 0;
      console.log(
        `[lambda] segment_downloaded layout=static participant=${participantId} sizeBytes=${stat.size} joinedOffsetMs=${joinedOffsetMs}`
      );
      participantInputs.push({ participantId, localPath: localFile, joinedOffsetMs });
    }
    participantInputs.sort(
      (a, b) => a.joinedOffsetMs - b.joinedOffsetMs || String(a.participantId).localeCompare(String(b.participantId))
    );
    return participantInputs;
  }

  const flat = segments.filter((s) => s?.key);
  if (flat.length === 0) throw new Error("manifest_has_no_valid_segment_keys");
  flat.sort((a, b) => {
    const ja = Number.isFinite(Number(a.joinedOffsetMs)) ? Number(a.joinedOffsetMs) : 0;
    const jb = Number.isFinite(Number(b.joinedOffsetMs)) ? Number(b.joinedOffsetMs) : 0;
    if (ja !== jb) return ja - jb;
    return String(a.key).localeCompare(String(b.key));
  });
  const participantInputs = [];
  for (let i = 0; i < flat.length; i += 1) {
    const seg = flat[i];
    const participantId = String(seg.participantId || "unknown");
    const safeId = participantId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const localFile = path.join(tmpRoot, `s${i}_${safeId}.webm`);
    await downloadToFile(bucket, seg.key, localFile);
    const stat = await fsp.stat(localFile);
    const joinedOffsetMs = Number.isFinite(Number(seg.joinedOffsetMs)) ? Number(seg.joinedOffsetMs) : 0;
    console.log(
      `[lambda] segment_downloaded layout=dynamic_row participant=${participantId} idx=${i} sizeBytes=${stat.size} joinedOffsetMs=${joinedOffsetMs}`
    );
    participantInputs.push({
      participantId,
      localPath: localFile,
      joinedOffsetMs,
      manifestKey: seg.key
    });
  }
  return participantInputs;
}

async function downloadToFile(bucket, key, localPath) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buffer = await streamToBuffer(response.Body);
  await fsp.writeFile(localPath, buffer);
}

function buildResultKey(manifestKey) {
  const dir = path.posix.dirname(manifestKey);
  return `${dir}/processing-result.json`;
}

function buildFinalKey(manifestKey) {
  const dir = path.posix.dirname(manifestKey);
  return `${dir}/${outputPrefixSuffix}.mp4`;
}

async function uploadJson(bucket, key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(value, null, 2),
    ContentType: "application/json"
  }));
}

exports.handler = async (event) => {
  const bucket = event?.bucket;
  const manifestKey = event?.manifestKey;
  if (!bucket || !manifestKey) {
    throw new Error("invalid_event_missing_bucket_or_manifest_key");
  }
  console.log(`[lambda] event_received bucket=${bucket} manifestKey=${manifestKey}`);

  const handlerStartMs = Date.now();
  const startedAt = new Date().toISOString();
  const resultKey = buildResultKey(manifestKey);
  const tmpRoot = path.join("/tmp", `vc-merge-${Date.now()}`);
  await fsp.mkdir(tmpRoot, { recursive: true });

  try {
    const manifestResp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey }));
    const manifestRaw = await streamToBuffer(manifestResp.Body);
    const manifest = JSON.parse(manifestRaw.toString("utf8"));
    const segments = Array.isArray(manifest.segments) ? manifest.segments : [];
    if (segments.length === 0) throw new Error("manifest_has_no_segments");
    console.log(
      `[lambda] manifest_loaded sessionId=${manifest.sessionId || "?"} recordingId=${manifest.recordingId || "?"} segments=${segments.length}`
    );

    const participantInputs = await buildParticipantInputsForMerge(bucket, segments, tmpRoot);

    const finalOutput = path.join(tmpRoot, "final-merged.mp4");
    const mergeStartMs = Date.now();
    let mergeMeta = { mergeLayout: "static", intervalClipCount: 1 };
    if (useStaticMergeLayout()) {
      const mergeArgs = buildMergeArgs(participantInputs, finalOutput);
      console.log(`[lambda] merge_started layout=static participants=${participantInputs.length}`);
      await runProcess(ffmpegPath, mergeArgs);
    } else {
      console.log(`[lambda] merge_started layout=dynamic participants=${participantInputs.length}`);
      mergeMeta = await runDynamicTimelineMerge({ participantInputs, manifest, tmpRoot, finalOutput });
    }
    const finalStat = await fsp.stat(finalOutput);
    console.log(
      `[lambda] merge_complete layout=${mergeMeta.mergeLayout} clips=${mergeMeta.intervalClipCount} durationMs=${Date.now() - mergeStartMs} outputBytes=${finalStat.size}`
    );

    const finalKey = buildFinalKey(manifestKey);
    const finalBody = await fsp.readFile(finalOutput);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: finalKey,
      Body: finalBody,
      ContentType: "video/mp4"
    }));
    console.log(`[lambda] final_uploaded bucket=${bucket} key=${finalKey} sizeBytes=${finalBody.length}`);

    const finishedAt = new Date().toISOString();
    const result = {
      state: "completed",
      startedAt,
      finishedAt,
      recordingId: manifest.recordingId || null,
      sessionId: manifest.sessionId || null,
      manifestKey,
      finalKey,
      participantCount: participantInputs.length,
      segmentCount: segments.length,
      mergeLayout: mergeMeta.mergeLayout,
      intervalClipCount: mergeMeta.intervalClipCount
    };
    await uploadJson(bucket, resultKey, result);
    console.log(
      `[lambda] processing_completed sessionId=${manifest.sessionId || "?"} recordingId=${manifest.recordingId || "?"} totalMs=${Date.now() - handlerStartMs} finalKey=${finalKey}`
    );
    return result;
  } catch (error) {
    console.error(
      `[lambda] processing_failed manifestKey=${manifestKey} totalMs=${Date.now() - handlerStartMs} error=${error?.name || "Error"}: ${error?.message || String(error)}`
    );
    const failed = {
      state: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      manifestKey,
      error: error.message || "unknown_processing_error"
    };
    await uploadJson(bucket, resultKey, failed);
    throw error;
  } finally {
    try {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    } catch (_e) {}
  }
};
