const { v7: uuidv7 } = require("uuid");

class RecordingService {
  constructor() {
    this.activeBySession = new Map();
    this.historyBySession = new Map();
  }

  start(sessionId, initiatedBy) {
    if (this.activeBySession.has(sessionId)) {
      return { ok: false, reason: "recording_already_active" };
    }
    const startedAt = new Date().toISOString();
    const recording = {
      recordingId: `vc_rec_${uuidv7().replaceAll("-", "")}`,
      sessionId,
      state: "recording",
      storageUri: null,
      startedAt,
      stoppedAt: null,
      durationMs: null,
      sizeBytes: null,
      initiatedBy
    };
    this.activeBySession.set(sessionId, recording);
    return { ok: true, recording };
  }

  stop(sessionId, stoppedBy) {
    const active = this.activeBySession.get(sessionId);
    if (!active) {
      return { ok: false, reason: "recording_not_active" };
    }
    const stoppedAt = new Date().toISOString();
    const durationMs = Math.max(new Date(stoppedAt).getTime() - new Date(active.startedAt).getTime(), 0);
    const finished = {
      ...active,
      state: "stopped",
      stoppedAt,
      durationMs,
      stoppedBy
    };
    this.activeBySession.delete(sessionId);
    const existing = this.historyBySession.get(sessionId) || [];
    existing.push(finished);
    this.historyBySession.set(sessionId, existing);
    return { ok: true, recording: finished };
  }

  getActive(sessionId) {
    return this.activeBySession.get(sessionId) || null;
  }

  listHistory(sessionId) {
    return this.historyBySession.get(sessionId) || [];
  }
}

module.exports = { RecordingService };
