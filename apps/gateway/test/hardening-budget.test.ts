import { describe, expect, it } from "vitest";
import { adminHeaders, setup } from "./helpers.js";

const create = (app: ReturnType<typeof setup>["app"], payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload: { name: "bot", allowedModels: ["gpt-4o-mini"], ...payload } });

describe("agent creation requires an explicit budget (E4)", () => {
  it.each([
    ["absent", {}],
    ["null", { dailyBudgetUsd: null }],
    ["a string", { dailyBudgetUsd: "5" }],
    ["zero without unlimited", { dailyBudgetUsd: 0 }],
    ["zero with unlimited false", { dailyBudgetUsd: 0, unlimited: false }],
    ["negative", { dailyBudgetUsd: -1 }],
  ])("rejects %s with a 400 that names the field", async (_name, extra) => {
    const { app, store } = setup();
    const res = await create(app, extra as Record<string, unknown>);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/dailyBudgetUsd/);
    expect(await store.listAgents()).toHaveLength(0);
  });

  it("rejects a positive budget combined with unlimited: true (ambiguous)", async () => {
    const { app } = setup();
    const res = await create(app, { dailyBudgetUsd: 5, unlimited: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unlimited/);
  });

  it("rejects a non-boolean unlimited", async () => {
    const { app } = setup();
    expect((await create(app, { dailyBudgetUsd: 0, unlimited: "yes" })).statusCode).toBe(400);
  });

  it("creates an agent with a positive budget", async () => {
    const { app } = setup();
    const res = await create(app, { dailyBudgetUsd: 2.5 });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent.dailyBudgetUsd).toBe(2.5);
  });

  it("creates an unlimited agent only with dailyBudgetUsd 0 and unlimited: true", async () => {
    const { app } = setup();
    const res = await create(app, { dailyBudgetUsd: 0, unlimited: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent.dailyBudgetUsd).toBe(0);
  });

  it("leaves existing agents untouched: PATCH still sets 0 (unlimited) explicitly", async () => {
    const { app } = setup();
    const { agent } = (await create(app, { dailyBudgetUsd: 2 })).json();
    const res = await app.inject({ method: "PATCH", url: `/admin/agents/${agent.id}`, headers: adminHeaders, payload: { dailyBudgetUsd: 0 } });
    expect(res.statusCode).toBe(200);
  });
});
