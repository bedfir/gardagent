// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let divergences: { agentId: string; name: string | null; spentUsd: number; ledgerUsd: number }[] = [];
let checkFails = false;

const bucket = { spentUsd: 1.5, allowed: 3, denied: 0, deniedByReason: {}, observedByReason: {}, promptTokens: 10, completionTokens: 5 };

vi.mock("../src/session", () => ({
  call: vi.fn(async (path: string) => {
    if (path.startsWith("/admin/spend-check")) {
      if (checkFails) throw new Error("indisponible");
      return { day: "2026-10-22", divergences };
    }
    return { days: 7, from: "2026-10-16", to: "2026-10-22", totals: bucket, agents: [], byDay: [{ day: "2026-10-22", ...bucket, agents: [] }] };
  }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : "erreur"),
}));

import DashboardView from "../src/views/DashboardView.vue";
import { setLocale } from "../src/i18n";

let wrapper: VueWrapper | undefined;
async function mountView() {
  wrapper = mount(DashboardView, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setLocale("fr");
  divergences = [];
  checkFails = false;
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("DashboardView spend/ledger check", () => {
  it("shows nothing when no agent diverges", async () => {
    const w = await mountView();
    expect(w.find(".notice").exists()).toBe(false);
    expect(w.text()).not.toContain("Écart entre la dépense et le journal");
    expect(w.text()).toContain("Tableau de bord");
  });

  it("shows the banner with the agents and both amounts when some diverge", async () => {
    divergences = [
      { agentId: "a1", name: "alpha", spentUsd: 1, ledgerUsd: 3 },
      { agentId: "a2", name: null, spentUsd: 0, ledgerUsd: 0.25 },
    ];
    const w = await mountView();
    const banner = w.get(".notice");
    expect(banner.text()).toContain("Écart entre la dépense et le journal pour 2 agents aujourd'hui");
    const rows = banner.findAll("tbody tr").map((r) => r.findAll("td").map((c) => c.text()));
    expect(rows).toEqual([
      ["alpha", "1,00 $", "3,00 $"],
      ["a2", "0,00 $", "0,25 $"],
    ]);
  });

  it("uses the singular for one agent", async () => {
    divergences = [{ agentId: "a1", name: "alpha", spentUsd: 1, ledgerUsd: 3 }];
    const w = await mountView();
    expect(w.get(".notice").text()).toContain("pour 1 agent aujourd'hui");
  });

  it("shows nothing, and still renders the dashboard, if the check itself fails", async () => {
    checkFails = true;
    const w = await mountView();
    expect(w.find(".notice").exists()).toBe(false);
    expect(w.find("[role=alert]").exists()).toBe(false);
    expect(w.text()).toContain("Dépense par jour");
  });
});
