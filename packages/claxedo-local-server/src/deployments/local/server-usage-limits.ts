/**
 * Local-only usage-limits endpoint backing the status-bar usage button:
 * remaining quota windows per installed harness (Claude 5h/weekly, Codex
 * session/weekly, Copilot, ...), probed via tokentracker-cli's library surface.
 *
 * Security constraints on the tokentracker-cli dependency (audited 2026-07-10
 * at 0.75.1; bunfig.toml exempts it from the release-age gate on that basis):
 * - Library-only. NEVER invoke its CLI (`sync`/`serve`): those paths contain an
 *   `npx --yes` self-update and a localhost dashboard we must not ship.
 * - `getUsageLimits()` may rewrite provider credential files when it refreshes
 *   stale tokens (`~/.codex/auth.json` atomically; gemini/kimi non-atomically).
 * - Exact-pinned. Bumping requires a tarball diff against the previous pin and
 *   the contract test staying green (usage-limits.contract.test.ts).
 *
 * Node-only (fs/child_process/keychain): loaded lazily so it can never enter
 * the Worker import graph, and mounted only in server.ts (local app).
 */
import os from "node:os"
import type { Hono as HonoType } from "hono"
import { localOnlyProjection } from "@claxedo/server-core/platform/http/local-only-projection"
import { errorBody } from "@claxedo/server-core/platform/http/http"

type UsageLimitsRouteOptions = Omit<Parameters<typeof localOnlyProjection>[0], "label">

type UsageLimitsModule = typeof import("tokentracker-cli/src/lib/usage-limits.js")

let loaded: Promise<UsageLimitsModule> | undefined

function loadUsageLimits(): Promise<UsageLimitsModule> {
  // The library path emits no telemetry today; pin it off in case a future
  // (re-audited) version moves the heartbeat call.
  process.env.TOKENTRACKER_NO_TELEMETRY ??= "1"
  return import("tokentracker-cli/src/lib/usage-limits.js")
}

export function mountLocalOnlyUsageLimits(app: HonoType, options: UsageLimitsRouteOptions) {
  app.use("/api/claxedo/usage-limits", localOnlyProjection({ ...options, label: "UsageLimits" }))
  app.get("/api/claxedo/usage-limits", async (c) => {
    try {
      const mod = await (loaded ??= loadUsageLimits())
      // The lib keeps a short in-memory cache with single-flight dedup, so the
      // client can poll freely; ?refresh=1 forces a live re-probe.
      if (c.req.query("refresh") === "1") mod.resetUsageLimitsCache()
      // CRITICAL: tokentracker does NOT default the home dir — without `home`,
      // every credential file under ~ (Codex ~/.codex, Gemini ~/.gemini, Cursor
      // state.vscdb, ...) reads as "not configured". Only Keychain-based Claude
      // survives argless. Always pass home + env.
      return c.json(await mod.getUsageLimits({ home: os.homedir(), env: process.env }))
    } catch (err) {
      return c.json(
        errorBody("usage_limits_failed", err instanceof Error ? err.message : String(err)),
        500,
      )
    }
  })
}
