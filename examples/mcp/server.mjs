// Local, stateless-transport demonstration only. The note lives in memory.
import { createServer } from "node:http";
let note = "Hello from the read tool.";
const tools = [
  { name: "read_note", description: "Read the in-memory note", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "write_note", description: "Replace the in-memory note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
];
createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (req.method !== "POST") return send(405, { error: "POST required" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 65536) return send(413, { error: "Request too large" });
    }
    const body = JSON.parse(raw);
    if (req.url === "/v1/messages") return send(200, {
      id: "msg_demo", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "Hello from the synthetic Anthropic fixture." }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 8, output_tokens: 10 },
    });
    if (req.url !== "/mcp") return send(404, { error: "Unknown path" });
    if (body.id === undefined) { res.writeHead(202); return res.end(); }
    const rpc = (result) => send(200, { jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize") return rpc({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local-note", version: "1.0.0" } });
    if (body.method === "tools/list") return rpc({ tools });
    if (body.method === "tools/call") {
      if (body.params?.name === "write_note" && typeof body.params.arguments?.text === "string") {
        note = body.params.arguments.text;
      } else if (body.params?.name !== "read_note") {
        return send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Unknown tool or invalid arguments" } });
      }
      return rpc({ content: [{ type: "text", text: note }] });
    }
    return send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown method" } });
  } catch {
    send(400, { error: "Invalid request" });
  }
}).listen(8090, "0.0.0.0");
