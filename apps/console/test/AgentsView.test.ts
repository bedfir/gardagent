// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { path: string; method: string }[] = [];
let failRotation = false;

const agent = (id: string, name: string) => ({
  id, name, allowedModels: ["m1"], allowedTools: [], approvalTools: [], dailyBudgetUsd: 2, spentTodayUsd: 0.5, reservedTodayUsd: 0, active: true,
});

vi.mock("../src/session", () => ({
  call: vi.fn(async (path: string, init?: { method?: string }) => {
    calls.push({ path, method: init?.method ?? "GET" });
    if (path.endsWith("/rotate-key")) {
      if (failRotation) throw new Error("Agent introuvable.");
      return { agent: agent("a1", "alpha"), key: "ga_NEWKEY_for_the_test" };
    }
    return { agents: [agent("a1", "alpha"), agent("a2", "beta")] };
  }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : "erreur"),
}));

import AgentsView from "../src/views/AgentsView.vue";
import { setLocale } from "../src/i18n";

let wrapper: VueWrapper | undefined;
const rotations = () => calls.filter((c) => c.path.endsWith("/rotate-key"));
const rotateButton = (w: VueWrapper, row = 0) =>
  w.findAll("tbody tr")[row]!.findAll("button").find((b) => b.text() === "Renouveler la clé")!;

async function mountView() {
  wrapper = mount(AgentsView, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setLocale("fr");
  calls.length = 0;
  failRotation = false;
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("AgentsView key rotation", () => {
  it("offers the action on every agent and calls nothing before confirmation", async () => {
    const w = await mountView();
    expect(w.findAll("tbody tr").every((tr) => tr.findAll("button").some((b) => b.text() === "Renouveler la clé"))).toBe(true);
    await rotateButton(w).trigger("click");
    expect(w.get("[role=alertdialog]").text()).toContain("L'ancienne clé cessera de fonctionner");
    expect(rotations()).toHaveLength(0);
    expect(w.find(".key-box").exists()).toBe(false);
  });

  it("cancel closes the confirmation without any call", async () => {
    const w = await mountView();
    await rotateButton(w).trigger("click");
    await w.get("[role=alertdialog]").findAll("button").find((b) => b.text() === "Annuler")!.trigger("click");
    expect(w.find("[role=alertdialog]").exists()).toBe(false);
    expect(rotations()).toHaveLength(0);
  });

  it("confirming POSTs to the route and shows the new key once, with the warning and a copy button", async () => {
    const w = await mountView();
    await rotateButton(w).trigger("click");
    await w.get("[role=alertdialog]").findAll("button").find((b) => b.text() === "Renouveler la clé")!.trigger("click");
    await flushPromises();

    expect(rotations()).toEqual([{ path: "/admin/agents/a1/rotate-key", method: "POST" }]);
    const box = w.get(".key-box");
    expect(box.text()).toContain("Nouvelle clé de l'agent « alpha »");
    expect(box.text()).toContain("Cette clé ne sera plus affichée.");
    expect(box.text()).toContain("L'ancienne clé ne fonctionne plus");
    expect((box.get("input").element as HTMLInputElement).value).toBe("ga_NEWKEY_for_the_test");
    expect(box.findAll("button").some((b) => b.text() === "Copier la clé")).toBe(true);

    await box.findAll("button").find((b) => b.text() === "J'ai noté la clé")!.trigger("click");
    expect(w.find(".key-box").exists()).toBe(false);
    expect(w.html()).not.toContain("ga_NEWKEY_for_the_test");
  });

  it("shows the error and no key when the rotation fails", async () => {
    failRotation = true;
    const w = await mountView();
    await rotateButton(w, 1).trigger("click");
    await w.get("[role=alertdialog]").findAll("button").find((b) => b.text() === "Renouveler la clé")!.trigger("click");
    await flushPromises();
    expect(w.get("[role=alert]").text()).toContain("Agent introuvable.");
    expect(w.find(".key-box").exists()).toBe(false);
  });
});
