import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@gardagent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "./helpers.js";

describe("console: static file serving", () => {
  let dir: string;

  beforeEach(() => {
    vi.stubEnv("GARDAGENT_CONSOLE_DIR", "");
    dir = mkdtempSync(join(tmpdir(), "gardagent-console-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Console factice</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log('ok');");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves index.html on /console/ and resources under /console/assets/", async () => {
    const app = buildApp({ config, store: new MemoryStore(), consoleDir: dir });
    const index = await app.inject({ method: "GET", url: "/console/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("Console factice");

    const asset = await app.inject({ method: "GET", url: "/console/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");
    await app.close();
  });

  it("redirects /console to /console/", async () => {
    const app = buildApp({ config, store: new MemoryStore(), consoleDir: dir });
    const res = await app.inject({ method: "GET", url: "/console" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/console/");
    await app.close();
  });

  it("redirects / to /console/ with no body", async () => {
    const app = buildApp({ config, store: new MemoryStore(), consoleDir: dir });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/console/");
    expect(res.body).toBe("");
    await app.close();
  });

  it("returns 404 on /console when the option is absent", async () => {
    const app = buildApp({ config, store: new MemoryStore() });
    expect((await app.inject({ method: "GET", url: "/console" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/console/" })).statusCode).toBe(404);
    await app.close();
  });

  it("serves nothing if the directory does not exist", async () => {
    const app = buildApp({ config, store: new MemoryStore(), consoleDir: join(dir, "absent") });
    expect((await app.inject({ method: "GET", url: "/console/" })).statusCode).toBe(404);
    await app.close();
  });

  it("does not alter /health or /admin routes", async () => {
    const app = buildApp({ config, store: new MemoryStore(), consoleDir: dir });
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok", mode: config.mode });
    expect((await app.inject({ method: "GET", url: "/admin/agents" })).statusCode).toBe(401);
    await app.close();
  });
});
