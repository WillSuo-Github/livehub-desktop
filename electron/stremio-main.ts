import { readFileSync } from "node:fs";
import path from "node:path";
import { PlatformService } from "./platform-service";
import { StreamService } from "./stream-service";
import { createStremioServer, StremioService } from "./stremio-service";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let host = "127.0.0.1";
  let port = 11471;
  let fullSync = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--host" && args[i + 1]) host = args[++i];
    else if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (args[i] === "--full-sync") fullSync = true;
    else throw new Error("Usage: npm run stremio -- [--host 127.0.0.1] [--port 11471] [--full-sync]");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid server port");
  const { version } = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { version: string };
  const directory = new PlatformService();
  directory.setBackgroundFullSyncEnabled(fullSync);
  const addon = new StremioService(directory, new StreamService(), version);
  const server = createStremioServer(addon);
  server.on("error", (error) => { console.error(error.message); addon.dispose(); directory.dispose(); process.exitCode = 1; });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const displayHost = host.includes(":") ? `[${host}]` : host;
  console.log(`LiveHub Stremio: http://${displayHost}:${port}/manifest.json`);
  console.log(`Directory status: http://${displayHost}:${port}/health.json`);
  console.log(`Search scope: ${fullSync ? "featured rooms, expanding with background full sync" : "indexed featured rooms (use --full-sync for wider coverage)"}`);
  const unsubscribe = directory.subscribe((update) => {
    if (update.status.state === "error") console.error(`[stremio] ${update.platform}: directory refresh failed`);
    else if (update.status.lastUpdatedAt && update.status.phase !== "syncing") {
      console.log(`[stremio] ${update.platform}: ${update.rooms.length} rooms${update.status.partial ? " (partial)" : ""}`);
    }
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    unsubscribe(); addon.dispose(); directory.dispose();
    server.close(); server.closeAllConnections();
    // In-flight upstream adapters can otherwise keep the process alive for several minutes.
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  void addon.warmup();
}

void main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
