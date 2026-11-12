import type { Agent } from "@gardagent/core";

/** Process-local rolling window. Acquisition has no await, so boundary admissions are serialized. */
export class AgentRateLimiter {
  private states = new Map<string, { starts: number[]; active: number }>();
  constructor(private now: () => number = Date.now) {}

  acquire(agent: Agent, observe = false): { retryAfter?: number; release: () => void } {
    const now = this.now();
    // Reclaim idle agents without resetting any live window or active call.
    for (const [id, state] of this.states) {
      if (!state.active && (!state.starts.length || state.starts[state.starts.length - 1]! <= now - 60_000)) this.states.delete(id);
    }
    const state = this.states.get(agent.id) ?? { starts: [], active: 0 };
    state.starts = state.starts.filter(start => start > now - 60_000);
    this.states.set(agent.id, state);
    let retryAfter: number | undefined;
    if (agent.requestsPerMinute && state.starts.length >= agent.requestsPerMinute) {
      retryAfter = Math.max(1, Math.ceil((state.starts[state.starts.length - agent.requestsPerMinute]! + 60_000 - now) / 1000));
    }
    if (agent.maxConcurrentRequests && state.active >= agent.maxConcurrentRequests) retryAfter = Math.max(retryAfter ?? 0, 1);
    if (retryAfter && !observe) return { retryAfter, release() {} };
    state.starts.push(now);
    state.active++;
    let released = false;
    return { retryAfter, release() { if (!released) { released = true; state.active--; } } };
  }
}
