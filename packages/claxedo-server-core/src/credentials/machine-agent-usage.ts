/**
 * What a probe on this machine says about the plan of every agent installed on
 * it, including the agents Claxedo cannot run a turn on.
 *
 * The probe itself is not here: it is a Node-only vendor library the local
 * server owns, and so is the one read of it both consumers share. What is here
 * is the shape the machine login report and the quota view both read.
 */

import { Log } from "../platform/runtime/lib/log"
import type { CredentialUsageWindow } from "./types"
import type { HarnessId } from "@claxedo/agent-runtime-contract"

const log = Log.create({ service: "credentials-machine-agent-usage" })

export type MachineAgentUsage = {
  /** The agent as the probe names it: `claude`, `codex`, `gemini`, `opencodeGo`. */
  agent: string
  /** The harness this agent is, for the agents Claxedo runs turns on. */
  harness?: HarnessId
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
