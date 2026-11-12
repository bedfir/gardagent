import { createHash } from "node:crypto";

const GENESIS = "0".repeat(64);
const HEX = /^[0-9a-f]{64}$/;
type Row = Record<string, unknown>;
export interface Checkpoint { format: string; sequence: number; head_hash: string; created_at: string }
export interface Result {
  valid: boolean;
  count: number;
  head: { sequence: number; hash: string };
  firstInvalid: { sequence: number | null; reason: string } | null;
  checkpoints: { index: number; valid: boolean; contained: boolean; reason: string | null }[];
  limitation: string;
}
const object = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const hex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;

// Independent implementation of docs/ledger-format.md, section 1.2.
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(",")}}`;
}
function fingerprint(entry: Row): string {
  const { hash: _hash, ...content } = entry;
  return createHash("sha256").update(canonical(content)).digest("hex");
}
function checkpoint(value: unknown): value is Checkpoint {
  return object(value) && value.format === "gardagent-checkpoint-v1" && integer(value.sequence) &&
    value.sequence < Number.MAX_SAFE_INTEGER && hex(value.head_hash) &&
    (value.sequence !== 0 || value.head_hash === GENESIS) &&
    typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at));
}
const required = ["seq", "prevHash", "hash", "ts", "agentId", "action", "model", "verdict", "reason",
  "upstreamStatus", "promptTokens", "completionTokens", "cost", "requestHash", "responseHash"];
const optional = ["degraded", "formatVersion", "policyRev", "operatorId", "approvalRef"];
function contentValid(e: Row, lastVersion: number): boolean {
  if (required.some((k) => !Object.hasOwn(e, k)) || Object.keys(e).some((k) => !required.includes(k) && !optional.includes(k))) return false;
  if (!hex(e.hash) || !hex(e.prevHash) || typeof e.ts !== "string" || !Number.isFinite(Date.parse(e.ts)) ||
      typeof e.action !== "string" || !["allowed", "denied"].includes(e.verdict as string)) return false;
  if (["agentId", "model", "reason"].some((k) => e[k] !== null && typeof e[k] !== "string") ||
      ["requestHash", "responseHash"].some((k) => e[k] !== null && !hex(e[k])) ||
      ["promptTokens", "completionTokens", "cost"].some((k) => !integer(e[k])) ||
      (e.upstreamStatus !== null && !Number.isSafeInteger(e.upstreamStatus))) return false;
  if (Object.hasOwn(e, "degraded") && e.degraded !== true) return false;
  const refs = ["policyRev", "operatorId", "approvalRef"];
  if (e.formatVersion === undefined) return lastVersion === 1 && !refs.some((k) => Object.hasOwn(e, k));
  return refs.every((k) => !Object.hasOwn(e, k) || nonempty(e[k])) &&
    (!Object.hasOwn(e, "policyRev") || hex(e.policyRev));
}

/** Verify complete M06 NDJSON pages concatenated in order. Never performs I/O. */
export function verifyExport(text: string, supplied: unknown[] = []): Result {
  const result: Result = {
    valid: false, count: 0, head: { sequence: 0, hash: GENESIS }, firstInvalid: null, checkpoints: [],
    limitation: "Without a trusted external checkpoint, suffix truncation and consistent rewrites cannot be detected. Integrity does not prove completeness or truth of events.",
  };
  const fail = (reason: string, sequence: number | null = null) => {
    result.firstInvalid ??= { sequence, reason };
  };
  let rows: unknown[] = [];
  try {
    rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
  } catch { fail("invalid_json"); }
  result.count = rows.filter((r) => !(object(r) && r.type === "metadata")).length;
  let captured: Checkpoint | undefined;
  let cursor: unknown;
  let lastVersion = 1;
  let havePage = false;
  const hashes = new Map<number, string>([[0, GENESIS]]);
  const decisions = new Map<unknown, Row>();
  const finishPage = () => {
    if (!havePage || !captured) return;
    const expected = result.head.sequence < captured.sequence ? result.head.sequence : null;
    if (cursor !== expected) fail("invalid_page_cursor");
  };
  if (!result.firstInvalid) for (const row of rows) {
    if (object(row) && row.type === "metadata") {
      finishPage();
      if (result.firstInvalid) break;
      if (!checkpoint(row.checkpoint)) { fail("invalid_metadata"); break; }
      if (captured && (captured.sequence !== row.checkpoint.sequence || captured.head_hash !== row.checkpoint.head_hash)) {
        fail("inconsistent_captured_head"); break;
      }
      captured = row.checkpoint;
      cursor = row.nextAfterSeq;
      havePage = true;
      continue;
    }
    if (!havePage || !object(row)) { fail("invalid_entry"); break; }
    const seq = typeof row.seq === "number" ? row.seq : null;
    if (row.seq !== result.head.sequence + 1) { fail("seq_gap", seq); break; }
    if (row.prevHash !== result.head.hash) { fail("link_mismatch", seq); break; }
    if (Object.hasOwn(row, "formatVersion") && row.formatVersion !== 2) { fail("unsupported_format", seq); break; }
    if (fingerprint(row) !== row.hash) { fail("hash_mismatch", seq); break; }
    if (!contentValid(row, lastVersion)) { fail("invalid_format", seq); break; }
    if (row.formatVersion === 2) {
      if (row.action === "mcp.approval.decided") {
        if (!nonempty(row.approvalRef) || !hex(row.policyRev) || !hex(row.requestHash) ||
            (row.reason === "expired" ? row.verdict !== "denied" || Object.hasOwn(row, "operatorId") : !nonempty(row.operatorId))) {
          fail("invalid_approval_decision", seq); break;
        }
        decisions.set(row.approvalRef, row);
      }
      if (row.action === "mcp.tools/call" && Object.hasOwn(row, "approvalRef")) {
        const decision = decisions.get(row.approvalRef);
        if (!decision || decision.verdict !== "allowed" || decision.agentId !== row.agentId || decision.requestHash !== row.requestHash) {
          fail("approval_mismatch", seq); break;
        }
      }
    }
    lastVersion = row.formatVersion === 2 ? 2 : 1;
    result.head = { sequence: row.seq as number, hash: row.hash as string };
    hashes.set(result.head.sequence, result.head.hash);
  }
  if (!result.firstInvalid) {
    finishPage();
    if (!captured) fail("missing_metadata");
    else if (result.head.sequence !== captured.sequence || result.head.hash !== captured.head_hash) fail("captured_head_mismatch");
    else if (cursor !== null) fail("incomplete_export");
  }
  result.checkpoints = supplied.map((c, index) => {
    const valid = checkpoint(c);
    const contained = valid && hashes.get(c.sequence) === c.head_hash;
    return { index, valid, contained, reason: !valid ? "invalid_checkpoint" : !contained ? "checkpoint_not_contained" : null };
  });
  result.valid = !result.firstInvalid && result.checkpoints.every((c) => c.valid && c.contained);
  return result;
}
