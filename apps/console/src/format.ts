import { hasKey, locale, numberLocale, plural, t, type MessageKey } from "./i18n";

export { plural };

/** Label for a ledger reason code; an "observed:" prefix marks observation mode. Unknown codes are shown as is. */
function codeLabel(code: string): string {
  const key = `reason.${code}`;
  return hasKey(key) ? t(key) : code;
}

export function reasonLabel(reason: string | null): string {
  if (!reason) return "";
  if (reason.startsWith("observed:")) return t("reason.observed", { reason: codeLabel(reason.slice(9)) });
  return codeLabel(reason);
}

function fieldLabel(field: string): string {
  const key = `field.${field}`;
  return hasKey(key) ? t(key) : field;
}

/** Label of an admin action from the ledger, or null for a model call. */
export function adminLabel(action: string, reason: string | null): string | null {
  if (action === "mcp.tools/call") return reason ? t("admin.mcpToolReason", { reason: reasonLabel(reason) }) : t("admin.mcpTool");
  if (action === "mcp.approval.requested") return t("admin.approvalRequested");
  if (action === "mcp.approval.decided") return t("admin.approvalDecided", { reason: reasonLabel(reason) });
  if (!action.startsWith("admin.")) return null;
  if (action === "admin.agent.create") return t("admin.agentCreated");
  if (action === "admin.agent.rotate-key") return t("admin.keyRotated");
  if (action === "admin.agent.update") {
    const fields = (reason ?? "").split(",").filter(Boolean).map(fieldLabel);
    return fields.length > 0 ? t("admin.agentUpdatedFields", { fields: fields.join(", ") }) : t("admin.agentUpdated");
  }
  return action;
}

/** Amount with 2 to 4 decimals, without the currency symbol. */
export function usdNumber(value: number): string {
  return value.toLocaleString(numberLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Currency symbol placement: after the number with a space in French, before it in English. */
function withSymbol(digits: string): string {
  return locale.value === "fr" ? `${digits} $` : `$${digits}`;
}

export function usd(value: number): string {
  return withSymbol(usdNumber(value));
}

export function problemLabel(problem: string | undefined): string {
  if (!problem) return t("problem.unknown");
  const key = `problem.${problem}`;
  return hasKey(key) ? t(key) : problem;
}

/** The ledger cost is in micro-dollars. */
export function costUsd(micro: number): string {
  return withSymbol((micro / 1_000_000).toFixed(4));
}

export function budgetLabel(value: number): string {
  if (value === 0) return t("budget.unlimited");
  return usd(value);
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(numberLocale(), { dateStyle: "short", timeStyle: "medium" });
}

export function clockTime(d: Date): string {
  return d.toLocaleTimeString(numberLocale());
}

/** "2026-10-22" as day/month (French) or month/day (English), for chart axis labels. */
export function shortDay(day: string): string {
  return t("chart.dayShort", { d: day.slice(8, 10), m: day.slice(5, 7) });
}

/** "2026-10-22" as dd/mm/yyyy (French) or mm/dd/yyyy (English). */
export function fullDay(day: string): string {
  return t("chart.dayFull", { d: day.slice(8, 10), m: day.slice(5, 7), y: day.slice(0, 4) });
}

/** Human-readable age of a request: "12 s", "3 min", "2 h" (the same in both languages). */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

export type { MessageKey };
