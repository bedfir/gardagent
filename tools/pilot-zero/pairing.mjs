// Criterion (c) pairing, kept free of side effects so that it can be self-tested (node pairing.selftest.mjs).

/**
 * Pairs calls the provider answered with HTTP 200 (and reported usage for) with the gateway ledger rows of the same
 * agent and request body hash, first in first out. Only ledger rows whose upstream status is 200 are candidates:
 * identical bodies share a hash, and a row of a call that never got an upstream answer (timeout, unreachable: status
 * empty, 0 tokens) would otherwise shift every later pair by one (docs/pilot-zero-round5-followup.md, point 2).
 *
 * `rows`: ledger entries ({ agentId, requestHash, upstreamStatus, promptTokens, completionTokens, cost }).
 * `calls`: harness records ({ agentId, hash, status, usage, model }), in sending order.
 * `costOf(model, promptTokens, completionTokens)`: provider-side cost in micro-USD.
 */
export function pairForCriterionC(rows, calls, costOf) {
  const queue = new Map();
  for (const e of rows) {
    if (e.upstreamStatus !== 200) continue;
    const k = `${e.agentId}|${e.requestHash}`;
    if (!queue.has(k)) queue.set(k, []);
    queue.get(k).push(e);
  }
  let ledgerCost = 0;
  let providerCost = 0;
  let matched = 0;
  let tokenMismatch = 0;
  for (const s of calls) {
    if (s.status !== 200 || !s.usage) continue;
    const e = queue.get(`${s.agentId}|${s.hash}`)?.shift();
    if (!e) continue;
    matched++;
    ledgerCost += e.cost;
    providerCost += costOf(s.model, s.usage.prompt_tokens, s.usage.completion_tokens);
    if (e.promptTokens !== s.usage.prompt_tokens || e.completionTokens !== s.usage.completion_tokens) tokenMismatch++;
  }
  return { matched, tokenMismatch, ledgerCost, providerCost };
}

/**
 * Criterion (f): verdict for one prompt from N direct and N gateway streaming samples, by majority.
 *
 * A single direct/gateway pair is not a valid comparison when the provider is not deterministic even at
 * temperature 0 (it gave a false FAIL). Each side is reduced to its majority outcome instead:
 *  - the outcome of a sample is its content plus finish_reason; only HTTP 200 samples have one;
 *  - a majority outcome is one shared by strictly more than half of ALL the samples of that side
 *    (failed samples count against it);
 *  - no majority on the direct side: the provider is not deterministic on this prompt, the prompt is
 *    "undetermined" and decides nothing (as before, at least 3 prompts must be determined);
 *  - no majority on the gateway side while the direct side has one: "different" (the gateway stream is unstable);
 *  - both have one: "identical" if they are equal, otherwise "different".
 * The gateway side must also end with [DONE] on a strict majority of its samples (`endedMajority`).
 *
 * `samples`: ({ status, content, finish, done }) records, one per call.
 */
export function majorityOutcome(samples) {
  const counts = new Map();
  for (const s of samples) {
    if (s.status !== 200) continue;
    const key = JSON.stringify([s.content, s.finish ?? null]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  for (const [key, count] of counts) if (!best || count > best.count) best = { key, count };
  const n = samples.length;
  const distinct = [...counts.values()].sort((a, b) => b - a);
  return { n, distinct, majority: best && best.count * 2 > n ? best : null };
}

export function streamVerdict(directSamples, gatewaySamples) {
  const d = majorityOutcome(directSamples);
  const g = majorityOutcome(gatewaySamples);
  const ended = gatewaySamples.filter((s) => s.status === 200 && s.done).length;
  const endedMajority = ended * 2 > gatewaySamples.length;
  const detail = { direct: d.distinct, gateway: g.distinct, ended, n: gatewaySamples.length };
  if (!d.majority) return { verdict: "undetermined", reason: "no majority outcome on the direct side", endedMajority, ...detail };
  if (!g.majority) return { verdict: "different", reason: "no majority outcome on the gateway side", endedMajority, ...detail };
  if (d.majority.key !== g.majority.key) return { verdict: "different", reason: "majority outcomes differ", endedMajority, ...detail };
  return { verdict: "identical", reason: "majority outcomes equal", endedMajority, ...detail };
}
