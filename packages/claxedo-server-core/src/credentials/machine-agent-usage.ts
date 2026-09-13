/**
 * What a probe on this machine says about the plan of every agent installed on
 * it, including the agents Claxedo cannot run a turn on.
 *
 * The probe itself is not here: it is a Node-only vendor library the local
 * server owns. What is here is the shape both readers of it share — the machine
 * login report and the quota view — and the one read they share, so opening
 * Settings and opening the usage tab do not each call every vendor.
 */

import { Log } from "../platform/runtime/lib/log"
import type { CredentialUsageWindow } from "./types"
import type { MachineLoginHarness } from "./machine-login"

const log = Log.create({ service: "credentials-machine-agent-usage" })

export type MachineAgentUsage = {
  /** The agent as the probe names it: `claude`, `codex`, `gemini`, `opencodeGo`. */
  agent: string
  /** The harness this agent is, for the agents Claxedo runs turns on. */
  harness?: MachineLoginHarness
  /** The product's name, as a reader knows it. */
  label: string
  /** The plan tier the agent names, with the brand stripped: "Max", "Pro". */
  plan?: string
  windows: CredentialUsageWindow[]
  /** When this agent's figures were read, which a served cache makes older than now. */
  at: number
  /** Why this agent reports no windows, in the probe's own words. */
  error?: string
}

export type MachineAgentUsageReader = (options: { fresh: boolean }) => Promise<readonly MachineAgentUsage[]>

/**
 * The probe's answer, or none of it.
 *
 * A plan read must not cost the surface that asked for it: a vendor that cannot
 * be reached leaves every login and every card on screen with the figures they
 * already had, and a host with no probe at all — anything that is not the
 * machine the agents are installed on — is that same case.
 */
export async function agentUsageOrNone(
  reader: MachineAgentUsageReader | undefined,
  options: { fresh: boolean },
): Promise<readonly MachineAgentUsage[]> {
  if (!reader) return []
  try {
    return await reader(options)
  } catch (error) {
    log.warn("machine agent usage probe failed", {
      detail: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/** How long one probe's answer stands before every vendor is asked again. */
const FRESH_FOR_MS = 60_000

/**
 * One probe at a time, and its answer for a while after.
 *
 * A probe reaches every vendor's usage endpoint at once and several of them
 * ration those reads — Anthropic's answers a 429 with a cool-down measured in
 * tens of minutes — so the Settings list and the usage tab opening together
 * must not be two sweeps. A caller that arrives while one is running takes its
 * answer, `fresh` or not: a second sweep started now would reach the same
 * endpoints the running one is already waiting on.
 */
export function createMachineAgentUsageCache(input: {
  read: (fresh: boolean) => Promise<readonly MachineAgentUsage[]>
  now?: () => number
  freshForMs?: number
}): MachineAgentUsageReader {
  const now = input.now ?? Date.now
  const freshForMs = input.freshForMs ?? FRESH_FOR_MS
  let held: { at: number; agents: readonly MachineAgentUsage[] } | undefined
  let asking: Promise<readonly MachineAgentUsage[]> | undefined
  return ({ fresh }) => {
    if (!fresh && held && now() - held.at < freshForMs) return Promise.resolve(held.agents)
    if (asking) return asking
    const started = input
      .read(fresh)
      .then((agents) => {
        held = { at: now(), agents }
        return agents
      })
      .finally(() => {
        asking = undefined
      })
    asking = started
    return started
  }
}
