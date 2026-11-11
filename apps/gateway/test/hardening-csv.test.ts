import { MemoryStore } from "@gardagent/core";
import { describe, expect, it } from "vitest";
import { csvChunks } from "../src/csv.js";

async function exportRows(overrides: Record<string, unknown>): Promise<string[]> {
  const store = new MemoryStore();
  await store.appendLedger({
    ts: "2026-11-01T10:00:00.000Z", agentId: null, action: "chat.completions", model: "m", verdict: "allowed", reason: null,
    upstreamStatus: 200, promptTokens: 1, completionTokens: 1, cost: 1, requestHash: null, responseHash: null, ...overrides,
  } as never);
  let text = "";
  for await (const chunk of csvChunks(store, new Map(), {})) text += chunk;
  return text.split("\r\n").slice(1, -1);
}

describe("CSV export neutralises formulas in every text field, action included (E7)", () => {
  it.each(["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"])("prefixes an action starting with %j", async (action) => {
    const [row] = await exportRows({ action });
    expect(row!.split(",")[3]).toMatch(/^'|^"'/);
  });

  it("leaves ordinary actions unchanged", async () => {
    const [row] = await exportRows({ action: "chat.completions" });
    expect(row!.split(",")[3]).toBe("chat.completions");
  });

  it("still neutralises model and reason", async () => {
    const [row] = await exportRows({ model: "=m", reason: "@r" });
    const cells = row!.split(",");
    expect(cells[4]).toBe("'=m");
    expect(cells[6]).toBe("'@r");
  });
});
