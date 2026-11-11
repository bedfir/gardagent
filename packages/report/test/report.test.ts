import { describe, expect, it } from "vitest";
import {
  buildReport,
  describeReason,
  type AdminAgent,
  type ReportData,
} from "../src/report.js";

function baseData(over: Partial<ReportData> = {}): ReportData {
  return {
    agents: [
      {
        id: "a1",
        name: "alpha",
        allowedModels: ["gpt-4o-mini"],
        allowedTools: ["gh/search"],
        dailyBudgetUsd: 10,
        spentTodayUsd: 1,
        active: true,
      },
    ],
    stats: {
      days: 7,
      from: "2026-10-14",
      to: "2026-10-20",
      totals: {
        spentUsd: 12.5,
        allowed: 100,
        denied: 5,
        deniedByReason: {},
        observedByReason: {},
        promptTokens: 1000,
        completionTokens: 500,
      },
      agents: [
        {
          agentId: "a1",
          name: "alpha",
          spentUsd: 12.5,
          allowed: 100,
          denied: 5,
          deniedByReason: {},
          observedByReason: {},
          promptTokens: 1000,
          completionTokens: 500,
        },
      ],
      byDay: [
        {
          day: "2026-10-20",
          spentUsd: 1,
          allowed: 100,
          denied: 5,
          deniedByReason: {},
          observedByReason: {},
          promptTokens: 1000,
          completionTokens: 500,
          agents: [
            {
              agentId: "a1",
              name: "alpha",
              spentUsd: 1,
              allowed: 100,
              denied: 5,
              deniedByReason: {},
              observedByReason: {},
              promptTokens: 1000,
              completionTokens: 500,
            },
          ],
        },
      ],
    },
    verify: { valid: true, checked: 1234 },
    ...over,
  };
}

describe("buildReport", () => {
  it("produces a correct summary", () => {
    const report = buildReport(baseData());
    expect(report).toContain("## Summary");
    expect(report).toContain("- Period: 7 days (2026-10-14 to 2026-10-20)");
    expect(report).toContain("- Agents: 1 (1 active)");
    expect(report).toContain("- Total spend: $12.5000");
    expect(report).toContain("- Allowed requests: 100");
    expect(report).toContain("- Denied requests: 5");
    expect(report).toContain("- Ledger intact: 1234 entries verified");
  });

  it("escapes vertical bars in table cells", () => {
    const data = baseData({
      agents: [
        {
          id: "a1",
          name: "agent | test",
          allowedModels: ["model|x"],
          allowedTools: ["srv|tool"],
          dailyBudgetUsd: 1,
          spentTodayUsd: 0,
          active: true,
        },
      ],
    });
    const report = buildReport(data);
    expect(report).toContain("agent \\| test");
    expect(report).toContain("model\\|x");
    expect(report).toContain("srv\\|tool");
  });

  it("labels denial reasons in English", () => {
    const data = baseData({
      stats: {
        ...baseData().stats,
        totals: {
          ...baseData().stats.totals,
          deniedByReason: {
            invalid_key: 2,
            model_not_allowed: 3,
            tool_not_allowed: 1,
            budget_exceeded: 4,
            agent_disabled: 1,
            upstream_error: 2,
            upstream_unreachable: 1,
            custom_reason: 5,
          },
        },
      },
    });
    const report = buildReport(data);
    expect(report).toContain("| invalid key | 2 |");
    expect(report).toContain("| model not allowed | 3 |");
    expect(report).toContain("| tool not allowed | 1 |");
    expect(report).toContain("| budget exceeded | 4 |");
    expect(report).toContain("| agent disabled | 1 |");
    expect(report).toContain("| upstream error | 2 |");
    expect(report).toContain("| upstream unreachable | 1 |");
    expect(report).toContain("| custom_reason | 5 |");
  });

  it("lists observed reasons in a dedicated section", () => {
    const data = baseData({
      stats: {
        ...baseData().stats,
        totals: {
          ...baseData().stats.totals,
          observedByReason: {
            "observed:model_not_allowed": 3,
            "observed:budget_exceeded": 1,
            "observed:approval_required": 2,
          },
        },
      },
    });
    const report = buildReport(data);
    expect(report).toContain("## Would have been blocked (observe mode)");
    expect(report.indexOf("## Would have been blocked (observe mode)")).toBeGreaterThan(report.indexOf("## Denied requests by reason"));
    expect(report).toContain("| model not allowed (observed) | 3 |");
    expect(report).toContain("| budget exceeded (observed) | 1 |");
    expect(report).toContain("| approval required (observed) | 2 |");
  });

  it("flags an agent with a wildcard in models", () => {
    const data = baseData({
      agents: [{ ...baseData().agents[0]!, allowedModels: ["*"] }],
    });
    const report = buildReport(data);
    expect(report).toContain("## Notes");
    expect(report).toContain('Agent "alpha" allows a wildcard ("*") in its models or MCP tools.');
  });

  it("flags an agent with a wildcard in tools", () => {
    const data = baseData({
      agents: [{ ...baseData().agents[0]!, allowedTools: ["*"] }],
    });
    const report = buildReport(data);
    expect(report).toContain('Agent "alpha" allows a wildcard ("*") in its models or MCP tools.');
  });

  it("flags an agent without a budget", () => {
    const data = baseData({
      agents: [{ ...baseData().agents[0]!, dailyBudgetUsd: 0 }],
    });
    const report = buildReport(data);
    expect(report).toContain('Agent "alpha" has no daily budget set.');
  });

  it("flags an agent that spent more than 80% of its budget on a given day", () => {
    const data = baseData({
      agents: [{ ...baseData().agents[0]!, dailyBudgetUsd: 10 }],
      stats: {
        ...baseData().stats,
        byDay: [
          {
            day: "2026-10-20",
            spentUsd: 8.1,
            allowed: 10,
            denied: 0,
            deniedByReason: {},
            observedByReason: {},
            promptTokens: 100,
            completionTokens: 50,
            agents: [
              {
                agentId: "a1",
                name: "alpha",
                spentUsd: 8.1,
                allowed: 10,
                denied: 0,
                deniedByReason: {},
                observedByReason: {},
                promptTokens: 100,
                completionTokens: 50,
              },
            ],
          },
        ],
      },
    });
    const report = buildReport(data);
    expect(report).toContain('Agent "alpha" spent $8.1000 on 2026-10-20');
    expect(report).toContain("more than 80% of its daily budget ($10.0000)");
  });

  it("flags invalid-key denials", () => {
    const data = baseData({
      stats: {
        ...baseData().stats,
        totals: {
          ...baseData().stats.totals,
          deniedByReason: { invalid_key: 3 },
        },
      },
    });
    const report = buildReport(data);
    expect(report).toContain("3 requests denied for an invalid key");
    expect(report).toContain("(unidentified callers)");
  });

  it("flags a tampered ledger", () => {
    const data = baseData({
      verify: { valid: false, checked: 100, brokenAtSeq: 42 },
    });
    const report = buildReport(data);
    expect(report).toContain("Ledger broken at entry 42");
    expect(report).toContain("The ledger is broken at entry 42.");
  });

  it("states there are no attention points when none apply", () => {
    const data = baseData();
    const report = buildReport(data);
    expect(report).toContain("Nothing to note for the period.");
  });

  it("never includes the admin token in the output", () => {
    const secret = "super-secret-token-12345";
    process.env.GARDAGENT_ADMIN_TOKEN = secret;
    const report = buildReport(baseData());
    expect(report).not.toContain(secret);
    delete process.env.GARDAGENT_ADMIN_TOKEN;
  });

  it("tolerates an agent without allowedTools, approvalTools or spentTodayUsd", () => {
    const data = baseData({
      agents: [
        {
          id: "a2",
          name: "beta",
          allowedModels: [],
          dailyBudgetUsd: 5,
          active: false,
        } as AdminAgent,
      ],
    });
    const report = buildReport(data);
    expect(report).toContain("beta");
    expect(report).toContain("Allowed MCP tools");
    expect(report).toContain("| — |");
    expect(report).not.toContain("undefined");
  });

  it("tolerates statistics without deniedByReason", () => {
    const data = baseData({
      stats: {
        ...baseData().stats,
        totals: {
          spentUsd: 0,
          allowed: 0,
          denied: 0,
          promptTokens: 0,
          completionTokens: 0,
        } as ReportData["stats"]["totals"],
        byDay: [],
      },
    });
    const report = buildReport(data);
    expect(report).toContain("## Denied requests by reason");
    expect(report).toContain("_No denied requests in the period._");
    expect(report).not.toContain("undefined");
  });

  it("tolerates an empty agent list", () => {
    const data = baseData({ agents: [] });
    const report = buildReport(data);
    expect(report).toContain("- Agents: 0 (0 active)");
    expect(report).toContain("## Agents");
    expect(report).not.toContain("undefined");
  });
});

describe("report wording", () => {
  it("uses a neutral English title and section order", () => {
    const report = buildReport(baseData());
    expect(report.startsWith("# Gardagent usage report\n")).toBe(true);
    const titles = report.split("\n").filter((l) => l.startsWith("## "));
    expect(titles).toEqual([
      "## Summary",
      "## Agents",
      "## Denied requests by reason",
      "## Would have been blocked (observe mode)",
      "## Notes",
      "## About this report",
    ]);
  });

  it("states the non-legal scope in the closing section", () => {
    const report = buildReport(baseData());
    expect(report).toContain("It is not legal advice on compliance with the EU AI Act or the GDPR.");
  });

  it("uses singular forms for one day, one entry and one request", () => {
    const data = baseData({
      verify: { valid: true, checked: 1 },
      stats: {
        ...baseData().stats,
        days: 1,
        totals: { ...baseData().stats.totals, deniedByReason: { invalid_key: 1 } },
      },
    });
    const report = buildReport(data);
    expect(report).toContain("- Period: 1 day (");
    expect(report).toContain("- Ledger intact: 1 entry verified");
    expect(report).toContain("1 request denied for an invalid key");
  });

  it("has no French, diagnostic or commercial wording", () => {
    const data = baseData({
      agents: [{ ...baseData().agents[0]!, allowedModels: ["*"], dailyBudgetUsd: 0 }],
      verify: { valid: false, checked: 3, brokenAtSeq: 2 },
      stats: {
        ...baseData().stats,
        totals: {
          ...baseData().stats.totals,
          deniedByReason: { invalid_key: 1, budget_exceeded: 1 },
          observedByReason: { "observed:model_not_allowed": 1 },
        },
      },
    });
    const report = buildReport(data);
    expect(report).not.toMatch(/diagnos|audit|client|recommend|[éèàêôç]/i);
  });
});

describe("describeReason", () => {
  it("labels known reasons", () => {
    expect(describeReason("invalid_key")).toBe("invalid key");
    expect(describeReason("budget_exceeded")).toBe("budget exceeded");
  });

  it("labels observed reasons", () => {
    expect(describeReason("observed:approval_required")).toBe("approval required (observed)");
    expect(describeReason("observed:custom")).toBe("custom (observed)");
  });

  it("keeps unknown reasons", () => {
    expect(describeReason("other")).toBe("other");
  });
});
