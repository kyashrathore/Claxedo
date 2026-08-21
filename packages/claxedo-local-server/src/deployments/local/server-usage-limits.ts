/**
 * Local usage-limit probe for the unified Usage endpoint: remaining quota
 * windows per installed harness (Claude 5h/weekly, Codex session/weekly,
 * Copilot, ...), read through tokentracker-cli's library surface.
 *
 * Security constraints on the tokentracker-cli dependency (audited 2026-07-10
 * at 0.75.1; bumped to 0.91.0 on 2026-08-21 with a tarball diff review — new
 * vendor-limit fetchers only talk to their own vendors' endpoints, no install
 * scripts, no new telemetry in the library path; bunfig.toml exempts it from
 * the release-age gate on that basis):
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
type UsageLimitsModule = {
  getUsageLimits(options?: {
    home?: string
    env?: NodeJS.ProcessEnv
    providerTimeoutMs?: number
  }): Promise<{ fetched_at: string } & Record<string, unknown>>
  resetUsageLimitsCache(): void
}

let loaded: Promise<UsageLimitsModule> | undefined

function loadUsageLimits(): Promise<UsageLimitsModule> {
  // The library path emits no telemetry today; pin it off in case a future
  // (re-audited) version moves the heartbeat call.
  process.env.TOKENTRACKER_NO_TELEMETRY ??= "1"
  // @ts-expect-error TokenTracker ships no declarations; UsageLimitsModule is
  // the audited boundary and its pinned runtime shape has a contract test.
  return import("tokentracker-cli/src/lib/usage-limits.js") as Promise<UsageLimitsModule>
}

export async function getLocalUsageLimits(input: { refresh?: boolean } = {}) {
  const mod = await (loaded ??= loadUsageLimits())
  if (input.refresh) mod.resetUsageLimitsCache()
  return await mod.getUsageLimits({ home: os.homedir(), env: process.env })
}
