/**
 * Local usage-limit probe for the unified Usage endpoint: remaining quota
 * windows per installed harness (Claude 5h/weekly, Codex session/weekly,
 * Copilot, ...), read through tokentracker-cli's library surface.
 *
 * Security constraints on the tokentracker-cli dependency (bunfig.toml exempts
 * it from the release-age gate because new vendor-limit fetchers only talk to
 * their own vendors' endpoints, with no install scripts and no new telemetry
 * in the library path):
 * - Library-only. Never invoke its CLI (`sync`/`serve`): those paths contain an
 *   `npx --yes` self-update and a localhost dashboard that must not ship.
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
  return import("tokentracker-cli/src/lib/usage-limits.js")
}

export async function getLocalUsageLimits(input: { refresh?: boolean } = {}) {
  const mod = await (loaded ??= loadUsageLimits())
  if (input.refresh) mod.resetUsageLimitsCache()
  return await mod.getUsageLimits({ home: os.homedir(), env: process.env })
}
