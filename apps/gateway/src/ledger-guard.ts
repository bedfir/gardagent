import { randomUUID } from "node:crypto";
import { access, constants, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256, type LedgerInput, type LedgerSettlement, type Store } from "@gardagent/core";

/** The spool holds ledger rows: readable by the gateway's user only (applies when the application creates them). */
const SPOOL_FILE_MODE = 0o600;
const SPOOL_DIR_MODE = 0o700;

export interface GuardLogger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface GuardOptions {
  spoolPath?: string;
  /** Delays between the attempts of a ledger write (3 attempts = 2 delays). */
  retryDelaysMs?: number[];
  /** Interval of the health probe / spool replay timer. */
  replayIntervalMs?: number;
  /** Maximum time of the database probe. */
  probeTimeoutMs?: number;
  /**
   * Maximum time of a database call made on the request path (agent lookup, budget, ledger write) before the database
   * is declared unreachable. Default 600 ms; GARDAGENT_DB_CALL_TIMEOUT_MS.
   */
  callTimeoutMs?: number;
  /** Observe + fail-open: keep forwarding traffic while the database is down, as long as the spool is durable. */
  failOpen?: boolean;
  /** Hard cap of the spool file, in bytes. Default 64 MiB. */
  spoolMaxBytes?: number;
  /**
   * Age after which a budget reservation is an orphan (upstream timeout + margin: past it, it no longer counts
   * anyway). When set, the guard purges older reservations from the database while it is healthy.
   */
  reservationTtlMs?: number;
}

/** How often the orphan reservations are purged. */
export const HOUSEKEEPING_INTERVAL_MS = 60_000;
const HOUSEKEEPING_TIMEOUT_MS = 30_000;

export const DEFAULT_SPOOL_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_DB_CALL_TIMEOUT_MS = 600;
export const DEFAULT_DB_PROBE_TIMEOUT_MS = 800;

/** A database call did not answer in time: the connection is considered dead, not merely slow. */
export class DbTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`database call timeout (${timeoutMs} ms)`);
  }
}

/**
 * Extra data kept next to a spooled row (never inserted into the ledger): what a later budget settlement needs
 * when the database reservation/settlement was skipped during an outage.
 */
export interface SpoolMeta {
  budgetDay?: string;
  budgetSettlement?: "pending";
  estimatedCost?: number;
  degraded?: boolean;
  /** Reservation taken for the call and not released (database down): dropped when the line is replayed. */
  reservationId?: string | null;
  /** Idempotency key of the spend increment (shared with the settlement attempt that may have timed out). */
  settlementKey?: string;
  /** Stable id of the spool line: the idempotency key of its ledger row. Generated when the line is spooled. */
  spoolId?: string;
}

export type SpooledLine = LedgerInput & { spoolMeta?: SpoolMeta };

export class SpoolError extends Error {}

export function defaultSpoolPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GARDAGENT_LEDGER_SPOOL || "/app/spool/ledger.jsonl";
}

/**
 * Keeps the ledger complete when the database fails: retry, then append (fsync) to a local spool (JSON Lines),
 * replayed in order into the chained ledger as soon as the database is back. Never drops an entry.
 * While the store is known to be unhealthy, callers must refuse new traffic (fail closed) unless fail-open is
 * enabled (observe mode only) and the spool is writable: proof first.
 */
export class LedgerGuard {
  private healthy = true;
  private backlog = 0;
  private spoolOk = true;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private lastHousekeeping = 0;
  private readonly spoolPath: string;
  private readonly retryDelays: number[];
  private readonly probeTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly failOpen: boolean;
  readonly spoolMaxBytes: number;

  constructor(
    private readonly store: Store,
    private readonly log: GuardLogger,
    private readonly options: GuardOptions = {},
  ) {
    this.spoolPath = options.spoolPath ?? join(tmpdir(), `gardagent-spool-${process.pid}.jsonl`);
    this.retryDelays = options.retryDelaysMs ?? [100, 400];
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_DB_PROBE_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_DB_CALL_TIMEOUT_MS;
    this.failOpen = options.failOpen === true;
    this.spoolMaxBytes = options.spoolMaxBytes ?? DEFAULT_SPOOL_MAX_BYTES;
  }

  /** False when the store is known to be unreachable or the spool is not empty: normal operation is impossible. */
  isReady(): boolean {
    return this.healthy && this.backlog === 0;
  }

  /** True when traffic may be forwarded: normal operation, or degraded fail-open with a writable spool. */
  canServe(): boolean {
    return this.isReady() || (this.failOpen && this.spoolOk);
  }

  /** True while running without the database (fail-open): no DB budget, no approvals. */
  degraded(): boolean {
    return !this.isReady();
  }

  /** Marks the store unhealthy at once (e.g. a request hit a connection error); the timer rechecks. */
  markUnhealthy(): void {
    this.healthy = false;
  }

  /** True once a call failed or timed out and until a probe or a successful write says otherwise. */
  dbKnownDown(): boolean {
    return !this.healthy;
  }

  /**
   * Bounds a database call made on the request path. A call that does not answer within `callTimeoutMs` (dead
   * connection, frozen server: the driver would wait for TCP/pool timeouts of 5 s or more) marks the database
   * unhealthy at once, so that every later call of the same outage skips the database, and fails with DbTimeoutError.
   */
  bounded<T>(promise: Promise<T>, onTimeout?: () => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        if (this.healthy) this.log.warn({ timeoutMs: this.callTimeoutMs, failOpen: this.failOpen }, "Database call timeout: database considered unreachable");
        this.healthy = false;
        reject(new DbTimeoutError(this.callTimeoutMs));
      }, this.callTimeoutMs);
    });
    // The abandoned call may still reject later: nobody listens, it must not become an unhandled rejection.
    promise.catch(() => undefined);
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  }

  spoolBacklog(): number {
    return this.backlog;
  }

  /** Admission check: ready, or fail-open and the spool can durably take one more entry (checked on disk). */
  async admissible(): Promise<boolean> {
    if (this.isReady()) return true;
    if (!this.failOpen) return false;
    return this.checkSpool();
  }

  /** Spool state for /health. */
  async spoolStatus(): Promise<{ backlog: number; bytes: number; maxBytes: number; writable: boolean }> {
    const writable = await this.checkSpool();
    return { backlog: this.backlog, bytes: await this.spoolBytes(), maxBytes: this.spoolMaxBytes, writable };
  }

  private async spoolBytes(): Promise<number> {
    try {
      return (await stat(this.spoolPath)).size;
    } catch {
      return 0;
    }
  }

  /** The spool directory is writable and the file is below the admission threshold (cap minus a reserve). */
  async checkSpool(): Promise<boolean> {
    let ok = true;
    try {
      const dir = dirname(this.spoolPath);
      await mkdir(dir, { recursive: true, mode: SPOOL_DIR_MODE });
      await access(dir, constants.W_OK);
      try {
        await access(this.spoolPath, constants.W_OK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const reserve = Math.min(1024 * 1024, Math.floor(this.spoolMaxBytes / 10));
      if ((await this.spoolBytes()) >= this.spoolMaxBytes - reserve) ok = false;
    } catch {
      ok = false;
    }
    if (ok !== this.spoolOk) {
      if (!ok) this.log.error({ spoolPath: this.spoolPath }, "Spool not writable or full: fail-open suspended, refusing traffic");
      else this.log.info({}, "Spool writable again");
    }
    this.spoolOk = ok;
    return ok;
  }

  /** Counts the spool left by a previous run, replays it, starts the timer. */
  async start(): Promise<void> {
    this.backlog = (await this.readLines()).length;
    if (this.backlog > 0) this.log.warn({ backlog: this.backlog }, "Ledger spool found at startup");
    await this.tick();
    const every = this.options.replayIntervalMs ?? 2000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Cheap database probe with a short timeout; updates the known health. */
  async probe(): Promise<boolean> {
    const ping = this.store.ping;
    let ok = true;
    if (ping) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ping.call(this.store),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("database probe timeout")), this.probeTimeoutMs);
          }),
        ]);
      } catch {
        ok = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (ok !== this.healthy) {
      if (ok) this.log.info({}, "Database reachable again");
      else this.log.warn({ failOpen: this.failOpen }, "Database unreachable");
    }
    this.healthy = ok;
    return ok;
  }

  /**
   * Writes a ledger row: 3 attempts, then durable spool. Resolves when the row is in the ledger or fsynced in the
   * spool; throws (SpoolError) when neither is possible. In fail-open, a store known to be down goes straight to the spool.
   */
  async append(input: LedgerInput, meta?: SpoolMeta): Promise<void> {
    // One stable id per row, used by every attempt (direct or replayed): whichever commits first wins, the others
    // are no-ops. A direct attempt that timed out client-side may still be committed by the server.
    const id = meta?.spoolId ?? randomUUID();
    // A store known to be down (any mode) goes straight to the spool: no call can answer faster than the outage.
    if (this.backlog === 0 && this.healthy) {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.appendBounded(input, id, settlementOf(input, { ...meta, spoolId: id }));
          this.healthy = true;
          return;
        } catch (error) {
          // A timeout means a dead connection: retrying would only repeat the wait.
          if (error instanceof DbTimeoutError || attempt >= this.retryDelays.length) {
            this.log.error({ err: error }, "Ledger write failed: spooling");
            break;
          }
          await new Promise((r) => setTimeout(r, this.retryDelays[attempt]));
          if (!this.healthy) break; // another call found the database down while we waited
        }
      }
      this.healthy = false;
    }
    await this.spool(input, { ...meta, spoolId: id });
  }

  /** One bounded store write; on timeout the store is told to abandon the row (it is kept in the spool instead). */
  private appendBounded(input: LedgerInput, idempotencyKey: string, settlement?: LedgerSettlement): Promise<unknown> {
    const abort = new AbortController();
    return this.bounded(this.store.appendLedger(input, { signal: abort.signal, idempotencyKey, settlement }), () => abort.abort());
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async spool(input: LedgerInput, meta?: SpoolMeta): Promise<void> {
    // Marked degraded: the row is written late, from the spool (part of its hash, so it cannot be removed later).
    const line: SpooledLine = { ...input, degraded: true, spoolMeta: meta };
    const data = JSON.stringify(line) + "\n";
    await this.locked(async () => {
      try {
        await mkdir(dirname(this.spoolPath), { recursive: true, mode: SPOOL_DIR_MODE });
        const size = await this.spoolBytes();
        if (size + Buffer.byteLength(data) > this.spoolMaxBytes) {
          throw new SpoolError(`spool size cap reached (${this.spoolMaxBytes} bytes)`);
        }
        const fresh = size === 0;
        const started = Date.now();
        const handle = await open(this.spoolPath, "a", SPOOL_FILE_MODE);
        try {
          await handle.appendFile(data, "utf-8");
          await handle.sync(); // durable before anyone is told the call is complete
        } finally {
          await handle.close();
        }
        const took = Date.now() - started;
        if (took > 500) this.log.warn({ ms: took }, "Slow spool write (fsync)");
        if (fresh) await this.syncDir();
      } catch (error) {
        this.spoolOk = false;
        this.log.error({ err: error }, "Ledger spool write failed");
        throw error instanceof SpoolError ? error : new SpoolError(`spool write failed: ${(error as Error).message}`);
      }
      this.backlog += 1;
    });
  }

  /** Best effort: makes the creation of the spool file itself durable. */
  private async syncDir(): Promise<void> {
    try {
      const dir = await open(dirname(this.spoolPath), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // not supported on every platform
    }
  }

  private async readLines(): Promise<string[]> {
    try {
      return (await readFile(this.spoolPath, "utf-8")).split("\n").filter((l) => l.trim() !== "");
    } catch {
      return [];
    }
  }

  /** Replays the spool in order; stops at the first failure and keeps the rest. Returns the entries replayed. */
  async replay(): Promise<number> {
    let done = 0;
    for (;;) {
      const step = await this.locked(async () => {
        const lines = await this.readLines();
        if (lines.length === 0) {
          this.backlog = 0;
          return "empty" as const;
        }
        try {
          // spoolMeta is spool-only data: it is never part of the chained row.
          const { spoolMeta: meta, ...parsed } = JSON.parse(lines[0]!) as SpooledLine;
          const entry: LedgerInput = { ...parsed, degraded: true };
          // Lines spooled before ids existed get a stable one from their own text.
          const id = meta?.spoolId ?? sha256(lines[0]!);
          // Idempotent: the row, its spend increment and its reservation release commit together, once per id.
          // Bounded: a frozen database must not hold the spool lock, which every spool write waits for.
          await this.appendBounded(entry, id, settlementOf(entry, { ...meta, spoolId: id }));
        } catch (error) {
          this.log.warn({ err: error, backlog: lines.length }, "Spool replay paused: database unavailable");
          return "failed" as const;
        }
        const rest = lines.slice(1);
        const tmp = `${this.spoolPath}.tmp`;
        const handle = await open(tmp, "w", SPOOL_FILE_MODE);
        try {
          await handle.writeFile(rest.map((l) => l + "\n").join(""), "utf-8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmp, this.spoolPath);
        this.backlog = rest.length;
        return "ok" as const;
      });
      if (step === "ok") {
        done += 1;
        continue;
      }
      if (step === "empty") this.healthy = true;
      return done;
    }
  }

  /** Purges orphan reservations (older than their TTL: never a live one) at most once per interval. */
  private async housekeeping(): Promise<void> {
    const ttl = this.options.reservationTtlMs;
    if (ttl === undefined || Date.now() - this.lastHousekeeping < HOUSEKEEPING_INTERVAL_MS) return;
    // Never purge while spooled lines wait for their replay: a call that finished during the outage still holds its
    // reservation, and its spooled row will settle it with the real cost. Purging first would write an
    // interrupted_no_response row and count the call twice. Not stamped: the next tick tries again.
    if (this.backlog > 0) return;
    this.lastHousekeeping = Date.now();
    try {
      // Not bounded by the request-path call timeout (which would declare the database down): a purge writes one
      // transaction per orphan and may legitimately take longer. A hung call is abandoned after a generous delay;
      // every orphan commits atomically and idempotently, so abandoning loses nothing.
      let timer: NodeJS.Timeout | undefined;
      const giveUp = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("housekeeping timed out")), HOUSEKEEPING_TIMEOUT_MS);
      });
      const done = await Promise.race([this.store.housekeeping(ttl), giveUp]).finally(() => clearTimeout(timer));
      if (done.reservations > 0) {
        this.log.warn({ reservations: done.reservations }, "Orphan budget reservations purged (one interrupted_no_response ledger row each)");
      }
    } catch (error) {
      this.log.warn({ err: error }, "Housekeeping failed (will retry)");
    }
  }

  private async tick(): Promise<void> {
    try {
      if (!(await this.probe())) return;
      if (this.backlog > 0) {
        const n = await this.replay();
        if (n > 0) this.log.info({ replayed: n, backlog: this.backlog }, "Ledger spool replayed");
      }
      await this.housekeeping();
    } catch (error) {
      this.log.error({ err: error }, "Ledger guard tick failed");
    }
  }
}

/** Budget settlement carried by a row that finished during an outage (null when the spend was already settled). */
export function settlementOf(entry: LedgerInput, meta: SpoolMeta | undefined): LedgerSettlement | undefined {
  if (!meta || meta.budgetSettlement !== "pending" || entry.agentId === null) return undefined;
  return {
    key: meta.settlementKey ?? `${meta.spoolId}:spend`,
    agentId: entry.agentId,
    // The day of the original request, never the day of the replay.
    day: meta.budgetDay ?? entry.ts.slice(0, 10),
    amount: entry.cost,
    reservationId: meta.reservationId ?? null,
  };
}

const guards = new WeakMap<Store, LedgerGuard>();

/** One guard per store, shared by all endpoints. */
export function ledgerGuardFor(store: Store, log: GuardLogger, options: GuardOptions = {}): LedgerGuard {
  let guard = guards.get(store);
  if (!guard) {
    guard = new LedgerGuard(store, log, options);
    guards.set(store, guard);
  }
  return guard;
}
