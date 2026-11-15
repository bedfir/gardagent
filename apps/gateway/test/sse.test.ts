import { describe, expect, it } from "vitest";
import { parseSseData, SseSplitter } from "../src/sse.js";

const message = { jsonrpc: "2.0", id: 1, result: {} };
const data = `data: ${JSON.stringify(message)}`;

describe("SSE framing", () => {
  it.each(["\n", "\r\n", "\r"])("parses and splits line ending %j at every chunk boundary", (ending) => {
    const event = `${data}${ending}${ending}`;
    const stream = event + event;
    for (let split = 0; split <= stream.length; split++) {
      const splitter = new SseSplitter();
      const events = [...splitter.push(stream.slice(0, split)), ...splitter.push(stream.slice(split))];
      const rest = splitter.flush();
      if (rest) events.push(rest);
      // An LF that follows a chunk-final CR is folded into that CRLF, so compare modulo line-ending bytes.
      const normalize = (text: string) => text.replace(/\r\n|\r|\n/g, "\n");
      expect(events.map(normalize)).toEqual([event, event].map(normalize));
      expect(parseSseData(events[0]!)).toEqual(message);
    }
    expect(parseSseData(`:comment${ending}${data}${ending}${ending}`)).toEqual(message);
  });

  it("recognizes mixed terminators and a stream-start BOM with one-character chunks", () => {
    const first = `${data}\n:ignored\r\r`;
    const second = `${data}\r\n\n`;
    const splitter = new SseSplitter();
    const events = Array.from(`\uFEFF${first}${second}`).flatMap((chunk) => splitter.push(chunk));
    const rest = splitter.flush();
    if (rest) events.push(rest);
    const normalize = (text: string) => text.replace(/\r\n|\r|\n/g, "\n");
    expect(events.map(normalize)).toEqual([first, second].map(normalize));
    expect(events.map(parseSseData)).toEqual([message, message]);
    expect(parseSseData(`\uFEFF${data}\r\r`)).toEqual(message);
  });

  it("does not treat CR and LF across chunks as two terminators", () => {
    const splitter = new SseSplitter();
    expect(splitter.push(`${data}\r`)).toEqual([]);
    expect(splitter.push("\n")).toEqual([]);
    expect(splitter.push("\n")).toEqual([`${data}\r\n`]);
    expect(splitter.flush()).toBe("");
  });

  it("dispatches a complete CR-terminated event at once, without waiting for the next chunk or the end of the stream", () => {
    const splitter = new SseSplitter();
    expect(splitter.push(`${data}\r\r`)).toEqual([`${data}\r\r`]);
    // The LF of a CRLF split after the final CR is swallowed and does not open an empty event.
    expect(splitter.push(`\n${data}\r\r`)).toEqual([`${data}\r\r`]);
    expect(splitter.push("\n")).toEqual([]);
    expect(splitter.flush()).toBe("");
  });

  it.each(["\n", "\r\n", "\r"])("rejects multiple JSON messages and invalid JSON with %j", (ending) => {
    expect(parseSseData(`${data}${ending}${data}${ending}${ending}`)).toBeNull();
    expect(parseSseData(`data: {invalid}${ending}${ending}`)).toBeNull();
  });
});
