// Pure diagnostics: safe to import without running the live-provider harness.
export function transportCause(error) {
  const pending = [error];
  const seen = new Set();
  const codes = [];
  while (pending.length) {
    const e = pending.shift();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    if (e.code) codes.push(String(e.code));
    if (e.name === "TimeoutError" || e.name === "AbortError") codes.push("ETIMEDOUT");
    pending.push(e.cause, ...(e.errors ?? []));
  }
  if (codes.includes("ECONNREFUSED")) return "connection_refused";
  if (codes.some((c) => ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(c))) return "connection_reset";
  if (codes.some((c) => /TIMEOUT|TIMEDOUT/.test(c))) return "timeout";
  return `transport:${codes.sort().join("+") || error?.name || "unknown"}`;
}

export function gatewayErrorCode(text) {
  try {
    const code = JSON.parse(text)?.error?.code;
    return typeof code === "string" || typeof code === "number" ? code : undefined;
  } catch { return undefined; }
}

export function failureBreakdown(requests) {
  const out = { total: 0, transport: {}, http: {}, gateway: {} };
  const add = (bucket, key) => { bucket[key] = (bucket[key] ?? 0) + 1; };
  for (const r of requests) {
    if (r.status === 200 && !r.failure) continue;
    out.total++;
    if (r.failure) add(out.transport, r.failure);
    if (r.status) add(out.http, String(r.status));
    if (r.gatewayCode !== undefined) add(out.gateway, `${r.status}:${r.gatewayCode}`);
  }
  return out;
}

export function restartInvariants(requests, rows, agentId, chainValid, accounting) {
  const have = new Map();
  const mine = rows.filter((e) => e.agentId === agentId);
  for (const e of mine.filter((e) => e.action === "chat.completions")) {
    have.set(e.requestHash, (have.get(e.requestHash) ?? 0) + 1);
  }
  const acknowledged = requests.filter((r) => r.status === 200 && !r.failure);
  let missing = 0;
  for (const r of acknowledged) {
    const count = have.get(r.hash) ?? 0;
    if (count) have.set(r.hash, count - 1);
    else missing++;
  }
  const ledgerSpendMicro = mine.reduce((sum, e) => sum + e.cost, 0);
  const observed = Number.isSafeInteger(accounting?.reservations) && accounting.reservations >= 0 &&
    Number.isSafeInteger(accounting?.spendMicro) && accounting.spendMicro >= 0;
  const checks = {
    chainValid: chainValid === true,
    acknowledgedPresent: acknowledged.length > 0 && missing === 0,
    noOrphanReservations: observed && accounting.reservations === 0,
    spendMatchesSettledEntries: observed && accounting.spendMicro === ledgerSpendMicro,
  };
  return { pass: Object.values(checks).every(Boolean), checks, acknowledged: acknowledged.length, missing,
    ledgerSpendMicro, accounting };
}
