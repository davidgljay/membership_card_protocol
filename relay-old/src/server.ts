import http from "node:http";
import { router } from "./router.js";
import { loadAppRegistry } from "./utils/apps.js";
import { loadObliviousTargets } from "./utils/oblivious_targets.js";
import { runStartupChecks } from "./startup.js";
import { stopWalletClearance } from "./utils/wallet_clearance.js";
import { closeRedis } from "./utils/storage/redis.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const APP_REGISTRY_PATH = process.env.APP_REGISTRY_PATH;
if (!APP_REGISTRY_PATH) {
  console.error("APP_REGISTRY_PATH environment variable is required");
  process.exit(1);
}
loadAppRegistry(APP_REGISTRY_PATH);

loadObliviousTargets(process.env.OBLIVIOUS_TARGETS_PATH);

const server = http.createServer((req, res) => {
  Promise.resolve(router(req, res)).catch((err: unknown) => {
    console.error("Unhandled route error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "INTERNAL_ERROR", message: "Unexpected error" }));
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  import("./routes/ws.js").then(({ handleUpgrade }) => {
    handleUpgrade(req, socket, head);
  });
});

// Run startup checks before accepting requests
runStartupChecks()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Relay listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Startup failed:", err);
    process.exit(1);
  });

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal} — shutting down`);
  server.close();
  await stopWalletClearance(5000);
  await closeRedis();
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(console.error); });
process.on("SIGINT",  () => { shutdown("SIGINT").catch(console.error); });

export { server };
