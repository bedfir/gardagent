import type { LedgerEntry, LedgerQuery, Store } from "@gardagent/core";

const PAGE = 1000;

export const CSV_COLUMNS = [
  "seq",
  "timestamp",
  "agent",
  "action",
  "model",
  "verdict",
  "reason",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "request_hash",
  "response_hash",
  "entry_hash",
];

/**
 * CSV field with comma separator: doubled quotes and quoted field if it contains
 * ",", a quote or a line break. `text` neutralises formula injection in a spreadsheet.
 */
export function csvField(value: string, text = false): string {
  const v = text && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[,"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Cost in dollars with a dot decimal separator. */
export function csvCost(micro: number): string {
  return (micro / 1_000_000).toFixed(6);
}

function line(entry: LedgerEntry, agentName: string): string {
  return (
    [
      String(entry.seq),
      entry.ts,
      csvField(agentName, true),
      csvField(entry.action, true),
      csvField(entry.model ?? "", true),
      entry.verdict,
      csvField(entry.reason ?? "", true),
      String(entry.promptTokens),
      String(entry.completionTokens),
      csvCost(entry.cost),
      entry.requestHash ?? "",
      entry.responseHash ?? "",
      entry.hash,
    ].join(",") + "\r\n"
  );
}

/** CSV stream: UTF-8 BOM for Excel, then the ledger read in 1000-row pages. */
export async function* csvChunks(
  store: Store,
  agentNames: Map<string, string>,
  filters: Omit<LedgerQuery, "afterSeq" | "beforeSeq" | "limit" | "order">,
): AsyncGenerator<string> {
  yield "﻿" + CSV_COLUMNS.join(",") + "\r\n";
  let afterSeq = 0;
  for (;;) {
    const page = await store.listLedger({ afterSeq, limit: PAGE, ...filters });
    if (page.length === 0) return;
    yield page.map((e) => line(e, e.agentId ? (agentNames.get(e.agentId) ?? "") : "")).join("");
    afterSeq = page.at(-1)!.seq;
    if (page.length < PAGE) return;
  }
}
