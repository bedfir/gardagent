import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@gardagent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { adminHeaders, config } from "./helpers.js";

const consoleCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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

  it.each(["/console/", "/console/assets/app.js", "/console/assets/app.js?v=1", "/console", "/%63onsole", "/console/%61ssets/app.js"])(
    "sets console security headers on %s",
    async (url) => {
      const app = buildApp({ config, store: new MemoryStore(), consoleDir: dir });
      try {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(url === "/console" || url === "/%63onsole" ? 302 : 200);
        expect(res.headers["content-security-policy"]).toBe(consoleCsp);
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
        expect(res.headers["x-frame-options"]).toBe("DENY");
      } finally {
        await app.close();
      }
    },
  );

  it("does not apply console CSP to JSON API responses or similar prefixes", async () => {
    const app = buildApp({ config, store: new MemoryStore(), consoleDir: dir });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      const admin = await app.inject({ method: "GET", url: "/admin/agents", headers: adminHeaders });
      const unauthorizedAdmin = await app.inject({ method: "GET", url: "/admin/agents" });
      const model = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: {} });
      for (const res of [health, admin, unauthorizedAdmin, model]) {
        expect(res.headers["content-security-policy"]).toBeUndefined();
        expect(res.headers["content-type"]).toContain("application/json");
      }
      expect(health.statusCode).toBe(200);
      expect(admin.statusCode).toBe(200);
      expect(unauthorizedAdmin.statusCode).toBe(401);
      expect(model.statusCode).toBe(401);
      const other = await app.inject({ method: "GET", url: "/console-other" });
      expect(other.statusCode).toBe(404);
      expect(other.headers["content-security-policy"]).toBeUndefined();
    } finally {
      await app.close();
    }
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
