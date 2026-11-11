import { describe, expect, it } from "vitest";
import { adminExposureWarning, loadConfig, parseAuthFailLimit, parseAuthFailWindowMs, parseTrustProxy } from "../src/config.js";

const base = { UPSTREAM_BASE_URL: "http://u.test", UPSTREAM_API_KEY: "k" };
const LONG_TOKEN = "a".repeat(32);

describe("admin token strength (E3a)", () => {
  it("refuses a token shorter than 32 characters without echoing it", () => {
    const short = "short-secret-value";
    let message = "";
    try {
      loadConfig({ ...base, GARDAGENT_ADMIN_TOKEN: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/GARDAGENT_ADMIN_TOKEN/);
    expect(message).toMatch(/32/);
    expect(message).not.toContain(short);
  });

  it("accepts 32 characters, and the 64 characters produced by openssl rand -hex 32", () => {
    expect(loadConfig({ ...base, GARDAGENT_ADMIN_TOKEN: LONG_TOKEN }).adminToken).toBe(LONG_TOKEN);
    expect(loadConfig({ ...base, GARDAGENT_ADMIN_TOKEN: "f".repeat(64) }).adminToken).toHaveLength(64);
  });

  it("refuses a 31-character token", () => {
    expect(() => loadConfig({ ...base, GARDAGENT_ADMIN_TOKEN: "a".repeat(31) })).toThrow(/at least 32/);
  });
});

describe("authentication failure limiter settings (E3b)", () => {
  it("has defaults and accepts 0 to disable", () => {
    const c = loadConfig({ ...base, GARDAGENT_ADMIN_TOKEN: LONG_TOKEN });
    expect(c.authFailLimit).toBe(10);
    expect(c.authFailWindowMs).toBe(60_000);
    expect(parseAuthFailLimit("0")).toBe(0);
    expect(parseAuthFailLimit("25")).toBe(25);
    expect(parseAuthFailWindowMs("5000")).toBe(5000);
  });

  it("rejects invalid values with the variable name", () => {
    expect(() => parseAuthFailLimit("-1")).toThrow(/GARDAGENT_AUTH_FAIL_LIMIT/);
    expect(() => parseAuthFailLimit("abc")).toThrow(/GARDAGENT_AUTH_FAIL_LIMIT/);
    expect(() => parseAuthFailWindowMs("10")).toThrow(/GARDAGENT_AUTH_FAIL_WINDOW_MS/);
  });

  it("parses GARDAGENT_TRUST_PROXY: off by default, true, or an address list", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(() => parseTrustProxy("1")).toThrow(/GARDAGENT_TRUST_PROXY/);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("172.16.0.0/12, 10.0.0.1")).toEqual(["172.16.0.0/12", "10.0.0.1"]);
  });
});

describe("admin exposure warning (E2)", () => {
  it("warns when listening on all interfaces without GARDAGENT_ADMIN_ALLOWED_CIDRS", () => {
    const w = adminExposureWarning("0.0.0.0", {});
    expect(w).toMatch(/0\.0\.0\.0/);
    expect(w).toMatch(/GARDAGENT_ADMIN_ALLOWED_CIDRS/);
  });

  it("is silent on loopback, or when the allow-list is configured", () => {
    expect(adminExposureWarning("127.0.0.1", {})).toBeNull();
    expect(adminExposureWarning("::1", {})).toBeNull();
    expect(adminExposureWarning("localhost", {})).toBeNull();
    expect(adminExposureWarning("0.0.0.0", { GARDAGENT_ADMIN_ALLOWED_CIDRS: "10.0.0.0/8" })).toBeNull();
  });
});
