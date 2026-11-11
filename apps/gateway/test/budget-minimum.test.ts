import { describe, expect, it } from "vitest";
import { adminHeaders, createAgent, setup } from "./helpers.js";

// A positive budget that rounds to 0 micro-USD would be stored as 0, which means "no cap".
// Only `unlimited: true` (create) or an explicit 0 (patch) may remove the cap.

const base = { name: "bot", allowedModels: ["gpt-4o-mini"] };

describe("admin: a positive budget below 1 micro-USD is refused", () => {
  it.each([[0.0000001], [0.0000004], [4.9e-7], [1e-12]])("POST dailyBudgetUsd %s -> 400, no agent created", async (value) => {
    const { app, store } = setup();
    const res = await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload: { ...base, dailyBudgetUsd: value } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/0\.000001/);
    expect(await store.listAgents()).toHaveLength(0);
  });

  it.each([[0.0000001], [0.0000004], [4.9e-7], [1e-12]])("PATCH dailyBudgetUsd %s -> 400, budget unchanged", async (value) => {
    const { app, store } = setup();
    const { agent } = await createAgent(app, { ...base, dailyBudgetUsd: 2 });
    const res = await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { dailyBudgetUsd: value } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/0\.000001/);
    expect((await store.getAgent(agent.id))?.dailyBudget).toBe(2_000_000);
  });

  it("accepts exactly 0.000001 USD (1 micro-USD) on POST and PATCH", async () => {
    const { app, store } = setup();
    const { agent } = await createAgent(app, { ...base, dailyBudgetUsd: 0.000001 });
    expect((await store.getAgent(agent.id))?.dailyBudget).toBe(1);
    const other = await createAgent(app, { ...base, dailyBudgetUsd: 2 });
    const res = await app.inject({ method: "PATCH", url: `/admin/agents/${other.agent.id}`, headers: adminHeaders, payload: { dailyBudgetUsd: 0.000001 } });
    expect(res.statusCode).toBe(200);
    expect((await store.getAgent(other.agent.id))?.dailyBudget).toBe(1);
  });

  it("0.0000005 converts to 1 micro-USD with Math.round, so it is accepted and stored as 1", async () => {
    const { app, store } = setup();
    const { agent } = await createAgent(app, { ...base, dailyBudgetUsd: 0.0000005 });
    expect((await store.getAgent(agent.id))?.dailyBudget).toBe(1);
  });

  it("keeps PATCH dailyBudgetUsd: 0 (no cap) and POST 0 + unlimited: true", async () => {
    const { app, store } = setup();
    const { agent } = await createAgent(app, { ...base, dailyBudgetUsd: 2 });
    const res = await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { dailyBudgetUsd: 0 } });
    expect(res.statusCode).toBe(200);
    expect((await store.getAgent(agent.id))?.dailyBudget).toBe(0);
    const u = await createAgent(app, { ...base, dailyBudgetUsd: 0, unlimited: true });
    expect((await store.getAgent(u.agent.id))?.dailyBudget).toBe(0);
  });
});
