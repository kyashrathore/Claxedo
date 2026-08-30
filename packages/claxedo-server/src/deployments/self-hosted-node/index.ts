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

process.on("uncaughtException", (err) => {
  console.error("[claxedo-server] FATAL uncaught exception:", err)
  void reportFatalThenExit(err)
})

const port = parseInt(process.env.CLAXEDO_SERVER_PORT ?? String(DEFAULT_CLAXEDO_SERVER_PORT), 10)
// The self-hosted single binary's one way in. It validates the self-hosted
// posture — deployment mode, embedded auth, SQLite authority, local execution,
// a static bundle if one is configured — before composing anything, and it
// supplies the capability factory that keeps WorkGraph and Documents composed
// after the desktop-local composition stopped contributing any.
startSelfHostedServer({ port })

console.log(
  `[claxedo-server] listening on http://${process.env.CLAXEDO_SERVER_HOST?.trim() || "127.0.0.1"}:${port}`,
)
