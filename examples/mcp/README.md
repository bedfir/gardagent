# MCP read and approved write

Complete the root README local quickstart. The Compose fixture exposes two tools;
`GARDAGENT_MCP_SERVERS` classifies only `read_note` as read. The gateway requires
approval for `write_note` even though the agent has permission for `demo/*`.
The write changes fixture memory only; restart clears it. No upstream account is used.

From the repository root, in the quickstart shell:

```bash
python3 examples/mcp/client.py
```

This minimal standard-library MCP client initializes, lists tools, reads the note,
and waits for approval before writing. While it waits, open the console at
<http://127.0.0.1:8080/console/> in a browser, log in with the bootstrap token, and
approve the pending `demo/write_note` request on the Approvals page within 120 seconds.
Check the agent, tool and arguments before approving. The pending client then prints
the updated note. Rejection or expiration produces an error and does not write.

Alternatively, in another terminal with the bootstrap token available:

```bash
curl --fail-with-body -sS 'http://127.0.0.1:8080/admin/approvals?status=pending' \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN"
# Replace APPROVAL_ID with the id of this client's write_note request.
curl --fail-with-body -sS -X POST http://127.0.0.1:8080/admin/approvals/APPROVAL_ID/approve \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{}'
```

Read `/admin/ledger` and verify `/admin/ledger/verify` as in the quickstart. Read and
write calls, approval correlation and the operator decision appear in the ledger.
The bootstrap token proves token possession, not the identity of a human.
