// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const files: string[] = [];
let emptyList = false;

vi.mock("../src/session", () => ({
  call: vi.fn(async (path: string) => {
    calls.push(path);
    if (path.startsWith("/admin/ledger/facets")) {
      return {
        agents: [
          { id: "agent-alpha", name: "alpha" },
          { id: "agent-ghost1234", name: null },
        ],
        models: ["m1", "m2"],
      };
    }
    if (path.startsWith("/admin/agents")) return { agents: [{ id: "agent-alpha", name: "alpha" }] };
    return {
      entries: emptyList
        ? []
        : [{ seq: 2, ts: "2026-10-01T10:00:00.000Z", agentId: "agent-alpha", action: "chat.completions", model: "m1", verdict: "allowed", reason: null, upstreamStatus: 200, promptTokens: 1, completionTokens: 2, cost: 250000, requestHash: null, responseHash: null, prevHash: "p", hash: "h" }],
    };
  }),
  callFile: vi.fn(async (path: string) => {
    files.push(path);
    return { blob: new Blob(["x"]), filename: "j.csv" };
  }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : "erreur"),
}));

import LedgerView from "../src/views/LedgerView.vue";
import { setLocale } from "../src/i18n";

let wrapper: VueWrapper | undefined;

async function mountView(url = "/console/") {
  history.replaceState(null, "", url);
  wrapper = mount(LedgerView, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const listCalls = () => calls.filter((c) => c.startsWith("/admin/ledger?"));
const lastList = () => new URL(listCalls().at(-1)!, "http://x").searchParams;
/** Types into a text field without committing it (the real `change` fires on blur or Enter). */
async function type(w: VueWrapper, label: string, value: string, commit = false) {
  const input = field(w, label).get("input");
  (input.element as HTMLInputElement).value = value;
  await input.trigger("input");
  if (commit) await input.trigger("change");
}
const field = (w: VueWrapper, label: string) => w.get(`[aria-label="Filtres du journal"]`).findAll("label").find((l) => l.text().startsWith(label))!;

beforeEach(() => {
  setLocale("fr");
  calls.length = 0;
  files.length = 0;
  emptyList = false;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined); // jsdom cannot navigate to a download
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe("LedgerView filters", () => {
  it("shows labelled selectors and fields, populated from the facets endpoint", async () => {
    const w = await mountView();
    expect(w.get("form[role=search]").attributes("aria-label")).toBe("Filtres du journal");
    for (const label of ["Agent", "Modèle", "Verdict", "Coût min. (USD)", "Coût max. (USD)"]) {
      expect(field(w, label), label).toBeTruthy();
    }
    const options = (label: string) => field(w, label).findAll("option").map((o) => o.text());
    expect(options("Agent")).toEqual(["Tous", "alpha", "clé inconnue (agent-gh)"]);
    expect(options("Modèle")).toEqual(["Tous", "m1", "m2"]);
    expect(options("Verdict")).toEqual(["Tous", "Autorisé", "Refusé"]);
    expect(w.text()).toContain("Réinitialiser");
    // First load without filters sends no filter parameter.
    expect(listCalls()[0]).toBe("/admin/ledger?order=desc&limit=100");
  });

  it("applies a selector change to the list request and the URL", async () => {
    const w = await mountView();
    await field(w, "Verdict").get("select").setValue("denied");
    await flushPromises();
    expect(lastList().get("verdict")).toBe("denied");
    expect(lastList().get("order")).toBe("desc");
    expect(Object.fromEntries(new URLSearchParams(location.search))).toEqual({ tab: "ledger", verdict: "denied" });

    await field(w, "Agent").get("select").setValue("agent-alpha");
    await field(w, "Modèle").get("select").setValue("m2");
    await flushPromises();
    const p = lastList();
    expect([p.get("agent"), p.get("model"), p.get("verdict")]).toEqual(["agent-alpha", "m2", "denied"]);
    expect(new URLSearchParams(location.search).get("model")).toBe("m2");
  });

  it("converts the cost fields (decimal comma accepted) and keeps them in the URL", async () => {
    const w = await mountView();
    await type(w, "Coût min.", "0,25", true);
    await type(w, "Coût max.", "1.5", true);
    await flushPromises();
    expect(lastList().get("minCost")).toBe("0.25");
    expect(lastList().get("maxCost")).toBe("1.5");
    expect(location.search).toContain("minCost=0.25");
  });

  it("rejects invalid costs without calling the gateway", async () => {
    const w = await mountView();
    const before = listCalls().length;
    await type(w, "Coût min.", "-1", true);
    await flushPromises();
    expect(w.get("[role=alert]").text()).toMatch(/Coût min\./);
    expect(listCalls().length).toBe(before);

    await type(w, "Coût min.", "3");
    await type(w, "Coût max.", "2", true);
    expect(w.get("[role=alert]").text()).toMatch(/ne peut pas dépasser/);
    expect(listCalls().length).toBe(before);
  });

  it("restores the filters from the URL and uses them on the first request", async () => {
    const w = await mountView("/console/?tab=ledger&agent=agent-alpha&model=m1&verdict=allowed&minCost=0.5");
    const p = lastList();
    expect([p.get("agent"), p.get("model"), p.get("verdict"), p.get("minCost")]).toEqual(["agent-alpha", "m1", "allowed", "0.5"]);
    expect((field(w, "Agent").get("select").element as HTMLSelectElement).value).toBe("agent-alpha");
    expect((field(w, "Verdict").get("select").element as HTMLSelectElement).value).toBe("allowed");
    expect((field(w, "Coût min.").get("input").element as HTMLInputElement).value).toBe("0.5");
  });

  it("keeps an agent from the URL selectable even if the facets do not list it", async () => {
    const w = await mountView("/console/?agent=agent-other12345");
    const select = field(w, "Agent").get("select").element as HTMLSelectElement;
    expect(select.value).toBe("agent-other12345");
  });

  it("a shared URL with an invalid cost shows the message and does not query the list", async () => {
    const w = await mountView("/console/?minCost=abc");
    expect(listCalls()).toEqual([]);
    expect(w.get("[role=alert]").text()).toMatch(/Coût min\./);
  });

  it("Réinitialiser clears the fields, the URL and the list filters", async () => {
    const w = await mountView("/console/?tab=ledger&verdict=denied&model=m1");
    const reset = w.findAll("button").find((b) => b.text() === "Réinitialiser")!;
    expect(reset.attributes("disabled")).toBeUndefined();
    await reset.trigger("click");
    await flushPromises();
    expect(lastList().has("verdict")).toBe(false);
    expect(lastList().has("model")).toBe(false);
    expect((field(w, "Verdict").get("select").element as HTMLSelectElement).value).toBe("");
    expect(location.search).toBe("?tab=ledger");
    expect(reset.attributes("disabled")).toBeDefined();
  });

  it("applies the active filters to the CSV export together with the dates", async () => {
    const w = await mountView("/console/?verdict=denied&agent=agent-alpha&maxCost=2");
    const forms = w.findAll("form");
    const dates = forms[1]!.findAll("input");
    await dates[0]!.setValue("2026-10-01");
    await dates[1]!.setValue("2026-10-31");
    await forms[1]!.trigger("submit");
    await flushPromises();
    expect(files).toHaveLength(1);
    const p = new URL(files[0]!, "http://x").searchParams;
    expect(new URL(files[0]!, "http://x").pathname).toBe("/admin/ledger/export.csv");
    expect([p.get("verdict"), p.get("agent"), p.get("maxCost"), p.get("from"), p.get("to")]).toEqual(["denied", "agent-alpha", "2", "2026-10-01", "2026-10-31"]);
    expect(w.text()).toContain("Les filtres ci-dessus sont appliqués à l'export.");
  });

  it("the export ignores filters that were typed but not applied", async () => {
    const w = await mountView();
    await field(w, "Verdict").get("select").setValue("denied");
    await flushPromises();
    await type(w, "Coût min.", "9"); // typed, not yet applied
    await w.findAll("form")[1]!.trigger("submit");
    await flushPromises();
    const p = new URL(files[0]!, "http://x").searchParams;
    expect(p.get("verdict")).toBe("denied");
    expect(p.has("minCost")).toBe(false);
  });

  it("says so when no row matches the filters", async () => {
    emptyList = true;
    const w = await mountView("/console/?verdict=denied");
    expect(w.text()).toContain("Aucune entrée ne correspond à ces filtres.");
  });

  it("removes its parameters from the URL when the page is left", async () => {
    await mountView("/console/?tab=ledger&verdict=denied&other=1");
    wrapper!.unmount();
    wrapper = undefined;
    expect(location.search).toBe("?other=1");
  });
});
