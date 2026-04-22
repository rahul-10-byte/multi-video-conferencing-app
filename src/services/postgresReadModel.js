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
