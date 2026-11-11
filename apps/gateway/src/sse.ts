/**
 * Splits an SSE stream into complete events (separated by an empty line),
 * without altering their bytes, so they can be relayed as-is.
 */
export class SseSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let index: number;
    while ((index = this.findBoundary()) !== -1) {
      const end = this.buffer.startsWith("\r\n\r\n", index) ? index + 4 : index + 2;
      events.push(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
    return events;
  }

  /** Unfinished remainder at the end of the stream. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }

  private findBoundary(): number {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1) return crlf;
    if (crlf === -1) return lf;
    return Math.min(lf, crlf);
  }
}

/** Extracts the JSON payload of a `data: {...}` event, or null (comment, [DONE], invalid JSON). */
export function parseSseData(event: string): Record<string, unknown> | null {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
