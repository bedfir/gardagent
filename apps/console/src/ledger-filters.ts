import { t } from "./i18n";

/** Journal filters: parsing from the page URL, validation and serialisation for the /admin/ledger routes. */

export type VerdictFilter = "" | "allowed" | "denied";

export interface LedgerFilters {
  /** Agent id; empty = all. */
  agent: string;
  /** Exact model name; empty = all. */
  model: string;
  verdict: VerdictFilter;
  /** Minimum cost in USD, as typed (empty = none). */
  minCost: string;
  maxCost: string;
}

export const EMPTY_FILTERS: Readonly<LedgerFilters> = Object.freeze({ agent: "", model: "", verdict: "", minCost: "", maxCost: "" });

/** Query-string keys owned by the ledger page (the same names as the gateway parameters). */
export const FILTER_KEYS = ["agent", "model", "verdict", "minCost", "maxCost"] as const;

/** Reads the filters from a query string; unknown or invalid verdicts are ignored. */
export function filtersFromSearch(search: string): LedgerFilters {
  const p = new URLSearchParams(search);
  const verdict = p.get("verdict");
  return {
    agent: p.get("agent") ?? "",
    model: p.get("model") ?? "",
    verdict: verdict === "allowed" || verdict === "denied" ? verdict : "",
    minCost: p.get("minCost") ?? "",
    maxCost: p.get("maxCost") ?? "",
  };
}

/** Accepts the French decimal comma and surrounding spaces; the gateway only takes a dot. */
export function normalizeCost(value: string): string {
  return value.trim().replace(",", ".");
}

const AMOUNT = /^\d+(\.\d+)?$/;

/** Error message in the active language, or an empty string when the filters can be sent. */
export function validateFilters(f: LedgerFilters): string {
  const min = normalizeCost(f.minCost);
  const max = normalizeCost(f.maxCost);
  for (const [label, value] of [[t("filters.minShort"), min], [t("filters.maxShort"), max]] as const) {
    if (value !== "" && !AMOUNT.test(value)) {
      return t("filters.invalidAmount", { label });
    }
  }
  if (min !== "" && max !== "" && Number(min) > Number(max)) {
    return t("filters.minAboveMax");
  }
  return "";
}

/** Gateway query parameters for the filters that are set (empty ones are left out). */
export function filtersToParams(f: LedgerFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.agent) p.set("agent", f.agent);
  if (f.model) p.set("model", f.model);
  if (f.verdict) p.set("verdict", f.verdict);
  const min = normalizeCost(f.minCost);
  const max = normalizeCost(f.maxCost);
  if (min) p.set("minCost", min);
  if (max) p.set("maxCost", max);
  return p;
}

export function hasActiveFilters(f: LedgerFilters): boolean {
  return filtersToParams(f).toString() !== "";
}

export function sameFilters(a: LedgerFilters, b: LedgerFilters): boolean {
  return filtersToParams(a).toString() === filtersToParams(b).toString();
}
