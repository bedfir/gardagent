import { describe, expect, it } from "vitest";
import { computeCost, evaluate, findPrice, type Agent, type PriceTable } from "@gardagent/core";

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "a1",
  name: "bot",
  keyHash: "h",
  allowedModels: ["gpt-4o-mini"],
  allowedTools: [],
  approvalTools: [],
  dailyBudget: 1000,
  active: true,
  ...over,
});

describe("evaluate", () => {
  it("allows a compliant call", () => {
    expect(evaluate(agent(), { model: "gpt-4o-mini", spentToday: 0 })).toEqual({ allowed: true });
  });

  it("denies a disabled agent", () => {
    expect(evaluate(agent({ active: false }), { model: "gpt-4o-mini", spentToday: 0 })).toMatchObject({
      allowed: false,
      reason: "agent_disabled",
    });
  });

  it("denies a non-allowed model", () => {
    expect(evaluate(agent(), { model: "gpt-4o", spentToday: 0 })).toMatchObject({
      allowed: false,
      reason: "model_not_allowed",
    });
  });

  it('"*" allows any model', () => {
    expect(evaluate(agent({ allowedModels: ["*"] }), { model: "anything-else", spentToday: 0 })).toEqual({
      allowed: true,
    });
  });

  it("denies when the budget is reached", () => {
    expect(evaluate(agent(), { model: "gpt-4o-mini", spentToday: 999 })).toEqual({ allowed: true });
    expect(evaluate(agent(), { model: "gpt-4o-mini", spentToday: 1000 })).toMatchObject({
      allowed: false,
      reason: "budget_exceeded",
    });
    expect(evaluate(agent(), { model: "gpt-4o-mini", spentToday: 5000 })).toMatchObject({ reason: "budget_exceeded" });
  });

  it("budget 0 = unlimited", () => {
    expect(evaluate(agent({ dailyBudget: 0 }), { model: "gpt-4o-mini", spentToday: 10_000_000 })).toEqual({
      allowed: true,
    });
  });
});

describe("computeCost", () => {
  const prices: PriceTable = {
    gpt: { input: 1, output: 2 },
    "gpt-4o": { input: 3, output: 4 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
  };
  const fallback = { input: 10, output: 30 };

  it("exact match", () => {
    expect(computeCost(prices, "gpt-4o", 100, 10, fallback)).toBe(100 * 3 + 10 * 4);
  });

  it("longest prefix", () => {
    expect(computeCost(prices, "gpt-4o-mini-2024-07-18", 1000, 1000, fallback)).toBe(750);
    expect(computeCost(prices, "gpt-4o-2024-08-06", 10, 10, fallback)).toBe(70);
    expect(computeCost(prices, "gpt-3.5", 10, 10, fallback)).toBe(30);
  });

  it("fallback for an unknown model", () => {
    expect(computeCost(prices, "llama-3", 10, 5, fallback)).toBe(10 * 10 + 5 * 30);
  });

  it("rounds up", () => {
    // 1 * 0.15 + 1 * 0.6 = 0.75 -> 1
    expect(computeCost(prices, "gpt-4o-mini", 1, 1, fallback)).toBe(1);
    expect(computeCost(prices, "gpt-4o-mini", 0, 0, fallback)).toBe(0);
  });
});

describe("pricing: inherited property names (E6)", () => {
  const prices = { "gpt-4o-mini": { input: 0.15, output: 0.6 } };
  const fallback = { input: 10, output: 30 };
  const fallbackCost = computeCost(prices, "unknown-model", 100, 50, fallback);

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"])(
    "%s is an unknown model: fallback price, never NaN",
    (model) => {
      expect(findPrice(prices, model)).toBeUndefined();
      const cost = computeCost(prices, model, 100, 50, fallback);
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBe(fallbackCost);
    },
  );

  it("still finds an own entry named like a prototype member", () => {
    const own = Object.assign(Object.create(null), { constructor: { input: 1, output: 2 } }) as Record<string, { input: number; output: number }>;
    expect(computeCost(own, "constructor", 10, 10, fallback)).toBe(30);
  });

  it("ignores a malformed price entry and falls back instead of producing NaN", () => {
    const bad = { m: { input: "x", output: 1 } } as unknown as Record<string, { input: number; output: number }>;
    expect(computeCost(bad, "m", 100, 50, fallback)).toBe(fallbackCost);
  });

  it("treats non-finite or negative token counts as zero", () => {
    expect(computeCost(prices, "gpt-4o-mini", Number.NaN, 10, fallback)).toBe(6);
    expect(computeCost(prices, "gpt-4o-mini", -5, Number.POSITIVE_INFINITY, fallback)).toBe(0);
  });

  it("throws on an invalid fallback price rather than returning NaN", () => {
    expect(() => computeCost(prices, "unknown-model", 1, 1, { input: Number.NaN, output: 1 })).toThrow(/finite/);
  });
});
