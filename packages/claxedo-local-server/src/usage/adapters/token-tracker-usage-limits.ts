/**
 * The plan windows every agent installed on this machine reports, read through
 * tokentracker-cli's library surface.
 *
 * Security constraints on the tokentracker-cli dependency (bunfig.toml exempts
 * it from the release-age gate because new vendor-limit fetchers only talk to
 * their own vendors' endpoints, with no install scripts and no new telemetry in
 * the library path). This block is where they are written down; the history
 * adapter beside this file is the other user and points here.
 * - Library-only. Never invoke its CLI (`sync`/`serve`): those paths contain an
 *   `npx --yes` self-update and a localhost dashboard that must not ship.
 * - `getUsageLimits()` reads each CLI's own credential store — Keychain, auth
 *   files — and rewrites gemini's and kimi's files non-atomically, and
 *   `~/.codex/auth.json` atomically, when it refreshes a stale token. The owner
 *   accepted that on 2026-09-13. Nothing here writes a Claxedo credential: the
 *   accounts Claxedo stores are read by their own Check.
 * - Exact-pinned. Bumping requires a tarball diff against the previous pin and
 *   the contract test beside this file staying green.
 *
 * Node-only (fs/child_process/keychain): loaded lazily so it can never enter
 * the Worker import graph.
 */

import os from "node:os"
import { isHarnessId } from "@claxedo/agent-runtime-contract"
import { clampPercent, usageResetMs, usageWindowName } from "@claxedo/server-core/credentials/usage-windows"
import { createFreshCache } from "@claxedo/server-core/platform/runtime/lib/fresh-cache"
import type { MachineAgentUsage, MachineAgentUsageReader } from "@claxedo/server-core/credentials/machine-agent-usage"
import type { CredentialUsageWindow } from "@claxedo/server-core/credentials/types"
import { num, record, text } from "../../platform/json"

type UsageLimitsModule = {
  getUsageLimits(options?: {
    home?: string
    env?: NodeJS.ProcessEnv
    providerTimeoutMs?: number
  }): Promise<{ fetched_at: string } & Record<string, unknown>>
  resetUsageLimitsCache(): void
}

/** The product each agent key names, in the probe's own brand words. */
const AGENT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  kimi: "Kimi",
  gemini: "Gemini",
  kiro: "Kiro",
  antigravity: "Antigravity",
  copilot: "Copilot",
  grok: "Grok",
  zcode: "ZCode",
  opencodeGo: "OpenCode Go",
  qoder: "Qoder",
  qoderCn: "Qoder CN",
  codingPlan: "Ark Coding Plan",
}

/** An unnamed slot keeps the probe's own field, minus the suffix every one of them carries. */
function slotName(agent: string, field: string) {
  const named = usageWindowName(agent, field)
  return named === field ? field.replace(/_window$/, "") : named
}

function windowAt(agent: string, field: string, value: unknown): CredentialUsageWindow | undefined {
  const window = record(value)
  const percent = window === undefined ? undefined : num(window.utilization) ?? num(window.used_percent)
  if (window === undefined || percent === undefined) return undefined
  // The probe labels some slots itself, and that label is the vendor's own word
  // for a window Claxedo has no name for, so it wins over the fallback.
  return {
    window: text(window.label) ?? slotName(agent, field),
    usedPercent: clampPercent(percent),
    resetsAt: usageResetMs(window.reset_at ?? window.resets_at),
  }
}

/**
 * Every window an agent reports, found by shape rather than by a list of field
 * names: the probe grows a slot per vendor release, and a list would silently
 * drop the new one. Scoped weekly limits arrive as an array whose entries name
 * themselves; everything else is one object per slot, and the fields that carry
 * no percentage — provenance, service status, plan labels — are not windows.
 */
function windowsOf(agent: string, reported: Record<string, unknown>): CredentialUsageWindow[] {
  return Object.entries(reported).flatMap(([field, value]) => {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const window = windowAt(agent, field, entry)
        return window ? [window] : []
      })
    }
    const window = windowAt(agent, field, value)
    return window ? [window] : []
  })
}

/**
 * One agent per key the probe configured. An agent it reports as unconfigured
 * is one this machine does not have, which is not the same as one whose plan
 * could not be read, so it is left out rather than listed as unknown.
 */
export function machineAgentUsage(probe: unknown, fallbackAt: number): MachineAgentUsage[] {
  const reported = record(probe)
  if (reported === undefined) return []
  const fetchedAt = Date.parse(text(reported.fetched_at) ?? "")
  return Object.entries(reported).flatMap(([agent, value]) => {
    const row = record(value)
    if (row === undefined || row.configured !== true) return []
    const capturedAt = Date.parse(text(record(row.provenance)?.captured_at) ?? text(row.cached_at) ?? "")
    const error = text(row.error)
    const plan = text(row.plan_label)
    return [{
      agent,
      ...(isHarnessId(agent) ? { harness: agent } : {}),
      label: (Object.hasOwn(AGENT_LABEL, agent) ? AGENT_LABEL[agent] : undefined) ?? agent,
      ...(plan === undefined ? {} : { plan }),
      windows: error === undefined ? windowsOf(agent, row) : [],
      at: [capturedAt, fetchedAt, fallbackAt].find((at) => Number.isFinite(at)) ?? fallbackAt,
      ...(error === undefined ? {} : { error }),
    }]
  })
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

async function probe(fresh: boolean): Promise<MachineAgentUsage[]> {
  const module = await (loaded ??= loadUsageLimits())
  // The library holds its own two-minute answer. An ordinary read is welcome to
  // it; a refresh is the button a user pressed to replace those figures, and
  // would otherwise return them.
  if (fresh) module.resetUsageLimitsCache()
  return machineAgentUsage(await module.getUsageLimits({ home: os.homedir(), env: process.env }), Date.now())
}

/**
 * The single read both the machine login report and the quota view share.
 *
 * A probe reaches every vendor's usage endpoint at once and several of them
 * ration those reads — Anthropic's answers a 429 with a cool-down measured in
 * tens of minutes — so the Settings list and the usage tab opening together
 * must not be two sweeps, and one sweep's figures stand for a minute.
 */
const sweep = createFreshCache<void, readonly MachineAgentUsage[]>({
  read: (_machine, { fresh }) => probe(fresh),
  freshForMs: 60_000,
})

export const readMachineAgentUsage: MachineAgentUsageReader = ({ fresh }) => sweep.read(undefined, { fresh })
