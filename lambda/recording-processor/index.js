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

async function runProcess(binary, args, timeoutMs = 10 * 60 * 1000) {
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

function buildParticipantMergeArgs(participantFiles, outputFile) {
  const args = ["-loglevel", "warning"];
  for (const input of participantFiles) args.push("-i", input);
  const videoCount = participantFiles.length;
  const audioCount = participantFiles.length;
  const filters = [];
  if (videoCount === 1) {
    filters.push("[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2[vout]");
  } else if (videoCount === 2) {
    filters.push("[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=480:540:force_original_aspect_ratio=decrease,pad=480:540:(ow-iw)/2:(oh-ih)/2[v0]");
    filters.push("[1:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=480:540:force_original_aspect_ratio=decrease,pad=480:540:(ow-iw)/2:(oh-ih)/2[v1]");
    filters.push("[v0][v1]hstack=inputs=2:shortest=0[vout]");
  } else {
    const capped = Math.min(videoCount, 4);
    for (let i = 0; i < capped; i += 1) {
      filters.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2[v${i}]`);
    }
    const joined = Array.from({ length: Math.min(videoCount, 4) }, (_v, i) => `[v${i}]`).join("");
    const layout = videoCount === 3 ? "0_0|480_0|0_270" : "0_0|480_0|0_270|480_270";
    filters.push(`${joined}xstack=inputs=${Math.min(videoCount, 4)}:layout=${layout}:shortest=0[vout]`);
  }
  if (audioCount > 0) {
    const cappedAudio = Math.min(audioCount, 6);
    const audioPrep = Array.from({ length: cappedAudio }, (_v, i) => `[${i}:a]aresample=async=1:first_pts=0[a${i}]`).join(";");
    filters.push(`${audioPrep};${Array.from({ length: cappedAudio }, (_v, i) => `[a${i}]`).join("")}amix=inputs=${cappedAudio}:duration=longest:dropout_transition=2[aout]`);
  }
  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "[vout]", "-c:v", "libvpx-vp9", "-b:v", "1200k", "-crf", "32", "-deadline", "realtime", "-cpu-used", "3");
  if (audioCount > 0) args.push("-map", "[aout]", "-c:a", "libopus", "-b:a", "64k");
  args.push("-f", "webm", outputFile);
  return args;
}

function buildParticipantMergeArgsMp4(participantFiles, outputFile) {
  const args = ["-loglevel", "warning"];
  for (const input of participantFiles) args.push("-i", input);
  const videoCount = participantFiles.length;
  const audioCount = participantFiles.length;
  const filters = [];
  if (videoCount === 1) {
    filters.push("[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]");
  } else if (videoCount === 2) {
    filters.push("[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2[v0]");
    filters.push("[1:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2[v1]");
    filters.push("[v0][v1]hstack=inputs=2:shortest=0[vout]");
  } else {
    const capped = Math.min(videoCount, 4);
    for (let i = 0; i < capped; i += 1) {
      filters.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[v${i}]`);
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
  args.push("-movflags", "+faststart", "-f", "mp4", outputFile);
  return args;
}

async function downloadToFile(bucket, key, localPath) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buffer = await streamToBuffer(response.Body);
  await fsp.writeFile(localPath, buffer);
}

async function concatParticipantChunks(baseDir, participantId, chunkFiles) {
  const workDir = path.join(baseDir, String(participantId || "unknown"));
  await fsp.mkdir(workDir, { recursive: true });
  const concatListFile = path.join(workDir, "concat-list.txt");
  const concatOutput = path.join(workDir, "participant.webm");
  const lines = chunkFiles.map((file) => `file '${String(file).replace(/'/g, "'\\''")}'`).join("\n");
  await fsp.writeFile(concatListFile, `${lines}\n`, "utf8");
  await runProcess(ffmpegPath, [
    "-loglevel", "warning",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListFile,
    "-c", "copy",
    concatOutput
  ], 12 * 60 * 1000);
  return concatOutput;
}

function buildResultKey(manifestKey) {
  const dir = path.posix.dirname(manifestKey);
  return `${dir}/processing-result.json`;
}

function buildFinalKey(manifestKey, extension = "webm") {
  const dir = path.posix.dirname(manifestKey);
  return `${dir}/${outputPrefixSuffix}.${extension}`;
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
    const outputFormat = String(manifest.outputFormat || "webm").toLowerCase();
    const isMp4 = outputFormat === "mp4";

    const byParticipant = new Map();
    for (const seg of segments) {
      const key = seg?.key;
      const participantId = String(seg?.participantId || "unknown");
      if (!key) continue;
      const list = byParticipant.get(participantId) || [];
      list.push(seg);
      byParticipant.set(participantId, list);
    }
    if (byParticipant.size === 0) throw new Error("manifest_has_no_valid_segment_keys");

    const participantMergedFiles = [];
    for (const [participantId, participantSegments] of byParticipant.entries()) {
      participantSegments.sort((a, b) => String(a.key).localeCompare(String(b.key)));
      const localChunkFiles = [];
      for (let i = 0; i < participantSegments.length; i += 1) {
        const seg = participantSegments[i];
        const localChunk = path.join(tmpRoot, `${participantId}_${String(i).padStart(6, "0")}.webm`);
        await downloadToFile(bucket, seg.key, localChunk);
        localChunkFiles.push(localChunk);
      }
      // For mp4 mode there is one complete WebM per participant, so skip the
      // chunk-concat step entirely and use the downloaded file directly.
      const merged = isMp4 && localChunkFiles.length === 1
        ? localChunkFiles[0]
        : await concatParticipantChunks(tmpRoot, participantId, localChunkFiles);
      participantMergedFiles.push(merged);
    }

    let finalOutput;
    if (isMp4) {
      finalOutput = path.join(tmpRoot, "final-merged.mp4");
      const mergeArgs = buildParticipantMergeArgsMp4(participantMergedFiles, finalOutput);
      await runProcess(ffmpegPath, mergeArgs, 14 * 60 * 1000);
    } else {
      finalOutput = participantMergedFiles[0];
      if (participantMergedFiles.length > 1) {
        finalOutput = path.join(tmpRoot, "final-merged.webm");
        const mergeArgs = buildParticipantMergeArgs(participantMergedFiles, finalOutput);
        await runProcess(ffmpegPath, mergeArgs, 14 * 60 * 1000);
      }
    }

    const finalKey = buildFinalKey(manifestKey, isMp4 ? "mp4" : "webm");
    const finalBody = await fsp.readFile(finalOutput);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: finalKey,
      Body: finalBody,
      ContentType: isMp4 ? "video/mp4" : "video/webm"
    }));

    const finishedAt = new Date().toISOString();
    const result = {
      state: "completed",
      startedAt,
      finishedAt,
      recordingId: manifest.recordingId || null,
      sessionId: manifest.sessionId || null,
      manifestKey,
      finalKey,
      participantCount: participantMergedFiles.length,
      segmentCount: segments.length
    };
    await uploadJson(bucket, resultKey, result);
    return result;
  } catch (error) {
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
