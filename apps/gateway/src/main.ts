import { MemoryStore, type Store } from "@gardagent/core";
import { buildApp, startLedgerReplay } from "./app.js";
import { adminExposureWarning, failOpenActive, loadConfig } from "./config.js";
import { PgStore } from "./pg-store.js";

const config = loadConfig();
if (config.dbOutage === "fail-open" && !failOpenActive(config)) {
  console.warn(
    `GARDAGENT_DB_OUTAGE=fail-open is ignored in "${config.mode}" mode: fail-open requires GARDAGENT_MODE=observe. Database outages stay fail-closed (503).`,
  );
}

const exposure = adminExposureWarning(config.host, process.env);
if (exposure) console.warn(exposure);

let store: Store;
let close: () => Promise<void> = async () => undefined;
if (config.databaseUrl) {
  const pgStore = PgStore.connect(config.databaseUrl, undefined, { connectTimeoutMs: config.dbConnectTimeoutMs });
  await pgStore.migrate();
  store = pgStore;
  close = () => pgStore.close();
} else {
  console.warn("DATABASE_URL missing: in-memory storage, lost on shutdown. For demos only.");
  store = new MemoryStore();
}

const app = buildApp({ config, store, logger: true });

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await startLedgerReplay(app, store, config);
await app.listen({ port: config.port, host: config.host });
