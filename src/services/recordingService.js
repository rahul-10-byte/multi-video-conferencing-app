const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { v7: uuidv7 } = require("uuid");

class RecordingService {
  constructor(config = {}) {
    this.config = config;
    this.activeBySession = new Map();
    this.historyBySession = new Map();
  }

  async start(sessionId, initiatedBy, mediasoupService) {
    if (this.activeBySession.has(sessionId)) {
      return { ok: false, reason: "recording_already_active" };
    }
    if (!this.config.enabled) {
      return { ok: false, reason: "recording_disabled" };
    }
    const producerRefs = mediasoupService.listSessionProducerRefs(sessionId);
    const audioRefs = producerRefs.filter((p) => p.kind === "audio");
    const videoRefs = producerRefs.filter((p) => p.kind === "video");
    if (audioRefs.length === 0 && videoRefs.length === 0) {
      return { ok: false, reason: "no_media_producers" };
    }

    const startedAt = new Date().toISOString();
    const recordingId = `vc_rec_${uuidv7().replaceAll("-", "")}`;
    const outputDir = path.resolve(process.cwd(), this.config.outputDir || "recordings");
    await fsp.mkdir(outputDir, { recursive: true });
    const outputFile = path.join(outputDir, `${recordingId}.webm`);
    const sdpFile = path.join(outputDir, `${recordingId}.sdp`);

    const taps = [];
    let nextPort = this.config.basePort || 50040;
    if (nextPort % 2 !== 0) nextPort += 1;

    const addTap = async (ref) => {
      if (!ref) return;
      const transport = await mediasoupService.createPlainTransport(sessionId);
      const rtpPort = nextPort;
      nextPort += 2;
      await transport.connect({ ip: this.config.hostIp || "127.0.0.1", port: rtpPort });
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
        transport,
        consumer,
        rtpPort
      });
      if (ref.kind === "video" && ref.producer && typeof ref.producer.requestKeyFrame === "function") {
        try {
          await ref.producer.requestKeyFrame();
        } catch (_err) {}
      }
    };

    try {
      for (const ref of audioRefs) {
        await addTap(ref);
      }
      for (const ref of videoRefs) {
        await addTap(ref);
      }

      const sdp = this.buildSdp(taps);
      await fsp.writeFile(sdpFile, sdp, "utf8");
      const ffmpegArgs = this.buildFfmpegArgs(taps, sdpFile, outputFile);
      const ffmpeg = spawn(this.config.ffmpegPath || "ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });

      setTimeout(async () => {
        for (const tap of taps) {
          try {
            await tap.consumer.resume();
          } catch (_err) {}
        }
        for (const tap of taps) {
          if (tap.kind !== "video") continue;
          if (tap.producer && typeof tap.producer.requestKeyFrame === "function") {
            try {
              await tap.producer.requestKeyFrame();
            } catch (_err) {}
          }
        }
      }, this.config.keyframeWarmupMs || 1500);

      // Keep requesting keyframes periodically so recording can recover
      // from packet loss/layer switches instead of freezing video.
      const keyframeIntervalMs = this.config.keyframeIntervalMs || 3000;
      const keyframeTimer = setInterval(async () => {
        for (const tap of taps) {
          if (tap.kind !== "video") continue;
          if (tap.producer && typeof tap.producer.requestKeyFrame === "function") {
            try {
              await tap.producer.requestKeyFrame();
            } catch (_err) {}
          }
        }
      }, keyframeIntervalMs);

      ffmpeg.stdout.on("data", () => {});
      let stderrTail = "";
      ffmpeg.stderr.on("data", (chunk) => {
        stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4000);
      });
      ffmpeg.on("exit", (code) => {
        if (!recording._stopping && code !== 0 && code !== null) {
          // eslint-disable-next-line no-console
          console.error(`recording_ffmpeg_exit_nonzero session=${sessionId} code=${code} detail=${stderrTail}`);
        }
      });

      const recording = {
        recordingId,
        sessionId,
        state: "recording",
        storageUri: outputFile,
        startedAt,
        stoppedAt: null,
        durationMs: null,
        sizeBytes: null,
        initiatedBy,
        ffmpegStderrTail: "",
        tapCount: taps.length,
        audioTapCount: taps.filter((t) => t.kind === "audio").length,
        videoTapCount: taps.filter((t) => t.kind === "video").length,
        _ffmpeg: ffmpeg,
        _sdpFile: sdpFile,
        _taps: taps,
        _keyframeTimer: keyframeTimer,
        _stopping: false,
        _getStderrTail: () => stderrTail
      };
      this.activeBySession.set(sessionId, recording);
      return { ok: true, recording: this.toPublic(recording) };
    } catch (error) {
      for (const tap of taps) {
        try { tap.consumer.close(); } catch (_e) {}
        try { tap.transport.close(); } catch (_e) {}
      }
      return { ok: false, reason: "recording_start_failed", detail: error.message };
    }
  }

  async stop(sessionId, stoppedBy) {
    const active = this.activeBySession.get(sessionId);
    if (!active) {
      return { ok: false, reason: "recording_not_active" };
    }
    const stoppedAt = new Date().toISOString();
    const durationMs = Math.max(new Date(stoppedAt).getTime() - new Date(active.startedAt).getTime(), 0);

    if (active._ffmpeg && !active._ffmpeg.killed) {
      active._stopping = true;
      active._ffmpeg.kill("SIGINT");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        active._ffmpeg.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (active._keyframeTimer) {
      clearInterval(active._keyframeTimer);
    }

    for (const tap of active._taps || []) {
      try { tap.consumer.close(); } catch (_e) {}
      try { tap.transport.close(); } catch (_e) {}
    }

    let sizeBytes = null;
    try {
      const stat = await fsp.stat(active.storageUri);
      sizeBytes = stat.size;
    } catch (_err) {}

    try {
      if (active._sdpFile) await fsp.unlink(active._sdpFile);
    } catch (_err) {}

    const finished = {
      ...active,
      state: "stopped",
      stoppedAt,
      durationMs,
      stoppedBy,
      sizeBytes,
      ffmpegStderrTail: typeof active._getStderrTail === "function" ? active._getStderrTail() : ""
    };
    delete finished._ffmpeg;
    delete finished._sdpFile;
    delete finished._taps;
    delete finished._keyframeTimer;

    this.activeBySession.delete(sessionId);
    const existing = this.historyBySession.get(sessionId) || [];
    existing.push(finished);
    this.historyBySession.set(sessionId, existing);
    return { ok: true, recording: this.toPublic(finished) };
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

  buildFfmpegArgs(taps, sdpFile, outputFile) {
    const args = [
      "-loglevel", "warning",
      "-protocol_whitelist", "file,udp,rtp",
      "-fflags", "+genpts",
      "-analyzeduration", "10000000",
      "-probesize", "50000000",
      "-max_delay", "20000000",
      "-f", "sdp",
      "-i", sdpFile
    ];
    const videoCount = taps.filter((t) => t.kind === "video").length;
    const audioCount = taps.filter((t) => t.kind === "audio").length;
    const filters = [];

    if (videoCount > 0) {
      if (videoCount === 1) {
        filters.push("[0:v:0]setpts=PTS-STARTPTS,format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]");
      } else if (videoCount === 2) {
        filters.push("[0:v:0]setpts=PTS-STARTPTS,format=yuv420p,scale=640:720[v0]");
        filters.push("[0:v:1]setpts=PTS-STARTPTS,format=yuv420p,scale=640:720[v1]");
        filters.push("[v0][v1]hstack=inputs=2[vout]");
      } else {
        const capped = Math.min(videoCount, 4);
        for (let i = 0; i < capped; i += 1) {
          filters.push(`[0:v:${i}]setpts=PTS-STARTPTS,format=yuv420p,scale=640:360[v${i}]`);
        }
        const joined = Array.from({ length: capped }, (_v, i) => `[v${i}]`).join("");
        const layout = capped === 3 ? "0_0|640_0|0_360" : "0_0|640_0|0_360|640_360";
        filters.push(`${joined}xstack=inputs=${capped}:layout=${layout}[vout]`);
      }
    }

    if (audioCount > 0) {
      if (audioCount === 1) {
        filters.push("[0:a:0]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]");
      } else {
        const capped = Math.min(audioCount, 6);
        const inputs = Array.from({ length: capped }, (_v, i) => `[0:a:${i}]asetpts=PTS-STARTPTS[a${i}]`).join(";");
        filters.push(`${inputs};${Array.from({ length: capped }, (_v, i) => `[a${i}]`).join("")}amix=inputs=${capped}:duration=longest:dropout_transition=2[aout]`);
      }
    }

    if (filters.length > 0) {
      args.push("-filter_complex", filters.join(";"));
    }
    if (videoCount > 0) {
      args.push("-map", "[vout]", "-c:v", "libvpx-vp9", "-b:v", "2500k", "-crf", "25", "-deadline", "good");
    }
    if (audioCount > 0) {
      args.push("-map", "[aout]", "-c:a", "libopus", "-b:a", "128k");
    }
    args.push("-shortest", "-f", "webm", outputFile);
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
      tapCount: recording.tapCount || 0,
      audioTapCount: recording.audioTapCount || 0,
      videoTapCount: recording.videoTapCount || 0
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
