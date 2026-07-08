import { createApp, initializeDb } from "./app";
import Database from "better-sqlite3";

const port = Number(process.env.PORT) || 4100;
const dbPath = process.env.DB_PATH || ":memory:";

const db = new Database(dbPath);
initializeDb(db);

const app = createApp(db);

console.log(`Orchestrator API running on http://localhost:${port}`);
console.log(`Dashboard: http://localhost:${port}/`);
if (dbPath === ":memory:") {
  console.log("Using in-memory database (data lost on restart)");
} else {
  console.log(`Using SQLite database: ${dbPath}`);
}

function cleanup() {
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255,
};
