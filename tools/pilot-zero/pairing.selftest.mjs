// Self-test of the criterion (c) pairing on fabricated data: node tools/pilot-zero/pairing.selftest.mjs
import assert from "node:assert/strict";
import { pairForCriterionC, streamVerdict } from "./pairing.mjs";

const costOf = (_m, p, c) => p + c;
const row = (over) => ({ agentId: "a", requestHash: "h", upstreamStatus: 200, promptTokens: 14, completionTokens: 8, cost: 22, ...over });
const call = (over = {}) => ({ agentId: "a", hash: "h", status: 200, model: "m", usage: { prompt_tokens: 14, completion_tokens: 8 }, ...over });

// Round 5 shape: three identical calls, the 2nd timed out upstream (ledger row 0/0, no upstream status).
// The harness only records the two 200 answers; the failed row used to be paired with the 2nd of them.
const rows = [row({ promptTokens: 14, completionTokens: 7, cost: 21 }), row({ upstreamStatus: null, promptTokens: 0, completionTokens: 0, cost: 0 }), row()];
const calls = [call({ usage: { prompt_tokens: 14, completion_tokens: 7 } }), call()];

const fixed = pairForCriterionC(rows, calls, costOf);
assert.deepEqual(fixed, { matched: 2, tokenMismatch: 0, ledgerCost: 43, providerCost: 43 });

// The old pairing (every row, FIFO) reproduces the artefact: one mismatch on the same data.
const old = pairForCriterionC(rows.map((r) => ({ ...r, upstreamStatus: 200 })), calls, costOf);
assert.equal(old.tokenMismatch, 1);

// A real mismatch is still detected.
assert.equal(pairForCriterionC([row({ completionTokens: 9 })], [call()], costOf).tokenMismatch, 1);
// Other agents and other hashes never pair.
assert.equal(pairForCriterionC([row({ agentId: "b" }), row({ requestHash: "x" })], [call()], costOf).matched, 0);
// Calls without a 200 answer or without usage are ignored.
assert.equal(pairForCriterionC([row()], [call({ status: 502 }), call({ usage: null })], costOf).matched, 0);

// ---- Criterion (f): majority verdict over N samples ----
const smp = (content, over = {}) => ({ status: 200, content, finish: "stop", done: true, ...over });
const many = (n, content, over) => Array.from({ length: n }, () => smp(content, over));

// Both sides agree on the majority although each side has one deviating sample: identical (a single pair would fail).
const noisyDirect = [...many(4, "A"), smp("B")];
const noisyGateway = [...many(4, "A"), smp("C")];
const v1 = streamVerdict(noisyDirect, noisyGateway);
assert.equal(v1.verdict, "identical");
assert.deepEqual(v1.direct, [4, 1]);
assert.equal(v1.endedMajority, true);

// The gateway deviates in the majority: different.
assert.equal(streamVerdict(many(5, "A"), [...many(2, "A"), ...many(3, "B")]).verdict, "different");
// Different finish_reason is a different outcome.
assert.equal(streamVerdict(many(5, "A"), many(5, "A", { finish: "length" })).verdict, "different");
// Direct side without a strict majority (2/2/1): provider not deterministic, undetermined, whatever the gateway says.
assert.equal(streamVerdict([...many(2, "A"), ...many(2, "B"), smp("C")], many(5, "A")).verdict, "undetermined");
// Exactly half is not a majority (2 of 4).
assert.equal(streamVerdict([...many(2, "A"), ...many(2, "B")], many(4, "A")).verdict, "undetermined");
// Failed samples count against the majority: 2 good of 5 is no majority; 3 of 5 is.
assert.equal(streamVerdict([...many(2, "A"), ...many(3, "x", { status: 502 })], many(5, "A")).verdict, "undetermined");
assert.equal(streamVerdict([...many(3, "A"), ...many(2, "x", { status: 502 })], many(5, "A")).verdict, "identical");
// Gateway with no majority while direct has one: different.
assert.equal(streamVerdict(many(5, "A"), [...many(2, "A"), ...many(2, "B"), smp("C")]).verdict, "different");
// [DONE] must end a strict majority of the gateway streams.
assert.equal(streamVerdict(many(5, "A"), [...many(2, "A"), ...many(3, "A", { done: false })]).endedMajority, false);
// N = 1 degenerates to the old single comparison.
assert.equal(streamVerdict([smp("A")], [smp("A")]).verdict, "identical");
assert.equal(streamVerdict([smp("A")], [smp("B")]).verdict, "different");
// Round 5-style false failure: direct itself unstable across calls, gateway equal to the direct majority.
assert.equal(streamVerdict([smp("A"), smp("A"), smp("B"), smp("A"), smp("A")], [smp("A"), smp("A"), smp("A"), smp("A"), smp("A")]).verdict, "identical");

console.log("pairing self-test: ok");
