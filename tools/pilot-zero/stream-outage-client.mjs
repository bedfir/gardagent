// Client for stream-outage-latency.sh. Starts 4 streams (2 OpenAI, 2 Anthropic) and then sends one small plain request
// every 400 ms. The shell script cuts PostgreSQL ~1.5 s after the START line. Prints per-request timings, then the
// "added delay" of each stream: client end minus the stub's last write. Needs K (agent key), STUB (stub ip:port).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = process.env.K;
const gw = "http://gateway:8080";
const t0 = Date.now();
const rel = () => String(Date.now() - t0).padStart(5);
const done = {};

async function call(kind, tag, stream) {
  const started = Date.now();
  const anthropic = kind === "anthropic";
  const url = gw + (anthropic ? "/v1/messages" : "/v1/chat/completions");
  const headers = { "content-type": "application/json", ...(anthropic ? { "x-api-key": key } : { authorization: "Bearer " + key }) };
  const body = { model: "m", stream, max_tokens: 8, messages: [{ role: "user", content: `tag-${tag} ${Date.now()}` }] };
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    let first = null;
    let text = "";
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      if (first === null) first = Date.now() - started;
      text += dec.decode(value, { stream: true });
    }
    const finished = Date.now();
    done[tag] = finished;
    const complete = stream ? (anthropic ? text.includes("message_stop") : text.includes("[DONE]")) : text.includes("hello");
    console.log(`t+${rel()}ms ${kind.padEnd(9)} ${stream ? "stream" : "plain "} ${tag.padEnd(7)} status ${r.status} complete ${complete} ttfb ${first}ms total ${finished - started}ms`);
  } catch (e) {
    done[tag] = Date.now();
    console.log(`t+${rel()}ms ${kind.padEnd(9)} ${stream ? "stream" : "plain "} ${tag.padEnd(7)} ERROR ${e.message} after ${Date.now() - started}ms`);
  }
}

console.log("START");
const jobs = [call("openai", "so1", true), call("anthropic", "sa1", true), call("openai", "so2", true), call("anthropic", "sa2", true)];
await sleep(500);
for (let i = 0; i < Number(process.env.PROBES ?? 22); i++) {
  jobs.push(call(i % 2 ? "anthropic" : "openai", `p${i}`, false));
  await sleep(400);
}
await Promise.all(jobs);
await sleep(300);
const ends = await (await fetch(`http://${process.env.STUB}/`)).json();
for (const tag of ["so1", "sa1", "so2", "sa2"]) {
  console.log(`ADDED ${tag} stub_end->client_end ${ends[tag] && done[tag] ? done[tag] - ends[tag] : "n/a"}ms`);
}
console.log("CLIENT_DONE");
