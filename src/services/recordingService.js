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
    const audioRef = producerRefs.find((p) => p.kind === "audio");
    const videoRef = producerRefs.find((p) => p.kind === "video");
    if (!audioRef && !videoRef) {
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
        paused: false
      });
      taps.push({ kind: ref.kind, transport, consumer, rtpPort });
    };

    try {
      await addTap(audioRef);
      await addTap(videoRef);
      const sdp = this.buildSdp(taps);
      await fsp.writeFile(sdpFile, sdp, "utf8");
      const ffmpeg = spawn(this.config.ffmpegPath || "ffmpeg", [
        "-protocol_whitelist", "file,udp,rtp",
        "-f", "sdp",
        "-i", sdpFile,
        "-map", "0:v?",
        "-map", "0:a?",
        "-c:v", "copy",
        "-c:a", "copy",
        "-f", "webm",
        outputFile
      ], { stdio: ["ignore", "pipe", "pipe"] });

      ffmpeg.stdout.on("data", () => {});
      ffmpeg.stderr.on("data", () => {});

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
        _ffmpeg: ffmpeg,
        _sdpFile: sdpFile,
        _taps: taps
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

    for (const tap of active._taps || []) {
      try { tap.consumer.close(); } catch (_e) {}
      try { tap.transport.close(); } catch (_e) {}
    }

    if (active._ffmpeg && !active._ffmpeg.killed) {
      active._ffmpeg.kill("SIGINT");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        active._ffmpeg.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
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
      sizeBytes
    };
    delete finished._ffmpeg;
    delete finished._sdpFile;
    delete finished._taps;

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
      if (tap.kind === "audio") {
        lines.push(`m=audio ${tap.rtpPort} RTP/AVP 111`);
        lines.push("a=rtpmap:111 opus/48000/2");
      } else {
        lines.push(`m=video ${tap.rtpPort} RTP/AVP 96`);
        lines.push("a=rtpmap:96 VP8/90000");
      }
    }
    return `${lines.join("\n")}\n`;
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
      stoppedBy: recording.stoppedBy
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
