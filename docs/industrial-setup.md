# Industrial setup guide

This guide is for teams deploying Gardagent in factories or plants where AI agents reach ERP, MES or SCADA systems through MCP servers.

## Declare an MCP server with read and write tools

Use the `readTools` field to list tool names or glob patterns that only read data. Every tool that does **not** match is treated as a write tool.

```bash
GARDAGENT_MCP_SERVERS={
  "erp": {
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer ..." },
    "readTools": ["read_work_order", "get_*", "list_inventory"]
  }
}
```

In this example:

- `read_work_order`, any tool starting with `get_`, and `list_inventory` are READ tools.
- `update_work_order`, `create_purchase_order`, or any other tool is a WRITE tool.

## What is governed: `tools/call` only

Gardagent applies the allowed-tools list, the read/write classification, human approval and the ledger to MCP `tools/call` requests only. Any other method sent to `/mcp/<server>` (`resources/read`, `resources/list`, `prompts/get`, `prompts/list`, `initialize`, `ping`, ...) is relayed to the MCP server with no rule check and no ledger row, so an agent with a valid key can read every resource and prompt the server exposes, and those reads leave no trace in the ledger. If the data behind a resource matters, make the MCP server itself enforce access, or expose it as a tool so that it is governed and logged. Batches are rejected.

## Why writes require human approval

A tool that writes to a production system can change schedules, release orders, or update inventory. By default, Gardagent treats every MCP tool as a WRITE tool and requires a human approval before the call reaches the server. READ tools keep the existing flow: they are allowed if the agent's `allowedTools` permits them, and they only wait for approval when explicitly listed in `approvalTools`.

Configure an agent with the tools it may use:

```bash
curl -X POST http://localhost:8080/admin/agents \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "agent-planning",
    "allowedModels": ["deepseek-v4.1-flash"],
    "allowedTools": ["erp/read_work_order", "erp/update_work_order"],
    "approvalTools": ["erp/update_work_order"],
    "dailyBudgetUsd": 2
  }'
```

Because `update_work_order` is a WRITE tool, it always requires approval even if you leave `approvalTools` empty. Listing it explicitly makes the rule visible in the agent configuration.

## Evaluating with observe mode

To evaluate the rules before enforcing them, run Gardagent in `observe` mode so that WRITE tools are forwarded and logged with reason `observed:approval_required` instead of being blocked. This lets you count how many write operations would have waited for a human decision without stopping production.

```bash
GARDAGENT_MODE=observe
```

## Important safety notice

Gardagent is a governance gateway, not a functional-safety system. It must never be placed in a safety loop, an emergency-stop circuit, or any SIL-rated function. Human approval of MCP tool calls is an administrative control, not a safety instrumented function. Always keep safety-critical protections independent of the gateway.
