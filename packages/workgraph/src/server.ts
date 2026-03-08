import { createApp, initializeDb } from "./app";
import { Database } from "bun:sqlite";
import { getActiveAgents } from "./routes/agent";
import { clearAllIntervals } from "./orchestrator/executor";

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
  // Stop all orchestrator poll loops
  clearAllIntervals();

  const active = getActiveAgents();
  if (active.length > 0) {
    console.log(`Killing ${active.length} active agent(s)...`);
    for (const agent of active) {
      try {
        agent.process.kill("SIGTERM");
      } catch (_) {
        // process may have already exited
      }
    }
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255, // seconds — max allowed by Bun; agents can run for minutes
};
