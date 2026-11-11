import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "./hash.js";

const PREFIX = "ga_";

/** Generates an agent key. It is shown only once, at creation time. */
export function generateAgentKey(): string {
  return PREFIX + randomBytes(24).toString("base64url");
}

export function hashAgentKey(key: string): string {
  return sha256(key);
}

export function looksLikeAgentKey(value: string): boolean {
  return value.startsWith(PREFIX) && value.length > PREFIX.length + 16;
}

/** Constant-time comparison, for the admin token. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
