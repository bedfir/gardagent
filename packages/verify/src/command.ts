import { verifyExport } from "./index.js";

/** Injectable local-file reader keeps CLI behavior testable without a subprocess. */
export function run(args: string[], read: (path: string) => string): { code: number; output: string } {
  const json = args.includes("--json");
  try {
    const files = args.filter((a) => a !== "--json");
    if (!files.length || files.some((a) => a.startsWith("-")) || args.filter((a) => a === "--json").length > 1) {
      throw new Error("Usage: gardagent-verify [--json] EXPORT.ndjson [CHECKPOINT.json ...]");
    }
    const result = verifyExport(read(files[0]!), files.slice(1).map((f) => JSON.parse(read(f)) as unknown));
    const output = json ? JSON.stringify(result) : [
      result.valid ? "VALID" : "INVALID",
      `Entries: ${result.count}`,
      `Verified head: ${result.head.sequence} ${result.head.hash}`,
      ...(result.firstInvalid ? [`First invalid entry: ${result.firstInvalid.sequence ?? "unknown"}: ${result.firstInvalid.reason}`] : []),
      ...result.checkpoints.map((c) => `Checkpoint ${c.index + 1}: ${c.contained ? "contained" : c.reason}`),
      result.limitation,
    ].join("\n");
    return { code: result.valid ? 0 : 1, output };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { code: 1, output: json ? JSON.stringify({ valid: false, error: reason }) : `INVALID: ${reason}` };
  }
}
