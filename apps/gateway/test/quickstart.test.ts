import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setup, jsonResponse, adminHeaders } from "./helpers.js";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const documents = ["README.md", "README.fr.md", ...["openai", "anthropic", "mcp"].map((name) => `examples/${name}/README.md`)];
const sourceFiles = readdirSync(new URL("apps/gateway/src/", root)).filter((name) => name.endsWith(".ts"));
const source = sourceFiles.map((name) => read(`apps/gateway/src/${name}`)).join("\n");
// Extract registrations, not arbitrary strings in comments or tests.
const routes = [...source.matchAll(/\.(?:get|post|patch|delete|put)\("([^"\n]+)"/g)].map((m) => m[1]!);
const variables = new Set([
  ...[...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!),
  ...[...source.matchAll(/required\(env, "([A-Z][A-Z0-9_]*)"\)/g)].map((m) => m[1]!),
  ...[...read("deploy/Caddyfile").matchAll(/\{\$([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!),
]);

function routeExists(path: string): boolean {
  path = path.replace(/\/$/, "");
  // Namespace references such as /admin/* and SDK base URLs are documented too.
  if (["/admin", "/admin/*", "/v1", "/mcp", "/mcp/*"].includes(path)) {
    const prefix = path.replace(/\/\*$/, "") + "/";
    return routes.some((route) => route.startsWith(prefix));
  }
  return routes.some((route) => {
    const parts = route.replace(/\/$/, "").split("/");
    const actual = path.split("/");
    return parts.length === actual.length && parts.every((part, i) => part.startsWith(":") ? Boolean(actual[i]) : part === actual[i]);
  });
}

function documentedRoutes(text: string): string[] {
  return [...text.replaceAll("<server>", "demo").matchAll(/(?:https?:\/\/127\.0\.0\.1:8080|(?<![\w./-]))(\/(?:admin|v1|mcp|health|console)(?:\/[A-Za-z0-9_.:*-]+)*\/?)/g)]
    .map((m) => m[1]!);
}

const namedVariables = (text: string) => [...text.matchAll(/\b(?:GARDAGENT_[A-Z_]+|UPSTREAM_[A-Z_]+|ANTHROPIC_UPSTREAM_[A-Z_]+|DATABASE_URL)\b/g)].map((m) => m[0]);

describe("local quickstart and example drift", () => {
  it.each(documents)("%s names implemented routes and configuration variables", (path) => {
    const text = read(path);
    const paths = documentedRoutes(text);
    expect(paths.length).toBeGreaterThan(0);
    for (const route of paths) expect(routeExists(route), `${path}: ${route}`).toBe(true);
    for (const variable of namedVariables(text)) expect(variables.has(variable), `${path}: ${variable}`).toBe(true);
  });

  it("rejects invented routes and configuration names", () => {
    expect(routeExists(documentedRoutes("curl http://127.0.0.1:8080/admin/not-a-route")[0]!)).toBe(false);
    expect(variables.has(namedVariables("export GARDAGENT_NOT_A_SETTING=x")[0]!)).toBe(false);
  });

  it("example commands name existing scripts and isolate SDK installations", () => {
    for (const name of ["openai", "anthropic", "mcp"]) {
      const doc = read(`examples/${name}/README.md`);
      const scripts = [...doc.matchAll(/(?:python3|\/python) (examples\/[\w/.-]+\.py)/g)];
      expect(scripts).toHaveLength(1);
      expect(read(scripts[0]![1]!)).toContain('os.environ["GA_KEY"]');
      if (name !== "mcp") expect(doc).toMatch(new RegExp(`pip install ${name}==[0-9.]+`));
    }
    expect(read("examples/openai/main.py")).toContain('base_url="http://127.0.0.1:8080/v1"');
    expect(read("examples/anthropic/main.py")).toContain('base_url="http://127.0.0.1:8080"');
    expect(read("examples/mcp/client.py")).toContain('http://127.0.0.1:8080/mcp/demo');
  });

  it("local profile keeps authentication, enforcement and read classification explicit", () => {
    const compose = read("docker-compose.local.yml");
    for (const variable of namedVariables(compose)) expect(variables.has(variable), variable).toBe(true);
    expect(compose).toContain("GARDAGENT_ADMIN_TOKEN: ${GARDAGENT_ADMIN_TOKEN:?");
    expect(compose).toContain("GARDAGENT_MODE: enforce");
    expect(compose).toContain("127.0.0.1:8080:8080");
    expect(compose).toContain('"readTools":["read_note"]');
    expect(compose).toContain("condition: service_completed_successfully");
    const model = read("examples/openai/main.py").match(/model="([^"]+)"/)![1]!;
    expect(compose).toContain(`pull, ${model}`);
    expect(compose).toContain(`"${model}":{"input":0,"output":0}`);
  });

  it.each(["README.md", "README.fr.md"])("%s request bodies work with real admission and ledger routes", async (path) => {
    const bodies = [...read(path).matchAll(/-d '(\{[^\n]+\})'/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
    const agentBody = bodies.find((body) => body.allowedModels);
    const callBody = bodies.find((body) => body.messages);
    expect(agentBody).toBeDefined();
    expect(callBody).toBeDefined();
    const { app, calls } = setup(() => jsonResponse({
      id: "local-test", choices: [{ message: { role: "assistant", content: "Hello" } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }));
    try {
      expect((await app.inject({ method: "POST", url: "/admin/agents", payload: agentBody })).statusCode).toBe(401);
      const created = await app.inject({ method: "POST", url: "/admin/agents", headers: adminHeaders, payload: agentBody });
      expect(created.statusCode).toBe(201);
      const key = created.json().key as string;
      const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: callBody });
      expect(response.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      const ledger = await app.inject({ method: "GET", url: "/admin/ledger?order=desc&limit=5", headers: adminHeaders });
      expect(ledger.statusCode).toBe(200);
      expect(ledger.body).toContain(String(callBody!.model));
      const verified = await app.inject({ method: "GET", url: "/admin/ledger/verify", headers: adminHeaders });
      expect(verified.json()).toMatchObject({ valid: true });
    } finally {
      await app.close();
    }
  });
});
