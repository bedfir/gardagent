import type { MicroUsd } from "./types.js";

/** Price in dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Cost of a call in micro-dollars.
 * One dollar per million tokens = one micro-dollar per token, hence the direct calculation.
 * A model missing from the table uses `fallback`: overestimating is safer than letting it through uncounted.
 */
export function computeCost(
  prices: PriceTable,
  model: string,
  promptTokens: number,
  completionTokens: number,
  fallback: ModelPrice,
): MicroUsd {
  const price = findPrice(prices, model) ?? fallback;
  if (!validPrice(price)) throw new RangeError("computeCost: the fallback price must have finite, non-negative input and output prices.");
  // Never let a NaN or an infinity reach the budget arithmetic: such a value passes every "spent > cap" comparison.
  const tokens = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return Math.ceil(tokens(promptTokens) * price.input + tokens(completionTokens) * price.output);
}

function validPrice(price: unknown): price is ModelPrice {
  if (typeof price !== "object" || price === null) return false;
  const { input, output } = price as Partial<ModelPrice>;
  return typeof input === "number" && typeof output === "number" && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0;
}

/**
 * Exact match, otherwise longest prefix (e.g. "gpt-4o-mini-2024-07-18" → "gpt-4o-mini"). Only the table's own,
 * well-formed entries count: "constructor", "__proto__" or "toString" are unknown models, not inherited members.
 */
export function findPrice(prices: PriceTable, model: string): ModelPrice | undefined {
  if (Object.hasOwn(prices, model) && validPrice(prices[model])) return prices[model];
  let best: string | undefined;
  for (const name of Object.keys(prices)) {
    if (model.startsWith(name) && validPrice(prices[name]) && (!best || name.length > best.length)) best = name;
  }
  return best ? prices[best] : undefined;
}
