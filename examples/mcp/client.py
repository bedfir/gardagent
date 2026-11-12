"""Minimal JSON-RPC MCP client using the governed Streamable HTTP POST transport."""
import json
import os
import urllib.request


def rpc(method, params, request_id):
    message = {"jsonrpc": "2.0", "method": method, "params": params}
    if request_id is not None:
        message["id"] = request_id
    request = urllib.request.Request(
        "http://127.0.0.1:8080/mcp/demo",
        data=json.dumps(message).encode(),
        headers={"Authorization": "Bearer " + os.environ["GA_KEY"],
                 "Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(request, timeout=150) as response:
        if response.status == 202:
            return
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(result["error"])
    print(json.dumps(result), flush=True)


rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "gardagent-example", "version": "1.0.0"}}, 1)
rpc("notifications/initialized", {}, None)
rpc("tools/list", {}, 2)
rpc("tools/call", {"name": "read_note", "arguments": {}}, 3)
print("Waiting for an administrator to approve write_note (120 seconds).", flush=True)
rpc("tools/call", {"name": "write_note", "arguments": {"text": "Approved local note."}}, 4)
rpc("tools/call", {"name": "read_note", "arguments": {}}, 5)
