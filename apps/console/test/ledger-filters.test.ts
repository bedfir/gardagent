import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../src/i18n";
import { EMPTY_FILTERS, filtersFromSearch, filtersToParams, hasActiveFilters, normalizeCost, sameFilters, validateFilters } from "../src/ledger-filters";

describe("ledger filters (pure helpers)", () => {
  beforeEach(() => setLocale("fr"));

  it("reads filters from a query string and ignores an invalid verdict", () => {
    expect(filtersFromSearch("?tab=ledger&agent=a1&model=m&verdict=denied&minCost=0.5&maxCost=2")).toEqual({
      agent: "a1",
      model: "m",
      verdict: "denied",
      minCost: "0.5",
      maxCost: "2",
    });
    expect(filtersFromSearch("?verdict=maybe").verdict).toBe("");
    expect(filtersFromSearch("")).toEqual(EMPTY_FILTERS);
  });

  it("serialises only the set filters, with a dot decimal separator", () => {
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe("");
    const p = filtersToParams({ agent: "a b", model: "", verdict: "allowed", minCost: " 0,25 ", maxCost: "" });
    expect(p.toString()).toBe("agent=a+b&verdict=allowed&minCost=0.25");
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, model: "m" })).toBe(true);
    expect(sameFilters(EMPTY_FILTERS, { ...EMPTY_FILTERS, minCost: "  " })).toBe(true);
  });

  it("normalises the decimal comma", () => {
    expect(normalizeCost("1,5")).toBe("1.5");
  });

  it.each([
    [{ minCost: "-1" }, /Coût min\./],
    [{ maxCost: "abc" }, /Coût max\./],
    [{ minCost: "1e3" }, /Coût min\./],
    [{ minCost: "2", maxCost: "1" }, /ne peut pas dépasser/],
  ])("rejects %j", (patch, message) => {
    expect(validateFilters({ ...EMPTY_FILTERS, ...patch })).toMatch(message);
  });

  it.each([{}, { minCost: "0" }, { minCost: "0,25", maxCost: "1.5" }, { minCost: "1", maxCost: "1" }])("accepts %j", (patch) => {
    expect(validateFilters({ ...EMPTY_FILTERS, ...patch })).toBe("");
  });
});
