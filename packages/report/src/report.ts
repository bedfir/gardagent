import type {
  AdminAgent,
  ReportData,
  StatsBucket,
  StatsDay,
  StatsResponse,
} from "./types.js";

export function normalize(data: ReportData): ReportData {
  return {
    agents: (data.agents ?? []).map(normalizeAgent),
    stats: normalizeStats(data.stats),
    verify: data.verify ?? { valid: false, checked: 0 },
  };
}

function normalizeAgent(agent: AdminAgent): AdminAgent {
  return {
    id: agent.id ?? "",
    name: agent.name ?? "",
    allowedModels: agent.allowedModels ?? [],
    allowedTools: agent.allowedTools ?? [],
    dailyBudgetUsd: agent.dailyBudgetUsd ?? 0,
    spentTodayUsd: agent.spentTodayUsd ?? 0,
    active: agent.active ?? false,
  };
}

function normalizeStats(stats: StatsResponse): StatsResponse {
  return {
    days: stats.days ?? 0,
    from: stats.from ?? "",
    to: stats.to ?? "",
    totals: normalizeBucket(stats.totals),
    agents: (stats.agents ?? []).map(normalizeBucket),
    byDay: (stats.byDay ?? []).map(normalizeDay),
  };
}

function normalizeDay(day: StatsDay): StatsDay {
  return {
    ...normalizeBucket(day),
    day: day.day ?? "",
    agents: (day.agents ?? []).map(normalizeBucket),
  };
}

function normalizeBucket(bucket: Partial<StatsBucket>): StatsBucket {
  return {
    agentId: bucket.agentId ?? null,
    name: bucket.name ?? null,
    spentUsd: bucket.spentUsd ?? 0,
    allowed: bucket.allowed ?? 0,
    denied: bucket.denied ?? 0,
    deniedByReason: bucket.deniedByReason ?? {},
    observedByReason: bucket.observedByReason ?? {},
    promptTokens: bucket.promptTokens ?? 0,
    completionTokens: bucket.completionTokens ?? 0,
  };
}

const REASON_LABELS: Record<string, string> = {
  invalid_key: "invalid key",
  model_not_allowed: "model not allowed",
  tool_not_allowed: "tool not allowed",
  budget_exceeded: "budget exceeded",
  agent_disabled: "agent disabled",
  approval_required: "approval required",
  upstream_error: "upstream error",
  upstream_unreachable: "upstream unreachable",
};

/** Human-readable label for a ledger denial reason; unknown reasons are kept as they are. */
function describeReason(reason: string): string {
  if (reason.startsWith("observed:")) {
    return `${REASON_LABELS[reason.slice(9)] ?? reason.slice(9)} (observed)`;
  }
  return REASON_LABELS[reason] ?? reason;
}

function formatUsd(value: number, decimals = 4): string {
  return `$${value.toFixed(decimals)}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tableRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function agentModels(agent: AdminAgent): string {
  return agent.allowedModels.join(", ") || "—";
}

function agentTools(agent: AdminAgent): string {
  return agent.allowedTools.join(", ") || "—";
}

function agentSpent(stats: StatsResponse, agentId: string): number {
  const entry = stats.agents.find((a) => a.agentId === agentId);
  return entry?.spentUsd ?? 0;
}

function sumByReason(counts: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [reason, count] of Object.entries(counts)) {
    result[reason] = (result[reason] ?? 0) + count;
  }
  return result;
}

function buildSummary(data: ReportData): string {
  const integrity = data.verify.valid
    ? `Ledger intact: ${plural(data.verify.checked, "entry", "entries")} verified`
    : `Ledger broken at entry ${data.verify.brokenAtSeq ?? data.verify.checked}`;

  return [
    `Period: ${plural(data.stats.days, "day")} (${data.stats.from} to ${data.stats.to})`,
    `Agents: ${data.agents.length} (${data.agents.filter((a) => a.active).length} active)`,
    `Total spend: ${formatUsd(data.stats.totals.spentUsd)}`,
    `Allowed requests: ${data.stats.totals.allowed}`,
    `Denied requests: ${data.stats.totals.denied}`,
    integrity,
  ]
    .map((line) => `- ${line}`)
    .join("\n");
}

function buildAgentTable(data: ReportData): string {
  const header = tableRow([
    "Name",
    "Active",
    "Allowed models",
    "Allowed MCP tools",
    "Daily budget",
    "Spend in period",
  ]);
  const separator = tableRow(["---", "---", "---", "---", "---", "---"]);
  const rows = data.agents.map((agent) =>
    tableRow([
      agent.name,
      agent.active ? "yes" : "no",
      agentModels(agent),
      agentTools(agent),
      formatUsd(agent.dailyBudgetUsd),
      formatUsd(agentSpent(data.stats, agent.id)),
    ])
  );
  return [header, separator, ...rows].join("\n");
}

function buildReasonTable(counts: Record<string, number>, emptyText: string): string {
  const entries = Object.entries(sumByReason(counts)).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return emptyText;
  }
  const header = tableRow(["Reason", "Count"]);
  const separator = tableRow(["---", "---"]);
  const rows = entries.map(([reason, count]) => tableRow([describeReason(reason), String(count)]));
  return [header, separator, ...rows].join("\n");
}

function buildDeniedByReason(data: ReportData): string {
  return buildReasonTable(data.stats.totals.deniedByReason, "_No denied requests in the period._");
}

function buildObservedByReason(data: ReportData): string {
  return buildReasonTable(data.stats.totals.observedByReason, "_Nothing would have been blocked in the period._");
}

function hasWildcard(items: string[]): boolean {
  return items.includes("*");
}

function buildNotes(data: ReportData): string {
  const lines: string[] = [];

  for (const agent of data.agents) {
    if (hasWildcard(agent.allowedModels) || hasWildcard(agent.allowedTools)) {
      lines.push(`Agent "${agent.name}" allows a wildcard ("*") in its models or MCP tools.`);
    }
  }

  for (const agent of data.agents) {
    if (agent.dailyBudgetUsd === 0) {
      lines.push(`Agent "${agent.name}" has no daily budget set.`);
    }
  }

  for (const day of data.stats.byDay) {
    for (const agentDay of day.agents) {
      if (!agentDay.agentId) continue;
      const agent = data.agents.find((a) => a.id === agentDay.agentId);
      if (!agent || agent.dailyBudgetUsd === 0) continue;
      if (agentDay.spentUsd > agent.dailyBudgetUsd * 0.8) {
        lines.push(
          `Agent "${agent.name}" spent ${formatUsd(agentDay.spentUsd)} on ${day.day}, more than 80% of its daily budget (${formatUsd(agent.dailyBudgetUsd)}).`
        );
      }
    }
  }

  const invalidKeyCount = data.stats.totals.deniedByReason.invalid_key ?? 0;
  if (invalidKeyCount > 0) {
    lines.push(`${plural(invalidKeyCount, "request")} denied for an invalid key (unidentified callers).`);
  }

  if (!data.verify.valid) {
    lines.push(`The ledger is broken at entry ${data.verify.brokenAtSeq ?? data.verify.checked}.`);
  }

  if (lines.length === 0) {
    return "Nothing to note for the period.";
  }
  return lines.map((line) => `- ${line}`).join("\n");
}

const ABOUT_TEXT =
  "This report is a technical summary generated from the Gardagent admin API and ledger. It is not legal advice on compliance with the EU AI Act or the GDPR.";

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

/** Generates a Markdown usage report from admin data. */
export function buildReport(data: ReportData): string {
  data = normalize(data);
  return [
    "# Gardagent usage report",
    "",
    section("Summary", buildSummary(data)),
    "",
    section("Agents", buildAgentTable(data)),
    "",
    section("Denied requests by reason", buildDeniedByReason(data)),
    "",
    section("Would have been blocked (observe mode)", buildObservedByReason(data)),
    "",
    section("Notes", buildNotes(data)),
    "",
    section("About this report", ABOUT_TEXT),
    "",
  ].join("\n");
}

export { describeReason };
export type { AdminAgent, ReportData, StatsBucket, StatsResponse };
