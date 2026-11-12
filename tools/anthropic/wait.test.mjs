import assert from "node:assert/strict";
import { test } from "node:test";
import { waitUntil } from "./wait.mjs";

test("waits for both ledger and spend, even when they become visible separately", async () => {
  const states = [
    { rows: [], spent: 0 },
    { rows: [{}], spent: 0 },
    { rows: [{}], spent: 7 },
  ];
  let reads = 0;
  const result = await waitUntil(async () => states[Math.min(reads++, states.length - 1)],
    ({ rows, spent }) => rows.length >= 1 && spent === 7);
  assert.equal(reads, 3);
  assert.deepEqual(result, states[2]);
});

test("fails within a bounded deadline when accounting never becomes ready", async () => {
  await assert.rejects(waitUntil(async () => ({ rows: [{}], spent: 0 }),
    ({ rows, spent }) => rows.length >= 1 && spent === 7, 0),
  /Accounting state was not reached before the deadline/);
});
