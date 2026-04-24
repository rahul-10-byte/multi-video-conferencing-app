const { v7: uuidv7 } = require("uuid");
const { activeSessionsGauge, sessionsCreatedTotal } = require("../metrics");

class SessionStore {
  constructor(idleTtlSeconds) {
    this.idleTtlSeconds = idleTtlSeconds;
    this.sessions = new Map();
  }

  createSession({ externalRef = null, metadata = {}, ttlSeconds = 3600 }) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const sessionId = `vc_sess_${uuidv7().replaceAll("-", "")}`;
    const session = {
      sessionId,
      externalRef,
      metadata,
      status: "created",
      inviteLinks: [],
      inviteSentAt: null,
      disposition: null,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      participants: new Map(),
      lastActivityAt: now.toISOString()
    };
    this.sessions.set(sessionId, session);
    sessionsCreatedTotal.inc();
    activeSessionsGauge.set(this.sessions.size);
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  findSessionByRoomName(roomName) {
    const normalized = String(roomName || "").trim().toLowerCase();
    if (!normalized) return null;
    for (const session of this.sessions.values()) {
      const candidate = String(session?.metadata?.roomName || "").trim().toLowerCase();
      if (candidate && candidate === normalized) {
        return session;
      }
    }
    return null;
  }

  listParticipants(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return Array.from(session.participants.values());
  }

  upsertParticipant(sessionId, participant) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const previous = session.participants.get(participant.participantId);
    session.participants.set(participant.participantId, {
      participantId: participant.participantId,
      role: participant.role,
      displayName: participant.displayName || null,
      state: participant.state || "connected",
      joinedAt: previous?.joinedAt || participant.joinedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    if (session.participants.size > 0) {
      session.status = "active";
    }
    session.lastActivityAt = new Date().toISOString();
    return session.participants.get(participant.participantId);
  }

  setParticipantState(sessionId, participantId, state) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const participant = session.participants.get(participantId);
    if (!participant) return null;
    participant.state = state;
    participant.updatedAt = new Date().toISOString();
    session.lastActivityAt = new Date().toISOString();
    return participant;
  }

  removeParticipant(sessionId, participantId) {
    const session = this.getSession(sessionId);
    if (!session) return false;
    const didDelete = session.participants.delete(participantId);
    session.lastActivityAt = new Date().toISOString();
    if (session.participants.size === 0) {
      session.status = "idle";
    }
    return didDelete;
  }

  leaveSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.status = "ended";
    session.endedAt = new Date().toISOString();
    session.participants.clear();
    session.lastActivityAt = new Date().toISOString();
    return session;
  }

  addInviteLink(sessionId, invite) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.inviteLinks.push(invite);
    session.inviteSentAt = invite.sentAt || new Date().toISOString();
    session.lastActivityAt = new Date().toISOString();
    return session;
  }

  setDisposition(sessionId, disposition) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.disposition = disposition;
    session.lastActivityAt = new Date().toISOString();
    return session;
  }

  sweepExpiredSessions() {
    const nowMs = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      const expiresAtMs = new Date(session.expiresAt).getTime();
      const idleCutoff = new Date(session.lastActivityAt).getTime() + this.idleTtlSeconds * 1000;
      if (expiresAtMs <= nowMs || (session.participants.size === 0 && idleCutoff <= nowMs)) {
        this.sessions.delete(id);
      }
    }
    activeSessionsGauge.set(this.sessions.size);
  }
}

module.exports = { SessionStore };
