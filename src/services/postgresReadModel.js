const { Pool } = require("pg");

class PostgresReadModel {
  constructor(config) {
    this.enabled = Boolean(config?.url);
    this.pool = null;
    this.config = config;
  }

  async connect() {
    if (!this.enabled) return;
    this.pool = new Pool({
      connectionString: this.config.url,
      max: this.config.poolMax,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false
    });
    await this.pool.query("SELECT 1");
    await this.migrate();
  }

  async migrate() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vc_sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        external_ref TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        invite_links JSONB NOT NULL DEFAULT '[]'::jsonb,
        invite_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vc_sessions_status_created_at
      ON vc_sessions (status, created_at DESC);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vc_recordings (
        recording_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        storage_uri TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        stopped_at TIMESTAMPTZ,
        duration_ms BIGINT,
        size_bytes BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vc_recordings_session_started_at
      ON vc_recordings (session_id, started_at DESC);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vc_dispositions (
        session_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL,
        notes TEXT,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ NOT NULL
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vc_dispositions_resolved_at_outcome
      ON vc_dispositions (resolved_at DESC, outcome);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vc_session_events (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT UNIQUE NOT NULL,
        event_type TEXT NOT NULL,
        session_id TEXT,
        participant_id TEXT,
        role TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vc_session_events_session_id_time
      ON vc_session_events (session_id, occurred_at DESC);
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vc_session_events_event_type_time
      ON vc_session_events (event_type, occurred_at DESC);
    `);
  }

  async persistEvent(envelope) {
    if (!this.pool) return;
    const sessionId = envelope.sessionId || null;
    const participantId = envelope.participantId || null;
    const role = envelope.role || null;
    await this.pool.query(
      `
      INSERT INTO vc_session_events
      (event_id, event_type, session_id, participant_id, role, occurred_at, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (event_id) DO NOTHING
      `,
      [
        envelope.eventId,
        envelope.eventType,
        sessionId,
        participantId,
        role,
        envelope.occurredAt,
        JSON.stringify(envelope)
      ]
    );
  }

  async upsertSession(session) {
    if (!this.pool) return;
    await this.pool.query(
      `
      INSERT INTO vc_sessions
      (session_id, status, external_ref, metadata, invite_links, invite_sent_at, created_at, started_at, ended_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, NOW())
      ON CONFLICT (session_id) DO UPDATE SET
        status = EXCLUDED.status,
        external_ref = EXCLUDED.external_ref,
        metadata = EXCLUDED.metadata,
        invite_links = EXCLUDED.invite_links,
        invite_sent_at = EXCLUDED.invite_sent_at,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        updated_at = NOW()
      `,
      [
        session.sessionId,
        session.status,
        session.externalRef || null,
        JSON.stringify(session.metadata || {}),
        JSON.stringify(session.inviteLinks || []),
        session.inviteSentAt || null,
        session.createdAt,
        session.startedAt || null,
        session.endedAt || null
      ]
    );
  }

  async appendInviteLink(sessionId, inviteLink, inviteSentAt) {
    if (!this.pool) return;
    await this.pool.query(
      `
      UPDATE vc_sessions
      SET invite_links = COALESCE(invite_links, '[]'::jsonb) || to_jsonb($2::text),
          invite_sent_at = $3,
          updated_at = NOW()
      WHERE session_id = $1
      `,
      [sessionId, inviteLink, inviteSentAt]
    );
  }

  async saveRecording(recording) {
    if (!this.pool) return;
    await this.pool.query(
      `
      INSERT INTO vc_recordings
      (recording_id, session_id, state, storage_uri, started_at, stopped_at, duration_ms, size_bytes, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      ON CONFLICT (recording_id) DO UPDATE SET
        state = EXCLUDED.state,
        storage_uri = EXCLUDED.storage_uri,
        stopped_at = EXCLUDED.stopped_at,
        duration_ms = EXCLUDED.duration_ms,
        size_bytes = EXCLUDED.size_bytes,
        updated_at = NOW()
      `,
      [
        recording.recordingId,
        recording.sessionId,
        recording.state,
        recording.storageUri || null,
        recording.startedAt,
        recording.stoppedAt || null,
        recording.durationMs || null,
        recording.sizeBytes || null
      ]
    );
  }

  async upsertDisposition(disposition) {
    if (!this.pool) return;
    await this.pool.query(
      `
      INSERT INTO vc_dispositions (session_id, outcome, notes, resolved_by, resolved_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (session_id) DO UPDATE SET
        outcome = EXCLUDED.outcome,
        notes = EXCLUDED.notes,
        resolved_by = EXCLUDED.resolved_by,
        resolved_at = EXCLUDED.resolved_at
      `,
      [
        disposition.sessionId,
        disposition.outcome,
        disposition.notes || null,
        disposition.resolvedBy || null,
        disposition.resolvedAt
      ]
    );
  }

  async listSessionEvents(sessionId, limit = 100) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `
      SELECT event_id, event_type, session_id, participant_id, role, occurred_at, payload
      FROM vc_session_events
      WHERE session_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2
      `,
      [sessionId, limit]
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      sessionId: row.session_id,
      participantId: row.participant_id,
      role: row.role,
      occurredAt: row.occurred_at,
      payload: row.payload
    }));
  }

  async listRecentSessions(limit = 50) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `
      SELECT session_id, MAX(occurred_at) AS last_event_at, COUNT(*)::int AS event_count
      FROM vc_session_events
      WHERE session_id IS NOT NULL
      GROUP BY session_id
      ORDER BY last_event_at DESC
      LIMIT $1
      `,
      [limit]
    );
    return result.rows.map((row) => ({
      sessionId: row.session_id,
      lastEventAt: row.last_event_at,
      eventCount: row.event_count
    }));
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

module.exports = { PostgresReadModel };
