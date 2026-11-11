// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminLabel, budgetLabel, costUsd, fullDay, localTime, plural, problemLabel, reasonLabel, shortDay, usd } from "../src/format";
import { detectLocale, LOCALE_STORAGE_KEY, locale, setLocale, t } from "../src/i18n";
import { en } from "../src/i18n/en";
import { fr } from "../src/i18n/fr";
import { EMPTY_FILTERS, validateFilters } from "../src/ledger-filters";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dictionaries", () => {
  it("have exactly the same keys in French and English", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  });

  it("have no empty value and the same placeholders in both languages", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(fr) as (keyof typeof fr)[]) {
      expect(fr[key].length, key).toBeGreaterThan(0);
      expect(en[key].length, key).toBeGreaterThan(0);
      expect(placeholders(en[key]), key).toEqual(placeholders(fr[key]));
    }
  });
});

describe("t()", () => {
  beforeEach(() => setLocale("en"));

  it("interpolates {name} and leaves unknown placeholders alone", () => {
    expect(t("agents.keyCreated", { name: "alpha" })).toBe('Agent "alpha" created');
    expect(t("agents.keyCreated")).toBe('Agent "{name}" created');
    setLocale("fr");
    expect(t("agents.keyCreated", { name: "alpha" })).toBe("Agent « alpha » créé");
  });

  it("switching the locale updates the ref, the page language and the title", () => {
    setLocale("fr");
    expect(locale.value).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
    expect(document.title).toBe("Console Gardagent");
    setLocale("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Gardagent console");
  });
});

describe("format helpers", () => {
  it("French", () => {
    setLocale("fr");
    expect(usd(1.5)).toBe("1,50 $");
    expect(usd(0.12345)).toBe("0,1235 $");
    expect(costUsd(250000)).toBe("0.2500 $");
    expect(budgetLabel(0)).toBe("illimité");
    expect(budgetLabel(2)).toBe("2,00 $");
    expect(reasonLabel("budget_exceeded")).toBe("budget atteint");
    expect(reasonLabel("observed:budget_exceeded")).toBe("budget atteint (observation)");
    expect(reasonLabel("something_new")).toBe("something_new");
    expect(reasonLabel(null)).toBe("");
    expect(problemLabel("seq_gap")).toBe("ligne manquante");
    expect(problemLabel(undefined)).toBe("problème inconnu");
    expect(adminLabel("admin.agent.update", "name,dailyBudget,active")).toBe("Agent modifié : nom, budget, actif");
    expect(adminLabel("admin.agent.update", null)).toBe("Agent modifié");
    expect(adminLabel("mcp.tools/call", "tool_not_allowed")).toBe("Outil MCP : outil non autorisé");
    expect(adminLabel("chat.completions", null)).toBeNull();
    expect(plural(0, "agent", "agents")).toBe("0 agent");
    expect(plural(1, "agent", "agents")).toBe("1 agent");
    expect(plural(2, "agent", "agents")).toBe("2 agents");
    expect(shortDay("2026-10-22")).toBe("22/10");
    expect(fullDay("2026-10-22")).toBe("22/10/2026");
    expect(localTime("2026-10-22T10:00:00.000Z")).toMatch(/^\d{2}\/\d{2}\/\d{4}/);
  });

  it("English", () => {
    setLocale("en");
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd(0.12345)).toBe("$0.1235");
    expect(costUsd(250000)).toBe("$0.2500");
    expect(budgetLabel(0)).toBe("unlimited");
    expect(budgetLabel(2)).toBe("$2.00");
    expect(reasonLabel("invalid_key")).toBe("invalid key");
    expect(reasonLabel("observed:budget_exceeded")).toBe("budget reached (observed)");
    expect(reasonLabel("observed:unmapped")).toBe("unmapped (observed)");
    expect(problemLabel("link_mismatch")).toBe("broken chain");
    expect(problemLabel("hash_mismatch")).toBe("content modified");
    expect(problemLabel(undefined)).toBe("unknown problem");
    expect(adminLabel("admin.agent.update", "name,allowedModels,allowedTools,approvalTools,dailyBudget,active")).toBe(
      "Agent updated: name, models, MCP tools, tools requiring approval, budget, active",
    );
    expect(adminLabel("admin.agent.update", "mystery")).toBe("Agent updated: mystery");
    expect(adminLabel("admin.agent.create", null)).toBe("Agent created");
    expect(adminLabel("mcp.tools/call", null)).toBe("MCP tool");
    expect(adminLabel("mcp.approval.decided", "rejected")).toBe("Approval: rejected");
    expect(plural(0, "agent", "agents")).toBe("0 agents");
    expect(plural(1, "agent", "agents")).toBe("1 agent");
    expect(plural(2, "agent", "agents")).toBe("2 agents");
    expect(shortDay("2026-10-22")).toBe("10/22");
    expect(fullDay("2026-10-22")).toBe("10/22/2026");
    expect(localTime("2026-10-22T10:00:00.000Z")).toMatch(/\d{1,2}\/\d{1,2}\/\d{2},/);
    expect(localTime("not a date")).toBe("not a date");
  });

  it("translates the filter validation messages", () => {
    setLocale("en");
    expect(validateFilters({ ...EMPTY_FILTERS, minCost: "abc" })).toBe("Min. cost: enter a positive amount in dollars, for example 0.25.");
    expect(validateFilters({ ...EMPTY_FILTERS, minCost: "2", maxCost: "1" })).toBe("The minimum cost cannot exceed the maximum cost.");
  });
});

describe("locale selection", () => {
  const language = (value: string) => vi.spyOn(navigator, "language", "get").mockReturnValue(value);

  beforeEach(() => localStorage.clear());

  it("a stored choice wins over the browser language", () => {
    language("fr-FR");
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    expect(detectLocale()).toBe("en");
    language("en-US");
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
    expect(detectLocale()).toBe("fr");
  });

  it("ignores an invalid stored value", () => {
    language("en-GB");
    localStorage.setItem(LOCALE_STORAGE_KEY, "de");
    expect(detectLocale()).toBe("en");
  });

  it("falls back to the browser language: fr* is French, everything else English", () => {
    language("fr-CA");
    expect(detectLocale()).toBe("fr");
    language("FR");
    expect(detectLocale()).toBe("fr");
    language("en-US");
    expect(detectLocale()).toBe("en");
    language("de-DE");
    expect(detectLocale()).toBe("en");
  });

  it("is French when the browser reports no language", () => {
    language("");
    expect(detectLocale()).toBe("fr");
  });

  it("works when storage throws, on read and on write", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", broken);
    language("fr-FR");
    expect(detectLocale()).toBe("fr");
    language("en-US");
    expect(detectLocale()).toBe("en");
    expect(() => setLocale("fr")).not.toThrow();
    expect(locale.value).toBe("fr");
  });

  it("setLocale saves the choice", () => {
    setLocale("en");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });
});
