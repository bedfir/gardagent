import { describe, expect, it } from "vitest";
// The live harness is deliberately not imported: it requires credentials and a running stack.
// @ts-expect-error Plain ESM tooling has no TypeScript declaration file.
import { failureBreakdown, gatewayErrorCode, restartInvariants, transportCause } from "../../../tools/pilot-zero/restart.mjs";

describe("pilot-zero restart diagnostics (no network)", () => {
  it.each([
    [{ cause: { code: "ECONNREFUSED" } }, "connection_refused"],
    [{ cause: { code: "ECONNRESET" } }, "connection_reset"],
    [{ code: "UND_ERR_SOCKET" }, "connection_reset"],
    [{ code: "EPIPE" }, "connection_reset"],
    [{ name: "TimeoutError" }, "timeout"],
    [{ name: "AbortError" }, "timeout"],
    [{ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }, "timeout"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ cause: { errors: [{ code: "ECONNREFUSED" }] } }, "connection_refused"],
    [{ code: "ENOTFOUND" }, "transport:ENOTFOUND"],
    [{ name: "TypeError" }, "transport:TypeError"],
    [{}, "transport:unknown"],
  ])("classifies transport failure %#", (error, expected) => {
    expect(transportCause(error)).toBe(expected);
  });

  it("handles cyclic causes without hanging", () => {
    const error: { cause?: unknown; code: string } = { code: "ECONNRESET" };
    error.cause = error;
    expect(transportCause(error)).toBe("connection_reset");
  });

  it.each([
    ['{"error":{"code":"ledger_unavailable"}}', "ledger_unavailable"],
    ['{"error":{"code":-32000}}', -32000],
    ['{"error":{"code":null}}', undefined],
    ['{"error":"unavailable"}', undefined],
    ['{}', undefined],
    ['null', undefined],
    ['<html>Bad gateway</html>', undefined],
  ])("extracts gateway error codes %#", (body, code) => {
    expect(gatewayErrorCode(body)).toBe(code);
  });

  it("counts every status and gateway code separately, including interrupted bodies", () => {
    expect(failureBreakdown([
      { status: 200 },
      { status: 0, failure: "connection_refused" },
      { status: 0, failure: "connection_reset" },
      { status: 0, failure: "timeout" },
      { status: 503, gatewayCode: "ledger_unavailable" },
      { status: 503, gatewayCode: "upstream_unreachable" },
      { status: 502 }, // non-JSON errors retain their HTTP status
      { status: 429, gatewayCode: "budget_exceeded" },
      { status: 200, failure: "connection_reset" },
    ])).toEqual({
      total: 8,
      transport: { connection_refused: 1, connection_reset: 2, timeout: 1 },
      http: { 200: 1, 503: 2, 502: 1, 429: 1 },
      gateway: { "503:ledger_unavailable": 1, "503:upstream_unreachable": 1, "429:budget_exceeded": 1 },
    });
  });

  const requests = [{ status: 200, hash: "h" }, { status: 200, hash: "h" }];
  const row = { agentId: "a", action: "chat.completions", requestHash: "h", cost: 7 };
  const rows = [row, row, { ...row, agentId: "unrelated", cost: 100 }];
  const accounting = { reservations: 0, spendMicro: 14 };
  it("checks multiplicity, isolates the agent, and compares integer micro-USD", () => {
    expect(restartInvariants(requests, rows, "a", true, accounting)).toMatchObject({ pass: true, missing: 0, ledgerSpendMicro: 14 });
  });
  it.each([
    [requests, [row], true, accounting, "acknowledgedPresent"],
    [requests, rows, false, accounting, "chainValid"],
    [requests, rows, true, { ...accounting, reservations: 1 }, "noOrphanReservations"],
    [requests, rows, true, { ...accounting, spendMicro: 15 }, "spendMatchesSettledEntries"],
    [requests, rows, true, undefined, "noOrphanReservations"],
    [[], rows, true, accounting, "acknowledgedPresent"],
  ])("fails on a violated invariant %#", (sent, ledger, chain, observed, check) => {
    const result = restartInvariants(sent, ledger, "a", chain, observed);
    expect(result.pass).toBe(false);
    expect(result.checks[check]).toBe(false);
  });
  it("does not acknowledge a 200 whose body was interrupted", () => {
    expect(restartInvariants([{ status: 200, hash: "lost", failure: "timeout" }, ...requests], rows, "a", true, accounting)).toMatchObject({ pass: true, acknowledged: 2 });
  });
});
