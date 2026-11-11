// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posts: Record<string, unknown>[] = [];
const patches: Record<string, unknown>[] = [];

vi.mock("../src/session", () => ({
  call: vi.fn(async (path: string, init?: { method?: string; body?: Record<string, unknown> }) => {
    if (path === "/admin/agents" && init?.method === "POST") {
      posts.push(init.body ?? {});
      return { agent: { id: "n1", name: "new" }, key: "ga_KEY_for_the_test" };
    }
    if (init?.method === "PATCH") {
      patches.push(init.body ?? {});
      return {};
    }
    return {
      agents: path === "/admin/agents"
        ? [{ id: "a1", name: "alpha", allowedModels: ["m1"], allowedTools: [], approvalTools: [], dailyBudgetUsd: 2, spentTodayUsd: 0, reservedTodayUsd: 0, active: true }]
        : [],
    };
  }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : "error"),
}));

import AgentsView from "../src/views/AgentsView.vue";
import { setLocale } from "../src/i18n";

let wrapper: VueWrapper | undefined;

async function fill(budget: string, unlimited = false) {
  wrapper = mount(AgentsView, { attachTo: document.body });
  await flushPromises();
  const form = wrapper.get("form");
  const texts = form.findAll("input[type=text]");
  await texts[0]!.setValue("bot");
  await texts[1]!.setValue("m1");
  if (budget !== "") await form.get("input[type=number]").setValue(budget);
  if (unlimited) await form.get("input[type=checkbox]").setValue(true);
  await form.trigger("submit");
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setLocale("en");
  posts.length = 0;
  patches.length = 0;
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("agent creation form requires a budget (E4)", () => {
  it("starts with an empty budget field and an unchecked no-cap box", async () => {
    wrapper = mount(AgentsView, { attachTo: document.body });
    await flushPromises();
    expect((wrapper.get("form input[type=number]").element as HTMLInputElement).value).toBe("");
    expect((wrapper.get("form input[type=checkbox]").element as HTMLInputElement).checked).toBe(false);
  });

  it.each([["empty", ""], ["zero", "0"], ["negative", "-3"]])("refuses an %s budget without calling the API", async (_n, value) => {
    const w = await fill(value);
    expect(posts).toHaveLength(0);
    expect(w.get("[role=alert]").text()).toMatch(/budget/i);
  });

  it("refuses a positive budget that would round to 0 micro-USD, in English and French", async () => {
    const w = await fill("0.0000001");
    expect(posts).toHaveLength(0);
    expect(w.get("[role=alert]").text()).toMatch(/at least 0\.000001/);
    wrapper?.unmount();
    setLocale("fr");
    const f = await fill("0.0000004");
    expect(posts).toHaveLength(0);
    expect(f.get("[role=alert]").text()).toMatch(/au moins 0,000001/);
  });

  it("accepts the minimum budget 0.000001", async () => {
    await fill("0.000001");
    expect(posts).toEqual([expect.objectContaining({ dailyBudgetUsd: 0.000001 })]);
  });

  it("sends the positive budget, without the unlimited flag", async () => {
    await fill("2.5");
    expect(posts).toEqual([expect.objectContaining({ dailyBudgetUsd: 2.5 })]);
    expect(posts[0]).not.toHaveProperty("unlimited");
  });

  it("sends 0 with unlimited: true only when the no-cap box is ticked", async () => {
    await fill("", true);
    expect(posts).toEqual([expect.objectContaining({ dailyBudgetUsd: 0, unlimited: true })]);
  });

  it("labels the box in French too", async () => {
    setLocale("fr");
    wrapper = mount(AgentsView, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get("form").text()).toMatch(/illimit/i);
  });

  it("edit form: refuses a positive budget below 0.000001 without calling the API, but still allows 0 and the minimum", async () => {
    wrapper = mount(AgentsView, { attachTo: document.body });
    await flushPromises();
    const edit = wrapper.findAll("tbody button").find((b) => b.text() === "Edit")!;
    await edit.trigger("click");
    const save = () => wrapper!.findAll("tbody button").find((b) => b.text() === "Save")!;
    const budget = wrapper.get("tbody input[type=number]");
    await budget.setValue("0.0000001");
    await save().trigger("click");
    await flushPromises();
    expect(patches).toHaveLength(0);
    expect(wrapper.get("[role=alert]").text()).toMatch(/at least 0\.000001/);
    await budget.setValue("0.000001");
    await save().trigger("click");
    await flushPromises();
    expect(patches).toEqual([expect.objectContaining({ dailyBudgetUsd: 0.000001 })]);
  });
});
