import { canonicalJson, sha256 } from "./hash.js";
import type { Agent } from "./types.js";

/** Immutable content address of the admission limits; credentials and display names are excluded. */
export function policyRevision(agent: Agent): { id: string; canonical: string } {
  const list = (values: string[]) => [...new Set(values)].sort();
  const canonical = canonicalJson({ v: 1, allowedModels: list(agent.allowedModels),
    allowedTools: list(agent.allowedTools), approvalTools: list(agent.approvalTools),
    dailyBudget: agent.dailyBudget, active: agent.active });
  return { id: sha256(canonical), canonical };
}
