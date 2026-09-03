import { startSelfHostedServer } from "./start"
import { DEFAULT_CLAXEDO_SERVER_PORT } from "@claxedo/local-server/self-hosted-execution"
import { getPostHog } from "../../platform/telemetry/errors/posthog"
import { reportError } from "../../platform/telemetry/errors/report"

/**
 * A fatal exception is the one event guaranteed to be lost: the buffered client
 * flushes on a 10s interval and the process is about to die. Capture, then wait
 * a BOUNDED 2s for the flush — the exit is what matters, so the timeout wins
 * ties and any failure in this path still exits.
 */
async function reportFatalThenExit(err: unknown): Promise<never> {
  try {
    reportError(err, { tags: { source: "uncaught_exception" } })
    const client = getPostHog()
    if (client) {
      await Promise.race([
        client.flush().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
  } catch {
    // Observability must never be the reason a crash hangs.
  }
  process.exit(1)
}

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
  void reportFatalThenExit(err)
})

const port = parseInt(process.env.CLAXEDO_SERVER_PORT ?? String(DEFAULT_CLAXEDO_SERVER_PORT), 10)
// Composition root: an explicit OPENCODE_URL is the external-URL opt-in; its
// ABSENCE now means EMBEDDED engine (in-process), not the retired :4096 default.
const opencodeUrl = process.env.OPENCODE_URL?.trim() || undefined
// The self-hosted single binary's one way in. It validates the self-hosted
// posture — deployment mode, embedded auth, SQLite authority, local execution,
// a static bundle if one is configured — before composing anything.
startSelfHostedServer({ port, ...(opencodeUrl ? { opencodeUrl } : {}) })

console.log(
  `[claxedo-server] listening on http://${process.env.CLAXEDO_SERVER_HOST?.trim() || "127.0.0.1"}:${port}`,
)
