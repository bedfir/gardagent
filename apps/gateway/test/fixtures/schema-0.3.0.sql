
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  allowed_models  TEXT[] NOT NULL,
  daily_budget    BIGINT NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent migration: databases created before MCP tools do not have this column.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_tools TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE agents ADD COLUMN IF NOT EXISTS approval_tools TEXT[] NOT NULL DEFAULT '{}';

-- Human validation requests. args_summary is the only readable trace of arguments (never in the ledger).
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  server        TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args_hash     TEXT NOT NULL,
  args_summary  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_at    TEXT,
  reason        TEXT,
  access_class  TEXT NOT NULL DEFAULT 'write'
);

-- Idempotent migration: add access_class to existing approvals tables.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS access_class TEXT NOT NULL DEFAULT 'write';

CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status, created_at);

CREATE TABLE IF NOT EXISTS agent_spend (
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  day       TEXT NOT NULL,
  amount    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);

-- In-flight budget reservations, one row each so that a stuck one can expire on its own.
CREATE TABLE IF NOT EXISTS agent_reservations (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  day        TEXT NOT NULL,
  amount     BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- What the call was, so that an orphaned reservation can still leave a ledger row (interrupted_no_response).
-- Idempotent migration; nullable: reservations created before it hold no metadata.
ALTER TABLE agent_reservations ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE agent_reservations ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE agent_reservations ADD COLUMN IF NOT EXISTS request_hash TEXT;
CREATE INDEX IF NOT EXISTS agent_reservations_agent_idx ON agent_reservations (agent_id, day);

CREATE TABLE IF NOT EXISTS ledger (
  seq                BIGINT PRIMARY KEY,
  ts                 TEXT NOT NULL,
  agent_id           TEXT,
  action             TEXT NOT NULL,
  model              TEXT,
  verdict            TEXT NOT NULL,
  reason             TEXT,
  upstream_status    INTEGER,
  prompt_tokens      INTEGER NOT NULL,
  completion_tokens  INTEGER NOT NULL,
  cost               BIGINT NOT NULL,
  request_hash       TEXT,
  response_hash      TEXT,
  prev_hash          TEXT NOT NULL,
  hash               TEXT NOT NULL UNIQUE
);

-- Rows that went through the local spool (database outage). Idempotent migration for older databases.
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per idempotency key: written in the same transaction as the ledger row it guards, so a spool line
-- replayed twice (crash, client timeout, timeout during COMMIT) yields one ledger row. Not part of the chain.
CREATE TABLE IF NOT EXISTS ledger_idempotency (
  key        TEXT PRIMARY KEY,
  seq        BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keys of spend increments applied for a call, so that a settlement is never counted twice.
CREATE TABLE IF NOT EXISTS spend_settlements (
  key        TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_ts_idx ON ledger (ts);
CREATE INDEX IF NOT EXISTS ledger_agent_ts_idx ON ledger (agent_id, ts);
-- Ledger filters: the list is paged by seq, so an equality filter plus seq lets PostgreSQL read the matching rows
-- already in seq order and stop at LIMIT (instead of scanning the primary key and discarding the rest).
CREATE INDEX IF NOT EXISTS ledger_agent_seq_idx ON ledger (agent_id, seq);
CREATE INDEX IF NOT EXISTS ledger_model_seq_idx ON ledger (model, seq);

-- The ledger is append-only: any modification or deletion is rejected by the database.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Gardagent ledger is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_no_update ON ledger;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
