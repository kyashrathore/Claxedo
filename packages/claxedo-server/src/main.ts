import { startServer } from "./server"

// Subsystem-isolation guard: the embedded OpenCode engine (and its bundled
// deps) can spawn worker_threads whose heap is sized independently of the main
// isolate. A worker OOM surfaces as an unhandled 'error' event and would take
// down the WHOLE control plane. That single failure mode must degrade the
// engine, not the server. Every other uncaught exception keeps crash semantics.
process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
    console.error("[claxedo-server] WARN  engine worker OOM (isolated, server continues):", err.message)
    return
  }
  console.error("[claxedo-server] FATAL uncaught exception:", err)
  process.exit(1)
})

const port = parseInt(process.env.CLAXEDO_SERVER_PORT ?? "3001", 10)
// Composition root: an explicit OPENCODE_URL is the external-URL opt-in; its
// ABSENCE now means EMBEDDED engine (in-process), not the retired :4096 default.
const opencodeUrl = process.env.OPENCODE_URL?.trim() || undefined
startServer(port, opencodeUrl)

console.log(
  `[claxedo-server] listening on http://${process.env.CLAXEDO_SERVER_HOST?.trim() || "127.0.0.1"}:${port}`,
)
