const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { v7: uuidv7 } = require("uuid");

let pidusage = null;
try { pidusage = require("pidusage"); } catch (_e) {}

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
    this.mergeQueue = [];
    this.activeMergeCount = 0;
  }

  upsertHistory(sessionId, recording) {
    const existing = this.historyBySession.get(sessionId) || [];
    const next = existing.filter((item) => item.recordingId !== recording.recordingId);
    next.push(recording);
    this.historyBySession.set(sessionId, next);
  }

  async pickLargestSegment(segmentFiles = []) {
    let longest = segmentFiles[0] || null;
    let longestSize = -1;
    for (const seg of segmentFiles) {
      try {
        const stat = await fsp.stat(seg.outputFile);
        if (stat.size > longestSize) {
          longestSize = stat.size;
          longest = seg;
        }
      } catch (_e) {}
    }
    return longest;
  }

  async finalizeSegmentMerge(active, processing, segmentDetails, existingSegmentFiles, hooks = {}) {
    let finalOutputFile = active.storageUri;
    let mergeStderrTail = "";
    let finalState = "stopped";
    const isMp4MergeMode = active.mode === "segment_merge_mp4";

    try {
      const shouldRunMerge = existingSegmentFiles.length > 1 || (isMp4MergeMode && existingSegmentFiles.length >= 1);
      if (existingSegmentFiles.length === 1 && !isMp4MergeMode) {
        finalOutputFile = existingSegmentFiles[0].outputFile;
      } else if (shouldRunMerge) {
        const mergeCandidates = existingSegmentFiles.filter((seg) => seg.hasVideo);
        const mergeInputs = (mergeCandidates.length > 0 ? mergeCandidates : existingSegmentFiles).map((seg) => seg.outputFile);
        const mergeArgs = isMp4MergeMode
          ? this.buildMergeArgsMp4(mergeInputs, finalOutputFile)
          : this.buildMergeArgs(mergeInputs, finalOutputFile);
        const { proc: mergeFfmpeg, getStderrTail: getMergeStderrTail } = this.createProcess(this.config.ffmpegPath || "ffmpeg", mergeArgs);
        const mergeExitCode = await this.waitProcessExit(mergeFfmpeg, 45 * 60 * 1000);
        mergeStderrTail = getMergeStderrTail();
        if (mergeExitCode === 0) {
          for (const seg of existingSegmentFiles) {
            try {
              await fsp.unlink(seg.outputFile);
            } catch (_e) {}
          }
        } else {
          const longest = await this.pickLargestSegment(existingSegmentFiles);
          if (longest) {
            finalOutputFile = longest.outputFile;
          }
          finalState = mergeExitCode === null ? "failed" : "stopped";
        }
      }
    } catch (error) {
      finalState = "failed";
      mergeStderrTail = `${mergeStderrTail}\n${error.message}`.trim();
      const longest = await this.pickLargestSegment(existingSegmentFiles);
      if (longest) {
        finalOutputFile = longest.outputFile;
      }
    }

    let sizeBytes = null;
    try {
      const stat = await fsp.stat(finalOutputFile);
      sizeBytes = stat.size;
    } catch (_err) {}

    const finished = {
      ...processing,
      state: finalState,
      storageUri: finalOutputFile,
      sizeBytes,
      ffmpegStderrTail: segmentDetails.map((seg) => seg.stderrTail).filter(Boolean).join("\n"),
      segmentCount: existingSegmentFiles.length,
      mergeStderrTail
    };

    this.upsertHistory(processing.sessionId, finished);
    if (typeof hooks.onUpdate === "function") {
      await hooks.onUpdate(this.toPublic(finished));
    }
  }

  getMergeConcurrency() {
    const value = Number.parseInt(String(this.config.mergeConcurrency || 1), 10);
    return Number.isNaN(value) || value < 1 ? 1 : value;
  }

  enqueueSegmentMerge(job) {
    this.mergeQueue.push(job);
    void this.drainMergeQueue();
  }

  async drainMergeQueue() {
    const concurrency = this.getMergeConcurrency();
    if (this.activeMergeCount >= concurrency) return;

    const nextJob = this.mergeQueue.shift();
    if (!nextJob) return;

    this.activeMergeCount += 1;
    try {
      await this.finalizeSegmentMerge(
        nextJob.active,
        nextJob.processing,
        nextJob.segmentDetails,
        nextJob.existingSegmentFiles,
        nextJob.hooks
      );
    } catch (error) {
      const failed = {
        ...nextJob.processing,
        state: "failed",
        mergeStderrTail: error.message || "merge_background_failed"
      };
      this.upsertHistory(nextJob.processing.sessionId, failed);
      if (typeof nextJob.hooks?.onUpdate === "function") {
        await nextJob.hooks.onUpdate(this.toPublic(failed));
      }
    } finally {
      this.activeMergeCount = Math.max(this.activeMergeCount - 1, 0);
      void this.drainMergeQueue();
    }
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

  async runProcess(binary, args, timeoutMs = 10 * 60 * 1000) {
    const { proc, getStderrTail } = this.createProcess(binary, args);
    const exitCode = await this.waitProcessExit(proc, timeoutMs);
    if (exitCode === 0) return;
    throw new Error(`${binary}_failed code=${exitCode} detail=${getStderrTail()}`);
  }

  collectRecordingPids(recording) {
    const items = [];
    if (recording?._liveCompose && recording._liveProc?.pid && recording._liveProc.exitCode === null) {
      items.push({ pid: recording._liveProc.pid, label: "live" });
    }
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
      const mode = recording.mode || (recording._liveCompose ? "live_compose" : this.getRecordingMode());
      console.log(
        `[recording] timer session=${recording.sessionId} recordingId=${recording.recordingId} mode=${mode} state=${recording.state} elapsed=${elapsed}`
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
    const mode = recording.mode || (recording._liveCompose ? "live_compose" : this.getRecordingMode());
    for (const item of items) {
      const stat = stats[item.pid];
      if (!stat) continue;
      const memMb = (stat.memory / 1024 / 1024).toFixed(1);
      const cpu = stat.cpu.toFixed(1);
      console.log(
        `[recording] cpu session=${recording.sessionId} recordingId=${recording.recordingId} mode=${mode} ${item.label} pid=${item.pid} cpu=${cpu}% mem=${memMb}MB`
      );
    }
  }

  getSegmentRecordingEngine() {
    const engine = String(this.config.engine || "ffmpeg").toLowerCase();
    return engine === "gstreamer" ? "gstreamer" : "ffmpeg";
  }

  getRecordingMode() {
    const mode = String(this.config.mode || "segment_merge").toLowerCase();
    if (mode === "live_compose") return "live_compose";
    if (mode === "segment_upload") return "segment_upload";
    if (mode === "segment_local") return "segment_local";
    if (mode === "segment_merge_mp4") return "segment_merge_mp4";
    if (mode === "segment_upload_mp4") return "segment_upload_mp4";
    return "segment_merge";
  }

  getChunkSeconds() {
    const value = Number.parseInt(String(this.config.chunkSeconds || 5), 10);
    if (Number.isNaN(value) || value < 2) return 5;
    return Math.min(value, 60);
  }

  async listChunkFiles(segment, includeLatest = false) {
    if (!segment?.isChunked) {
      if (!segment?.outputFile) return [];
      return [segment.outputFile];
    }
    let names = [];
    try {
      names = await fsp.readdir(segment.outputDir);
    } catch (_e) {
      return [];
    }
    const prefix = String(segment.chunkFilePrefix || "");
    const files = names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".webm"))
      .sort()
      .map((name) => path.join(segment.outputDir, name));
    if (includeLatest) return files;
    return files.length > 1 ? files.slice(0, files.length - 1) : [];
  }

  async uploadPendingChunks(recording, hooks = {}, includeLatest = false) {
    const uploadChunk =
      typeof hooks.onUploadChunk === "function"
        ? hooks.onUploadChunk
        : typeof this.config.onUploadChunk === "function"
          ? this.config.onUploadChunk
          : null;
    if (!uploadChunk) return;
    const segments = recording?._segments || [];
    for (const segment of segments) {
      const candidates = await this.listChunkFiles(segment, includeLatest);
      const pendingFiles = candidates.filter((file) => !segment.uploadedChunks.has(file));
      if (pendingFiles.length === 0) continue;
      const segmentDetails = pendingFiles.map((outputFile) => ({
        participantId: segment.participantId,
        outputFile,
        hasVideo: (segment.taps || []).some((tap) => tap.kind === "video"),
        hasAudio: (segment.taps || []).some((tap) => tap.kind === "audio")
      }));
      try {
        const uploaded = await uploadChunk({
          recording: this.toPublic(recording),
          segmentDetails
        });
        const uploadedPaths = Array.isArray(uploaded)
          ? uploaded.map((item) => item.localPath).filter(Boolean)
          : pendingFiles;
        for (const file of uploadedPaths) {
          segment.uploadedChunks.add(file);
        }
        if (Array.isArray(uploaded)) {
          for (const item of uploaded) {
            if (!item?.localPath) continue;
            segment.uploadedDetailsByPath.set(item.localPath, {
              participantId: segment.participantId,
              outputFile: item.localPath,
              hasVideo: Boolean(item.hasVideo),
              hasAudio: Boolean(item.hasAudio),
              stderrTail: segment.getStderrTail ? segment.getStderrTail() : ""
            });
          }
        }
      } catch (_error) {}
    }
  }

  async logPendingChunks(recording, includeLatest = false) {
    if (!this.config.chunkLogs) return;
    const segments = recording?._segments || [];
    for (const segment of segments) {
      const candidates = await this.listChunkFiles(segment, includeLatest);
      const pendingLogFiles = candidates.filter((file) => !segment.loggedChunks.has(file));
      if (pendingLogFiles.length === 0) continue;
      for (const file of pendingLogFiles) {
        segment.loggedChunks.add(file);
        console.log(
          `[recording] chunk_ready session=${recording.sessionId} recordingId=${recording.recordingId} participant=${segment.participantId} file=${path.basename(file)}`
        );
      }
    }
  }

  async concatParticipantChunksLocal(workDir, participantId, chunkFiles) {
    await fsp.mkdir(workDir, { recursive: true });
    const concatListFile = path.join(workDir, `${participantId}_concat_list.txt`);
    const concatOutput = path.join(workDir, `${participantId}_participant.webm`);
    const lines = chunkFiles.map((file) => `file '${String(file).replace(/'/g, "'\\''")}'`).join("\n");
    await fsp.writeFile(concatListFile, `${lines}\n`, "utf8");
    await this.runProcess(this.config.ffmpegPath || "ffmpeg", [
      "-loglevel", "warning",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListFile,
      "-c", "copy",
      concatOutput
    ], 12 * 60 * 1000);
    return concatOutput;
  }

  async finalizeLocalChunkProcessing({ recording, segmentDetails = [] }) {
    const outputRoot = path.resolve(process.cwd(), this.config.outputDir || "recordings");
    const localRecordingDir = recording.localRecordingDir || outputRoot;
    const byParticipant = new Map();
    for (const seg of segmentDetails) {
      if (!seg?.outputFile) continue;
      const list = byParticipant.get(seg.participantId) || [];
      list.push(seg);
      byParticipant.set(seg.participantId, list);
    }
    if (byParticipant.size === 0) {
      return { state: "failed", reason: "no_local_segments_found" };
    }

    const manifestPath = path.join(localRecordingDir, "manifest.local.json");
    const participantMergedFiles = [];
    const localMergeDir = path.join(localRecordingDir, "_local_merge_work");
    await fsp.mkdir(localMergeDir, { recursive: true });

    const manifestSegments = [];
    for (const [participantId, segments] of byParticipant.entries()) {
      const sorted = segments.slice().sort((a, b) => String(a.outputFile).localeCompare(String(b.outputFile)));
      const chunkFiles = sorted.map((s) => s.outputFile);
      for (const seg of sorted) {
        manifestSegments.push({
          participantId,
          localPath: seg.outputFile,
          hasVideo: Boolean(seg.hasVideo),
          hasAudio: Boolean(seg.hasAudio)
        });
      }
      const merged = await this.concatParticipantChunksLocal(localMergeDir, participantId, chunkFiles);
      participantMergedFiles.push(merged);
    }

    let finalOutput = participantMergedFiles[0];
    if (participantMergedFiles.length > 1) {
      finalOutput = path.join(localRecordingDir, "final.local.webm");
      const mergeArgs = this.buildMergeArgs(participantMergedFiles, finalOutput);
      await this.runProcess(this.config.ffmpegPath || "ffmpeg", mergeArgs, 14 * 60 * 1000);
    } else {
      finalOutput = path.join(localRecordingDir, "final.local.webm");
      await fsp.copyFile(participantMergedFiles[0], finalOutput);
    }

    const manifest = {
      version: 1,
      recordingId: recording.recordingId,
      sessionId: recording.sessionId,
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt,
      durationMs: recording.durationMs,
      initiatedBy: recording.initiatedBy,
      stoppedBy: recording.stoppedBy,
      segmentCount: manifestSegments.length,
      participantCount: participantMergedFiles.length,
      segments: manifestSegments,
      finalOutput
    };
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    try {
      await fsp.rm(localMergeDir, { recursive: true, force: true });
    } catch (_e) {}
    const finalStat = await fsp.stat(finalOutput);
    return {
      state: "uploaded",
      storageUri: finalOutput,
      manifestKey: manifestPath,
      segmentCount: manifestSegments.length,
      sizeBytes: finalStat.size
    };
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

    const warmupTimer = setTimeout(async () => {
      for (const tap of taps) {
        try {
          await tap.consumer.resume();
        } catch (_err) {}
        if (tap.kind === "video" && tap.consumer && typeof tap.consumer.requestKeyFrame === "function") {
          try { await tap.consumer.requestKeyFrame(); } catch (_e) {}
        }
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

    proc.on("exit", (code) => {
      if (!recording._stopping && code !== 0 && code !== null) {
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
    const recordingMode = this.getRecordingMode();
    const isMp4MergeMode = recordingMode === "segment_merge_mp4" || recordingMode === "segment_upload_mp4";
    const outputFile = path.join(outputDir, `${recordingId}.${isMp4MergeMode ? "mp4" : "webm"}`);
    const participantIds = Array.from(new Set(mediaRefs.map((ref) => ref.participantId)));
    const segmentRecorders = [];
    let nextPort = this.config.basePort || 50040;
    if (nextPort % 2 !== 0) nextPort += 1;

    if (recordingMode === "live_compose") {
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

    const isSegmentUploadMode = recordingMode === "segment_upload";
    const isSegmentLocalMode = recordingMode === "segment_local";
    const isChunkedSegmentMode = isSegmentUploadMode || isSegmentLocalMode;
    const safeSessionId = String(sessionId || "unknown_session").replace(/[^a-zA-Z0-9_-]/g, "_");
    const localRecordingDir = isSegmentLocalMode ? path.join(outputDir, safeSessionId, recordingId) : outputDir;
    if (isSegmentLocalMode) {
      await fsp.mkdir(localRecordingDir, { recursive: true });
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
        const chunkFilePrefix = `${recordingId}_${safeParticipantId}_`;
        const participantBaseDir = isSegmentLocalMode
          ? path.join(localRecordingDir, safeParticipantId)
          : outputDir;
        const participantChunkDir = isSegmentLocalMode
          ? path.join(participantBaseDir, "chunks")
          : outputDir;
        if (isSegmentLocalMode) {
          await fsp.mkdir(participantChunkDir, { recursive: true });
        }
        const segmentFile = path.join(participantBaseDir, `${recordingId}_${safeParticipantId}.webm`);
        const chunkPattern = path.join(participantChunkDir, `${chunkFilePrefix}%06d.webm`);
        const sdpFile = path.join(participantBaseDir, `${recordingId}_${safeParticipantId}.sdp`);
        const sdp = this.buildSdp(taps);
        await fsp.writeFile(sdpFile, sdp, "utf8");
        const segmentEngine = this.getSegmentRecordingEngine();
        if (isChunkedSegmentMode && segmentEngine === "gstreamer") {
          throw new Error("segment_chunking_requires_ffmpeg_engine");
        }
        const processArgs =
          segmentEngine === "gstreamer"
            ? this.buildSegmentGstreamerArgs(sdpFile, segmentFile)
            : this.buildSegmentFfmpegArgs(taps, sdpFile, isChunkedSegmentMode ? chunkPattern : segmentFile, {
              chunked: isChunkedSegmentMode,
              chunkSeconds: this.getChunkSeconds()
            });
        const processBinary = segmentEngine === "gstreamer" ? (this.config.gstreamerPath || "gst-launch-1.0") : (this.config.ffmpegPath || "ffmpeg");
        const { proc: ffmpeg, getStderrTail } = this.createProcess(processBinary, processArgs);
        segmentRecorders.push({
          participantId,
          outputFile: isChunkedSegmentMode ? chunkPattern : segmentFile,
          sdpFile,
          taps,
          ffmpeg,
          engine: segmentEngine,
          getStderrTail,
          isChunked: isChunkedSegmentMode,
          outputDir: participantChunkDir,
          chunkFilePrefix,
          loggedChunks: new Set(),
          uploadedChunks: new Set(),
          uploadedDetailsByPath: new Map()
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

      let chunkUploadTimer = null;
      let chunkLogTimer = null;
      if (isChunkedSegmentMode && this.config.chunkLogs) {
        const logIntervalMs = Math.max(this.getChunkSeconds() * 1000, 5000);
        chunkLogTimer = setInterval(() => {
          void this.logPendingChunks(recording, false);
        }, logIntervalMs);
      }
      if (isSegmentUploadMode) {
        const uploadIntervalMs = Math.max(this.getChunkSeconds() * 1000, 5000);
        chunkUploadTimer = setInterval(() => {
          void this.uploadPendingChunks(recording, {}, false);
        }, uploadIntervalMs);
      }

      const recording = {
        recordingId,
        sessionId,
        engine: this.getSegmentRecordingEngine(),
        mode: recordingMode,
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
        _localRecordingDir: isSegmentLocalMode ? localRecordingDir : "",
        _keyframeTimer: keyframeTimer,
        _warmupTimer: warmupTimer,
        _chunkUploadTimer: chunkUploadTimer,
        _chunkLogTimer: chunkLogTimer,
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

    if (active._keyframeTimer) {
      clearInterval(active._keyframeTimer);
    }
    if (active._warmupTimer) {
      clearTimeout(active._warmupTimer);
    }
    if (active._chunkUploadTimer) {
      clearInterval(active._chunkUploadTimer);
    }
    if (active._chunkLogTimer) {
      clearInterval(active._chunkLogTimer);
    }
    if (active._cpuLogTimer) {
      clearInterval(active._cpuLogTimer);
    }
    if (pidusage) {
      try { pidusage.clear(); } catch (_e) {}
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
      delete finished._warmupTimer;
      delete finished._cpuLogTimer;
      this.activeBySession.delete(sessionId);
      this.upsertHistory(sessionId, finished);
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

    const segmentDetails = [];
    await this.logPendingChunks(active, true);
    for (const segment of segments) {
      for (const uploaded of segment.uploadedDetailsByPath.values()) {
        segmentDetails.push(uploaded);
      }
      const outputFiles = segment.isChunked
        ? await this.listChunkFiles(segment, true)
        : [segment.outputFile];
      for (const outputFile of outputFiles) {
        if (segment.uploadedChunks.has(outputFile)) continue;
        segmentDetails.push({
          participantId: segment.participantId,
          outputFile,
          hasVideo: (segment.taps || []).some((tap) => tap.kind === "video"),
          hasAudio: (segment.taps || []).some((tap) => tap.kind === "audio"),
          stderrTail: segment.getStderrTail ? segment.getStderrTail() : ""
        });
      }
    }
    const existingSegmentFiles = [];
    for (const seg of segmentDetails) {
      try {
        await fsp.access(seg.outputFile);
        existingSegmentFiles.push(seg);
      } catch (_e) {}
    }
    if (active._segments?.some((segment) => segment.isChunked)) {
      const expectedChunks = Math.max(Math.ceil(durationMs / (this.getChunkSeconds() * 1000)), 1);
      console.log(
        `[recording] chunk_summary session=${sessionId} recordingId=${active.recordingId} expectedChunks~=${expectedChunks} actualChunks=${existingSegmentFiles.length} durationMs=${durationMs}`
      );
    }

    const isLocalMp4MergeMode = active.mode === "segment_merge_mp4";
    const willRunMerge = existingSegmentFiles.length > 1 || (isLocalMp4MergeMode && existingSegmentFiles.length >= 1);
    const processing = {
      ...active,
      state: willRunMerge ? "processing" : "stopped",
      storageUri: !isLocalMp4MergeMode && existingSegmentFiles.length === 1
        ? existingSegmentFiles[0].outputFile
        : active.storageUri,
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
    delete processing._chunkUploadTimer;
    delete processing._chunkLogTimer;
    delete processing._cpuLogTimer;
    delete processing._localRecordingDir;

    this.activeBySession.delete(sessionId);
    this.upsertHistory(sessionId, processing);

    if (this.getRecordingMode() === "segment_upload") {
      const uploading = {
        ...processing,
        state: "uploading",
        storageUri: ""
      };
      this.upsertHistory(sessionId, uploading);
      if (typeof hooks.onUpdate === "function") {
        await hooks.onUpdate(this.toPublic(uploading));
      }
      await this.uploadPendingChunks(active, hooks, true);
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
          `[recording] upload_finalize_failed mode=segment_upload session=${sessionId} recordingId=${active.recordingId} error=${error?.message || String(error)}`,
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

    if (this.getRecordingMode() === "segment_local") {
      const localUploading = {
        ...processing,
        state: "uploading",
        storageUri: ""
      };
      this.upsertHistory(sessionId, localUploading);
      if (typeof hooks.onUpdate === "function") {
        await hooks.onUpdate(this.toPublic(localUploading));
      }
      try {
        const finalized = await this.finalizeLocalChunkProcessing({
          recording: {
            ...this.toPublic(localUploading),
            localRecordingDir: active._localRecordingDir || ""
          },
          segmentDetails: existingSegmentFiles
        });
        const finished = {
          ...localUploading,
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
        const failed = {
          ...localUploading,
          state: "failed",
          mergeStderrTail: error.message || "local_chunk_finalize_failed"
        };
        this.upsertHistory(sessionId, failed);
        if (typeof hooks.onUpdate === "function") {
          await hooks.onUpdate(this.toPublic(failed));
        }
        return { ok: true, recording: this.toPublic(failed) };
      }
    }

    if (this.getRecordingMode() === "segment_upload_mp4") {
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
        // copies to keep disk usage bounded. Failure paths (catch below)
        // intentionally leave local files in place for manual recovery.
        for (const seg of existingSegmentFiles) {
          try {
            await fsp.unlink(seg.outputFile);
          } catch (_e) {}
        }
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
          `[recording] upload_finalize_failed mode=segment_upload_mp4 session=${sessionId} recordingId=${active.recordingId} error=${error?.message || String(error)}`,
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

    if (!willRunMerge) {
      let sizeBytes = null;
      try {
        const stat = await fsp.stat(processing.storageUri);
        sizeBytes = stat.size;
      } catch (_err) {}
      const finished = { ...processing, sizeBytes };
      this.upsertHistory(sessionId, finished);
      return { ok: true, recording: this.toPublic(finished) };
    }

    this.enqueueSegmentMerge({
      active,
      processing,
      segmentDetails,
      existingSegmentFiles,
      hooks
    });

    return { ok: true, recording: this.toPublic(processing) };
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
      "-fflags", "+discardcorrupt",
      "-use_wallclock_as_timestamps", "1",
      "-analyzeduration", "1000000",
      "-probesize", "1000000",
      "-max_delay", "1000000",
      "-f", "sdp",
      "-i", sdpFile
    ];
    const videoCount = taps.filter((t) => t.kind === "video").length;
    const audioCount = taps.filter((t) => t.kind === "audio").length;
    const filters = [];

    // For the common 1:1 session recording, keep RTP packets as-is —
    // but only when the negotiated codecs are WebM-compatible. If the
    // router negotiated H.264 / non-Opus audio, fall through to transcode.
    if (videoCount <= 1 && audioCount <= 1) {
      const videoTap = taps.find((t) => t.kind === "video");
      const audioTap = taps.find((t) => t.kind === "audio");
      const videoMime = String(videoTap?.consumer?.rtpParameters?.codecs?.[0]?.mimeType || "").toLowerCase();
      const audioMime = String(audioTap?.consumer?.rtpParameters?.codecs?.[0]?.mimeType || "").toLowerCase();
      const videoCopyOk = !videoTap || /^video\/(vp8|vp9|av1)$/.test(videoMime);
      const audioCopyOk = !audioTap || /^audio\/(opus|vorbis)$/.test(audioMime);
      if (videoCopyOk && audioCopyOk) {
        if (videoCount > 0) {
          args.push("-map", "0:v:0", "-c:v", "copy");
        }
        if (audioCount > 0) {
          args.push("-map", "0:a:0", "-c:a", "copy");
        }
        args.push("-f", "webm", outputFile);
        return args;
      }
    }

    if (videoCount > 0) {
      if (videoCount === 1) {
        filters.push("[0:v:0]setpts=PTS-STARTPTS,format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]");
      } else if (videoCount === 2) {
        filters.push("[0:v:0]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p,scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,fifo[v0]");
        filters.push("[0:v:1]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p,scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,fifo[v1]");
        filters.push("[v0][v1]hstack=inputs=2[vout]");
      } else {
        const capped = Math.min(videoCount, 4);
        for (let i = 0; i < capped; i += 1) {
          filters.push(`[0:v:${i}]settb=AVTB,setpts=PTS-STARTPTS,fps=30,format=yuv420p,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,fifo[v${i}]`);
        }
        const joined = Array.from({ length: capped }, (_v, i) => `[v${i}]`).join("");
        const layout = capped === 3 ? "0_0|640_0|0_360" : "0_0|640_0|0_360|640_360";
        filters.push(`${joined}xstack=inputs=${capped}:layout=${layout}:fill=black:shortest=0[vout]`);
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

  buildSegmentFfmpegArgs(taps, sdpFile, outputFile, options = {}) {
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

    // Fast path for segment_merge: when not chunking and codecs are
    // WebM-compatible, repackage RTP into WebM with no decode/encode.
    // Chunked modes still transcode so segment boundaries land on keyframes.
    if (!options.chunked) {
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
    }

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
    if (options.chunked) {
      const chunkSeconds = Number.parseInt(String(options.chunkSeconds || 5), 10);
      const safeChunkSeconds = Number.isNaN(chunkSeconds) ? 5 : Math.max(chunkSeconds, 2);
      if (hasVideo) {
        const gop = Math.max(safeChunkSeconds * 30, 30);
        args.push(
          "-g", String(gop),
          "-keyint_min", String(gop),
          "-force_key_frames", `expr:gte(t,n_forced*${safeChunkSeconds})`
        );
      }
      args.push(
        "-f", "segment",
        "-segment_format", "webm",
        "-segment_time", String(safeChunkSeconds),
        "-break_non_keyframes", "1",
        "-segment_time_delta", "0.2",
        "-write_empty_segments", "1",
        "-reset_timestamps", "1",
        "-strftime", "0",
        outputFile
      );
      return args;
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
    args.push("-map", "[vout]", "-c:v", "libvpx-vp9", "-b:v", "1200k", "-crf", "32", "-deadline", "realtime", "-cpu-used", "3");
    if (audioCount > 0) {
      args.push("-map", "[aout]", "-c:a", "libopus", "-b:a", "64k");
    }
    args.push("-f", "webm", outputFile);
    return args;
  }

  buildMergeArgsMp4(inputFiles, outputFile) {
    const args = ["-loglevel", "warning"];
    for (const input of inputFiles) {
      args.push("-i", input);
    }
    const videoCount = inputFiles.length;
    const audioCount = inputFiles.length;
    const filters = [];
    if (videoCount === 1) {
      filters.push("[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]");
    } else if (videoCount === 2) {
      filters.push("[0:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,fifo[v0]");
      filters.push("[1:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=640:720:force_original_aspect_ratio=decrease,pad=640:720:(ow-iw)/2:(oh-ih)/2,fifo[v1]");
      filters.push("[v0][v1]hstack=inputs=2:shortest=0[vout]");
    } else {
      const capped = Math.min(videoCount, 4);
      for (let i = 0; i < capped; i += 1) {
        filters.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=24,format=yuv420p,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,fifo[v${i}]`);
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
    const preset = String(this.config.mp4Preset || "ultrafast");
    const crf = String(this.config.mp4Crf || 23);
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
      const audioBitrate = String(this.config.mp4AudioBitrate || "128k");
      args.push("-map", "[aout]", "-c:a", "aac", "-b:a", audioBitrate);
    }
    args.push("-movflags", "+faststart", "-f", "mp4", outputFile);
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
      mode: recording.mode || this.getRecordingMode(),
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
