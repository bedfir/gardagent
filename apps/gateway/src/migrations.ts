import pg from "pg";

/** Initial DDL only: never replayed for adoption or a versioned restart. */
const INITIAL_SCHEMA = `
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
`;

export interface Migration {
  version: number;
  name: string;
  up(client: pg.PoolClient): Promise<void>;
}

// Separate from the ledger writer lock; held across commits on this connection.
const MIGRATION_LOCK = 72_617_002;

const LEGACY_COLUMNS: Record<string, string[]> = {
  "agents": [
    "id",
    "name",
    "key_hash",
    "allowed_models",
    "daily_budget",
    "active",
    "created_at",
    "allowed_tools",
    "approval_tools"
  ],
  "approvals": [
    "id",
    "created_at",
    "agent_id",
    "server",
    "tool",
    "args_hash",
    "args_summary",
    "status",
    "decided_at",
    "reason",
    "access_class"
  ],
  "agent_spend": [
    "agent_id",
    "day",
    "amount"
  ],
  "agent_reservations": [
    "id",
    "agent_id",
    "day",
    "amount",
    "created_at",
    "action",
    "model",
    "request_hash"
  ],
  "ledger": [
    "seq",
    "ts",
    "agent_id",
    "action",
    "model",
    "verdict",
    "reason",
    "upstream_status",
    "prompt_tokens",
    "completion_tokens",
    "cost",
    "request_hash",
    "response_hash",
    "prev_hash",
    "hash",
    "degraded"
  ],
  "ledger_idempotency": [
    "key",
    "seq",
    "created_at"
  ],
  "spend_settlements": [
    "key",
    "created_at"
  ]
};

const LEGACY_INDEXES = ["approvals_status_idx", "agent_reservations_agent_idx", "ledger_ts_idx", "ledger_agent_ts_idx", "ledger_agent_seq_idx", "ledger_model_seq_idx"];

async function initialize(client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [Object.keys(LEGACY_COLUMNS)],
  );
  if (rows.length === 0) {
    await client.query(INITIAL_SCHEMA);
    return;
  }
  for (const [table, columns] of Object.entries(LEGACY_COLUMNS)) {
    for (const column of columns) {
      if (!rows.some((row) => row.table_name === table && row.column_name === column)) {
        throw new Error(`Cannot adopt incomplete 0.3.0 schema: missing ${table}.${column}`);
      }
    }
  }
  const indexes = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])",
    [LEGACY_INDEXES],
  );
  const trigger = await client.query(
    `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = current_schema() AND c.relname = 'ledger'
       AND t.tgname = 'ledger_no_update' AND t.tgenabled = 'O'
       AND t.tgtype = 27 AND p.proname = 'ledger_append_only'`,
  );
  if (indexes.rows.length !== LEGACY_INDEXES.length || trigger.rows.length !== 1) {
    throw new Error("Cannot adopt incomplete 0.3.0 schema: missing indexes or append-only trigger");
  }
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "0.3.0 baseline", up: initialize },
  { version: 2, name: "Ledger format 2", up: async (client) => {
    await client.query(`ALTER TABLE ledger
      ADD COLUMN format_version INTEGER,
      ADD COLUMN policy_rev TEXT,
      ADD COLUMN operator_id TEXT,
      ADD COLUMN approval_ref TEXT`);
  } },
];

/** The optional migration list permits rollback tests without shipping a failing migration. */
export async function migrateDatabase(pool: pg.Pool, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) throw new Error("Migration definitions must be numbered contiguously from 1");
  }
  const client = await pool.connect();
  let locked = false;
  let discard = false;
  let step = "metadata";
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    locked = true;
    await client.query("BEGIN");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
    const latest = rows.at(-1)?.version ?? 0;
    if (latest > migrations.length) {
      throw new Error(`Database schema version ${latest} is newer than supported version ${migrations.length}; use a matching executable`);
    }
    if (rows.some((row, index) => row.version !== index + 1)) throw new Error("Database migration history has gaps");
    await client.query("COMMIT");
    for (const migration of migrations.slice(latest)) {
      step = `${migration.version} (${migration.name})`;
      await client.query("BEGIN");
      await migration.up(client);
      await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [migration.version, migration.name]);
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { discard = true; });
    throw new Error(`Database migration ${step} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => { discard = true; });
    client.release(discard);
  }
}
