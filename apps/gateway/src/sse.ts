/** Splits SSE events on blank lines using LF, CRLF, or CR line endings. */
export class SseSplitter {
  private buffer = "";
  private cursor = 0;
  private lineStart = 0;
  private atStart = true;

  push(chunk: string): string[] {
    if (this.atStart && chunk.length > 0) {
      this.atStart = false;
      if (chunk.startsWith("\uFEFF")) chunk = chunk.slice(1);
    }
    this.buffer += chunk;
    const events: string[] = [];
    while (this.cursor < this.buffer.length) {
      const char = this.buffer[this.cursor];
      if (char !== "\r" && char !== "\n") {
        this.cursor++;
        continue;
      }
      // Wait for the next chunk before deciding whether a trailing CR is CRLF.
      if (char === "\r" && this.cursor + 1 === this.buffer.length) break;
      const blank = this.cursor === this.lineStart;
      this.cursor += char === "\r" && this.buffer[this.cursor + 1] === "\n" ? 2 : 1;
      if (blank) {
        events.push(this.buffer.slice(0, this.cursor));
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
      }
      this.lineStart = this.cursor;
    }
    return events;
  }

  /** Unfinished remainder, including a possible final CR, at stream end. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    this.cursor = 0;
    this.lineStart = 0;
    return rest;
  }
}

/** Extracts the JSON payload of a `data: {...}` event, or null (comment, [DONE], invalid JSON). */
export function parseSseData(event: string): Record<string, unknown> | null {
  const data = event
    .replace(/^\uFEFF/, "")
    .split(/\r\n|[\r\n]/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
