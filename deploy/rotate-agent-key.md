# Rotating an agent key

Rotation keeps the agent: same id, name, limits and history. The new key is shown once; the old one stops working immediately.

Run from the repository root. Replace `GATEWAY` with the Gardagent address (for example
`https://gardagent.example.com`, add `-k` only for a `tls internal` test before installing the CA).
Your machine must be inside `GARDAGENT_ADMIN_ALLOWED_CIDRS`.

```sh
ADMIN_TOKEN=$(sed -n 's/^GARDAGENT_ADMIN_TOKEN=//p' deploy/.env | head -n 1)
```

1. Find the agent and its `id`:

```sh
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" GATEWAY/admin/agents
```

2. Rotate the key (this is the point of no return for the old key). The response contains the new `ga_...` key once only: store it in the password vault right away; do not paste it in tickets or chat.

```sh
curl -s -X POST GATEWAY/admin/agents/AGENT_ID/rotate-key -H "Authorization: Bearer $ADMIN_TOKEN"
```

   The console does the same from the Agents page (“Renouveler la clé”, with a confirmation).

3. Put the new key in the tool (API key setting only; the base URL is unchanged) and run one test request. Check in `/console/` that the same agent shows the call.

4. Confirm that a request with the old key now fails (401).

5. Remove the old key from the vault and record the rotation date. The ledger has an `admin.agent.rotate-key` row for the agent (it contains no key).

Rotation also works on a disabled agent; it stays disabled.

## Fallback: replace the agent

Only if the rotate route is unavailable (an older gateway). Create a new agent, switch the tool, then disable the old one; the history is then split between the two agents.

Run from the repository root with the same `ADMIN_TOKEN`.


1. Find the old agent and note its settings (name, `allowedModels`, `allowedTools`, `approvalTools`, `dailyBudgetUsd`) and its `id`:

```sh
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" GATEWAY/admin/agents
```

2. Create the replacement agent with the same limits and a versioned name (add `allowedTools` / `approvalTools` if the old agent had them):

```sh
curl -s -X POST GATEWAY/admin/agents \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"agent-support-2","allowedModels":["deepseek-v4.1-flash"],"dailyBudgetUsd":2}'
```

   The response contains the new `ga_...` key once only. Store it in the password vault; do not paste it in tickets or chat.

3. Put the new key in the tool (API key setting only; the base URL is unchanged) and run one test request. Check in `/console/` that the new agent shows the call.

4. Disable the old agent (use the `id` from step 1):

```sh
curl -s -X PATCH GATEWAY/admin/agents/OLD_AGENT_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"active":false}'
```

   Confirm that a request with the old key now fails (401/403).

5. Remove the old key from the vault and record the rotation date.

Note: per-agent rate limiting is not available at the edge; it will come in the application later.
