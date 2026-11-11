// Stub provider for stream-outage-latency.sh: OpenAI and Anthropic streaming, ~4 s per stream, no real provider.
// GET /ends returns, per request tag, the epoch ms at which the stub finished its last write.
import http from "node:http";

const CHUNKS = Number(process.env.CHUNKS ?? 8);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 500);
const ends = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (event, data) => (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`;

http
  .createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ends));
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // ignore
      }
      const text = JSON.stringify(body.messages ?? "");
      const tag = (text.match(/tag-([a-z0-9]+)/) ?? [])[1] ?? "none";
      const anthropic = req.url.startsWith("/v1/messages");
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            anthropic
              ? { id: "m", type: "message", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 10, output_tokens: 2 } }
              : { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
          ),
        );
        ends[tag] = Date.now();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (anthropic) res.write(sse("message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }));
      for (let i = 0; i < CHUNKS; i++) {
        await sleep(INTERVAL_MS);
        res.write(
          anthropic
            ? sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "w" + i } })
            : sse(null, { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "w" + i } }] }),
        );
      }
      if (anthropic) {
        res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: CHUNKS } }));
        res.write(sse("message_stop", { type: "message_stop" }));
      } else {
        res.write(sse(null, { id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: CHUNKS } }));
        res.write("data: [DONE]\n\n");
      }
      ends[tag] = Date.now();
      res.end();
    });
  })
  .listen(9000);
