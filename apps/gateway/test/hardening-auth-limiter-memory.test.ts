import { describe, expect, it } from "vitest";
import { AuthFailureLimiter } from "../src/auth-limiter.js";

// The admin limiter is never drained: it must not accumulate per-window counts.
describe("auth limiter without aggregated rows keeps bounded memory", () => {
  it("retains nothing after many ended windows and evictions, and still blocks", () => {
    let now = 0;
    const limiter = new AuthFailureLimiter({ limit: 3, windowMs: 1000, now: () => now, maxEntries: 5, trackSuppressed: false });
    for (let i = 0; i < 200; i++) {
      limiter.recordFailure(`10.0.0.${i % 50}`); // more addresses than maxEntries: evictions
      limiter.recordFailure("10.9.9.9");
      now += 1001; // every window ends
    }
    expect((limiter as unknown as { expired: number[] }).expired.length).toBe(0);
    for (let i = 0; i < 3; i++) limiter.recordFailure("1.1.1.1");
    expect(limiter.retryAfterSeconds("1.1.1.1")).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds("2.2.2.2")).toBe(0);
  });
});
