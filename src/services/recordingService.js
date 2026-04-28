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

  async waitProcessExit(ffmpeg, timeoutMs = 30000) {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      ffmpeg.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  getSegmentRecordingEngine() {
    const engine = String(this.config.engine || "ffmpeg").toLowerCase();
    return engine === "gstreamer" ? "gstreamer" : "ffmpeg";
  }

  getRecordingMode() {
    const mode = String(this.config.mode || "segment_merge").toLowerCase();
    return mode === "live_compose" ? "live_compose" : "segment_merge";
  }

  async startLiveComposeRecording({
    sessionId,
    initiatedBy,
    mediaRefs,
    recordingId,
    outputDir,
    outputFile,
    mediasoupService,
    nextPortStart
  }) {
    const taps = [];
    let nextPort = nextPortStart;
    for (const ref of mediaRefs) {
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
      if (ref.kind === "video" && typeof consumer.setPreferredLayers === "function") {
        try {
          await consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 2 });
        } catch (_err) {}
      }
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

    const sdpFile = path.join(outputDir, `${recordingId}.sdp`);
    await fsp.writeFile(sdpFile, this.buildSdp(taps), "utf8");
    const engine = this.getSegmentRecordingEngine();
    const processBinary = engine === "gstreamer" ? (this.config.gstreamerPath || "gst-launch-1.0") : (this.config.ffmpegPath || "ffmpeg");
    const processArgs =
      engine === "gstreamer"
        ? this.buildLiveComposeGstreamerArgs(taps, sdpFile, outputFile)
        : this.buildFfmpegArgs(taps, sdpFile, outputFile);
    const { proc, getStderrTail } = this.createProcess(processBinary, processArgs);

    setTimeout(async () => {
      for (const tap of taps) {
        try {
          await tap.consumer.resume();
        } catch (_err) {}
      }
    }, this.config.keyframeWarmupMs || 1500);

    const keyframeIntervalMs = this.config.keyframeIntervalMs || 3000;
    const keyframeTimer = setInterval(async () => {
      for (const tap of taps) {
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
    }, keyframeIntervalMs);

    const recording = {
      recordingId,
      sessionId,
      engine,
      mode: "live_compose",
      state: "recording",
      storageUri: outputFile,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      durationMs: null,
      sizeBytes: null,
      initiatedBy,
      ffmpegStderrTail: "",
      tapCount: taps.length,
      audioTapCount: taps.filter((t) => t.kind === "audio").length,
      videoTapCount: taps.filter((t) => t.kind === "video").length,
      _liveCompose: true,
      _liveProc: proc,
      _liveTaps: taps,
      _liveSdpFile: sdpFile,
      _liveGetStderrTail: getStderrTail,
      _keyframeTimer: keyframeTimer,
      _stopping: false
    };

    proc.on("exit", (code) => {
      if (!recording._stopping && code !== 0 && code !== null) {
        // eslint-disable-next-line no-console
        console.error(`recording_live_compose_exit_nonzero session=${sessionId} code=${code} detail=${getStderrTail()}`);
      }
    });

    return recording;
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
    const outputFile = path.join(outputDir, `${recordingId}.webm`);
    const participantIds = Array.from(new Set(mediaRefs.map((ref) => ref.participantId)));
    const segmentRecorders = [];
    let nextPort = this.config.basePort || 50040;
    if (nextPort % 2 !== 0) nextPort += 1;

    if (this.getRecordingMode() === "live_compose") {
      try {
        const sortedRefs = mediaRefs.slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "video" ? -1 : 1));
        const liveRecording = await this.startLiveComposeRecording({
          sessionId,
          initiatedBy,
          mediaRefs: sortedRefs,
          recordingId,
          outputDir,
          outputFile,
          mediasoupService,
          nextPortStart: nextPort
        });
        this.activeBySession.set(sessionId, liveRecording);
        return { ok: true, recording: this.toPublic(liveRecording) };
      } catch (error) {
        return { ok: false, reason: "recording_start_failed", detail: error.message };
      }
    }

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
          if (ref.kind === "video" && typeof consumer.setPreferredLayers === "function") {
            try {
              await consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 2 });
            } catch (_err) {}
          }
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
        const segmentEngine = this.getSegmentRecordingEngine();
        const processArgs =
          segmentEngine === "gstreamer"
            ? this.buildSegmentGstreamerArgs(sdpFile, segmentFile)
            : this.buildSegmentFfmpegArgs(taps, sdpFile, segmentFile);
        const processBinary = segmentEngine === "gstreamer" ? (this.config.gstreamerPath || "gst-launch-1.0") : (this.config.ffmpegPath || "ffmpeg");
        const { proc: ffmpeg, getStderrTail } = this.createProcess(processBinary, processArgs);
        segmentRecorders.push({
          participantId,
          outputFile: segmentFile,
          sdpFile,
          taps,
          ffmpeg,
          engine: segmentEngine,
          getStderrTail
        });
      }

      setTimeout(async () => {
        for (const segment of segmentRecorders) {
          for (const tap of segment.taps) {
            try {
              await tap.consumer.resume();
            } catch (_err) {}
          }
        }
      }, this.config.keyframeWarmupMs || 1500);

      const keyframeIntervalMs = this.config.keyframeIntervalMs || 3000;
      const keyframeTimer = setInterval(async () => {
        for (const segment of segmentRecorders) {
          for (const tap of segment.taps) {
            if (tap.kind !== "video") continue;
            if (tap.consumer && typeof tap.consumer.setPreferredLayers === "function") {
              try {
                await tap.consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 2 });
              } catch (_err) {}
            }
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
        engine: this.getSegmentRecordingEngine(),
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
        _stopping: false
      };
      for (const segment of segmentRecorders) {
        segment.ffmpeg.on("exit", (code) => {
          if (!recording._stopping && code !== 0 && code !== null) {
            // eslint-disable-next-line no-console
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

  async stop(sessionId, stoppedBy) {
    const active = this.activeBySession.get(sessionId);
    if (!active) {
      return { ok: false, reason: "recording_not_active" };
    }
    const stoppedAt = new Date().toISOString();
    const durationMs = Math.max(new Date(stoppedAt).getTime() - new Date(active.startedAt).getTime(), 0);

    active._stopping = true;

    if (active._keyframeTimer) {
      clearInterval(active._keyframeTimer);
    }

    if (active._liveCompose) {
      try {
        await this.stopFfmpeg(active._liveProc);
      } catch (_e) {}
      for (const tap of active._liveTaps || []) {
        try { tap.consumer.close(); } catch (_e) {}
        try { tap.transport.close(); } catch (_e) {}
      }
      try {
        if (active._liveSdpFile) await fsp.unlink(active._liveSdpFile);
      } catch (_e) {}
      let sizeBytes = null;
      try {
        const stat = await fsp.stat(active.storageUri);
        sizeBytes = stat.size;
      } catch (_err) {}
      const finished = {
        ...active,
        state: "stopped",
        stoppedAt,
        durationMs,
        stoppedBy,
        sizeBytes,
        ffmpegStderrTail: typeof active._liveGetStderrTail === "function" ? active._liveGetStderrTail() : ""
      };
      delete finished._liveProc;
      delete finished._liveTaps;
      delete finished._liveSdpFile;
      delete finished._liveGetStderrTail;
      delete finished._keyframeTimer;
      this.activeBySession.delete(sessionId);
      const existing = this.historyBySession.get(sessionId) || [];
      existing.push(finished);
      this.historyBySession.set(sessionId, existing);
      return { ok: true, recording: this.toPublic(finished) };
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

    const segmentDetails = segments.map((segment) => ({
      participantId: segment.participantId,
      outputFile: segment.outputFile,
      hasVideo: (segment.taps || []).some((tap) => tap.kind === "video"),
      hasAudio: (segment.taps || []).some((tap) => tap.kind === "audio"),
      stderrTail: segment.getStderrTail ? segment.getStderrTail() : ""
    }));
    const existingSegmentFiles = [];
    for (const seg of segmentDetails) {
      try {
        await fsp.access(seg.outputFile);
        existingSegmentFiles.push(seg);
      } catch (_e) {}
    }

    let finalOutputFile = active.storageUri;
    if (existingSegmentFiles.length === 1) {
      finalOutputFile = existingSegmentFiles[0].outputFile;
    } else if (existingSegmentFiles.length > 1) {
      const mergeCandidates = existingSegmentFiles.filter((seg) => seg.hasVideo);
      const mergeInputs = (mergeCandidates.length > 0 ? mergeCandidates : existingSegmentFiles).map((seg) => seg.outputFile);
      const mergeArgs = this.buildMergeArgs(mergeInputs, finalOutputFile);
      const { proc: mergeFfmpeg, getStderrTail: getMergeStderrTail } = this.createProcess(this.config.ffmpegPath || "ffmpeg", mergeArgs);
      const mergeExitCode = await this.waitProcessExit(mergeFfmpeg, 45000);
      const mergeStderrTail = getMergeStderrTail();
      if (mergeExitCode === 0) {
        for (const seg of existingSegmentFiles) {
          try {
            await fsp.unlink(seg.outputFile);
          } catch (_e) {}
        }
      } else {
        // Fallback to the longest available segment when merge fails.
        let longest = existingSegmentFiles[0];
        let longestSize = -1;
        for (const seg of existingSegmentFiles) {
          try {
            const stat = await fsp.stat(seg.outputFile);
            if (stat.size > longestSize) {
              longestSize = stat.size;
              longest = seg;
            }
          } catch (_e) {}
        }
        finalOutputFile = longest.outputFile;
      }
      active._mergeStderrTail = mergeStderrTail;
    }

    let sizeBytes = null;
    try {
      const stat = await fsp.stat(finalOutputFile);
      sizeBytes = stat.size;
    } catch (_err) {}

    const finished = {
      ...active,
      state: "stopped",
      storageUri: finalOutputFile,
      stoppedAt,
      durationMs,
      stoppedBy,
      sizeBytes,
      ffmpegStderrTail: segmentDetails.map((seg) => seg.stderrTail).filter(Boolean).join("\n"),
      segmentCount: existingSegmentFiles.length,
      mergeStderrTail: active._mergeStderrTail || ""
    };
    delete finished._segments;
    delete finished._keyframeTimer;
    delete finished._mergeStderrTail;

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

  buildFfmpegArgs(taps, sdpFile, outputFile) {
    const args = [
      "-loglevel", "warning",
      "-protocol_whitelist", "file,udp,rtp",
      "-fflags", "+genpts+discardcorrupt",
      "-use_wallclock_as_timestamps", "1",
      "-analyzeduration", "10000000",
      "-probesize", "50000000",
      "-max_delay", "20000000",
      "-f", "sdp",
      "-i", sdpFile
    ];
    const videoCount = taps.filter((t) => t.kind === "video").length;
    const audioCount = taps.filter((t) => t.kind === "audio").length;
    const filters = [];

    // For the common 1:1 session recording, keep RTP packets as-is.
    // This avoids decode/re-encode stalls and preserves call timing better.
    if (videoCount <= 1 && audioCount <= 1) {
      if (videoCount > 0) {
        args.push("-map", "0:v:0", "-c:v", "copy");
      }
      if (audioCount > 0) {
        args.push("-map", "0:a:0", "-c:a", "copy");
      }
      args.push("-f", "webm", outputFile);
      return args;
    }

    if (videoCount > 0) {
      if (videoCount === 1) {
        filters.push("[0:v:0]setpts=PTS-STARTPTS,format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]");
      } else if (videoCount === 2) {
        // Normalize timestamps/cadence per input before stacking to keep
        // two-party recordings stable over longer sessions.
        filters.push("[0:v:0]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p,scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,fifo[v0]");
        filters.push("[0:v:1]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p,scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,fifo[v1]");
        filters.push("[v0][v1]hstack=inputs=2[vout]");
      } else {
        // For >2 videos, prefer a stable representative feed over fragile
        // large mosaics in the current recorder path.
        filters.push("[0:v:0]setpts=PTS-STARTPTS,format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]");
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
    args.push("-f", "webm", outputFile);
    return args;
  }

  buildSegmentFfmpegArgs(taps, sdpFile, outputFile) {
    const args = [
      "-loglevel", "warning",
      "-protocol_whitelist", "file,udp,rtp",
      "-fflags", "+genpts+discardcorrupt",
      "-use_wallclock_as_timestamps", "1",
      "-analyzeduration", "10000000",
      "-probesize", "50000000",
      "-max_delay", "20000000",
      "-f", "sdp",
      "-i", sdpFile
    ];
    const hasVideo = taps.some((t) => t.kind === "video");
    const hasAudio = taps.some((t) => t.kind === "audio");
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

  buildSegmentGstreamerArgs(sdpFile, outputFile) {
    const normalizedSdpFile = String(sdpFile).replace(/\\/g, "/");
    return [
      "-e",
      "filesrc",
      `location=${normalizedSdpFile}`,
      "!",
      "sdpdemux",
      "name=demux",
      "demux.",
      "!",
      "queue",
      "!",
      "application/x-rtp,media=video",
      "!",
      "rtpvp8depay",
      "!",
      "queue",
      "!",
      "mux.",
      "demux.",
      "!",
      "queue",
      "!",
      "application/x-rtp,media=audio",
      "!",
      "rtpopusdepay",
      "!",
      "opusparse",
      "!",
      "queue",
      "!",
      "mux.",
      "webmmux",
      "name=mux",
      "!",
      "filesink",
      `location=${outputFile}`
    ];
  }

  buildLiveComposeGstreamerArgs(taps, sdpFile, outputFile) {
    const normalizedSdpFile = String(sdpFile).replace(/\\/g, "/");
    const videoCount = Math.min(taps.filter((t) => t.kind === "video").length, 4);
    const audioCount = Math.min(taps.filter((t) => t.kind === "audio").length, 6);
    const args = ["-e", "filesrc", `location=${normalizedSdpFile}`, "!", "sdpdemux", "name=demux"];

    if (videoCount <= 1) {
      args.push(
        "compositor", "name=comp", "background=black",
        "!", "videoconvert",
        "!", "vp8enc", "deadline=1", "target-bitrate=2500000",
        "!", "queue",
        "!", "mux.",
        "demux.", "!", "application/x-rtp,media=video", "!", "rtpvp8depay", "!", "vp8dec", "!", "videoconvert", "!", "videoscale",
        "!", "video/x-raw,width=1280,height=720,framerate=30/1", "!", "queue", "!", "comp."
      );
    } else if (videoCount === 2) {
      args.push(
        "compositor", "name=comp", "background=black", "sink_0::xpos=0", "sink_1::xpos=640",
        "!", "videoconvert",
        "!", "video/x-raw,width=1280,height=720,framerate=30/1",
        "!", "vp8enc", "deadline=1", "target-bitrate=2800000",
        "!", "queue",
        "!", "mux.",
        "demux.", "!", "application/x-rtp,media=video", "!", "rtpvp8depay", "!", "vp8dec", "!", "videoconvert", "!", "videoscale",
        "!", "video/x-raw,width=640,height=720,framerate=30/1", "!", "queue", "!", "comp.sink_0",
        "demux.", "!", "application/x-rtp,media=video", "!", "rtpvp8depay", "!", "vp8dec", "!", "videoconvert", "!", "videoscale",
        "!", "video/x-raw,width=640,height=720,framerate=30/1", "!", "queue", "!", "comp.sink_1"
      );
    } else {
      args.push(
        "compositor", "name=comp", "background=black",
        "sink_0::xpos=0", "sink_0::ypos=0",
        "sink_1::xpos=640", "sink_1::ypos=0",
        "sink_2::xpos=0", "sink_2::ypos=360",
        "sink_3::xpos=640", "sink_3::ypos=360",
        "!", "videoconvert",
        "!", "video/x-raw,width=1280,height=720,framerate=30/1",
        "!", "vp8enc", "deadline=1", "target-bitrate=3000000",
        "!", "queue",
        "!", "mux."
      );
      for (let i = 0; i < videoCount; i += 1) {
        args.push(
          "demux.", "!", "application/x-rtp,media=video", "!", "rtpvp8depay", "!", "vp8dec", "!", "videoconvert", "!", "videoscale",
          "!", "video/x-raw,width=640,height=360,framerate=30/1", "!", "queue", "!", `comp.sink_${i}`
        );
      }
    }

    if (audioCount > 0) {
      args.push("audiomixer", "name=amix", "!", "audioconvert", "!", "audioresample", "!", "opusenc", "bitrate=128000", "!", "queue", "!", "mux.");
      for (let i = 0; i < audioCount; i += 1) {
        args.push(
          "demux.", "!", "application/x-rtp,media=audio", "!", "rtpopusdepay", "!", "opusdec", "!", "audioconvert", "!", "audioresample", "!", "queue", "!", "amix."
        );
      }
    }

    args.push("webmmux", "name=mux", "!", "filesink", `location=${outputFile}`);
    return args;
  }

  buildMergeArgs(inputFiles, outputFile) {
    const args = ["-loglevel", "warning"];
    for (const input of inputFiles) {
      args.push("-i", input);
    }
    const videoCount = inputFiles.length;
    const audioCount = inputFiles.length;
    const filters = [];
    if (videoCount === 1) {
      filters.push("[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2[vout]");
    } else if (videoCount === 2) {
      filters.push("[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=480:540:force_original_aspect_ratio=decrease,pad=480:540:(ow-iw)/2:(oh-ih)/2,fifo[v0]");
      filters.push("[1:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=480:540:force_original_aspect_ratio=decrease,pad=480:540:(ow-iw)/2:(oh-ih)/2,fifo[v1]");
      filters.push("[v0][v1]hstack=inputs=2:shortest=0[vout]");
    } else {
      const capped = Math.min(videoCount, 4);
      for (let i = 0; i < capped; i += 1) {
        filters.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,fifo[v${i}]`);
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
    args.push("-map", "[vout]", "-c:v", "libvpx-vp9", "-b:v", "1200k", "-crf", "32", "-deadline", "realtime", "-cpu-used", "5");
    if (audioCount > 0) {
      args.push("-map", "[aout]", "-c:a", "libopus", "-b:a", "64k");
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
      engine: recording.engine || this.getSegmentRecordingEngine(),
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
