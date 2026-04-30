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

function buildMergeArgs(participantFiles, outputFile) {
  const args = ["-loglevel", "warning"];
  for (const input of participantFiles) {
    args.push("-fflags", "+genpts", "-avoid_negative_ts", "make_zero", "-i", input);
  }
  const videoCount = participantFiles.length;
  const audioCount = participantFiles.length;
  const filters = [];
  if (videoCount === 1) {
    filters.push(`[0:v]${VIDEO_PREP},scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]`);
  } else if (videoCount === 2) {
    filters.push(`[0:v]${VIDEO_PREP},scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,${TPAD_TAIL}[v0]`);
    filters.push(`[1:v]${VIDEO_PREP},scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,${TPAD_TAIL}[v1]`);
    filters.push("[v0][v1]hstack=inputs=2:shortest=0[vout]");
  } else {
    const capped = Math.min(videoCount, 4);
    for (let i = 0; i < capped; i += 1) {
      filters.push(`[${i}:v]${VIDEO_PREP},scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,${TPAD_TAIL}[v${i}]`);
    }
    const joined = Array.from({ length: capped }, (_v, i) => `[v${i}]`).join("");
    const layout = capped === 3 ? "0_0|640_0|0_360" : "0_0|640_0|0_360|640_360";
    filters.push(`${joined}xstack=inputs=${capped}:layout=${layout}:fill=black:shortest=0[vout]`);
  }
  if (audioCount > 0) {
    const cappedAudio = Math.min(audioCount, 6);
    const audioPrep = Array.from({ length: cappedAudio }, (_v, i) => `[${i}:a]aresample=async=1:first_pts=0[a${i}]`).join(";");
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

    // segment_upload_mp4 mode emits exactly one .webm per participant. If we
    // ever receive more than one segment for a participant (legacy data),
    // pick the largest one — falling back to a stable order so the merge
    // stays deterministic.
    const byParticipant = new Map();
    for (const seg of segments) {
      if (!seg?.key) continue;
      const participantId = String(seg.participantId || "unknown");
      const list = byParticipant.get(participantId) || [];
      list.push(seg);
      byParticipant.set(participantId, list);
    }
    if (byParticipant.size === 0) throw new Error("manifest_has_no_valid_segment_keys");

    const participantFiles = [];
    for (const [participantId, participantSegments] of byParticipant.entries()) {
      participantSegments.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0));
      const seg = participantSegments[0];
      const localFile = path.join(tmpRoot, `${participantId}.webm`);
      await downloadToFile(bucket, seg.key, localFile);
      const stat = await fsp.stat(localFile);
      console.log(
        `[lambda] segment_downloaded participant=${participantId} sizeBytes=${stat.size}`
      );
      participantFiles.push(localFile);
    }

    const finalOutput = path.join(tmpRoot, "final-merged.mp4");
    const mergeArgs = buildMergeArgs(participantFiles, finalOutput);
    console.log(`[lambda] merge_started participants=${participantFiles.length}`);
    const mergeStartMs = Date.now();
    await runProcess(ffmpegPath, mergeArgs);
    const finalStat = await fsp.stat(finalOutput);
    console.log(
      `[lambda] merge_complete durationMs=${Date.now() - mergeStartMs} outputBytes=${finalStat.size}`
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
      participantCount: participantFiles.length,
      segmentCount: segments.length
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
