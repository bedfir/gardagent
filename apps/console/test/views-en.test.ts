// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bucket = { spentUsd: 1.5, allowed: 3, denied: 2, deniedByReason: { budget_exceeded: 2 }, observedByReason: {}, promptTokens: 10, completionTokens: 5 };
const agent = { id: "a1", name: "alpha", allowedModels: ["m1"], allowedTools: [], approvalTools: [], dailyBudgetUsd: 2, spentTodayUsd: 0.5, reservedTodayUsd: 0.1, active: true };

vi.mock("../src/session", async () => {
  const { ref } = await import("vue");
  return {
    loginNotice: ref("error.invalidToken"),
    setToken: vi.fn(),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : "error"),
    callFile: vi.fn(),
    call: vi.fn(async (path: string) => {
      if (path.startsWith("/admin/spend-check")) return { day: "2026-10-22", divergences: [{ agentId: "a1", name: "alpha", spentUsd: 1, ledgerUsd: 3 }] };
      if (path.startsWith("/admin/stats")) {
        return { days: 7, from: "2026-10-16", to: "2026-10-22", totals: bucket, agents: [], byDay: [{ day: "2026-10-22", ...bucket, agents: [] }] };
      }
      if (path.startsWith("/admin/ledger/verify")) return { valid: false, checked: 3, brokenAtSeq: 3, problem: "seq_gap" };
      if (path.startsWith("/admin/ledger/facets")) return { agents: [{ id: "a1", name: "alpha" }, { id: "ghost-1234567", name: null }], models: ["m1"] };
      if (path.startsWith("/admin/agents")) return { agents: [agent] };
      return {
        entries: [
          { seq: 2, ts: "2026-10-01T10:00:00.000Z", agentId: "a1", action: "chat.completions", model: "m1", verdict: "denied", reason: "invalid_key", upstreamStatus: 0, promptTokens: 1, completionTokens: 2, cost: 250000, requestHash: null, responseHash: null, prevHash: "p", hash: "h" },
          { seq: 1, ts: "2026-10-01T09:00:00.000Z", agentId: "a1", action: "admin.agent.update", model: null, verdict: "allowed", reason: "name,dailyBudget", upstreamStatus: null, promptTokens: 0, completionTokens: 0, cost: 0, requestHash: null, responseHash: null, prevHash: "p", hash: "h" },
        ],
      };
    }),
  };
});

import AgentsView from "../src/views/AgentsView.vue";
import DashboardView from "../src/views/DashboardView.vue";
import IntegrityView from "../src/views/IntegrityView.vue";
import LedgerView from "../src/views/LedgerView.vue";
import LoginView from "../src/views/LoginView.vue";
import LocaleSwitch from "../src/LocaleSwitch.vue";
import { setLocale } from "../src/i18n";

let wrapper: VueWrapper | undefined;
async function show(component: object) {
  history.replaceState(null, "", "/console/");
  wrapper = mount(component, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}
const FRENCH = /[àâçéèêëîïôùûü]|Tableau de bord|Journal|Chargement|Aucun/;

beforeEach(() => setLocale("en"));
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("views in English", () => {
  it("Dashboard", async () => {
    const w = await show(DashboardView);
    expect(w.text()).toContain("Dashboard");
    expect(w.text()).toContain("Spend and ledger disagree for 1 agent today");
    expect(w.text()).toContain("Ledger cost, 7 days");
    expect(w.text()).toContain("Allowed requests");
    expect(w.text()).toContain("Denials by reason");
    expect(w.text()).toContain("budget reached");
    expect(w.text()).toContain("2 denials");
    expect(w.text()).toContain("$1.50");
    expect(w.get("svg").attributes("aria-label")).toBe("Daily spend, stacked by agent");
    expect(w.get(".readout").text()).toBe("Hover over or tap a bar to see the day's details.");
    expect(w.text()).not.toMatch(FRENCH);
  });

  it("Agents", async () => {
    const w = await show(AgentsView);
    const text = w.text();
    for (const s of ["Allowed models", "Allowed MCP tools", "Tools requiring approval", "Daily budget", "Today's spend (UTC)", "$0.50 of $2.00", "$0.10 reserved", "Create an agent", "Create agent", "none", "Edit", "Rotate key"]) {
      expect(text).toContain(s);
    }
    expect(w.get("[role=switch]").attributes("aria-label")).toBe("Agent alpha: active");
    expect(text).not.toMatch(FRENCH);
  });

  it("Agents: validation error and key-rotation texts", async () => {
    const w = await show(AgentsView);
    await w.get("form").trigger("submit");
    expect(w.get("[role=alert]").text()).toBe("Enter the agent's name.");
    await w.findAll("tbody button").find((b) => b.text() === "Rotate key")!.trigger("click");
    expect(w.get("[role=alertdialog]").text()).toContain("The old key will stop working immediately.");
  });

  it("Ledger", async () => {
    const w = await show(LedgerView);
    const text = w.text();
    for (const s of ["Ledger", "Refreshes automatically every 10 s", "Min. cost (USD)", "Max. cost (USD)", "Export to CSV", "Reset", "denied", "invalid key", "Agent updated: name, budget", "$0.2500", "Tokens (in / out)"]) {
      expect(text).toContain(s);
    }
    const verdict = w.get('[aria-label="Ledger filters"]').findAll("label").find((l) => l.text().startsWith("Verdict"))!;
    expect(verdict.findAll("option").map((o) => o.text())).toEqual(["All", "Allowed", "Denied"]);
    const agentSelect = w.get('[aria-label="Ledger filters"]').findAll("label").find((l) => l.text().startsWith("Agent"))!;
    expect(agentSelect.findAll("option").map((o) => o.text())).toEqual(["All", "alpha", "unknown key (ghost-12)"]);
    expect(text).not.toMatch(FRENCH);
  });

  it("Integrity", async () => {
    const w = await show(IntegrityView);
    expect(w.text()).toContain("Each ledger row is chained to the previous one");
    await w.get("button").trigger("click");
    await flushPromises();
    expect(w.get("[role=status]").text()).toBe("Ledger tampered at row 3 (missing row)");
    expect(w.text()).not.toMatch(FRENCH);
  });

  it("Login", async () => {
    const w = await show(LoginView);
    expect(w.text()).toContain("Gateway admin console. Enter the admin token to continue.");
    expect(w.text()).toContain("Admin token");
    expect(w.text()).toContain("Log in");
    expect(w.get("[role=alert]").text()).toBe("Invalid token.");
    expect(w.text()).not.toMatch(FRENCH);
    await w.get("form").trigger("submit");
    expect(w.get("[role=alert]").text()).toBe("Enter the admin token.");
  });

  it("the same view switches to French without remounting", async () => {
    const w = await show(IntegrityView);
    expect(w.get("h1").text()).toBe("Integrity");
    setLocale("fr");
    await flushPromises();
    expect(w.get("h1").text()).toBe("Intégrité");
  });
});

describe("LocaleSwitch", () => {
  it("shows FR | EN with aria-pressed on the active one and switches on click", async () => {
    const w = await show(LocaleSwitch);
    const [fr, en] = w.findAll("button");
    expect([fr!.text(), en!.text()]).toEqual(["FR", "EN"]);
    expect(en!.attributes("aria-pressed")).toBe("true");
    expect(fr!.attributes("aria-pressed")).toBe("false");
    await fr!.trigger("click");
    expect(document.documentElement.lang).toBe("fr");
    expect(fr!.attributes("aria-pressed")).toBe("true");
    expect(w.get("[role=group]").attributes("aria-label")).toBe("Langue");
  });
});
