import { EventEmitter } from "node:events";
import type { Approval, Store } from "@gardagent/core";

export const REQUESTED = "mcp.approval.requested";
export const DECIDED = "mcp.approval.decided";

/**
 * Wait for a human decision: immediate in-memory wake-up when the decision arrives on this instance,
 * fallback store polling when it arrives from another instance.
 */
export class ApprovalHub {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly store: Store,
    private readonly pollMs = 2000,
  ) {
    this.emitter.setMaxListeners(0);
  }

  /** Call after writing a decision into the store. */
  notify(id: string): void {
    this.emitter.emit(id);
  }

  /**
   * Waits until the request is no longer pending. On timeout (or if `signal` is aborted), the request is
   * marked "expired"; if a decision preceded it, that decision is returned.
   */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Approval> {
    return new Promise<Approval>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        this.emitter.off(id, check);
        signal?.removeEventListener("abort", expire);
      };
      const finish = (a: Approval) => {
        if (settled) return;
        cleanup();
        resolve(a);
      };
      const check = async () => {
        try {
          const a = await this.store.getApproval(id);
          if (a && a.status !== "pending") finish(a);
        } catch {
          // read failed: next poll retries
        }
      };
      const expire = async () => {
        if (settled) return;
        try {
          const a =
            (await this.store.decideApproval(id, "expired", null, new Date().toISOString())) ?? (await this.store.getApproval(id));
          if (a) finish(a);
          else if (!settled) {
            cleanup();
            reject(new Error("Approval request not found."));
          }
        } catch (error) {
          if (!settled) {
            cleanup();
            reject(error);
          }
        }
      };
      const timer = setTimeout(expire, timeoutMs);
      const poll = setInterval(check, this.pollMs);
      this.emitter.on(id, check);
      if (signal?.aborted) void expire();
      else signal?.addEventListener("abort", expire, { once: true });
    });
  }
}
