import { describe, expect, it } from "vitest";
import { adminHeaders, createAgent, jsonResponse, setup } from "./helpers.js";

describe("admin: authentication", () => {
  it.each([
    ["GET", "/admin/agents"],
    ["POST", "/admin/agents"],
    ["GET", "/admin/ledger"],
    ["GET", "/admin/ledger/verify"],
  ] as const)("%s %s without token or with wrong token -> 401", async (method, url) => {
    const { app } = setup();
    expect((await app.inject({ method, url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method, url, headers: { authorization: "Bearer wrong-token" } })).statusCode,
    ).toBe(401);
  });
});

describe("admin: agents", () => {
  it("creates an agent with a ga_ key and does not list keyHash", async () => {
    const { app } = setup();
    const created = await createAgent(app, { name: "bot", allowedModels: ["gpt-4o-mini"], dailyBudgetUsd: 2.5 });
    expect(created.key.startsWith("ga_")).toBe(true);

    const list = await app.inject({ method: "GET", url: "/admin/agents", headers: adminHeaders });
    expect(list.statusCode).toBe(200);
    const { agents } = list.json();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "bot", dailyBudgetUsd: 2.5, active: true });
    expect(agents[0]).not.toHaveProperty("keyHash");
    expect(list.body).not.toContain(created.key);
  });

  it.each([
    ["missing name", { allowedModels: ["gpt-4o-mini"] }],
    ["empty allowedModels", { name: "x", allowedModels: [] }],
    ["negative budget", { name: "x", allowedModels: ["a"], dailyBudgetUsd: -1 }],
  ])("validation: %s -> 400", async (_n, payload) => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload });
    expect(res.statusCode).toBe(400);
  });
});

describe("admin: ledger verification", () => {
  it("valid after several requests, invalid after tampering", async () => {
    const { app, store } = setup(() =>
      jsonResponse({ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] }),
    );
    const { key } = await createAgent(app);
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${key}` },
        payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: `m${i}` }] },
      });
    }
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "x" } });

    const ok = await app.inject({ method: "GET", url: "/admin/ledger/verify", headers: adminHeaders });
    expect(ok.json()).toMatchObject({ valid: true, checked: 6 });

    const ledger = await app.inject({ method: "GET", url: "/admin/ledger", headers: adminHeaders });
    expect(ledger.json().entries).toHaveLength(6);

    store._tamper(3, { cost: 1 });
    const bad = await app.inject({ method: "GET", url: "/admin/ledger/verify", headers: adminHeaders });
    expect(bad.json()).toMatchObject({ valid: false, brokenAtSeq: 3, problem: "hash_mismatch" });
  });
});

describe("admin: paginated ledger reading", () => {
  async function seeded(count = 7) {
    const ctx = setup();
    for (let i = 0; i < count; i++) {
      // One invalid_key row per source address and window: each request comes from its own address.
      await ctx.app.inject({ method: "POST", url: "/v1/chat/completions", remoteAddress: `10.1.0.${i + 1}`, payload: { model: "x" } });
    }
    const read = async (qs = "") => {
      const res = await ctx.app.inject({ method: "GET", url: `/admin/ledger${qs}`, headers: adminHeaders });
      return { status: res.statusCode, seqs: (res.json().entries ?? []).map((e: { seq: number }) => e.seq) as number[] };
    };
    return { ...ctx, read };
  }

  it("ascending order by default", async () => {
    const { read } = await seeded();
    expect((await read()).seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await read("?order=asc&limit=3")).seqs).toEqual([1, 2, 3]);
  });

  it("order=desc returns the most recent first", async () => {
    const { read } = await seeded();
    expect((await read("?order=desc")).seqs).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect((await read("?order=desc&limit=3")).seqs).toEqual([7, 6, 5]);
  });

  it("beforeSeq is an exclusive bound, with or without limit", async () => {
    const { read } = await seeded();
    expect((await read("?order=desc&beforeSeq=5")).seqs).toEqual([4, 3, 2, 1]);
    expect((await read("?order=desc&beforeSeq=5&limit=2")).seqs).toEqual([4, 3]);
    expect((await read("?order=desc&beforeSeq=1")).seqs).toEqual([]);
    expect((await read("?beforeSeq=4")).seqs).toEqual([1, 2, 3]);
  });

  it("afterSeq and beforeSeq combine", async () => {
    const { read } = await seeded();
    expect((await read("?afterSeq=2&beforeSeq=6&order=desc")).seqs).toEqual([5, 4, 3]);
    expect((await read("?afterSeq=2&beforeSeq=6&limit=2")).seqs).toEqual([3, 4]);
  });

  it("pages through the whole ledger descending without duplicate or gap", async () => {
    const { read } = await seeded(7);
    const seen: number[] = [];
    let before: number | undefined;
    for (;;) {
      const { seqs } = await read(`?order=desc&limit=3${before ? `&beforeSeq=${before}` : ""}`);
      if (seqs.length === 0) break;
      seen.push(...seqs);
      before = seqs.at(-1);
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it("the maximum limit stays 1000", async () => {
    const { read } = await seeded(3);
    expect((await read("?limit=5000")).seqs).toHaveLength(3);
  });

  it.each(["order=up", "beforeSeq=abc", "afterSeq=-1", "limit=1.5", "beforeSeq=-3"])(
    "invalid parameter %s -> 400",
    async (qs) => {
      const { read } = await seeded(1);
      expect((await read(`?${qs}`)).status).toBe(400);
    },
  );

  it("verify stays in ascending order", async () => {
    const { app } = await seeded(5);
    const res = await app.inject({ method: "GET", url: "/admin/ledger/verify", headers: adminHeaders });
    expect(res.json()).toMatchObject({ valid: true, checked: 5 });
  });
});
