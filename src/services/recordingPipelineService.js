const path = require("path");
const fsp = require("fs/promises");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

class RecordingPipelineService {
  constructor(config = {}) {
    this.config = config;
    this.bucket = String(config.s3Bucket || "").trim();
    this.prefix = String(config.s3Prefix || "recordings").replace(/^\/+|\/+$/g, "");
    this.region = String(config.awsRegion || "ap-south-1");
    this.processingLambdaName = String(config.processingLambdaName || "").trim();
    this.s3 = this.bucket ? new S3Client({ region: this.region }) : null;
    this.lambda = this.processingLambdaName ? new LambdaClient({ region: this.region }) : null;
    this.uploadedChunkByPath = new Map();
  }

  isEnabled() {
    return Boolean(this.bucket);
  }

  buildChunkKey({ sessionId, recordingId, participantId, filename }) {
    const safeSession = String(sessionId || "unknown_session").replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeRecording = String(recordingId || "unknown_recording").replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeParticipant = String(participantId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    const base = path.basename(filename || "");
    return `${this.prefix}/${safeSession}/${safeRecording}/${safeParticipant}/${base}`;
  }

  buildManifestKey({ sessionId, recordingId }) {
    const safeSession = String(sessionId || "unknown_session").replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeRecording = String(recordingId || "unknown_recording").replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${this.prefix}/${safeSession}/${safeRecording}/manifest.json`;
  }

  async uploadFile(localPath, key) {
    if (!this.s3) throw new Error("recording_s3_not_configured");
    const body = await fsp.readFile(localPath);
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "video/webm"
      }));
    } catch (error) {
      console.error(
        `[recording] s3_upload_failed bucket=${this.bucket} key=${key} localPath=${localPath} error=${error?.name || "Error"}: ${error?.message || String(error)}`
      );
      throw error;
    }
  }

  async uploadChunkFiles({ recording, segmentDetails = [] }) {
    if (!this.s3) throw new Error("recording_s3_not_configured");
    const uploaded = [];
    for (const segment of segmentDetails) {
      const localPath = segment.outputFile;
      if (!localPath) continue;
      if (this.uploadedChunkByPath.has(localPath)) {
        uploaded.push(this.uploadedChunkByPath.get(localPath));
        continue;
      }
      const key = this.buildChunkKey({
        sessionId: recording.sessionId,
        recordingId: recording.recordingId,
        participantId: segment.participantId,
        filename: localPath
      });
      const stat = await fsp.stat(localPath);
      await this.uploadFile(localPath, key);
      const detail = {
        participantId: segment.participantId,
        key,
        sizeBytes: stat.size,
        hasVideo: Boolean(segment.hasVideo),
        hasAudio: Boolean(segment.hasAudio),
        localPath
      };
      this.uploadedChunkByPath.set(localPath, detail);
      uploaded.push(detail);
    }
    return uploaded;
  }

  async uploadJson(key, data) {
    if (!this.s3) throw new Error("recording_s3_not_configured");
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(data, null, 2),
        ContentType: "application/json"
      }));
    } catch (error) {
      console.error(
        `[recording] s3_manifest_upload_failed bucket=${this.bucket} key=${key} error=${error?.name || "Error"}: ${error?.message || String(error)}`
      );
      throw error;
    }
  }

  async finalizeAndTrigger({ recording, segmentDetails = [] }) {
    if (!this.s3) {
      return {
        state: "failed",
        reason: "recording_s3_not_configured",
        uploadedSegments: []
      };
    }

    const uploadedSegments = [];
    let totalSize = 0;
    for (const segment of segmentDetails) {
      const [uploaded] = await this.uploadChunkFiles({ recording, segmentDetails: [segment] });
      if (!uploaded) continue;
      uploadedSegments.push({
        participantId: uploaded.participantId,
        key: uploaded.key,
        sizeBytes: uploaded.sizeBytes,
        hasVideo: uploaded.hasVideo,
        hasAudio: uploaded.hasAudio
      });
      totalSize += uploaded.sizeBytes;
    }

    const manifestKey = this.buildManifestKey({
      sessionId: recording.sessionId,
      recordingId: recording.recordingId
    });
    const isMp4OutputMode = String(recording?.mode || "").toLowerCase() === "segment_upload_mp4";
    const manifest = {
      version: 1,
      sessionId: recording.sessionId,
      recordingId: recording.recordingId,
      mode: recording?.mode || "",
      outputFormat: isMp4OutputMode ? "mp4" : "webm",
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt,
      durationMs: recording.durationMs,
      initiatedBy: recording.initiatedBy,
      stoppedBy: recording.stoppedBy,
      segmentCount: uploadedSegments.length,
      segments: uploadedSegments
    };
    await this.uploadJson(manifestKey, manifest);

    if (this.lambda) {
      const payload = {
        type: "recording_manifest_finalized",
        bucket: this.bucket,
        manifestKey,
        recordingId: recording.recordingId,
        sessionId: recording.sessionId
      };
      try {
        await this.lambda.send(new InvokeCommand({
          FunctionName: this.processingLambdaName,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify(payload))
        }));
      } catch (error) {
        console.error(
          `[recording] lambda_invoke_failed function=${this.processingLambdaName} sessionId=${recording.sessionId} recordingId=${recording.recordingId} error=${error?.name || "Error"}: ${error?.message || String(error)}`
        );
        throw error;
      }
    }

    return {
      state: "uploaded",
      storageUri: `s3://${this.bucket}/${manifestKey}`,
      manifestKey,
      segmentCount: uploadedSegments.length,
      sizeBytes: totalSize,
      uploadedSegments
    };
  }
}

module.exports = { RecordingPipelineService };
