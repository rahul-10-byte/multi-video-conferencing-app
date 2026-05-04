-- VC Postgres read model (optional; enabled when DATABASE_URL set).
-- Tables are also created by src/services/postgresReadModel.js migrate() at startup.
-- This file is the human-readable contract + greenfield reference.

-- ---------------------------------------------------------------------------
-- vc_sessions
-- Snapshot of one room/call: ids match in-memory SessionStore (vc_sess_*).
-- invite_links: JSON array of strings (URLs), appended on customer-invite.
-- metadata: JSON (e.g. roomName, displayName).
-- ---------------------------------------------------------------------------
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
-- Suggested CHECK (status): created | active | idle | ended — add after data audit.

CREATE INDEX IF NOT EXISTS idx_vc_sessions_status_created_at
  ON vc_sessions (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- vc_recordings
-- One row per recording attempt (vc_rec_*). state follows RecordingService.
-- storage_uri: e.g. s3://bucket/.../manifest.json after upload.
-- manifest_key: S3 key to manifest (same path as inside storage_uri; query-friendly).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vc_recordings (
  recording_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  storage_uri TEXT,
  manifest_key TEXT,
  initiated_by TEXT,
  stopped_by TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  duration_ms BIGINT,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Suggested CHECK (state): recording | processing | uploading | uploaded | failed

CREATE INDEX IF NOT EXISTS idx_vc_recordings_session_started_at
  ON vc_recordings (session_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_vc_recordings_state
  ON vc_recordings (state);

CREATE INDEX IF NOT EXISTS idx_vc_recordings_manifest_key
  ON vc_recordings (manifest_key)
  WHERE manifest_key IS NOT NULL;

-- Optional FK (add only if no orphan rows): session must exist first.
-- ALTER TABLE vc_recordings
--   ADD CONSTRAINT fk_vc_recordings_session
--   FOREIGN KEY (session_id) REFERENCES vc_sessions (session_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- vc_dispositions
-- One row per session: agent outcome after call (resolved | follow_up | dropped).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vc_dispositions (
  session_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  notes TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ NOT NULL
);
-- Suggested CHECK (outcome): resolved | follow_up | dropped

CREATE INDEX IF NOT EXISTS idx_vc_dispositions_resolved_at_outcome
  ON vc_dispositions (resolved_at DESC, outcome);

-- ---------------------------------------------------------------------------
-- vc_session_events
-- Append-only event log (idempotent on event_id). payload = full envelope JSONB.
-- session_id nullable if event has no session context.
-- ---------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_vc_session_events_session_id_time
  ON vc_session_events (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_vc_session_events_event_type_time
  ON vc_session_events (event_type, occurred_at DESC);
