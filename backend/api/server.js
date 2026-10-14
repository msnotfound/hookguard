import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "./app.js";
import { config } from "../shared/config.js";
import { closeDb } from "../shared/db.js";
import { closeQueue } from "../shared/queue.js";
import { migrate } from "../shared/migrate.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = path.join(rootDir, "dist");

await migrate();
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method !== "GET" || !req.accepts("html")) return next();
  res.sendFile(path.join(distDir, "index.html"), (error) => error && next(error));
});

const server = app.listen(config.port, config.host, () => {
  console.log(`HookGuard API running at http://${config.host}:${config.port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  server.close(async () => {
    await Promise.allSettled([closeQueue(), closeDb()]);
    process.exit(0);
  });
}
