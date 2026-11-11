import type { LedgerAggregate, Store } from "@gardagent/core";

/** UTC days (YYYY-MM-DD) for the last `days` days, today included, from oldest to newest. */
export function lastDays(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

interface Bucket {
  costMicro: number;
  allowed: number;
  denied: number;
  deniedByReason: Record<string, number>;
  observedByReason: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
}

const empty = (): Bucket => ({
  costMicro: 0,
  allowed: 0,
  denied: 0,
  deniedByReason: {},
  observedByReason: {},
  promptTokens: 0,
  completionTokens: 0,
});

function add(bucket: Bucket, row: LedgerAggregate): void {
  bucket.costMicro += row.cost;
  bucket.promptTokens += row.promptTokens;
  bucket.completionTokens += row.completionTokens;
  if (row.verdict === "allowed") {
    bucket.allowed += row.count;
    const reason = row.reason ?? "unknown";
    if (reason.startsWith("observed:")) {
      bucket.observedByReason[reason] = (bucket.observedByReason[reason] ?? 0) + row.count;
    }
  } else {
    bucket.denied += row.count;
    const reason = row.reason ?? "unknown";
    bucket.deniedByReason[reason] = (bucket.deniedByReason[reason] ?? 0) + row.count;
  }
}

function publish(bucket: Bucket) {
  const { costMicro, ...rest } = bucket;
  return { spentUsd: costMicro / 1_000_000, ...rest };
}

/** Statistics computed from the ledger: by UTC day and by agent. */
export async function buildStats(store: Store, days: number, now: Date = new Date()) {
  const range = lastDays(days, now);
  const rows = await store.aggregateLedger(range[0]!);
  const names = new Map((await store.listAgents()).map((a) => [a.id, a.name]));

  const total = empty();
  const perAgent = new Map<string | null, Bucket>();
  const perDay = new Map<string, { bucket: Bucket; agents: Map<string | null, Bucket> }>();
  for (const day of range) perDay.set(day, { bucket: empty(), agents: new Map() });

  for (const row of rows) {
    const day = perDay.get(row.day);
    if (!day) continue;
    add(total, row);
    add(day.bucket, row);
    if (!day.agents.has(row.agentId)) day.agents.set(row.agentId, empty());
    add(day.agents.get(row.agentId)!, row);
    if (!perAgent.has(row.agentId)) perAgent.set(row.agentId, empty());
    add(perAgent.get(row.agentId)!, row);
  }

  const agentEntry = (agentId: string | null, bucket: Bucket) => ({
    agentId,
    name: agentId ? (names.get(agentId) ?? null) : null,
    ...publish(bucket),
  });
  const bySpend = (a: { spentUsd: number; allowed: number }, b: { spentUsd: number; allowed: number }) =>
    b.spentUsd - a.spentUsd || b.allowed - a.allowed;

  return {
    days,
    from: range[0]!,
    to: range.at(-1)!,
    totals: publish(total),
    agents: [...perAgent].map(([id, b]) => agentEntry(id, b)).sort(bySpend),
    byDay: range.map((day) => {
      const d = perDay.get(day)!;
      return {
        day,
        ...publish(d.bucket),
        agents: [...d.agents].map(([id, b]) => agentEntry(id, b)).sort(bySpend),
      };
    }),
  };
}
