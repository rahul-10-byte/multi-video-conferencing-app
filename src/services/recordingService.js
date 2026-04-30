const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { v7: uuidv7 } = require("uuid");

let pidusage = null;
try { pidusage = require("pidusage"); } catch (_e) {}

const RECORDING_MODE = "segment_upload_mp4";

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

class RecordingService {
  constructor(config = {}) {
    this.config = config;
    this.activeBySession = new Map();
    this.historyBySession = new Map();
  }

  upsertHistory(sessionId, recording) {
    const existing = this.historyBySession.get(sessionId) || [];
    const next = existing.filter((item) => item.recordingId !== recording.recordingId);
    next.push(recording);
    this.historyBySession.set(sessionId, next);
  }

  createProcess(binary, args) {
    const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";
    proc.stdout.on("data", () => {});
    proc.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4000);
    });
    return { proc, getStderrTail: () => stderrTail };
  }

  async stopFfmpeg(ffmpeg, timeoutMs = 4000) {
    if (!ffmpeg || ffmpeg.exitCode !== null || ffmpeg.signalCode) return true;
    ffmpeg.kill("SIGINT");
    const exitedAfterSigint = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      ffmpeg.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (exitedAfterSigint) return true;

    ffmpeg.kill("SIGTERM");
    const exitedAfterSigterm = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 1500);
      ffmpeg.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (exitedAfterSigterm) return true;

    ffmpeg.kill("SIGKILL");
    await new Promise((resolve) => ffmpeg.once("exit", () => resolve()));
    return true;
  }

  collectRecordingPids(recording) {
    const items = [];
    for (const segment of recording?._segments || []) {
      if (segment.ffmpeg?.pid && segment.ffmpeg.exitCode === null) {
        items.push({ pid: segment.ffmpeg.pid, label: `participant=${segment.participantId}` });
      }
    }
    return items;
  }

  logActiveRecordingTimers() {
    const nowMs = Date.now();
    for (const recording of this.activeBySession.values()) {
      if (!recording.startedAt) continue;
      const elapsedMs = Math.max(nowMs - new Date(recording.startedAt).getTime(), 0);
      const elapsed = formatElapsed(elapsedMs);
      console.log(
        `[recording] timer session=${recording.sessionId} recordingId=${recording.recordingId} mode=${RECORDING_MODE} state=${recording.state} elapsed=${elapsed}`
      );
    }
  }

  async logProcessCpuUsage(recording) {
    if (!pidusage) return;
    const items = this.collectRecordingPids(recording);
    if (items.length === 0) return;
    let stats;
    try {
      stats = await pidusage(items.map((i) => i.pid));
    } catch (_e) {
      return;
    }
    for (const item of items) {
      const stat = stats[item.pid];
      if (!stat) continue;
      const memMb = (stat.memory / 1024 / 1024).toFixed(1);
      const cpu = stat.cpu.toFixed(1);
      console.log(
        `[recording] cpu session=${recording.sessionId} recordingId=${recording.recordingId} mode=${RECORDING_MODE} ${item.label} pid=${item.pid} cpu=${cpu}% mem=${memMb}MB`
      );
    }
  }

  async start(sessionId, initiatedBy, mediasoupService) {
    if (this.activeBySession.has(sessionId)) {
      return { ok: false, reason: "recording_already_active" };
    }
    if (!this.config.enabled) {
      return { ok: false, reason: "recording_disabled" };
    }
    const producerRefs = mediasoupService.listSessionProducerRefs(sessionId);
    const mediaRefs = producerRefs.filter((p) => p.kind === "audio" || p.kind === "video");
    if (mediaRefs.length === 0) {
      return { ok: false, reason: "no_media_producers" };
    }

    const startedAt = new Date().toISOString();
    const recordingId = `vc_rec_${uuidv7().replaceAll("-", "")}`;
    const outputDir = path.resolve(process.cwd(), this.config.outputDir || "recordings");
    await fsp.mkdir(outputDir, { recursive: true });
    // Final mp4 lives in S3 only; keep the local placeholder path for logs.
    const outputFile = path.join(outputDir, `${recordingId}.mp4`);
    const participantIds = Array.from(new Set(mediaRefs.map((ref) => ref.participantId)));
    const segmentRecorders = [];
    let nextPort = this.config.basePort || 50040;
    if (nextPort % 2 !== 0) nextPort += 1;

    try {
      for (const participantId of participantIds) {
        const refs = mediaRefs
          .filter((ref) => ref.participantId === participantId)
          .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "video" ? -1 : 1));
        if (refs.length === 0) continue;
        const taps = [];
        for (const ref of refs) {
          const transport = await mediasoupService.createPlainTransport(sessionId, { rtcpMux: false, comedia: false });
          const rtpPort = nextPort;
          nextPort += 2;
          const rtcpPort = rtpPort + 1;
          await transport.connect({ ip: this.config.hostIp || "127.0.0.1", port: rtpPort, rtcpPort });
          const room = mediasoupService.getRoom(sessionId);
          const consumer = await transport.consume({
            producerId: ref.producerId,
            rtpCapabilities: room.router.rtpCapabilities,
            paused: true
          });
          taps.push({
            kind: ref.kind,
            participantId: ref.participantId,
            producerId: ref.producerId,
            producer: ref.producer,
            transport,
            consumer,
            rtpPort,
            rtcpPort
          });
        }

        const safeParticipantId = String(participantId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
        const segmentFile = path.join(outputDir, `${recordingId}_${safeParticipantId}.webm`);
        const sdpFile = path.join(outputDir, `${recordingId}_${safeParticipantId}.sdp`);
        const sdp = this.buildSdp(taps);
        await fsp.writeFile(sdpFile, sdp, "utf8");
        const processArgs = this.buildSegmentFfmpegArgs(taps, sdpFile, segmentFile);
        const processBinary = this.config.ffmpegPath || "ffmpeg";
        const { proc: ffmpeg, getStderrTail } = this.createProcess(processBinary, processArgs);
        segmentRecorders.push({
          participantId,
          outputFile: segmentFile,
          sdpFile,
          taps,
          ffmpeg,
          getStderrTail
        });
      }

      const warmupTimer = setTimeout(async () => {
        for (const segment of segmentRecorders) {
          for (const tap of segment.taps) {
            try {
              await tap.consumer.resume();
            } catch (_err) {}
            if (tap.kind === "video" && tap.consumer && typeof tap.consumer.requestKeyFrame === "function") {
              try { await tap.consumer.requestKeyFrame(); } catch (_e) {}
            }
          }
        }
      }, this.config.keyframeWarmupMs || 1500);

      const keyframeIntervalMs = this.config.keyframeIntervalMs || 3000;
      const keyframeTimer = setInterval(async () => {
        for (const segment of segmentRecorders) {
          for (const tap of segment.taps) {
            if (tap.kind !== "video") continue;
            try {
              if (tap.consumer && typeof tap.consumer.requestKeyFrame === "function") {
                await tap.consumer.requestKeyFrame();
                continue;
              }
            } catch (_err) {}
            if (tap.producer && typeof tap.producer.requestKeyFrame === "function") {
              try {
                await tap.producer.requestKeyFrame();
              } catch (_err) {}
            }
          }
        }
      }, keyframeIntervalMs);

      const recording = {
        recordingId,
        sessionId,
        engine: "ffmpeg",
        mode: RECORDING_MODE,
        state: "recording",
        storageUri: outputFile,
        startedAt,
        stoppedAt: null,
        durationMs: null,
        sizeBytes: null,
        initiatedBy,
        ffmpegStderrTail: "",
        tapCount: segmentRecorders.reduce((sum, s) => sum + s.taps.length, 0),
        audioTapCount: segmentRecorders.reduce((sum, s) => sum + s.taps.filter((t) => t.kind === "audio").length, 0),
        videoTapCount: segmentRecorders.reduce((sum, s) => sum + s.taps.filter((t) => t.kind === "video").length, 0),
        _segments: segmentRecorders,
        _keyframeTimer: keyframeTimer,
        _warmupTimer: warmupTimer,
        _cpuLogTimer: null,
        _stopping: false
      };
      if (this.config.cpuLogs !== false && pidusage) {
        const cpuIntervalMs = Math.max(Number.parseInt(String(this.config.cpuLogIntervalMs || 10000), 10) || 10000, 1000);
        recording._cpuLogTimer = setInterval(() => {
          void this.logProcessCpuUsage(recording);
        }, cpuIntervalMs);
      }
      for (const segment of segmentRecorders) {
        segment.ffmpeg.on("exit", (code) => {
          if (!recording._stopping && code !== 0 && code !== null) {
            console.error(
              `recording_ffmpeg_exit_nonzero session=${sessionId} participant=${segment.participantId} code=${code} detail=${segment.getStderrTail()}`
            );
          }
        });
      }
      this.activeBySession.set(sessionId, recording);
      return { ok: true, recording: this.toPublic(recording) };
    } catch (error) {
      for (const segment of segmentRecorders) {
        try { await this.stopFfmpeg(segment.ffmpeg); } catch (_e) {}
        for (const tap of segment.taps || []) {
          try { tap.consumer.close(); } catch (_e) {}
          try { tap.transport.close(); } catch (_e) {}
        }
        try {
          if (segment.sdpFile) await fsp.unlink(segment.sdpFile);
        } catch (_e) {}
      }
      return { ok: false, reason: "recording_start_failed", detail: error.message };
    }
  }

  async stop(sessionId, stoppedBy, hooks = {}) {
    const active = this.activeBySession.get(sessionId);
    if (!active) {
      return { ok: false, reason: "recording_not_active" };
    }
    const stoppedAt = new Date().toISOString();
    const durationMs = Math.max(new Date(stoppedAt).getTime() - new Date(active.startedAt).getTime(), 0);

    active._stopping = true;

    if (active._keyframeTimer) clearInterval(active._keyframeTimer);
    if (active._warmupTimer) clearTimeout(active._warmupTimer);
    if (active._cpuLogTimer) clearInterval(active._cpuLogTimer);
    if (pidusage) {
      try { pidusage.clear(); } catch (_e) {}
    }

    const segments = active._segments || [];
    for (const segment of segments) {
      try {
        await this.stopFfmpeg(segment.ffmpeg);
      } catch (_e) {}
    }
    for (const segment of segments) {
      for (const tap of segment.taps || []) {
        try { tap.consumer.close(); } catch (_e) {}
        try { tap.transport.close(); } catch (_e) {}
      }
      try {
        if (segment.sdpFile) await fsp.unlink(segment.sdpFile);
      } catch (_e) {}
    }

    const segmentDetails = [];
    for (const segment of segments) {
      segmentDetails.push({
        participantId: segment.participantId,
        outputFile: segment.outputFile,
        hasVideo: (segment.taps || []).some((tap) => tap.kind === "video"),
        hasAudio: (segment.taps || []).some((tap) => tap.kind === "audio"),
        stderrTail: segment.getStderrTail ? segment.getStderrTail() : ""
      });
    }
    const existingSegmentFiles = [];
    for (const seg of segmentDetails) {
      try {
        await fsp.access(seg.outputFile);
        existingSegmentFiles.push(seg);
      } catch (_e) {}
    }

    const processing = {
      ...active,
      state: "processing",
      stoppedAt,
      durationMs,
      stoppedBy,
      sizeBytes: null,
      ffmpegStderrTail: segmentDetails.map((seg) => seg.stderrTail).filter(Boolean).join("\n"),
      segmentCount: existingSegmentFiles.length,
      mergeStderrTail: ""
    };
    delete processing._segments;
    delete processing._keyframeTimer;
    delete processing._warmupTimer;
    delete processing._cpuLogTimer;

    this.activeBySession.delete(sessionId);
    this.upsertHistory(sessionId, processing);

    const uploading = {
      ...processing,
      state: "uploading",
      storageUri: ""
    };
    this.upsertHistory(sessionId, uploading);
    if (typeof hooks.onUpdate === "function") {
      await hooks.onUpdate(this.toPublic(uploading));
    }

    if (typeof hooks.onUploadFinalize !== "function") {
      const failed = {
        ...uploading,
        state: "failed",
        mergeStderrTail: "recording_upload_finalize_hook_missing"
      };
      this.upsertHistory(sessionId, failed);
      if (typeof hooks.onUpdate === "function") {
        await hooks.onUpdate(this.toPublic(failed));
      }
      return { ok: true, recording: this.toPublic(failed) };
    }

    try {
      const finalized = await hooks.onUploadFinalize({
        recording: this.toPublic(uploading),
        segmentDetails: existingSegmentFiles
      });
      // Upload + Lambda invoke succeeded. Per-participant WebMs are now
      // safely on S3 and Lambda has been triggered, so delete the local
      // copies to keep disk usage bounded. Failure paths intentionally
      // leave local files in place for manual recovery.
      let deletedCount = 0;
      for (const seg of existingSegmentFiles) {
        try {
          await fsp.unlink(seg.outputFile);
          deletedCount += 1;
        } catch (_e) {}
      }
      console.log(
        `[recording] local_cleanup_ok session=${sessionId} recordingId=${active.recordingId} deletedFiles=${deletedCount}`
      );
      const finished = {
        ...uploading,
        state: finalized?.state || "uploaded",
        storageUri: finalized?.storageUri || "",
        manifestKey: finalized?.manifestKey || "",
        sizeBytes: Number.isFinite(finalized?.sizeBytes) ? finalized.sizeBytes : null,
        segmentCount: Number.isFinite(finalized?.segmentCount) ? finalized.segmentCount : existingSegmentFiles.length
      };
      this.upsertHistory(sessionId, finished);
      if (typeof hooks.onUpdate === "function") {
        await hooks.onUpdate(this.toPublic(finished));
      }
      return { ok: true, recording: this.toPublic(finished) };
    } catch (error) {
      console.error(
        `[recording] upload_finalize_failed session=${sessionId} recordingId=${active.recordingId} error=${error?.name || "Error"}: ${error?.message || String(error)}`,
        error?.stack || ""
      );
      const failed = {
        ...uploading,
        state: "failed",
        mergeStderrTail: error.message || "recording_upload_finalize_failed"
      };
      this.upsertHistory(sessionId, failed);
      if (typeof hooks.onUpdate === "function") {
        await hooks.onUpdate(this.toPublic(failed));
      }
      return { ok: true, recording: this.toPublic(failed) };
    }
  }

  buildSdp(taps) {
    const lines = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=VC Session Recording",
      "c=IN IP4 127.0.0.1",
      "t=0 0"
    ];
    for (const tap of taps) {
      const codec = tap.consumer?.rtpParameters?.codecs?.[0];
      if (!codec) continue;
      const payloadType = codec.payloadType;
      const mimeType = String(codec.mimeType || "").toLowerCase();
      const codecName = mimeType.split("/")[1] || (tap.kind === "audio" ? "opus" : "VP8");
      const channels = codec.channels ? `/${codec.channels}` : "";
      const encoding = tap.consumer?.rtpParameters?.encodings?.[0];
      lines.push(`m=${tap.kind} ${tap.rtpPort} RTP/AVP ${payloadType}`);
      if (tap.rtcpPort) {
        lines.push(`a=rtcp:${tap.rtcpPort} IN IP4 127.0.0.1`);
      }
      lines.push("a=recvonly");
      lines.push(`a=rtpmap:${payloadType} ${codecName}/${codec.clockRate}${channels}`);
      if (codec.parameters && Object.keys(codec.parameters).length > 0) {
        const fmtp = Object.entries(codec.parameters)
          .map(([k, v]) => `${k}=${v}`)
          .join(";");
        lines.push(`a=fmtp:${payloadType} ${fmtp}`);
      }
      if (encoding?.ssrc) {
        lines.push(`a=ssrc:${encoding.ssrc} cname:vc-recording`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  buildSegmentFfmpegArgs(taps, sdpFile, outputFile) {
    const args = [
      "-loglevel", "warning",
      "-protocol_whitelist", "file,udp,rtp",
      "-fflags", "+discardcorrupt",
      "-use_wallclock_as_timestamps", "1",
      "-analyzeduration", "1000000",
      "-probesize", "1000000",
      "-max_delay", "1000000",
      "-f", "sdp",
      "-i", sdpFile
    ];
    const hasVideo = taps.some((t) => t.kind === "video");
    const hasAudio = taps.some((t) => t.kind === "audio");

    // Fast path: when codecs are WebM-compatible (VP8/VP9/AV1 + Opus/Vorbis),
    // repackage RTP into WebM with no decode/encode. This is the common case
    // for browser MediaSoup sessions.
    const videoTap = taps.find((t) => t.kind === "video");
    const audioTap = taps.find((t) => t.kind === "audio");
    const videoMime = String(videoTap?.consumer?.rtpParameters?.codecs?.[0]?.mimeType || "").toLowerCase();
    const audioMime = String(audioTap?.consumer?.rtpParameters?.codecs?.[0]?.mimeType || "").toLowerCase();
    const videoCopyOk = !videoTap || /^video\/(vp8|vp9|av1)$/.test(videoMime);
    const audioCopyOk = !audioTap || /^audio\/(opus|vorbis)$/.test(audioMime);
    if (videoCopyOk && audioCopyOk) {
      if (hasVideo) args.push("-map", "0:v:0", "-c:v", "copy");
      if (hasAudio) args.push("-map", "0:a:0", "-c:a", "copy");
      args.push("-f", "webm", outputFile);
      return args;
    }

    // Transcode fallback: needed when the router negotiated H.264 / non-Opus.
    const filters = [];
    if (hasVideo) {
      filters.push("[0:v:0]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]");
    }
    if (hasAudio) {
      filters.push("[0:a:0]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]");
    }
    if (filters.length > 0) {
      args.push("-filter_complex", filters.join(";"));
    }
    if (hasVideo) {
      args.push("-map", "[vout]", "-c:v", "libvpx-vp9", "-b:v", "1400k", "-crf", "30", "-deadline", "good");
    }
    if (hasAudio) {
      args.push("-map", "[aout]", "-c:a", "libopus", "-b:a", "96k");
    }
    args.push("-f", "webm", outputFile);
    return args;
  }

  toPublic(recording) {
    return {
      recordingId: recording.recordingId,
      sessionId: recording.sessionId,
      state: recording.state,
      storageUri: recording.storageUri,
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt,
      durationMs: recording.durationMs,
      sizeBytes: recording.sizeBytes,
      initiatedBy: recording.initiatedBy,
      stoppedBy: recording.stoppedBy,
      ffmpegStderrTail: recording.ffmpegStderrTail || "",
      segmentCount: recording.segmentCount || 0,
      mergeStderrTail: recording.mergeStderrTail || "",
      engine: "ffmpeg",
      mode: RECORDING_MODE,
      tapCount: recording.tapCount || 0,
      audioTapCount: recording.audioTapCount || 0,
      videoTapCount: recording.videoTapCount || 0,
      manifestKey: recording.manifestKey || ""
    };
  }

  getActive(sessionId) {
    const active = this.activeBySession.get(sessionId) || null;
    return active ? this.toPublic(active) : null;
  }

  listHistory(sessionId) {
    return (this.historyBySession.get(sessionId) || []).map((item) => this.toPublic(item));
  }
}

module.exports = { RecordingService };
