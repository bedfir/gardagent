import { writeFile } from "node:fs/promises";
import { buildReport, type ReportData } from "./report.js";

interface CliOptions {
  url: string;
  days: number;
  out: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const options: CliOptions = { url: "", days: 7, out: "" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--url":
        options.url = args[++i] ?? "";
        break;
      case "--days":
        options.days = Number(args[++i]);
        break;
      case "--out":
        options.out = args[++i] ?? "";
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.url) throw new Error("The --url option is required.");
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 90) {
    throw new Error("The --days option must be an integer between 1 and 90.");
  }
  if (!options.out) throw new Error("The --out option is required.");
  return options;
}

function printUsage(): void {
  console.error("Usage: node packages/report/dist/cli.js --url <url> --days <1-90> --out <file.md>");
  console.error("The admin token is read from the GARDAGENT_ADMIN_TOKEN environment variable.");
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP error ${response.status} on ${url}${text ? `: ${text}` : ""}`);
  }
  return response.json();
}

async function main(): Promise<void> {
  const token = process.env.GARDAGENT_ADMIN_TOKEN;
  if (!token) {
    console.error("Missing GARDAGENT_ADMIN_TOKEN environment variable.");
    process.exit(1);
  }

  let options: CliOptions;
  try {
    options = parseArgs(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printUsage();
    process.exit(1);
  }

  const baseUrl = options.url.replace(/\/$/, "");
  const [agentsJson, statsJson, verifyJson] = await Promise.all([
    fetchJson(`${baseUrl}/admin/agents`, token),
    fetchJson(`${baseUrl}/admin/stats?days=${options.days}`, token),
    fetchJson(`${baseUrl}/admin/ledger/verify`, token),
  ]);

  const data: ReportData = {
    agents: (agentsJson as { agents: ReportData["agents"] }).agents,
    stats: statsJson as ReportData["stats"],
    verify: verifyJson as ReportData["verify"],
  };

  const report = buildReport(data);
  await writeFile(options.out, report, "utf-8");
  console.log(`Report written to ${options.out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
